// Phone Settings on the Mac side: the new settings keys, the new WebSocket messages (a revoked phone refused), the
// accounts list (arrays only, never id-keyed), and the fan-out to Web Push and APNs. Run: npm run test:phonesettings
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSettingWrite, handleTodayMessage, setTodayBridge, TODAY_FEATURES } from '../mobile-today.js';
import { shapePhoneAccounts, usageForPhone } from '../phone-accounts.js';
import { createPhonePush, REF_CAP } from '../phone-push.js';
import { ALERT_DEFAULTS } from '../phone-notifier.js';

const TOKEN = 'ab'.repeat(32);
const flush = () => new Promise((r) => setTimeout(r, 0));

test('features advertised for the new phone groups', () => {
  for (const f of ['alerts', 'accounts', 'chatDefaults', 'apns']) assert.ok(TODAY_FEATURES.includes(f), f);
});

test('settings writes: chat defaults only from the launch allowlist, alerts only the known switches as booleans', () => {
  assert.deepEqual(checkSettingWrite('newTabModel', 'opus'), { ok: true, apply: { settings: { newTabModel: 'opus' } } });
  assert.deepEqual(checkSettingWrite('newTabModel', ''), { ok: true, apply: { settings: { newTabModel: '' } } });
  for (const bad of ['opus --dangerously-skip-permissions', 'gpt', null, 3, '__proto__']) assert.equal(checkSettingWrite('newTabModel', bad).ok, false, String(bad));
  assert.equal(checkSettingWrite('newTabPermissionMode', 'plan').ok, true);
  for (const bad of ['bypassPermissions', 'dontAsk', 'default; rm -rf ~']) assert.equal(checkSettingWrite('newTabPermissionMode', bad).ok, false, bad);
  const r = checkSettingWrite('phoneAlerts', { done: false }, {}, { team: false });
  assert.deepEqual(r.apply.settings.phoneAlerts, { ...ALERT_DEFAULTS, done: false, team: false });
  assert.equal(checkSettingWrite('phoneAlerts', { done: 'no' }).ok, false);
  assert.equal(checkSettingWrite('phoneAlerts', { pairing: true }).ok, false);
  assert.equal(checkSettingWrite('phoneAlerts', JSON.parse('{"__proto__":{"needs":false}}')).ok, false);
  assert.equal(checkSettingWrite('phoneAlerts', [true]).ok, false);
  assert.equal(checkSettingWrite('mobileServer', { enabled: false }).error, 'not-allowed');
});

function bridgeRig() {
  const calls = [];
  setTodayBridge({
    readSettings: (ctx) => { calls.push(['readSettings', ctx]); return { ok: 1 }; },
    readAccounts: () => { calls.push(['readAccounts']); return { claude: [], codex: [] }; },
    activateAccount: (id, stillOk) => { calls.push(['activate', id]); return stillOk() ? { ok: true } : { ok: false, error: 'unavailable' }; },
    registerApns: (reg, stillOk) => { calls.push(['register', reg]); return stillOk() ? { ok: true } : { ok: false, error: 'unavailable' }; },
    unregisterApns: (t) => { calls.push(['unregister', t]); },
    resolveNotifyRef: (ref) => (ref === 'f'.repeat(32) ? 'term-/p-1' : null),
  });
  return calls;
}

