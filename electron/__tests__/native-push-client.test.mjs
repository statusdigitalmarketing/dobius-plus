// The App Store app's registration message (mobile/native-push.js): what the Mac receives, with the token's sequence
// number from the phone's counter. Run: npm run test:nativepush
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.window = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) } };
const { _sendRegisterForTest: sendRegister } = await import('../../mobile/native-push.js');

function fakeConnection() {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    status: 'authed',
    features: ['apns'],
    pairing: { id: 'pid-1' },
    onMessage: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    send: (m) => { sent.push(m); queueMicrotask(() => { for (const fn of [...listeners]) fn({ type: 'apnsResult', reqId: m.reqId, ok: true }); }); },
  };
}

test('a registration reaches the Mac with the token and its sequence number; a new token gets the next number', async () => {
  const c = fakeConnection();
  const a = 'ab'.repeat(32);
  const b = 'cd'.repeat(32);
  assert.deepEqual(await sendRegister(c, a), { ok: true });
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].type, 'apnsRegister');
  assert.equal(c.sent[0].token, a);
  assert.equal(c.sent[0].seq, 1);
  await sendRegister(c, b);
  assert.equal(c.sent[1].seq, 2);
  await sendRegister(c, a);
  assert.equal(c.sent[2].seq, 1, 'the same token keeps its number');
});

test('a token the Mac calls stale while it is our newest is numbered past the Mac and sent once more', async () => {
  const sent = [];
  const listeners = new Set();
  let first = true;
  const c = {
    status: 'authed', features: ['apns'], pairing: { id: 'pid-2' },
    onMessage: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    send: (m) => {
      sent.push(m);
      const reply = first ? { type: 'apnsResult', reqId: m.reqId, ok: false, error: 'stale', haveSeq: 40 } : { type: 'apnsResult', reqId: m.reqId, ok: true };
      first = false;
      queueMicrotask(() => { for (const fn of [...listeners]) fn(reply); });
    },
  };
  const t = 'ef'.repeat(32);
  assert.deepEqual(await sendRegister(c, t), { ok: true });
  assert.equal(sent.length, 2);
  assert.ok(sent[1].seq > 40, `numbered past the Mac's 40: ${sent[1].seq}`);
});
