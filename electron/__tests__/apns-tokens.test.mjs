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
