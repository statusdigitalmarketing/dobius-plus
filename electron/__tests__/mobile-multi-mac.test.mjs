import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activePairing, emptyPairings, loadPairings, savePairings, upsertPairing, switchPairing, renamePairing, removePairing, pairingRequest, pairingKey, PAIRINGS_KEY } from '../../mobile/pairings.js';
import { HOST_KEY, TOKEN_KEY, normaliseHost, mixedContent, reachabilityMessage } from '../../mobile/host.js';
import { isAllowedMobileOrigin } from '../mobile-cors.js';
import { Connection } from '../../mobile/connection.js';

const a = { id: 'a', origin: 'https://a.tail.ts.net:8420', token: 'token-a', name: 'Work Mac', addedAt: 1, lastUsedAt: 1 };
const b = { id: 'b', origin: 'https://b.tail.ts.net:8420', token: 'token-b', name: 'Home Mac', addedAt: 2, lastUsedAt: 2 };
const initial = () => ({ version: 1, pairings: [{ ...a }, { ...b }], activeId: 'a' });
function memoryStorage(entries = []) {
  const values = new Map(entries);
  return { values, get: async (key) => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); } };
}

test('legacy migration writes one complete record and retains both legacy keys', async () => {
  const storage = memoryStorage([[HOST_KEY, 'HTTPS://WORK.TAIL.TS.NET:443/'], [TOKEN_KEY, 'original-token']]);
  const expected = { version: 1, activeId: 'legacy', pairings: [{ id: 'legacy', origin: 'https://work.tail.ts.net', token: 'original-token', name: 'work.tail.ts.net', addedAt: 100, lastUsedAt: 100 }] };
  assert.deepEqual(await loadPairings(storage, 'capacitor://localhost', 100), expected);
  assert.deepEqual(JSON.parse(storage.values.get(PAIRINGS_KEY)), expected);
  assert.equal(storage.values.get(HOST_KEY), 'HTTPS://WORK.TAIL.TS.NET:443/');
  assert.equal(storage.values.get(TOKEN_KEY), 'original-token');
  assert.deepEqual(await loadPairings(storage, 'capacitor://localhost', 200), expected);
});

test('an interrupted migration before commit retries without losing origin or token', async () => {
  const storage = memoryStorage([[HOST_KEY, a.origin], [TOKEN_KEY, a.token]]);
  const failing = { ...storage, set: async () => { throw new Error('interrupted'); } };
  await assert.rejects(loadPairings(failing, 'capacitor://localhost', 1), { message: 'interrupted' });
  assert.equal(storage.values.has(PAIRINGS_KEY), false);
  const state = await loadPairings(storage, 'capacitor://localhost', 2);
  assert.deepEqual(activePairing(state), { ...a, id: 'legacy', name: 'a.tail.ts.net', addedAt: 2, lastUsedAt: 2 });
});

test('an interrupted migration after commit reads the document and never resurrects legacy records', async () => {
  const storage = memoryStorage([[HOST_KEY, a.origin], [TOKEN_KEY, a.token]]);
  const interrupted = { ...storage, set: async (key, value) => { await storage.set(key, value); throw new Error('interrupted after write'); } };
  await assert.rejects(loadPairings(interrupted, 'capacitor://localhost', 1), { message: 'interrupted after write' });
  const state = await loadPairings(storage, 'capacitor://localhost', 2);
  assert.equal(activePairing(state).addedAt, 1);
  await savePairings(storage, removePairing(state, 'legacy'));
  assert.deepEqual(await loadPairings(storage, a.origin, 3), emptyPairings());
});

test('new store wins over partially remaining legacy keys, corrupt stores are not overwritten', async () => {
  const storage = memoryStorage([[PAIRINGS_KEY, JSON.stringify(initial())], [TOKEN_KEY, 'stale']]);
  assert.deepEqual(await loadPairings(storage, a.origin), initial());
  storage.values.set(PAIRINGS_KEY, '{');
  await assert.rejects(loadPairings(storage, a.origin), SyntaxError);
  assert.equal(storage.values.get(PAIRINGS_KEY), '{');
  storage.values.set(PAIRINGS_KEY, JSON.stringify({ ...initial(), activeId: 'missing' }));
  await assert.rejects(loadPairings(storage, a.origin), { message: 'Invalid active Mac' });
});

test('silent storage write failure is reported and leaves legacy pairing recoverable', async () => {
  const storage = memoryStorage([[HOST_KEY, a.origin], [TOKEN_KEY, a.token]]);
  await assert.rejects(loadPairings({ ...storage, set: async () => {} }, a.origin), { message: 'Could not save paired Macs' });
  assert.equal(activePairing(await loadPairings(storage, a.origin)).token, a.token);
});

