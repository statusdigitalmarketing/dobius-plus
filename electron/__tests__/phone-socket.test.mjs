import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  ensureRunDir, socketPath, writeTokenFile, takeTokenFile, dropTokenFile, lineReader, startPhoneSocket, MAX_LINE, MAX_OUTBOUND,
} from '../phone-socket.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-')));

test('run folder: 0700 under userData, a short temp folder when the socket path is too long', () => {
  const ud = tmp();
  try {
    const d = ensureRunDir(ud);
    assert.equal(d, path.join(ud, 'run'));
    assert.equal(fs.statSync(d).mode & 0o777, 0o700);
    const deep = path.join(ud, 'x'.repeat(120));
    fs.mkdirSync(deep);
    const d2 = ensureRunDir(deep);
    assert.ok(Buffer.byteLength(socketPath(d2)) <= 103);
    assert.equal(fs.statSync(d2).mode & 0o777, 0o700);
    assert.equal(ensureRunDir(deep), d2); // stable
    fs.rmSync(d2, { recursive: true, force: true });
  } finally { fs.rmSync(ud, { recursive: true, force: true }); }
});

test('run folder: a symlink in its place is refused', () => {
  const ud = tmp();
  try {
    fs.mkdirSync(path.join(ud, 'elsewhere'));
    fs.symlinkSync(path.join(ud, 'elsewhere'), path.join(ud, 'run'));
    assert.throws(() => ensureRunDir(ud), /not a plain directory/);
  } finally { fs.rmSync(ud, { recursive: true, force: true }); }
});

test('token files: 0600, one read, refused if loose, symlinked or pre-existing', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'phone-x.ticket');
    writeTokenFile(f, 'abc');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.throws(() => writeTokenFile(f, 'again'), /EEXIST/);
    assert.equal(takeTokenFile(f), 'abc');
    assert.equal(fs.existsSync(f), false);
    assert.throws(() => takeTokenFile(f), /ENOENT/);
    fs.writeFileSync(f, 'loose', { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    assert.throws(() => takeTokenFile(f), /0600/);
    fs.unlinkSync(f);
    const target = path.join(d, 'target');
    fs.writeFileSync(target, 'x', { mode: 0o600 });
    fs.symlinkSync(target, f);
    assert.throws(() => takeTokenFile(f), /ELOOP|EMLINK|symbolic/i);
    assert.equal(fs.lstatSync(f).isSymbolicLink(), true); // put back, not deleted
    assert.equal(fs.readFileSync(target, 'utf8'), 'x');
    assert.throws(() => writeTokenFile(f, 'z'), /EEXIST|ELOOP/);
    dropTokenFile(path.join(d, 'missing')); // no throw
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('lineReader: split lines, cap a line, stop at the first bad one', () => {
  const got = [], bad = [];
  const r = lineReader((m) => got.push(m), (w) => bad.push(w), 50);
  r('{"t":"a"}\n{"t":');
  r('"b"}\n\n');
  assert.deepEqual(got.map((m) => m.t), ['a', 'b']);
  r('x'.repeat(60));
  assert.deepEqual(bad, ['line too long']);
  r('{"t":"c"}\n');
  assert.equal(got.length, 2); // dead after a bad line
  const bad2 = [];
  const r2 = lineReader(() => {}, (w) => bad2.push(w));
  r2('[1]\n');
  assert.deepEqual(bad2, ['not a message']);
});

function client(file) {
  const sock = net.connect(file);
  sock.setEncoding('utf8');
  const lines = [];
  let waiters = [];
  let buf = '';
  sock.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    waiters.forEach((w) => w()); waiters = [];
  });
  sock.on('error', () => {}); // the server may close first, mid-write (EPIPE); the close is what is asserted
  const closed = new Promise((r) => sock.on('close', r));
  return {
    sock, closed,
    send: (o) => sock.write(`${JSON.stringify(o)}\n`),
    next: async () => { while (!lines.length) await new Promise((r) => waiters.push(r)); return lines.shift(); },
  };
}

test('server: messages in, replies out, socket 0600, oversized line closes, close() removes the file', async () => {
  const ud = tmp();
  const runDir = ensureRunDir(ud);
  const closes = [];
  const srv = await startPhoneSocket(runDir, {
    handler: (conn, msg) => { conn.authed = true; conn.send({ t: 'echo', got: msg.t }); },
    onClose: (conn, why) => closes.push(why),
  });
  try {
    assert.equal(fs.statSync(srv.path).mode & 0o777, 0o600);
    const c = client(srv.path);
    c.send({ t: 'hi' });
    assert.deepEqual(await c.next(), { t: 'echo', got: 'hi' });
    const big = client(srv.path);
    big.sock.write(`{"t":"x","pad":"${'y'.repeat(MAX_LINE + 10)}"}\n`);
    await big.closed;
    assert.ok(closes.includes('line too long'));
    c.sock.end();
    await c.closed;
  } finally {
    await srv.close();
    assert.equal(fs.existsSync(socketPath(runDir)), false);
    fs.rmSync(ud, { recursive: true, force: true });
  }
});

