/**
 * Phone mode: the local socket the gate, the runner and `done` talk to main through, and the one-time files that
 * carry their tokens (docs/phone-mode-design.md, "Main: electron/phone-mode.js", "Socket").
 *
 * Transport only: newline-delimited JSON, a line cap, a connection cap and an idle cap for connections that have not
 * proved themselves. Which messages are accepted, and from whom, is phone-mode.js's (it owns the registry).
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_LINE = 256 * 1024;
export const MAX_CONNS = 16;
export const UNAUTHED_IDLE_MS = 10_000;
// Bytes main may hold for one connection that is not reading its replies. A connection past it is closed (Codex P1,
// impl round 4: a client that stops reading made every reply queue in main's memory without limit).
export const MAX_OUTBOUND = 1024 * 1024;
const SOCK_NAME = 'phone.sock';
const SUN_PATH_MAX = 103; // macOS sockaddr_un.sun_path is 104 bytes including the terminating NUL

/**
 * The run folder: `<userData>/run`, or a short folder under the temp dir when the socket path would be too long.
 * Created 0700; refused unless it is a real directory (not a symlink) owned by this user with no group/other access.
 */
export function ensureRunDir(userData) {
  let dir = path.join(userData, 'run');
  if (Buffer.byteLength(path.join(dir, SOCK_NAME)) > SUN_PATH_MAX) {
    const tag = crypto.createHash('sha256').update(userData).digest('hex').slice(0, 12);
    dir = path.join(os.tmpdir(), `dobius-${process.getuid?.() ?? 'u'}-${tag}`);
  }
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`phone run folder is not a plain directory: ${dir}`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`phone run folder is not ours: ${dir}`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

export const socketPath = (runDir) => path.join(runDir, SOCK_NAME);
export const ticketPath = (runDir, runId) => path.join(runDir, `phone-${runId}.ticket`);
export const donePath = (runDir, runId) => path.join(runDir, `phone-${runId}.done`);

/**
 * Write a one-time token file: 0600, created fresh (never through a symlink, never over an existing file). Every byte
 * is written or the file is removed and this throws (Codex P2, impl round 4: a short write was reported as success).
 */
export function writeTokenFile(file, token) {
  const buf = Buffer.from(String(token), 'utf8');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let ok = false;
  try {
    let off = 0;
    while (off < buf.length) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error('token file write made no progress');
      off += n;
    }
    fs.fsyncSync(fd);
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) { try { fs.unlinkSync(file); } catch { /* best effort: the create succeeded, so the name is ours */ } }
  }
}

/**
 * Read and delete a token file (the gate and `done` side). Refuses anything that is not a regular 0600 file owned
 * by this user, opened without following a symlink. Returns the token or throws.
 *
 * The name is claimed first: renamed to a fresh random name in the same folder, so nothing put at the original path
 * afterwards is ever touched. The claimed file is deleted only while it is still the one that was read (same device
 * and inode); a file found there instead is left alone (Codex P1, impl round 4: the old code deleted whatever was at
 * the path after reading). The folder is 0700 (ensureRunDir), so only this user can race these steps at all.
 * `hooks.afterRead(claimedPath)` exists for the tests.
 */
export function takeTokenFile(file, hooks = {}) {
  const claimed = `${file}.taken-${crypto.randomBytes(8).toString('hex')}`;
  fs.renameSync(file, claimed);
  let fd;
  try {
    fd = fs.openSync(claimed, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    // A symlink (or anything that cannot be opened) was claimed: put the name back as it was, never delete it.
    try { fs.renameSync(claimed, file); } catch { /* the original name was taken meanwhile: leave ours for the sweep */ }
    throw e;
  }
  let token;
  let st;
  try {
    st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('not owned by this user');
    if ((st.mode & 0o777) !== 0o600) throw new Error('not private (0600)');
    if (st.size > 256) throw new Error('too large');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (!(n > 0)) throw new Error('token file ended early');
      off += n;
    }
    token = buf.toString('utf8').trim();
  } catch (e) {
    try { fs.renameSync(claimed, file); } catch { /* see above */ }
    throw e;
  } finally { fs.closeSync(fd); }
  hooks.afterRead?.(claimed);
  let now;
  try { now = fs.lstatSync(claimed); } catch (e) { if (e.code === 'ENOENT') return token; throw e; }
  if (now.dev !== st.dev || now.ino !== st.ino) throw new Error('token file was replaced while it was read');
  fs.unlinkSync(claimed);
  return token;
}