test('hostless browser legacy pairing uses serving origin; native never invents a host', async () => {
  const web = memoryStorage([[TOKEN_KEY, a.token]]);
  assert.equal(activePairing(await loadPairings(web, a.origin)).origin, a.origin);
  const native = memoryStorage([[TOKEN_KEY, a.token]]);
  assert.deepEqual(await loadPairings(native, 'capacitor://localhost'), emptyPairings());
  assert.equal(native.values.get(TOKEN_KEY), a.token);
});

test('re-pair deduplicates normalized origins and retains identity and name', () => {
  const before = initial();
  const next = upsertPairing(before, { origin: 'HTTPS://A.TAIL.TS.NET:8420/path?x=1', token: 'new-a' }, { id: 'unused', now: 9 });
  assert.deepEqual(next, { version: 1, activeId: 'a', pairings: [{ ...a, token: 'new-a', lastUsedAt: 9 }, b] });
  assert.deepEqual(before, initial());
  const first = upsertPairing(emptyPairings(), { origin: 'https://a.ts.net:443', token: 'one' }, { id: 'first', now: 1 });
  assert.equal(upsertPairing(first, { origin: 'https://a.ts.net/', token: 'two' }, { id: 'second', now: 2 }).pairings.length, 1);
  assert.equal(normaliseHost('100.64.0.1'), 'http://100.64.0.1:8420');
  assert.equal(normaliseHost('100.64.0.1:80'), 'http://100.64.0.1');
  assert.equal(normaliseHost('https://user:pass@a.ts.net'), '');
  assert.equal(normaliseHost('ftp://a.ts.net'), '');
});

test('switch, rename and remove preserve complete records and select the most recently used survivor', () => {
  const switched = switchPairing(initial(), 'b', 10);
  assert.deepEqual(activePairing(switched), { ...b, lastUsedAt: 10 });
  assert.deepEqual(renamePairing(switched, 'a', '  Studio  ').pairings[0], { ...a, name: 'Studio' });
  assert.deepEqual(removePairing(initial(), 'b'), { version: 1, activeId: 'a', pairings: [a] });
  const three = upsertPairing(switched, { origin: 'http://100.64.1.3:8420', token: 'c' }, { id: 'c', now: 20 });
  assert.equal(removePairing(three, 'c').activeId, 'b');
  assert.deepEqual(removePairing(removePairing(initial(), 'a'), 'b'), emptyPairings());
  assert.throws(() => switchPairing(initial(), 'missing', 11), { message: 'Unknown Mac' });
  assert.equal(pairingKey(a, 'drafts'), 'drafts:a');
  assert.equal(pairingKey(b, 'drafts'), 'drafts:b');
});

test('REST binding captures a matching origin and token and rejects external destinations', () => {
  const original = activePairing(initial());
  const request = pairingRequest(original, '/upload?name=hello', { headers: { Authorization: 'Bearer wrong' }, credentials: 'include', redirect: 'follow' });
  const switched = switchPairing(initial(), 'b', 10);
  assert.equal(activePairing(switched).origin, b.origin);
  assert.equal(request.url, `${a.origin}/upload?name=hello`);
  assert.equal(request.options.headers.get('Authorization'), `Bearer ${a.token}`);
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
  assert.throws(() => pairingRequest(a, '//b.tail.ts.net/voice/audio'), { message: 'Expected a local request path' });
  assert.throws(() => pairingRequest(a, '/\\b.tail.ts.net/voice/audio'), { message: 'Request changed origin' });
});

