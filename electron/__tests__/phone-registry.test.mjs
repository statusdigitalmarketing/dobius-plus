import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneRegistry, MAX_PENDING, MAX_SEND_IDS } from '../phone-registry.js';

const S1 = '11111111-1111-1111-1111-111111111111';
const S2 = '22222222-2222-2222-2222-222222222222';

// A run all the way to live: gate hello, runner reported, runner hello, Claude reported.
function live(reg, tab = 'T1', sid = S1) {
  const b = reg.begin(tab, sid);
  assert.equal(b.ok, true);
  const g = reg.redeem(b.gateToken, 'gate');
  assert.equal(g.ok, true);
  const a = reg.acceptGate(b.run, 500);
  assert.equal(a.ok, true);
  assert.equal(reg.noteRunnerSpawned(b.run, 600, 'Sat Nov 14 10:00:00 2026'), true);
  assert.equal(reg.redeem(a.runnerToken, 'runner').ok, true);
  assert.equal(reg.acceptRunner(b.run, 600, true).ok, true);
  assert.equal(reg.noteClaude(b.run, 700, 'Sat Nov 14 10:00:01 2026'), true);
  return { run: b.run, gateToken: b.gateToken, runnerToken: a.runnerToken, doneToken: a.doneToken };
}

test('one run per tab, one claim per session, at most 4 runs', () => {
  const reg = createPhoneRegistry();
  assert.equal(reg.begin('T1', S1).ok, true);
  assert.equal(reg.begin('T1', S2).code, 'busy');
  assert.equal(reg.begin('T2', S1).code, 'claimed');
  assert.equal(reg.begin('T2', S2).ok, true);
  assert.equal(reg.begin('T3', '33333333-3333-3333-3333-333333333333').ok, true);
  assert.equal(reg.begin('T4', '44444444-4444-4444-4444-444444444444').ok, true);
  assert.equal(reg.begin('T5', '55555555-5555-5555-5555-555555555555').code, 'too_many');
  assert.equal(reg.claimOf(S1).tabId, 'T1');
});

test('run ids are 128-bit hex and the generation moves on start and on end', () => {
  const reg = createPhoneRegistry();
  assert.equal(reg.gen('T1'), 0);
  const { run } = reg.begin('T1', S1);
  assert.match(run.runId, /^[0-9a-f]{32}$/);
  const g1 = reg.gen('T1');
  assert.ok(g1 > 0);
  reg.end(run, 'test');
  assert.ok(reg.gen('T1') > g1);
});

test('tokens: one use each, kind-bound, and a reused token ends the run loudly', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  assert.equal(reg.redeem(b.gateToken, 'runner').code, 'bad_token');
  assert.equal(reg.redeem('f'.repeat(64), 'gate').code, 'bad_token');
  assert.equal(reg.redeem(42, 'gate').code, 'bad_token');
  assert.equal(reg.redeem(b.gateToken, 'gate').ok, true);
  const again = reg.redeem(b.gateToken, 'gate');
  assert.equal(again.code, 'reused');
  assert.equal(b.run.status, 'ending');
  assert.match(b.run.error, /another program used its start ticket/);
  assert.equal(reg.acceptGate(b.run, 500).code, 'not_starting');
});

test('runner hello: only the reported, verified pid, only while starting', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  reg.redeem(b.gateToken, 'gate');
  const a = reg.acceptGate(b.run, 500);
  assert.equal(reg.acceptRunner(b.run, 600, true).code, 'not_verified'); // nothing reported yet
  reg.noteRunnerSpawned(b.run, 600, 'x');
  assert.equal(reg.noteRunnerSpawned(b.run, 601, 'y'), false); // reported once
  assert.equal(reg.acceptRunner(b.run, 601, true).code, 'not_verified');
  assert.equal(reg.acceptRunner(b.run, 600, false).code, 'not_verified');
  reg.end(b.run, 'no-hello');
  assert.equal(reg.redeem(a.runnerToken, 'runner').ok, true);
  assert.equal(reg.acceptRunner(b.run, 600, true).code, 'not_starting'); // a late hello is refused
  assert.equal(b.run.helloAccepted, false);
});

test('a closed tab refuses the gate and runner hellos', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  reg.tabClosed('T1');
  assert.equal(reg.acceptGate(b.run, 500).code, 'not_starting');
});

test('status moves only between live states', () => {
  const reg = createPhoneRegistry();
  const { run } = live(reg);
  assert.equal(reg.setStatus(run, 'working'), true);
  assert.equal(reg.setStatus(run, 'ending'), false);
  assert.equal(reg.setStatus(run, 'starting'), false);
  reg.end(run, 'x');
  assert.equal(reg.setStatus(run, 'idle'), false);
  assert.equal(run.status, 'ending');
});

test('pending cards: at most 8, unique ids, answered once, cleared at end', () => {
  const reg = createPhoneRegistry();
  const { run } = live(reg);
  for (let i = 0; i < MAX_PENDING; i++) assert.equal(reg.addPending(run, { requestId: `r${i}`, kind: 'permission' }), true);
  assert.equal(reg.addPending(run, { requestId: 'r9', kind: 'permission' }), false);
  assert.equal(reg.takePending(run, 'r0').requestId, 'r0');
  assert.equal(reg.takePending(run, 'r0'), null);
  assert.equal(reg.addPending(run, { requestId: 'r1', kind: 'permission' }), false); // id taken
  reg.end(run, 'x');
  assert.equal(run.pending.size, 0);
  assert.equal(reg.addPending(run, { requestId: 'z', kind: 'question' }), false);
});