/** Remove a token file if it is still there (expiry, run end). ENOENT is fine. */
export function dropTokenFile(file, log = () => {}) {
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') log(`phone: could not remove ${path.basename(file)}: ${e.message}`); }
}

/**
 * Split a byte stream into JSON lines with a cap counted in BYTES (Codex P2, impl round 4: a cap on string length let
 * a line of 3-byte characters run three times over). Feed it Buffers; a line is decoded only once it is complete, so
 * a character split across chunks is never broken. onLine(obj) per parsed line; onBad(reason) once, then stops.
 */
export function lineReader(onLine, onBad, maxLine = MAX_LINE) {
  let parts = [];
  let size = 0;
  let dead = false;
  const fail = (why) => { dead = true; parts = []; size = 0; onBad(why); };
  return (chunk) => {
    if (dead) return;
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let start = 0;
    for (;;) {
      const i = b.indexOf(0x0a, start);
      if (i === -1) break;
      const piece = b.subarray(start, i);
      const len = size + piece.length;
      start = i + 1;
      if (len > maxLine) { fail('line too long'); return; }
      const line = (parts.length ? Buffer.concat([...parts, piece], len) : piece).toString('utf8');
      parts = [];
      size = 0;
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { fail('not JSON'); return; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.t !== 'string') { fail('not a message'); return; }
      onLine(obj);
      if (dead) return;
    }
    if (start < b.length) {
      size += b.length - start;
      if (size > maxLine) { fail('line too long'); return; }
      parts.push(Buffer.from(b.subarray(start))); // a copy: never keep a whole read buffer alive for its tail
    }
  };
}

/**
 * Start the server. handler(conn, msg) for each message; conn = { id, send(obj), close(reason), authed, data }.
 * A handler marks a connection proved with `conn.authed = true`; until then it is closed after UNAUTHED_IDLE_MS.
 * onClose(conn, reason) when any connection ends. Returns { close(), path, connections() }.
 */
export async function startPhoneSocket(runDir, { handler, onClose, log = () => {} }) {
  const file = socketPath(runDir);
  // A stale socket from a crashed main: remove only a socket, never another kind of file.
  try {
    const st = fs.lstatSync(file);
    if (!st.isSocket()) throw new Error(`${file} exists and is not a socket`);
    fs.unlinkSync(file);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const conns = new Set();
  let seq = 0;
  const server = net.createServer((sock) => {
    if (conns.size >= MAX_CONNS) { sock.destroy(); log('phone socket: connection refused, too many open'); return; }
    let closed = false;
    const conn = {
      id: ++seq, authed: false, data: {},
      send(obj) {
        if (closed) return false;
        const line = `${JSON.stringify(obj)}\n`;
        const bytes = Buffer.byteLength(line);
        if (bytes > MAX_LINE) { log(`phone socket: dropped an oversized message (${bytes} bytes)`); return false; }
        const ok = sock.write(line);
        if (sock.writableLength > MAX_OUTBOUND) { log('phone socket: closing a connection that stopped reading'); conn.close('not reading'); return false; }
        return ok;
      },
      // A connection that stopped reading never drains, so end() alone would keep its queued bytes: destroy after 1 s.
      close(reason) { if (!closed) { closed = true; sock.end(); setTimeout(() => sock.destroy(), 1000).unref(); finish(reason); } },
    };
    const finish = (reason) => {
      if (!conns.has(conn)) return;
      conns.delete(conn);
      clearTimeout(idle);
      try { onClose?.(conn, reason); } catch (e) { log(`phone socket: close handler failed: ${e.message}`); }
    };
    const idle = setTimeout(() => { if (!conn.authed) { log('phone socket: unproved connection timed out'); conn.close('idle'); } }, UNAUTHED_IDLE_MS);
    idle.unref();
    conns.add(conn);
    const read = lineReader((msg) => {
      try { handler(conn, msg); } catch (e) { log(`phone socket: handler failed: ${e.message}`); conn.close('handler-error'); }
    }, (why) => { log(`phone socket: closing connection (${why})`); closed = true; sock.destroy(); finish(why); });
    sock.on('data', read);
    sock.on('error', (e) => { log(`phone socket: ${e.code || e.message}`); });
    sock.on('close', () => { closed = true; finish('closed'); });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => { server.off('error', reject); resolve(); });
  });
  fs.chmodSync(file, 0o600);
  return {
    path: file,
    connections: () => [...conns],
    close: () => new Promise((resolve) => {
      for (const c of [...conns]) c.close('server-close');
      server.close(() => { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') log(`phone socket: ${e.message}`); } resolve(); });
    }),
  };
}