test('close invalidates late socket frames, timers, queued commands and in-flight REST', async () => {
  const sockets = [];
  const oldWebSocket = globalThis.WebSocket;
  const oldFetch = globalThis.fetch;
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  };
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true }; };
  const source = { ...a };
  const first = new Connection(source);
  const second = new Connection(b);
  try {
    source.token = 'mutated';
    const messages = [];
    first.onMessage((msg) => messages.push(msg));
    first.connect();
    const oldSocket = sockets[0];
    const lateMessage = oldSocket.onmessage;
    const lateClose = oldSocket.onclose;
    oldSocket.onopen();
    assert.equal(oldSocket.url, 'wss://a.tail.ts.net:8420/ws');
    assert.deepEqual(oldSocket.sent, [{ type: 'auth', token: 'token-a' }]);
    first.send({ type: 'submitPrompt', id: 'same-tab', text: 'old command' });
    await first.request('/voice/audio', { method: 'POST' });
    first.close();
    second.connect();
    sockets[1].onopen();
    sockets[1].onmessage({ data: '{"type":"authed"}' });
    await second.request('/upload');
    lateMessage({ data: '{"type":"terminals","list":[{"id":"same-tab"}]}' });
    lateClose({ code: 1006 });
    first.wake(); first.connect(); first.send({ type: 'input', id: 'same-tab', data: 'bad' });
    assert.deepEqual(messages, []);
    assert.equal(first.ws, null);
    assert.equal(first.listeners.size, 0);
    assert.equal(first.statusListeners.size, 0);
    assert.deepEqual(first._queue, []);
    assert.equal(first._pingTimer, null);
    assert.equal(first._probeTimer, null);
    assert.equal(sockets.length, 2);
    assert.deepEqual(sockets[1].sent, [{ type: 'auth', token: 'token-b' }]);
    assert.equal(requests[0].url, `${a.origin}/voice/audio`);
    assert.equal(requests[0].options.headers.get('Authorization'), 'Bearer token-a');
    assert.equal(requests[0].options.signal.aborted, true);
    assert.equal(requests[1].url, `${b.origin}/upload`);
    assert.equal(requests[1].options.headers.get('Authorization'), 'Bearer token-b');
    assert.equal(requests[1].options.signal.aborted, false);
    await assert.rejects(first.request('/push/subscribe'), { message: 'Connection closed' });
  } finally { first.close(); second.close(); globalThis.WebSocket = oldWebSocket; globalThis.fetch = oldFetch; }
});

test('CORS accepts only supported native, localhost and Tailscale origins', () => {
  const allowed = ['capacitor://localhost', 'ionic://localhost', 'http://localhost', 'http://localhost:5173', 'https://localhost:8420', 'http://100.64.0.0:8420', 'https://100.127.255.255', 'https://mac.tail.ts.net:8420', 'http://mac.ts.net', 'http://[fd7a:115c:a1e0::1]:8420'];
  const denied = ['', null, 'null', 'https://100.63.255.255', 'http://100.128.0.0', 'http://192.168.1.1', 'http://100.64.0.256', 'http://localhost.evil.test', 'https://evilts.net', 'https://ts.net', 'https://a.ts.net.evil.test', 'https://a..ts.net', 'https://user@a.ts.net', 'https://localhost@evil.test', 'capacitor://localhost@evil.test', 'capacitor://a.ts.net', 'ionic://100.64.0.1', 'file://localhost', 'ftp://mac.ts.net', 'https://a.ts.net/path', 'https://a.ts.net/', 'https://a.ts.net?x=1', 'https://a.ts.net#x', 'http://[fd7a:115c:a1e1::1]', 'https://a.ts.net https://b.ts.net', 'http://localhost\\evil', 'https://a.ts.net\n'];
  for (const origin of allowed) assert.equal(isAllowedMobileOrigin(origin), true, origin);
  for (const origin of denied) assert.equal(isAllowedMobileOrigin(origin), false, String(origin));
});

test('transport diagnostics distinguish mixed content and describe possible older-Mac CORS rejection', () => {
  assert.equal(mixedContent('http://100.64.0.1:8420', a.origin), true);
  assert.equal(mixedContent(a.origin, b.origin), false);
  assert.equal(mixedContent('http://100.64.0.1:8420', 'capacitor://localhost'), false);
  assert.equal(reachabilityMessage(b.origin, a.origin), 'Could not reach this Mac. Check Tailscale and that the Mac is awake. If it is reachable directly, update Dobius+ on that Mac to allow connections from this app.');
});

test('voice cancellation works on iOS without AbortSignal.any and does not close the connection', async () => {
  const originalAny = AbortSignal.any;
  const originalFetch = globalThis.fetch;
  const requests = [];
  AbortSignal.any = undefined;
  globalThis.fetch = async (_url, options) => { requests.push(options); return { ok: true }; };
  const connection = new Connection(a);
  try {
    const voice = new AbortController();
    await connection.request('/voice/audio', { signal: voice.signal });
    await connection.request('/push/vapid');
    voice.abort();
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].signal.aborted, false);
    assert.equal(connection.closed, false);
    connection.close();
    assert.equal(requests[1].signal.aborted, true);
  } finally { connection.close(); AbortSignal.any = originalAny; globalThis.fetch = originalFetch; }
});

