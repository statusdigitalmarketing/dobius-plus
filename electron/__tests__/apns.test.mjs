// Native push (APNs): the key folder, the ES256 provider token, the request, and what Apple's answers do to a device
// token. Every send goes to a local HTTP/2 stand-in; nothing here ever reaches Apple. Run: npm run test:apns
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import {
  readApnsKey, makeJwt, buildRequest, apnsPayload, outcomeFor, createApnsSender, isDeviceToken,
  APNS_ORIGINS, DEFAULT_TEAM_ID, DEFAULT_BUNDLE_ID,
} from '../apns.js';

const TOKEN = 'ab'.repeat(32);
const TOKEN2 = 'cd'.repeat(32);

function keyDir({ name = 'AuthKey_ABCDE12345.p8', mode = 0o600, config } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-apns-'));
  fs.chmodSync(dir, 0o700);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(path.join(dir, name), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode });
  fs.chmodSync(path.join(dir, name), mode);
  if (config) fs.writeFileSync(path.join(dir, 'apns.json'), JSON.stringify(config), { mode: 0o600 });
  return { dir, publicKey };
}

const b64urlJson = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('the key folder: Apple file name gives the Key ID, defaults for team and bundle, loose modes tightened', () => {
  const { dir } = keyDir({ mode: 0o644 });
  try {
    const k = readApnsKey(dir);
    assert.equal(k.ok, true);
    assert.equal(k.keyId, 'ABCDE12345');
    assert.equal(k.teamId, DEFAULT_TEAM_ID);
    assert.equal(k.bundleId, DEFAULT_BUNDLE_ID);
    assert.equal(fs.statSync(path.join(dir, 'AuthKey_ABCDE12345.p8')).mode & 0o777, 0o600, 'tightened to 0600');
    assert.equal(JSON.stringify(k).includes('PRIVATE KEY'), false, 'the result never carries the PEM text');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the key folder: missing, two keys, a symlink, a bad key or bad ids are fixed reason codes', () => {
  assert.deepEqual(readApnsKey(path.join(os.tmpdir(), 'dobius-apns-none-xyz')), { ok: false, reason: 'no-key' });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-apns-'));
  try { assert.equal(readApnsKey(empty).reason, 'no-key'); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  const two = keyDir();
  fs.writeFileSync(path.join(two.dir, 'AuthKey_ZZZZZ99999.p8'), 'x', { mode: 0o600 });
  try { assert.equal(readApnsKey(two.dir).reason, 'several-keys'); } finally { fs.rmSync(two.dir, { recursive: true, force: true }); }
  const link = keyDir();
  const real = path.join(link.dir, 'AuthKey_ABCDE12345.p8');
  fs.renameSync(real, path.join(link.dir, 'elsewhere.pem'));
  fs.symlinkSync(path.join(link.dir, 'elsewhere.pem'), real);
  try { assert.equal(readApnsKey(link.dir).reason, 'unsafe-file'); } finally { fs.rmSync(link.dir, { recursive: true, force: true }); }
  const bad = keyDir();
  fs.writeFileSync(path.join(bad.dir, 'AuthKey_ABCDE12345.p8'), '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n', { mode: 0o600 });
  try { assert.equal(readApnsKey(bad.dir).reason, 'bad-key'); } finally { fs.rmSync(bad.dir, { recursive: true, force: true }); }
  const rsa = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-apns-'));
  fs.chmodSync(rsa, 0o700);
  fs.writeFileSync(path.join(rsa, 'AuthKey_ABCDE12345.p8'), crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  try { assert.equal(readApnsKey(rsa).reason, 'bad-key', 'only an EC P-256 key'); } finally { fs.rmSync(rsa, { recursive: true, force: true }); }
  for (const config of [{ teamId: 'short' }, { keyId: 'OTHERKEY99' }, { bundleId: 'no spaces allowed' }, ['array']]) {
    const c = keyDir({ config });
    try { assert.equal(readApnsKey(c.dir).reason, 'bad-config', JSON.stringify(config)); } finally { fs.rmSync(c.dir, { recursive: true, force: true }); }
  }
  const ok = keyDir({ config: { teamId: 'TEAM123456', bundleId: 'com.example.app' } });
  try { const k = readApnsKey(ok.dir); assert.equal(k.teamId, 'TEAM123456'); assert.equal(k.bundleId, 'com.example.app'); } finally { fs.rmSync(ok.dir, { recursive: true, force: true }); }
});

test('the provider token is ES256 with kid and iss/iat, and verifies with the public key', () => {
  const { dir, publicKey } = keyDir();
  try {
    const k = readApnsKey(dir);
    const jwt = makeJwt(k, 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    assert.deepEqual(b64urlJson(h), { alg: 'ES256', kid: 'ABCDE12345' });
    assert.deepEqual(b64urlJson(c), { iss: DEFAULT_TEAM_ID, iat: 1_700_000_000 });
    const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    assert.equal(sig.length, 64, 'raw r||s, not DER');
    assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('request and payload: the right headers, an opaque collapse id, and nothing but title, body, kind, mac and ref', () => {
  const payload = apnsPayload({ title: 'webapp', body: 'Tab 2 needs you', kind: 'needs', mac: 'pair-1', ref: 'a'.repeat(32), extra: 'terminal text', tabId: 'term-/Users/x/secret-1' });
  assert.deepEqual(payload, { aps: { alert: { title: 'webapp', body: 'Tab 2 needs you' }, sound: 'default', 'thread-id': 'needs' }, mac: 'pair-1', ref: 'a'.repeat(32) });
  assert.equal(apnsPayload({ title: 'x', ref: 'not-a-ref', mac: 'bad mac!' }).ref, undefined);
  assert.equal(apnsPayload({ title: 'x\u2028y\x1b' }).aps.alert.title, 'x y');
  assert.equal(apnsPayload({ kind: 'today' }).view, 'tasks');
  const req = buildRequest({ token: TOKEN, bundleId: 'com.x.y', jwt: 'J', payload, tag: `t${'0'.repeat(80)}`, nowSeconds: 100 });
  assert.equal(req.headers[':path'], `/3/device/${TOKEN}`);
  assert.equal(req.headers.authorization, 'bearer J');
  assert.equal(req.headers['apns-topic'], 'com.x.y');
  assert.equal(req.headers['apns-push-type'], 'alert');
  assert.equal(req.headers['apns-expiration'], '700');
  assert.ok(Buffer.byteLength(req.headers['apns-collapse-id']) <= 64);
  assert.deepEqual(JSON.parse(req.body), payload);
  assert.equal(isDeviceToken(TOKEN), true);
  assert.equal(isDeviceToken('AB'.repeat(32)), false);
  assert.equal(isDeviceToken('ab'), false);
});

test('outcomes: 410 and Unregistered drop, BadDeviceToken tries the other host only while the host is unknown', () => {
  assert.equal(outcomeFor(200, '', { envKnown: false }), 'sent');
  assert.equal(outcomeFor(410, 'Unregistered', { envKnown: true }), 'drop');
  assert.equal(outcomeFor(400, 'BadDeviceToken', { envKnown: false }), 'other-host');
  assert.equal(outcomeFor(400, 'BadDeviceToken', { envKnown: true }), 'drop');
  assert.equal(outcomeFor(403, 'ExpiredProviderToken', { envKnown: true }), 'retry-auth');
  assert.equal(outcomeFor(400, 'DeviceTokenNotForTopic', { envKnown: true }), 'failed', 'a config problem never drops the token');
  assert.equal(outcomeFor(429, 'TooManyRequests', { envKnown: true }), 'failed');
});

// Two local h2c stand-ins, one per Apple host. `answer(req)` decides each reply.
async function standIns(answer) {
  const seen = [];
  const servers = {};
  for (const env of ['production', 'sandbox']) {
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (c) => { body += c; });
      stream.on('end', () => {
        const req = { env, headers, body: body ? JSON.parse(body) : null };
        seen.push(req);
        const { status, reason } = answer(req, seen);
        stream.respond({ ':status': status, 'content-type': 'application/json' });
        stream.end(reason ? JSON.stringify({ reason }) : '');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers[env] = server;
  }
  const origins = [];
  const connect = (origin) => {
    origins.push(origin);
    const env = origin === APNS_ORIGINS.production ? 'production' : origin === APNS_ORIGINS.sandbox ? 'sandbox' : null;
    if (!env) throw new Error(`unexpected origin ${origin}`);
    return http2.connect(`http://127.0.0.1:${servers[env].address().port}`);
  };
  const close = () => Promise.all(Object.values(servers).map((s) => new Promise((r) => s.close(r))));
  return { seen, origins, connect, close };
}

test('send: one request per device to the stand-in, a sandbox-only token found and remembered, dead tokens dropped', async () => {
  const { dir, publicKey } = keyDir();
  const net = await standIns((req) => {
    const token = req.headers[':path'].split('/').pop();
    if (token === TOKEN2) return { status: 410, reason: 'Unregistered' };
    if (req.env === 'production') return { status: 400, reason: 'BadDeviceToken' }; // a development build's token
    return { status: 200 };
  });
  const sender = createApnsSender({ dir, connect: net.connect, idleMs: 200 });
  try {
    assert.deepEqual(sender.status(), { ready: true });
    const results = await sender.send([{ token: TOKEN, env: 'auto', pairingId: 'p1' }, { token: TOKEN2, env: 'production', pairingId: 'p2' }, { token: 'junk' }], { title: 'proj', body: 'Tab 1 finished', kind: 'done', tag: 'tabc', ref: 'f'.repeat(32) });
    assert.deepEqual(results.map((r) => [r.token, r.outcome, r.env]), [[TOKEN, 'sent', 'sandbox'], [TOKEN2, 'drop', 'production']]);
    assert.equal(net.seen.length, 3, 'auto: production first, then sandbox; the junk token never sent');
    const first = net.seen[0];
    assert.equal(first.headers['apns-topic'], DEFAULT_BUNDLE_ID);
    const jwt = first.headers.authorization.replace(/^bearer /, '');
    const [h, c, s] = jwt.split('.');
    assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')), true);
    assert.deepEqual(first.body, { aps: { alert: { title: 'proj', body: 'Tab 1 finished' }, sound: 'default', 'thread-id': 'done' }, mac: 'p1', ref: 'f'.repeat(32) });
    // A known sandbox token goes straight to the sandbox host.
    net.seen.length = 0;
    await sender.send([{ token: TOKEN, env: 'sandbox' }], { title: 'a', body: 'b' });
    assert.deepEqual(net.seen.map((r) => r.env), ['sandbox']);
    assert.ok(net.origins.every((o) => o === APNS_ORIGINS.production || o === APNS_ORIGINS.sandbox), 'only the two Apple hosts are ever named');
  } finally { sender.close(); await net.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('send: a refused provider token is made again once, then the send fails without dropping the device', async () => {
  const { dir } = keyDir();
  const net = await standIns(() => ({ status: 403, reason: 'ExpiredProviderToken' }));
  const sender = createApnsSender({ dir, connect: net.connect, idleMs: 200 });
  try {
    const [r] = await sender.send([{ token: TOKEN, env: 'production' }], { title: 'a', body: 'b' });
    assert.equal(r.outcome, 'failed');
    assert.equal(net.seen.length, 2, 'one retry with a fresh token');
  } finally { sender.close(); await net.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inert without a key: status says why and nothing connects', async () => {
  let connects = 0;
  const sender = createApnsSender({ dir: path.join(os.tmpdir(), 'dobius-apns-missing-abc'), connect: () => { connects += 1; throw new Error('no'); } });
  assert.deepEqual(sender.status(), { ready: false, reason: 'no-key' });
  assert.deepEqual(await sender.send([{ token: TOKEN, env: 'auto' }], { title: 'a', body: 'b' }), []);
  assert.equal(connects, 0);
  const none = createApnsSender({ dir: null });
  assert.equal(none.status().ready, false);
});

test('a stand-in that never answers times out as failed, keeping the device', async () => {
  const { dir } = keyDir();
  const server = http2.createServer();
  server.on('stream', () => { /* never answers */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sender = createApnsSender({ dir, connect: () => http2.connect(`http://127.0.0.1:${server.address().port}`), timeoutMs: 200, idleMs: 200 });
  try {
    const [r] = await sender.send([{ token: TOKEN, env: 'production' }], { title: 'a', body: 'b' });
    assert.equal(r.outcome, 'failed');
    assert.equal(r.reason, 'timeout');
  } finally { sender.close(); await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
