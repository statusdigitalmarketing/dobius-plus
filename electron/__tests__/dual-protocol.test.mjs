// One port, both protocols: plain HTTP and HTTPS (and WebSockets over each)
// reach the right server, and close() frees the port for a restart.
// Run: node ./electron/__tests__/dual-protocol.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { dualProtocolServer, attachWebSocketServer, listenSettled } from '../mobile-autostart.js';

let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };

// A throwaway self-signed cert, made here so no key is ever committed.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
const tlsOpts = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };

// /hang never answers: a request held in flight, like /voice/reply's 60s wait.
const app = (label) => (req, res) => { if (req.url !== '/hang') res.end(`${label} ${req.url}`); };
// Trust exactly the throwaway cert (the chain is verified); only the
// hostname check is skipped, since it is issued to localhost, not 127.0.0.1.
const trust = { ca: tlsOpts.cert, checkServerIdentity: () => undefined };
const get = (mod, url) => new Promise((resolve, reject) => {
  mod.get(url, { ...trust, agent: false }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(body));
  }).on('error', reject);
});
const wsOpen = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, trust);
  ws.on('open', () => { ws.close(); resolve(true); });
  ws.on('error', reject);
});

const start = async (port = 0) => {
  const front = dualProtocolServer(http.createServer(app('plain')), https.createServer(tlsOpts, app('secure')));
  const wss = attachWebSocketServer(front, { path: '/ws' });
  const r = await listenSettled(front, port, '127.0.0.1');
  assert.equal(r.ok, true, r.error);
  return { front, wss, port: front.address().port };
};

const { front, wss, port } = await start();
assert.equal(await get(http, `http://127.0.0.1:${port}/a`), 'plain /a'); ok('plain HTTP reaches the HTTP side');
assert.equal(await get(https, `https://127.0.0.1:${port}/b`), 'secure /b'); ok('HTTPS reaches the HTTPS side on the same port');

const seen = [];
wss.on('connection', (_ws, req) => seen.push(req.socket.encrypted ? 'wss' : 'ws'));
assert.equal(await wsOpen(`ws://127.0.0.1:${port}/ws`), true);
assert.equal(await wsOpen(`wss://127.0.0.1:${port}/ws`), true);
await new Promise((r) => setTimeout(r, 50));
assert.deepEqual(seen.sort(), ['ws', 'wss']); ok('WebSockets over both protocols land in ONE server');
await assert.rejects(wsOpen(`ws://127.0.0.1:${port}/elsewhere`)); ok('an upgrade on another path is refused');

// A connection with a request still in flight is ended by close(): a stop or
// a device removal must not leave a paired phone a live connection (Codex P1).
const held = net.connect(port, '127.0.0.1');
held.on('error', () => {});
await new Promise((r) => held.once('connect', r));
held.write('GET /hang HTTP/1.1\r\nHost: x\r\n\r\n');
await new Promise((r) => setTimeout(r, 150));
const heldClosed = new Promise((r) => held.once('close', () => r(true)));
// Bounded: a close() that waits on a live connection would hang the test.
await Promise.race([new Promise((r) => front.close(r)), new Promise((r) => setTimeout(r, 2000))]);
assert.equal(await Promise.race([heldClosed, new Promise((r) => setTimeout(() => r(false), 2000))]), true);
ok('close() ends a connection with a request in flight');
const again = await start(port);
assert.equal(again.port, port); ok('close() frees the port for an immediate restart');
await new Promise((r) => again.front.close(r));

// A client that sends one byte and stalls is dropped by the server's
// inactivity timeout, which applies to sockets handed over by the front.
// (mobile-server.js sets 120s; Node's header deadline alone does not end it.)
{
  const plain = http.createServer(app('plain')); plain.timeout = 300;
  const secure = https.createServer(tlsOpts, app('secure')); secure.timeout = 300;
  const f = dualProtocolServer(plain, secure);
  const r = await listenSettled(f, 0, '127.0.0.1');
  assert.equal(r.ok, true, r.error);
  const slow = net.connect(f.address().port, '127.0.0.1');
  slow.on('error', () => {});
  await new Promise((res) => slow.once('connect', res));
  slow.write('G');
  const dropped = new Promise((res) => slow.once('close', () => res(true)));
  assert.equal(await Promise.race([dropped, new Promise((res) => setTimeout(() => res(false), 3000))]), true);
  ok('a one-byte stalled connection is dropped by the inactivity timeout');
  await new Promise((res) => f.close(res));
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`dual-protocol: ${pass} pass`);
