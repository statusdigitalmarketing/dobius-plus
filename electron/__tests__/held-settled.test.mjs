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
  assert.match(body, /await waitHeldSettled\(e\.sessionId\);[^\n]*\n[\s\S]{0,200}?\}\n\s*let claimed = true;\n\s*try \{ claimed = await claimSessionResume\(e\.sessionId, e\.tabId\)/);
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /setHeldSessions\(\(\) => pm\.heldSessions\(\), \{ pending: \(sid\) => pm\.heldUntilSwept\(sid\), settled: \(\) => pm\.whenSwept\(\) \}\)/);
});

test('heldSettlePending answers what the owner says, and false on a throw', () => {
  tm.setHeldSessions(() => new Set([S]), { pending: (sid) => sid === S });
  assert.equal(tm.heldSettlePending(S), true);
  assert.equal(tm.heldSettlePending('other'), false);
  tm.setHeldSessions(() => new Set(), { pending: () => { throw new Error('x'); } });
  assert.equal(tm.heldSettlePending(S), false);
});

test('the launch pass does not wait behind a held tab: it is queued on its own (Codex impl r18)', () => {
  const src = fs.readFileSync(new URL('../auto-resume.js', import.meta.url), 'utf8');
  const loop = src.slice(src.indexOf('const sweepWaits = new Set();'), src.indexOf('async function queueResume('));
  assert.match(loop, /if \(heldSettlePending\(e\.sessionId\)\) \{\s*sweepWaits\.add\(e\.tabId\);\s*void queueResume\(e, 0\)\.catch\([^\n]*\n\s*continue;\s*\}\s*const delayMs = cumulativeMs;\s*cumulativeMs \+= writeGapMs\(e\.sizeMB, cfg\.staggerMs\);\s*await queueResume\(e, delayMs\);/);
  assert.match(loop, /for \(const c of candidates\) if \(!sweepWaits\.has\(c\.tabId\)\) preparing\.delete\(c\.tabId\);/, 'a waiting tab keeps its preparing entry');
});

test('the write gate: one attempt from its checks to its write, room counted from the write (Codex impl r20, r21)', async () => {
  const ar = await import('../auto-resume.js');
  let t = 1000;
  const gate = ar.createWriteGate(() => t, { holdMaxMs: 30_000, pollMs: 250 });
  const gap = ar.writeGapMs(2000, 50);
  assert.equal(gap, 4050);
  // T1 takes the gate; its write-time checks take 4,050 ms. T2 does not pass meanwhile.
  const t1 = gate.take();
  assert.equal(t1.waitMs, 0);
  t = 5050;
  assert.equal(gate.take().waitMs, 250, 'held while T1 is still checking');
  // T1 writes now: T2 waits the room from that write, not from when T1 took the gate.
  t1.wrote(gap);
  assert.equal(gate.take().waitMs, 4050, 'two heavy writes never start together');
  t = 9100;
  const t3 = gate.take();
  assert.equal(t3.waitMs, 0);
  // That attempt was given up: the gate is free at once and no room is added.
  t3.release();
  const t4 = gate.take();
  assert.equal(t4.waitMs, 0, 'a given-up attempt holds up nobody');
  // A stale release (another attempt holds the gate now) changes nothing.
  t3.release();
  assert.equal(gate.take().waitMs, 250);
  // An attempt that never answers (a throw) is treated as gone after holdMaxMs, and then no longer holds it, so its
  // late callback cannot write (Codex impl r22).
  const slow = t4; // t4 took the gate at 9,100
  assert.equal(slow.held(), true);
  t += 30_000;
  assert.equal(slow.held(), false, 'expired');
  const fresh = gate.take();
  assert.equal(fresh.waitMs, 0);
  assert.equal(slow.held(), false, 'taken over');
  assert.equal(fresh.held(), true);
  fresh.release();
  assert.equal(fresh.held(), false);
});

test('writeGapMs: size bounded, missing values are zero', async () => {
  const ar = await import('../auto-resume.js');
  assert.equal(ar.writeGapMs(5000, 50), 4050);
  assert.equal(ar.writeGapMs(undefined, undefined), 0);
  assert.equal(ar.writeGapMs(NaN, -5), 0);
  assert.equal(ar.writeGapMs(10, 50), 70);
});

test('every resume write goes through the gate, and every path that gives up releases it', () => {
  const src = fs.readFileSync(new URL('../auto-resume.js', import.meta.url), 'utf8');
  assert.ok(!/takeWriteSlot|nextWriteAt|nextRestoredAt/.test(src), 'no reservation clock left');
  const fire = src.slice(src.indexOf('const fire = async () => {'), src.indexOf('entry.timer = setTimeout(fire, delayMs);'));
  assert.ok(fire.length > 2000, 'the fire slice is found');
  assert.match(fire, /const slot = writeGate\.take\(\);\s*if \(slot\.waitMs > 0\) \{ entry\.timer = setTimeout\(fire, slot\.waitMs\); return; \}/);
  assert.match(fire, /slot\.wrote\(writeGapMs\(e\.sizeMB, getAutoResume\(\)\.staggerMs\)\);\s*writeTerminal\(e\.tabId, cmd\);/, 'the room starts at the write');
  // After the gate is taken, every return releases it (directly or through giveUpHere), except a written resume.
  const at = fire.indexOf('const release = () =>');
  assert.ok(at > 0, 'the release marker is found (a missing marker made these checks vacuous once)');
  const after = fire.slice(at);
  assert.ok(after.length > 1500, 'the slice covers the checks and the write');
  assert.ok(!/\bgiveUp\(/.test(after.replace('giveUp(why)', '')), 'no bare giveUp after the gate');
  // The write is made only while this attempt still owns the gate (Codex impl r22), checked right before it.
  assert.match(after, /if \(!slot\.held\(\)\) \{[\s\S]{0,400}?entry\.timer = setTimeout\(fire, 0\);\s*return;\s*\}\s*entry\.releaseGate = null;\s*queue\.delete\(e\.tabId\);\s*try \{[\s\S]{0,300}?slot\.wrote\(/);
  assert.match(after, /entry\.releaseGate = release;/);
  // Every cancel path frees a gate the attempt holds (Codex impl r22).
  const cancels = src.match(/clearTimeout\(entry\.timer\);\n\s*entry\.releaseGate\?\.\(\);/g) || [];
  assert.equal(cancels.length, (src.match(/clearTimeout\(entry\.timer\);/g) || []).length);
  assert.equal(cancels.length, 4);
  for (const line of after.split('\n').filter((l) => /\breturn;/.test(l))) assert.match(line, /release\(\)|giveUpHere\(|^\s*return;\s*$/, line);
  assert.equal((after.match(/if \(entry\.cancelled\) \{ release\(\); return; \}/g) || []).length, 2);
  assert.match(after, /catch \(err\) \{[\s\S]*?release\(\);\s*releaseSessionResume/);
});

test.after(() => { tm.setHeldSessions(() => new Set()); fs.rmSync(process.env.DOBIUS_TEST_USERDATA, { recursive: true, force: true }); });
