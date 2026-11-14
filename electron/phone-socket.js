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

/** Write a one-time token file: 0600, created fresh (never through a symlink, never over an existing file). */
export function writeTokenFile(file, token) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, token); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Read and delete a token file (the gate and `done` side). Refuses anything that is not a regular 0600 file owned
 * by this user, opened without following a symlink. Returns the token or throws.
 */
export function takeTokenFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('not owned by this user');
    if ((st.mode & 0o777) !== 0o600) throw new Error('not private (0600)');
    if (st.size > 256) throw new Error('too large');
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    fs.unlinkSync(file);
    return buf.toString('utf8').trim();
  } finally { fs.closeSync(fd); }
}

/** Remove a token file if it is still there (expiry, run end). ENOENT is fine. */
export function dropTokenFile(file, log = () => {}) {
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') log(`phone: could not remove ${path.basename(file)}: ${e.message}`); }
}

/** Split a byte stream into JSON lines with a cap. onLine(obj) per parsed line; onBad(reason) once, then stops. */
export function lineReader(onLine, onBad, maxLine = MAX_LINE) {
  let buf = '';
  let dead = false;
  return (chunk) => {
    if (dead) return;
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.length > maxLine) { dead = true; onBad('line too long'); return; }
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { dead = true; onBad('not JSON'); return; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.t !== 'string') { dead = true; onBad('not a message'); return; }
      onLine(obj);
      if (dead) return;
    }
    if (buf.length > maxLine) { dead = true; onBad('line too long'); }
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
    sock.setEncoding('utf8');
    let closed = false;
    const conn = {
      id: ++seq, authed: false, data: {},
      send(obj) {
        if (closed) return false;
        const line = JSON.stringify(obj);
        if (line.length > MAX_LINE) { log(`phone socket: dropped an oversized message (${line.length})`); return false; }
        return sock.write(`${line}\n`);
      },
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
