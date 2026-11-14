// A one-shot launch resume waits for phone mode's launch sweep before claiming a session the start hold covers, so a
// hold that is about to lift does not skip the tab for the whole launch (Codex P1, impl round 17).
// Run: node --import ./electron/__tests__/register.mjs --test electron/__tests__/held-settled.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DOBIUS_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-heldsettled-'));
const tm = await import('../terminal-manager.js');
const S = '0b5c2a6e-1111-4222-8333-444455556666';

test('no pending hold: returns at once', async () => {
  tm.setHeldSessions(() => new Set([S]), { pending: () => false, settled: () => new Promise(() => {}) });
  const t0 = Date.now();
  await tm.waitHeldSettled(S, 5000);
  assert.ok(Date.now() - t0 < 1000);
});

test('a pending hold: waits until the owner settles, then the claim sees the lifted hold', async () => {
  let held = new Set([S]);
  let settle;
  const settled = new Promise((r) => { settle = r; });
  tm.setHeldSessions(() => held, { pending: (sid) => held.has(sid), settled: () => settled });
  let done = false;
  const w = tm.waitHeldSettled(S, 5000).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done, false, 'still waiting while the sweep runs');
  held = new Set();
  settle();
  await w;
  assert.equal(done, true);
  assert.equal(await tm.claimSessionResume(S, 'term-/x-1'), true, 'claimed once the hold lifted');
  tm.releaseSessionResume(S, 'term-/x-1');
});

test('an owner that never settles: the wait is capped and the claim is refused (the safe side)', async () => {
  tm.setHeldSessions(() => new Set([S]), { pending: () => true, settled: () => new Promise(() => {}) });
  const t0 = Date.now();
  await tm.waitHeldSettled(S, 100);
  assert.ok(Date.now() - t0 >= 90);
  assert.equal(await tm.claimSessionResume(S, 'term-/x-1'), false);
});

test('a throwing owner is not pending; no options is not pending', async () => {
  tm.setHeldSessions(() => new Set(), { pending: () => { throw new Error('x'); } });
  await tm.waitHeldSettled(S, 5000);
  tm.setHeldSessions(() => new Set());
  await tm.waitHeldSettled(S, 5000);
});

test('auto-resume waits before its launch claim', () => {
  const src = fs.readFileSync(new URL('../auto-resume.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function queueResumeNow('));
  assert.match(body, /await waitHeldSettled\(e\.sessionId\);[^\n]*\n\s*let claimed = true;\n\s*try \{ claimed = await claimSessionResume\(e\.sessionId, e\.tabId\)/);
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /setHeldSessions\(\(\) => pm\.heldSessions\(\), \{ pending: \(sid\) => pm\.heldUntilSwept\(sid\), settled: \(\) => pm\.whenSwept\(\) \}\)/);
});

test.after(() => { tm.setHeldSessions(() => new Set()); fs.rmSync(process.env.DOBIUS_TEST_USERDATA, { recursive: true, force: true }); });
