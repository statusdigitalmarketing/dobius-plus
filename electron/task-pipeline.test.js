/**
 * Dependency-free unit tests for task-pipeline.js (Epic 7, task 7.1).
 * Run: `node electron/task-pipeline.test.js` (exits non-zero on failure).
 * No test framework — just node:assert, since the module is pure.
 */
import assert from 'node:assert/strict';
import * as p from './task-pipeline.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const AT = 1_700_000_000_000; // fixed timestamp so assertions are deterministic
const newTask = () => ({ id: 't1', title: 'x', done: false, createdAt: AT, ...p.pipelineFields({ at: AT }) });

// --- shape / init ---
test('pipelineFields seeds intake + created event', () => {
  const t = newTask();
  assert.equal(t.stage, 'intake');
  assert.equal(t.events.length, 1);
  assert.equal(t.events[0].kind, 'created');
  assert.deepEqual(t.runs, []);
  assert.equal(t.stagedAt.intake, AT);
});

// --- legal forward path (build lane) ---
test('full build-lane path intake->done', () => {
  let t = newTask();
  for (const s of ['queued', 'building', 'review', 'shiptest', 'approval']) {
    t = p.advance(t, s, { at: AT });
    assert.equal(t.stage, s);
  }
  t = p.advance(t, 'done', { actor: 'human', at: AT });
  assert.equal(t.stage, 'done');
  assert.equal(t.done, true);
  assert.equal(t.events.at(-1).kind, 'done');
});

// --- review lane skips building ---
test('review lane intake->review allowed', () => {
  const t = p.advance(newTask(), 'review', { at: AT });
  assert.equal(t.stage, 'review');
});

// --- illegal transitions throw ---
test('illegal transition throws', () => {
  assert.throws(() => p.advance(newTask(), 'shiptest', { at: AT }), /illegal transition/);
});
test('skipping into approval from intake throws', () => {
  assert.throws(() => p.advance(newTask(), 'approval', { at: AT }), /illegal transition/);
});
test('unknown stage throws', () => {
  assert.throws(() => p.advance(newTask(), 'nope', { at: AT }), /unknown stage/);
});

// --- human-only gate: approval->done ---
test('approval->done by system throws, by human ok', () => {
  let t = newTask();
  for (const s of ['queued', 'building', 'review', 'shiptest', 'approval']) t = p.advance(t, s, { at: AT });
  assert.throws(() => p.advance(t, 'done', { actor: 'system', at: AT }), /requires a human actor/);
  const done = p.advance(t, 'done', { actor: 'human', at: AT });
  assert.equal(done.stage, 'done');
});

// --- idempotent same-stage ---
test('advancing to current stage is a no-op', () => {
  const t = newTask();
  assert.equal(p.advance(t, 'intake', { at: AT }), t);
});

// --- block / unblock ---
test('block remembers origin, unblock returns to it', () => {
  let t = p.advance(newTask(), 'building', { at: AT });
  t = p.block(t, 'tests failing', { at: AT });
  assert.equal(t.stage, 'blocked');
  assert.equal(t.blockedFrom, 'building');
  assert.equal(t.events.at(-1).note, 'tests failing');
  t = p.unblock(t, { at: AT });
  assert.equal(t.stage, 'building');
  assert.equal(t.blockedFrom, null);
});
test('unblock to explicit target', () => {
  let t = p.block(p.advance(newTask(), 'review', { at: AT }), 'x', { at: AT });
  t = p.unblock(t, { toStage: 'queued', at: AT });
  assert.equal(t.stage, 'queued');
});
test('unblock on non-blocked throws', () => {
  assert.throws(() => p.unblock(newTask(), { at: AT }), /not blocked/);
});

// --- immutability: input never mutated ---
test('advance does not mutate input', () => {
  const t = newTask();
  const before = JSON.stringify(t);
  p.advance(t, 'queued', { at: AT });
  assert.equal(JSON.stringify(t), before);
});

// --- migration of legacy tasks ---
test('migrate legacy done:false -> intake', () => {
  const m = p.migrate({ id: 'old', title: 'x', done: false, createdAt: AT });
  assert.equal(m.stage, 'intake');
  assert.equal(m.events[0].kind, 'created');
  assert.deepEqual(m.runs, []);
});
test('migrate legacy done:true -> done', () => {
  const m = p.migrate({ id: 'old', title: 'x', done: true, createdAt: AT });
  assert.equal(m.stage, 'done');
});
test('migrate is value-idempotent on current tasks', () => {
  // migrate() no longer early-returns the same reference (so future fields can
  // back-fill), but migrating a current task must not change its VALUE, and
  // repeated migration must be stable.
  const t = newTask();
  const once = p.migrate(t);
  assert.deepEqual(once, t);
  assert.deepEqual(p.migrate(once), once);
});

// --- complete() force-done works from any stage ---
test('complete force-done from intake', () => {
  const t = p.complete(newTask(), { at: AT });
  assert.equal(t.stage, 'done');
  assert.equal(t.done, true);
});

// --- done is terminal: block() must refuse a completed task ---
test('block() refuses a completed task', () => {
  const done = p.complete(newTask(), { at: AT });
  assert.throws(() => p.block(done, 'nope', { at: AT }), /completed task/);
});

// --- event cap ---
test('events stay capped', () => {
  let t = newTask();
  // bounce queued<->building isn't legal repeatedly; instead spam runs/blocks
  for (let i = 0; i < 200; i++) t = p.block(p.unblock(p.block(t, 'b', { at: AT }), { at: AT }), 'b', { at: AT });
  assert.ok(t.events.length <= 100, `events length ${t.events.length} should be <= 100`);
});

console.log(`\n${passed} passed`);