test('push keeps distinct VAPID subscriptions and binds registration requests to their Mac', async () => {
  const { enablePush, pushActive } = await import('../../mobile/push-client.js');
  const descriptors = Object.fromEntries(['window', 'navigator', 'Notification'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const regs = new Map();
  const requests = [];
  const subscriptions = [];
  let unsubscribed = 0;
  const root = 'https://app.tail.ts.net:8420/';
  const worker = {
    async getRegistration(scope) { return regs.get(scope); },
    async register(script, { scope }) {
      assert.equal(script, `${root}sw.js`);
      let sub = null;
      const reg = { scope, active: {}, pushManager: {
        async getSubscription() { return sub; },
        async subscribe({ applicationServerKey }) {
          sub = { options: { applicationServerKey }, toJSON: () => ({ endpoint: `https://push.example/${subscriptions.length}`, keys: {} }), unsubscribe: async () => { unsubscribed += 1; } };
          subscriptions.push(sub);
          return sub;
        },
      } };
      regs.set(scope, reg);
      return reg;
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { PushManager: {}, isSecureContext: true, location: { href: root, origin: root.slice(0, -1) } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: worker } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'granted' } });
  const makeConnection = (record, publicKey) => ({ pairing: record, origin: record.origin, closed: false, async request(path, options) {
    const req = pairingRequest(record, path, options);
    requests.push([req.url, req.options.headers.get('Authorization')]);
    return { ok: true, json: async () => path === '/push/vapid' ? { ok: true, publicKey } : { ok: true } };
  } });
  const first = makeConnection(a, 'AQID');
  const second = makeConnection(b, 'BAUG');
  try {
    assert.equal(await pushActive(first), false);
    assert.deepEqual(await enablePush(first), { ok: true });
    assert.deepEqual(await enablePush(second), { ok: true });
    assert.equal(await pushActive(first), true);
    assert.equal(await pushActive(second), true);
    assert.deepEqual(await enablePush(first), { ok: true });
    assert.equal(subscriptions.length, 2);
    assert.deepEqual([...regs.keys()], [`${root}__dobius_push__/a/`, `${root}__dobius_push__/b/`]);
    assert.deepEqual([...subscriptions[0].options.applicationServerKey], [1, 2, 3]);
    assert.deepEqual([...subscriptions[1].options.applicationServerKey], [4, 5, 6]);
    assert.equal(unsubscribed, 0);
    assert.deepEqual(requests, [
      [`${a.origin}/push/vapid`, 'Bearer token-a'], [`${a.origin}/push/subscribe`, 'Bearer token-a'],
      [`${b.origin}/push/vapid`, 'Bearer token-b'], [`${b.origin}/push/subscribe`, 'Bearer token-b'],
      [`${a.origin}/push/vapid`, 'Bearer token-a'], [`${a.origin}/push/subscribe`, 'Bearer token-a'],
    ]);
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('push taps carry the Mac identity on both warm and cold launches with colliding tab ids', async () => {
  const { readFile } = await import('node:fs/promises');
  const vm = await import('node:vm');
  const script = await readFile(new URL('../../mobile/public/sw.js', import.meta.url), 'utf8');
  const handlers = new Map();
  const shown = [];
  const messages = [];
  const opened = [];
  let clients = [{ url: 'https://app.tail.ts.net/', postMessage: (msg) => messages.push(msg), focus: async () => {} }];
  const self = {
    location: { href: 'https://app.tail.ts.net/sw.js', origin: 'https://app.tail.ts.net' },
    registration: { scope: 'https://app.tail.ts.net/__dobius_push__/b/', showNotification: async (title, options) => shown.push({ title, options }) },
    addEventListener: (event, handler) => handlers.set(event, handler),
    clients: { matchAll: async () => clients, openWindow: async (url) => opened.push(url) },
  };
  vm.runInNewContext(script, { self, URL, decodeURIComponent });
  let pending;
  handlers.get('push')({ data: { json: () => ({ title: 'Home Mac', url: './?open=same-tab', tag: 'same-tab' }) }, waitUntil: (p) => { pending = p; } });
  await pending;
  assert.equal(shown[0].options.data.url, 'https://app.tail.ts.net/?open=same-tab&mac=b');
  assert.equal(shown[0].options.tag, 'b:same-tab');
  const click = () => handlers.get('notificationclick')({ notification: { data: shown[0].options.data, close() {} }, waitUntil: (p) => { pending = p; } });
  click(); await pending;
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'open-session', id: 'same-tab', pairingId: 'b', origin: 'https://app.tail.ts.net' }]);
  clients = [];
  click(); await pending;
  assert.deepEqual(opened, ['https://app.tail.ts.net/?open=same-tab&mac=b']);
});