test('server: a stale socket left by a crash is replaced, any other file in its place is refused', async () => {
  const ud = tmp();
  const runDir = ensureRunDir(ud);
  try {
    const file = socketPath(runDir);
    const ch = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(file)}, () => console.log('up'))`]);
    await once(ch.stdout, 'data');
    ch.kill('SIGKILL');
    await once(ch, 'exit');
    assert.equal(fs.lstatSync(file).isSocket(), true); // left behind
    const b = await startPhoneSocket(runDir, { handler: () => {} });
    const c = client(b.path);
    c.sock.end();
    await c.closed;
    await b.close();
    fs.writeFileSync(file, 'not a socket');
    await assert.rejects(startPhoneSocket(runDir, { handler: () => {} }), /not a socket/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'not a socket'); // never removed
  } finally { fs.rmSync(ud, { recursive: true, force: true }); }
});

test('token files: a file swapped in after the read is never deleted (Codex impl r4)', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'phone-y.ticket');
    writeTokenFile(f, 'tok');
    const other = path.join(d, 'other');
    assert.throws(() => takeTokenFile(f, {
      afterRead: (claimed) => {
        fs.renameSync(claimed, path.join(d, 'moved-away'));
        fs.writeFileSync(claimed, 'not ours to delete', { mode: 0o600 });
        fs.linkSync(claimed, other);
      },
    }), /replaced/);
    assert.equal(fs.readFileSync(other, 'utf8'), 'not ours to delete');
    assert.equal(fs.statSync(other).nlink, 2); // the swapped-in file still has its claimed name too
    // and the original path is never touched after the claim
    writeTokenFile(f, 'tok2');
    assert.equal(takeTokenFile(f, { afterRead: () => fs.writeFileSync(f, 'new ticket', { mode: 0o600 }) }), 'tok2');
    assert.equal(fs.readFileSync(f, 'utf8'), 'new ticket');
    assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes('.taken-') && n.startsWith('phone-y.ticket.taken-') && fs.readFileSync(path.join(d, n), 'utf8') === 'tok2'), []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('token files: multibyte tokens round trip whole', () => {
  const d = tmp();
  try {
    const f = path.join(d, 'phone-z.ticket');
    writeTokenFile(f, 'é界'.repeat(20));
    assert.equal(takeTokenFile(f), 'é界'.repeat(20));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('lineReader: the cap counts bytes, and a character split across chunks survives (Codex impl r4)', () => {
  const bad = [];
  const r = lineReader(() => {}, (w) => bad.push(w), 50);
  r(Buffer.from(`{"t":"${'界'.repeat(15)}"}\n`)); // 15 chars of string, 52 bytes of line
  assert.deepEqual(bad, ['line too long']);
  const bad2 = [];
  const r2 = lineReader(() => {}, (w) => bad2.push(w), 50);
  r2(Buffer.from('{"t":"' + '界'.repeat(15))); // unfinished, already over in bytes
  assert.deepEqual(bad2, ['line too long']);
  const got = [];
  const r3 = lineReader((m) => got.push(m), () => {});
  const whole = Buffer.from('{"t":"界"}\n');
  r3(whole.subarray(0, 7)); // splits the 3-byte character
  r3(whole.subarray(7));
  assert.deepEqual(got, [{ t: '界' }]);
});

test('server: a multibyte line over the cap in bytes is refused, a reply over it is not sent', async () => {
  const ud = tmp();
  const runDir = ensureRunDir(ud);
  const closes = [];
  const srv = await startPhoneSocket(runDir, {
    handler: (conn, msg) => {
      conn.authed = true;
      if (msg.t === 'hi') conn.send({ t: 'r', pad: '界'.repeat(100000) }); // 300 KB in bytes, 100 K characters
      else conn.send({ t: 'pong' });
    },
    onClose: (conn, why) => closes.push(why),
  });
  try {
    const c = client(srv.path);
    c.send({ t: 'hi' });
    c.send({ t: 'ping' });
    assert.deepEqual(await c.next(), { t: 'pong' }); // the oversized reply was never sent
    const big = client(srv.path);
    big.sock.write(`{"t":"x","pad":"${'界'.repeat(100000)}"}\n`);
    await big.closed;
    assert.ok(closes.includes('line too long'));
    c.sock.end();
    await c.closed;
  } finally { await srv.close(); fs.rmSync(ud, { recursive: true, force: true }); }
});

test('server: a client that stops reading is closed before main holds more than the outbound cap (Codex impl r4)', async () => {
  const ud = tmp();
  const runDir = ensureRunDir(ud);
  const closes = [];
  let peak = 0;
  const srv = await startPhoneSocket(runDir, {
    handler: (conn) => {
      conn.authed = true;
      conn.send({ t: 'r', pad: 'x'.repeat(200000) });
      for (const c of srv.connections()) peak = Math.max(peak, c.id);
    },
    onClose: (conn, why) => closes.push(why),
  });
  try {
    const sock = net.connect(srv.path);
    await once(sock, 'connect');
    sock.pause(); // never reads a reply
    const closed = new Promise((r) => sock.on('close', r));
    for (let i = 0; i < 200 && !closes.length; i++) {
      sock.write('{"t":"hi"}\n');
      await new Promise((r) => setTimeout(r, 5));
    }
    sock.resume();
    await closed;
    assert.deepEqual(closes, ['not reading']);
    assert.equal(srv.connections().length, 0);
    assert.ok(MAX_OUTBOUND < 200 * 200000); // the loop would have queued far more than the cap
  } finally { await srv.close(); fs.rmSync(ud, { recursive: true, force: true }); }
});