test('new messages: a revoked phone is refused before anything runs; an APNs token is bound to the socket pairing', async () => {
  const calls = bridgeRig();
  const out = [];
  const send = (m) => out.push(m);
  for (const type of ['accountsRead', 'accountActivate', 'apnsRegister', 'apnsUnregister', 'notifyResolve']) {
    assert.equal(handleTodayMessage({ type, reqId: 'r', id: 'x', token: TOKEN, ref: 'f'.repeat(32) }, send, () => false, { token: 'pair' }), true);
  }
  await flush();
  assert.equal(calls.length, 0, 'nothing reached the bridge for a revoked phone');
  assert.ok(out.every((m) => m.ok === false && m.error === 'unavailable'));
  out.length = 0;
  handleTodayMessage({ type: 'apnsRegister', reqId: 'a', token: TOKEN, pairingId: 'pid-1', pairToken: 'someone-else' }, send, () => true, { token: 'pair-A' });
  handleTodayMessage({ type: 'apnsRegister', reqId: 'b', token: 'NOT HEX' }, send, () => true, { token: 'pair-A' });
  handleTodayMessage({ type: 'apnsRegister', reqId: 'c', token: TOKEN }, send, () => true, {});
  handleTodayMessage({ type: 'notifyResolve', reqId: 'd', ref: 'f'.repeat(32) }, send, () => true, { token: 'pair-A' });
  handleTodayMessage({ type: 'notifyResolve', reqId: 'e', ref: '../etc' }, send, () => true, { token: 'pair-A' });
  handleTodayMessage({ type: 'accountActivate', reqId: 'f', id: { toString: () => 'x' } }, send, () => true, { token: 'pair-A' });
  handleTodayMessage({ type: 'accountActivate', reqId: 'g', id: null }, send, () => true, { token: 'pair-A' });
  await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'register')[1], { deviceToken: TOKEN, pairToken: 'pair-A', pairingId: 'pid-1' }, 'the pairing comes from the socket, never the message');
  assert.equal(calls.filter((c) => c[0] === 'register').length, 1);
  const by = Object.fromEntries(out.map((m) => [m.reqId, m]));
  assert.equal(by.a.ok, true);
  assert.equal(by.b.error, 'bad-request');
  assert.equal(by.c.error, 'bad-request', 'no socket pairing, no registration');
  assert.equal(by.d.id, 'term-/p-1');
  assert.equal(by.e.id, null);
  assert.equal(by.f.error, 'bad-request');
  assert.equal(by.g.ok, true);
  assert.deepEqual(calls.find((c) => c[0] === 'activate'), ['activate', null]);
  // settingsRead hands the socket's pairing token to the bridge (to say whether THIS phone is set up).
  handleTodayMessage({ type: 'settingsRead', reqId: 's' }, send, () => true, { token: 'pair-A' });
  await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'readSettings')[1], { token: 'pair-A' });
  // The unpair check inside the write: a phone revoked between dispatch and the write is refused there too.
  let alive = true;
  out.length = 0;
  handleTodayMessage({ type: 'apnsRegister', reqId: 'h', token: TOKEN }, send, () => { const was = alive; alive = false; return was; }, { token: 'pair-B' });
  await flush();
  assert.equal(out[0].ok, false);
});

test('accounts list: arrays only, a __proto__ account id is a plain value, the active row marked, windows as an array', () => {
  const usage = {
    ok: true,
    scanFailed: false,
    accounts: [
      { id: null, isDefault: true, label: 'Default', email: 'me@x.com', login: 'in', usage: { known: true, headroom: 40, windows: { five_hour: { used: 60, resetsAt: 10, ageMs: 5 }, 'Weird Name': { used: 1 } } }, stale: false, sessionsRunning: 2 },
      { id: '__proto__', label: 'Proto', email: 'p@x.com', login: 'in', usage: null },
      { id: '__default__', label: 'Sneaky', login: 'bogus' },
    ],
  };
  const out = shapePhoneAccounts({ usage, accounts: [{ id: 'cx', type: 'codex', name: 'Codex One' }], activeClaude: '__proto__', activeCodex: 'cx', codexIds: { default: { email: 'd@x.com', login: 'in' }, accounts: [{ id: 'cx', email: 'c@x.com', plan: 'pro', login: 'in' }] } });
  assert.ok(Array.isArray(out.claude) && Array.isArray(out.codex));
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(out.claude.map((r) => [r.id, r.active]), [[null, false], ['__proto__', true], ['__default__', false]]);
  assert.equal(out.claude[2].login, 'unknown');
  assert.deepEqual(out.claude[0].usage.windows, [{ name: 'five_hour', used: 60, resetsAt: 10, ageMs: 5 }]);
  assert.deepEqual(out.codex.map((r) => [r.id, r.label, r.active]), [[null, 'Default', false], ['cx', 'Codex One', true]]);
  // No usage service: the config list, the default row active when nothing is chosen.
  const bare = shapePhoneAccounts({ usage: null, accounts: [{ id: 'a1', type: 'claude', name: 'Work' }] });
  assert.deepEqual(bare.claude.map((r) => [r.id, r.label, r.active]), [[null, 'Default', true], ['a1', 'Work', false]]);
  // Round 1: ids are never shortened; one too long to send back is shown but cannot be chosen.
  const long = 'a'.repeat(200);
  const twoLong = shapePhoneAccounts({ usage: null, accounts: [{ id: long, type: 'claude', name: 'L1' }, { id: `${long}b`, type: 'claude', name: 'L2' }] });
  assert.deepEqual(twoLong.claude.map((r) => [r.id === long, r.id, r.selectable]).slice(1), [[true, long, true], [false, null, false]]);
  assert.deepEqual(usageForPhone('junk'), { known: false, headroom: null, limited: false, ageMs: null, windows: [] });
});

