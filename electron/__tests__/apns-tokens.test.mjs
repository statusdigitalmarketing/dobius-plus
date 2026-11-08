// APNs device tokens in config: one per pairing, never taken over by another live pairing, removed with the pairing,
// and a late answer for an older registration never removes a newer one. Run: npm run test:apnstokens
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-apnstok-'));
process.env.DOBIUS_TEST_USERDATA = dir;
const cm = await import('../config-manager.js');
const T = 'ab'.repeat(32);
const T2 = 'cd'.repeat(32);

test('registration: one token per pairing; another live pairing cannot take a token; removal follows the pairing', () => {
  try {
    assert.equal(cm.addApnsToken({ token: 'NOTHEX', pairToken: 'A' }), null);
    const a = cm.addApnsToken({ token: T, pairToken: 'A', pairingId: 'pid-a' });
    assert.equal(a.env, 'auto');
    assert.deepEqual(cm.addApnsToken({ token: T, pairToken: 'B', pairingId: 'pid-b' }, () => false), { taken: true });
    assert.deepEqual(cm.getApnsTokens().map((t) => t.pairToken), ['A']);
    // The same pairing re-registering a new token replaces its old one.
    cm.addApnsToken({ token: T2, pairToken: 'A', pairingId: 'pid-a' });
    assert.deepEqual(cm.getApnsTokens().map((t) => t.token), [T2]);
    // Allowed move (the old pairing is gone): the host Apple took it on is kept.
    cm.setApnsTokenEnv(T2, 'sandbox');
    cm.addApnsToken({ token: T2, pairToken: 'C', pairingId: 'pid-c' }, () => true);
    const moved = cm.getApnsTokens();
    assert.deepEqual(moved.map((t) => [t.pairToken, t.env]), [['C', 'sandbox']]);
    // A late drop for an older registration leaves the newer one.
    cm.removeApnsToken(T2, moved[0].addedAt - 1);
    assert.equal(cm.getApnsTokens().length, 1);
    cm.removeApnsTokensByPairToken('C');
    assert.equal(cm.getApnsTokens().length, 0);
    cm.flushConfig?.();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('round 12: a notification names a tab only by a name someone chose, never one copied from the terminal title', () => {
  const cfg = cm.loadConfig();
  cfg.projects = { '/p': { tabs: [
    { id: 'term-/p-1', label: 'cat /Users/x/private.txt', labelSource: 'title' },
    { id: 'term-/p-2', label: 'Fix login', labelSource: 'agent' },
    { id: 'term-/p-3', label: 'Release', labelLockedByUser: true },
  ] } };
  cm.saveConfig(cfg);
  const all = cm.getTabLabelsById();
  assert.equal(all.get('term-/p-1'), 'cat /Users/x/private.txt', 'the screens still show it');
  const spoken = cm.getTabLabelsById({ spokenOnly: true });
  assert.equal(spoken.has('term-/p-1'), false);
  assert.equal(spoken.get('term-/p-2'), 'Fix login');
  assert.equal(spoken.get('term-/p-3'), 'Release');
});

test('round 14: a Run tab (named from its command) is never spoken, even marked locked by a tear-off', () => {
  const cfg = cm.loadConfig();
  cfg.projects = { '/p': { tabs: [
    { id: 'term-/p-7', label: 'Run: cat /tmp/private.txt', labelSource: 'run' },
    { id: 'term-/p-8', label: 'Run: cat /tmp/private.txt', labelLockedByUser: true },
  ] } };
  cm.saveConfig(cfg);
  const spoken = cm.getTabLabelsById({ spokenOnly: true });
  assert.equal(spoken.has('term-/p-7'), false);
  assert.equal(spoken.has('term-/p-8'), false);
});

test('round 16: a pairing the phone unregistered never registers again (a late frame cannot bring its token back)', () => {
  cm.addApnsToken({ token: 'ef'.repeat(32), pairToken: 'Z', pairingId: 'pid-z' });
  cm.optOutApnsPairing('Z');
  assert.equal(cm.getApnsTokens().some((t) => t.pairToken === 'Z'), false);
  assert.deepEqual(cm.addApnsToken({ token: 'ef'.repeat(32), pairToken: 'Z', pairingId: 'pid-z' }), { optedOut: true });
  assert.ok(!JSON.stringify(cm.loadConfig().apnsOptOuts).includes('"Z"'), 'only a hash is kept');
  const other = cm.addApnsToken({ token: 'ef'.repeat(32), pairToken: 'Y', pairingId: 'pid-y' }, () => true);
  assert.equal(other.pairToken, 'Y', 'a new pairing of the same phone registers normally');
});

test('round 17: opt-outs lapse only when their pairing is gone; a late older token never replaces a newer one', () => {
  const cfg = cm.loadConfig();
  cfg.mobileServer = { ...(cfg.mobileServer || {}), devices: [{ token: 'P1', name: 'a' }, ...Array.from({ length: 60 }, (_, i) => ({ token: `Q${i}`, name: 'q' }))] };
  cm.saveConfig(cfg);
  cm.optOutApnsPairing('P1');
  for (let i = 0; i < 60; i += 1) cm.optOutApnsPairing(`Q${i}`);
  assert.deepEqual(cm.addApnsToken({ token: '12'.repeat(32), pairToken: 'P1' }), { optedOut: true }, 'still opted out after 60 more');
  // P1 unpaired on the Mac: its entry is pruned at the next opt-out.
  const c2 = cm.loadConfig(); c2.mobileServer.devices = c2.mobileServer.devices.filter((d) => d.token !== 'P1'); cm.saveConfig(c2);
  cm.optOutApnsPairing('Q0');
  assert.equal(cm.loadConfig().apnsOptOuts.length, 60);
  const t1 = '34'.repeat(32); const t2 = '56'.repeat(32);
  cm.addApnsToken({ token: t2, pairToken: 'R', seq: 2000 });
  assert.deepEqual(cm.addApnsToken({ token: t1, pairToken: 'R', seq: 1000 }), { stale: true, haveSeq: 2000 });
  assert.equal(cm.getApnsTokens().find((t) => t.pairToken === 'R').token, t2);
  assert.equal(cm.addApnsToken({ token: t1, pairToken: 'R', seq: 3000 }).token, t1, 'a genuinely newer one replaces it');
});

test("round 18: many paired phones never evict a live phone's token ownership; unpaired pairings are pruned", () => {
  const cfg = cm.loadConfig();
  cfg.apnsTokens = [];
  cfg.mobileServer = { ...(cfg.mobileServer || {}), devices: Array.from({ length: 30 }, (_, i) => ({ token: `D${i}`, name: 'd' })) };
  cm.saveConfig(cfg);
  const tok = (i) => i.toString(16).padStart(2, '0').repeat(32);
  for (let i = 0; i < 30; i += 1) cm.addApnsToken({ token: tok(i + 1), pairToken: `D${i}` });
  assert.equal(cm.getApnsTokens().length, 30, 'all 30 live phones keep their tokens');
  assert.deepEqual(cm.addApnsToken({ token: tok(1), pairToken: 'D5' }, () => false), { taken: true }, "the first phone's token still has its owner");
  const c2 = cm.loadConfig(); c2.mobileServer.devices = c2.mobileServer.devices.slice(10); cm.saveConfig(c2);
  cm.addApnsToken({ token: tok(99), pairToken: 'D15' });
  assert.equal(cm.getApnsTokens().length, 20, 'entries of unpaired phones are pruned');
});

test('round 21: the same token re-registered by the same pairing keeps its entry (a send in flight still reaches it)', () => {
  const t = '78'.repeat(32);
  const first = cm.addApnsToken({ token: t, pairToken: 'S', seq: 5 });
  const again = cm.addApnsToken({ token: t, pairToken: 'S', seq: 5 });
  assert.equal(again.addedAt, first.addedAt);
  assert.equal(cm.getApnsTokens().filter((x) => x.pairToken === 'S').length, 1);
});