test('send ids: deduped and bounded', () => {
  const reg = createPhoneRegistry();
  const { run } = live(reg);
  assert.equal(reg.firstSend(run, 'a'), true);
  assert.equal(reg.firstSend(run, 'a'), false);
  for (let i = 0; i < MAX_SEND_IDS; i++) reg.firstSend(run, `s${i}`);
  assert.equal(run.sendIds.length, MAX_SEND_IDS);
  assert.equal(reg.firstSend(run, 'a'), true); // the oldest was forgotten
});

test('claim: held through ending until done AND the group and Claude are confirmed gone', () => {
  const reg = createPhoneRegistry();
  const { run } = live(reg);
  reg.end(run, 'give-back');
  assert.equal(reg.settle(run).released, null);
  reg.noteDone(run);
  assert.equal(reg.settle(run).released, null); // processes not confirmed gone
  reg.noteGroupGone(run);
  assert.equal(reg.settle(run).released, null); // Claude pid not confirmed gone
  reg.noteClaudeGone(run);
  assert.deepEqual(reg.settle(run), { released: 'done', forgotten: true });
  assert.equal(reg.claimOf(S1), null);
  assert.equal(reg.get(run.runId), null);
});

test('claim: an idle-looking shell without done never releases', () => {
  const reg = createPhoneRegistry();
  const { run } = live(reg);
  reg.end(run, 'ended');
  reg.noteGroupGone(run);
  reg.noteClaudeGone(run);
  assert.equal(reg.settle(run).released, null);
  assert.equal(reg.claimOf(S1), run);
});

test('claim: the TUI seen running the session releases, but cleanup still keeps the run', () => {
  const reg = createPhoneRegistry();
  const { run } = live(reg);
  assert.equal(reg.noteTuiRunning('T1', S1), null); // not while live
  reg.end(run, 'ended');
  assert.equal(reg.noteTuiRunning('T1', S2), null); // another session
  assert.equal(reg.noteTuiRunning('T1', S1), run);
  assert.deepEqual(reg.settle(run), { released: 'tui-running', forgotten: false });
  assert.equal(reg.claimOf(S1), null);
  assert.equal(reg.stateOf('T1').on, false);
  assert.equal(reg.list().length, 1); // still tracked for cleanup
  reg.noteGroupGone(run);
  reg.noteClaudeGone(run);
  assert.deepEqual(reg.settle(run), { released: null, forgotten: true });
});

test('claim: tab closed needs the shell AND the processes confirmed gone', () => {
  const reg = createPhoneRegistry();
  const { run } = live(reg);
  reg.tabClosed('T1');
  reg.noteGroupGone(run);
  reg.noteClaudeGone(run);
  assert.equal(reg.settle(run).released, null);
  reg.noteShellGone(run);
  assert.deepEqual(reg.settle(run), { released: 'tab-closed', forgotten: true });
});

test('claim: closed before any hello releases on the shell alone; cleanup waits for the tag sweep', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  reg.redeem(b.gateToken, 'gate');
  reg.acceptGate(b.run, 500);
  reg.tabClosed('T1');
  reg.noteShellGone(b.run);
  assert.deepEqual(reg.settle(b.run), { released: 'tab-closed', forgotten: false });
  reg.noteTagSweepClean(b.run);
  assert.deepEqual(reg.settle(b.run), { released: null, forgotten: true });
});

test('claim: done with no accepted hello needs no process confirmations, but a reported group still blocks cleanup', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  reg.redeem(b.gateToken, 'gate');
  reg.acceptGate(b.run, 500);
  reg.noteRunnerSpawned(b.run, 600, 'x');
  reg.end(b.run, 'no-hello');
  reg.noteDone(b.run);
  assert.deepEqual(reg.settle(b.run), { released: 'done', forgotten: false });
  reg.noteGroupGone(b.run);
  assert.deepEqual(reg.settle(b.run), { released: null, forgotten: true });
});

test('a ticket never redeemed: nothing to clean, released once done or the closed tab shell is gone', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  reg.tabClosed('T1');
  reg.noteShellGone(b.run);
  assert.deepEqual(reg.settle(b.run), { released: 'tab-closed', forgotten: true });
});

test('stateOf: no tokens or pids reach the phone', () => {
  const reg = createPhoneRegistry();
  const { run, runnerToken } = live(reg);
  reg.addPending(run, { requestId: 'r1', kind: 'question' });
  const s = reg.stateOf('T1');
  assert.deepEqual(Object.keys(s).sort(), ['gen', 'id', 'on', 'pending', 'runId', 'sessionId', 'status']);
  assert.equal(JSON.stringify(s).includes(runnerToken), false);
  assert.deepEqual(reg.stateOf('T9'), { id: 'T9', on: false, gen: 0 });
});