function pushRig({ web = true, devices = [{ token: TOKEN, env: 'auto', pairingId: 'p', addedAt: 7 }], results } = {}) {
  const webSent = [];
  const apnsSent = [];
  const dropped = [];
  const envs = [];
  const p = createPhonePush({
    webPush: (x) => { webSent.push(x); return Promise.resolve(); },
    hasWebPush: () => web,
    apns: { status: () => ({ ready: true }), send: async (list, n) => { apnsSent.push({ list, n }); return results || list.map((d) => ({ token: d.token, outcome: 'sent', env: 'production' })); } },
    tokens: { list: () => devices, drop: (t, at) => dropped.push([t, at]), setEnv: (t, env, at) => envs.push([t, env, at]) },
  });
  return { p, webSent, apnsSent, dropped, envs };
}

test('fan-out: Web Push keeps its link; APNs gets an opaque ref, never the tab id; the ref resolves on the Mac only', async () => {
  const r = pushRig();
  await r.p.send({ kind: 'needs', title: 'proj', body: 'Tab 1 needs you', tag: 'tx', tabId: 'term-/Users/sam/secret-1' });
  assert.equal(r.webSent[0].url, './?open=term-%2FUsers%2Fsam%2Fsecret-1');
  const n = r.apnsSent[0].n;
  assert.doesNotMatch(JSON.stringify(n), /secret|Users/);
  assert.match(n.ref, /^[0-9a-f]{32}$/);
  assert.equal(r.p.resolve(n.ref), 'term-/Users/sam/secret-1');
  assert.equal(r.p.resolve('0'.repeat(32)), null);
  assert.equal(r.p.resolve({}), null);
  assert.deepEqual(r.envs, [[TOKEN, 'production', 7]], 'the host Apple took it on is remembered for that registration');
  // Bounded: the oldest refs go first.
  for (let i = 0; i < REF_CAP + 5; i += 1) await r.p.send({ kind: 'done', title: 'a', body: 'b', tag: 't', tabId: `t${i}` });
  assert.equal(r.p.resolve(n.ref), null);
});

test('round 2: the sender asks whether the news is still true and whether the device is still registered, per device', async () => {
  let checks = [];
  let current = true;
  const p = createPhonePush({
    webPush: () => Promise.resolve(),
    hasWebPush: () => false,
    apns: { status: () => ({ ready: true }), send: async (list, n, stillValid) => { for (const d of list) { checks.push(stillValid(d)); current = false; } return []; } },
    tokens: { list: () => [{ token: TOKEN, addedAt: 1 }, { token: 'cd'.repeat(32), addedAt: 2 }], drop: () => {}, setEnv: () => {} },
  });
  await p.send({ kind: 'needs', title: 'a', body: 'b', tag: 't', tabId: 'x', current: () => current });
  assert.deepEqual(checks, [true, false], 'answered after the first phone: the second is not sent');
  checks = [];
  current = true;
  const gone = createPhonePush({
    webPush: () => Promise.resolve(), hasWebPush: () => false,
    apns: { status: () => ({ ready: true }), send: async (list, n, stillValid) => { checks = list.map((d) => stillValid(d)); return []; } },
    tokens: { list: () => [], drop: () => {}, setEnv: () => {} },
  });
  await gone.send({ kind: 'done', title: 'a', body: 'b', tag: 't', tabId: null });
  assert.deepEqual(checks, [], 'no devices, nothing asked');
});

test('fan-out: a dead APNs token is dropped for the registration that was used; nothing to send to sends nothing', async () => {
  const r = pushRig({ results: [{ token: TOKEN, outcome: 'drop', reason: 'Unregistered' }] });
  await r.p.send({ kind: 'done', title: 'a', body: 'b', tag: 't', tabId: null });
  assert.deepEqual(r.dropped, [[TOKEN, 7]]);
  const none = pushRig({ web: false, devices: [] });
  await none.p.send({ kind: 'done', title: 'a', body: 'b', tag: 't', tabId: 'x' });
  assert.equal(none.webSent.length + none.apnsSent.length, 0);
  assert.deepEqual(none.p.channels(), { webPush: false, apnsReady: true, apnsReason: null, apnsDevices: 0 });
});
