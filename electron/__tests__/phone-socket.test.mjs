import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  ensureRunDir, socketPath, writeTokenFile, takeTokenFile, dropTokenFile, lineReader, startPhoneSocket, MAX_LINE,
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
