import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneRegistry, MAX_PENDING, MAX_SEND_IDS, MAX_GENS, EPOCH_SPAN } from '../phone-registry.js';

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
  return { run: b.run, gateToken: b.gateToken, runnerToken: a.runnerToken, doneToken: b.doneToken };
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

test('run ids are 128-bit hex and the generation moves on start, on end and when the Mac takes it back', () => {
  const reg = createPhoneRegistry();
  const g0 = reg.gen('T1');
  assert.ok(g0 > 0);
  assert.equal(reg.gen('T1'), g0); // stable while nothing happens
  const { run } = reg.begin('T1', S1);
  assert.match(run.runId, /^[0-9a-f]{32}$/);
  const g1 = reg.gen('T1');
  assert.ok(g1 > g0);
  reg.end(run, 'test');
  const g2 = reg.gen('T1');
  assert.ok(g2 > g1);
  reg.noteDone(run, true); // main confirmed the gate exited when done arrived
  reg.settle(run);
  assert.ok(reg.gen('T1') > g2); // the view published during ending is stale once the Mac has the tab
});

test('a delayed frame from the ending stretch is stale once the TUI is back (Codex impl r1)', () => {
  const reg = createPhoneRegistry();
  const { run } = live(reg);
  reg.end(run, 'give-back');
  const shown = reg.stateOf('T1').gen;
  reg.noteTuiRunning('T1', S1);
  reg.settle(run);
  assert.notEqual(reg.gen('T1'), shown);
});

test('asking about other tabs never changes a live tab\'s generation (Codex impl r9)', () => {
  const reg = createPhoneRegistry();
  const base = reg.gen('T0');
  for (let i = 0; i < MAX_GENS + 5; i++) reg.gen(`X${i}`);
  assert.equal(reg.gen('T0'), base, 'a tab that never moved keeps the launch base');
  const { run } = reg.begin('T0', S1);
  const moved = reg.gen('T0');
  assert.ok(moved > base);
  for (let i = 0; i < MAX_GENS + 5; i++) reg.gen(`Y${i}`);
  assert.equal(reg.gen('T0'), moved, 'nor one that moved');
  reg.cancel(run);
});

test('a full map drops a tab that is no longer live before any live one (Codex impl r1, r9)', () => {
  const live = new Set(['T0']);
  const reg = createPhoneRegistry({ isLive: (id) => live.has(id) });
  const { run } = reg.begin('T0', S1);
  const mine = reg.gen('T0');
  // Other tabs move and are gone again: each move leaves an entry behind.
  let d0 = 0;
  for (let i = 0; i < MAX_GENS + 5; i++) { const b = reg.begin(`D${i}`, `s-${i}`); reg.cancel(b.run); if (i === 0) d0 = reg.gen('D0'); }
  assert.equal(reg.gen('T0'), mine, 'the live tab keeps its generation');
  assert.notEqual(reg.gen('D0'), d0, 'a dropped tab falls back to a base it never had');
  reg.cancel(run);
});

test('a live tab dropped from a full map never gets back a generation it had (Codex impl r10)', () => {
  const reg = createPhoneRegistry();
  const seen = new Map(); // tab -> every generation it was shown
  const look = (id) => { const g = reg.gen(id); if (!seen.has(id)) seen.set(id, new Set()); seen.get(id).add(g); return g; };
  const before = look('T0');
  for (let i = 0; i <= MAX_GENS + 2; i++) {
    const id = `T${i}`;
    look(id);
    const b = reg.begin(id, `s-${i}`);
    look(id);
    reg.cancel(b.run);
    look(id);
  }
  // Every tab is live (default isLive), so T0, T1 and T2 were dropped.
  assert.notEqual(reg.gen('T0'), before, 'T0 is not back at the generation a frame typed before its move carries');
  for (const id of ['T0', 'T1', 'T2']) {
    const g = reg.gen(id);
    assert.ok(![...seen.get(id)].includes(g), `${id} never gets an old generation back`);
  }
  // The base moved once for the first drop, not once per drop.
  assert.equal(reg.gen('never-moved-a'), reg.gen('never-moved-b'));
  assert.equal(reg.gen('T1'), reg.gen('never-moved-a'));
});

test('a later launch never reissues a generation, whatever the clock (Codex impl r11, r12)', () => {
  // Two launches draw different epochs; nothing is read from disk or the clock.
  const draws = [7, 8];
  const a = createPhoneRegistry({ epoch: () => draws.shift() });
  const handed = new Set([a.gen('T')]);
  const { run } = a.begin('T', S1);
  handed.add(a.gen('T'));
  a.end(run, 'ended');
  handed.add(a.gen('T'));
  const b = createPhoneRegistry({ epoch: () => draws.shift() });
  assert.ok(!handed.has(b.gen('T')), 'the restarted tab has none of the old generations');
  for (const g of [...handed, b.gen('T')]) assert.ok(Number.isSafeInteger(g) && g >= 0);
});

test('epochs: random, below 2^31, every generation a safe integer, a used-up epoch replaced by an unused one', () => {
  const real = createPhoneRegistry();
  assert.ok(Number.isSafeInteger(real.gen('T')) && real.gen('T') >= EPOCH_SPAN);
  // The highest epoch's last generation is still safe.
  assert.ok(Number.isSafeInteger((2 ** 31 - 1) * EPOCH_SPAN + EPOCH_SPAN - 1));
  // Out-of-range or repeated draws are drawn again.
  const draws = [0, 2 ** 31, 1.5, 5, 5, 6];
  const reg = createPhoneRegistry({ epoch: () => draws.shift() });
  assert.equal(reg.gen('T'), 5 * EPOCH_SPAN);
  const seen = new Set([reg.gen('T')]);
  const fresh = () => { const g = reg.gen('T'); assert.ok(!seen.has(g), `generation ${g} issued twice`); seen.add(g); };
  // Use up the epoch: each begin and cancel issues two generations, every one of them new.
  while (seen.size < EPOCH_SPAN + 4) {
    const { run } = reg.begin('T', S1);
    fresh();
    reg.cancel(run);
    fresh();
  }
  assert.equal(draws.length, 0, 'the repeated 5 was refused and 6 drawn');
  assert.ok(reg.gen('T') >= 6 * EPOCH_SPAN && reg.gen('T') < 7 * EPOCH_SPAN);
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
  reg.noteDone(run, true); // main confirmed the gate exited when done arrived
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

test('claim: closed before any hello releases on the shell alone; cleanup waits for the gate and a later tag sweep', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  reg.redeem(b.gateToken, 'gate');
  reg.acceptGate(b.run, 500);
  reg.tabClosed('T1');
  reg.noteShellGone(b.run);
  assert.deepEqual(reg.settle(b.run), { released: 'tab-closed', forgotten: false });
  assert.equal(reg.noteTagSweepClean(b.run), false); // the gate may still spawn
  assert.deepEqual(reg.settle(b.run), { released: null, forgotten: false });
  reg.noteGateGone(b.run);
  assert.equal(reg.noteTagSweepClean(b.run), true);
  assert.deepEqual(reg.settle(b.run), { released: null, forgotten: true });
});

test('a tag sweep from before the gate was gone is not kept (Codex impl r1)', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  reg.redeem(b.gateToken, 'gate');
  reg.acceptGate(b.run, 500);
  reg.end(b.run, 'no-hello');
  reg.noteTagSweepClean(b.run); // gate alive: ignored
  reg.tabClosed('T1');
  reg.noteShellGone(b.run);
  reg.noteGateGone(b.run);
  assert.deepEqual(reg.settle(b.run), { released: 'tab-closed', forgotten: false });
  assert.equal(reg.list().length, 1);
});

test('claim: done with no accepted hello needs no process confirmations, but a reported group still blocks cleanup', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  reg.redeem(b.gateToken, 'gate');
  reg.acceptGate(b.run, 500);
  reg.noteRunnerSpawned(b.run, 600, 'x');
  reg.end(b.run, 'no-hello');
  reg.noteDone(b.run, true); // the gate had exited
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
  const t9 = reg.stateOf('T9');
  assert.deepEqual(Object.keys(t9).sort(), ['gen', 'id', 'on']);
  assert.equal(t9.on, false);
});

test('done for a run whose gate never ran releases at once (no hello, nothing to clean)', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  const d = reg.redeem(b.doneToken, 'done');
  assert.equal(d.ok, true);
  reg.noteDone(b.run);
  assert.deepEqual(reg.settle(b.run), { released: 'done', forgotten: true });
  assert.equal(reg.claimOf(S1), null);
});

test('done tokens are one-use and kind-bound like the others', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  assert.equal(reg.redeem(b.doneToken, 'gate').code, 'bad_token');
  assert.equal(reg.redeem(b.doneToken, 'done').ok, true);
  assert.equal(reg.redeem(b.doneToken, 'done').code, 'reused');
});

test('a done while the accepted gate still runs is refused and the claim stays held', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  assert.equal(reg.redeem(b.gateToken, 'gate').ok, true);
  assert.equal(reg.acceptGate(b.run, 4242).ok, true);
  assert.equal(reg.redeem(b.doneToken, 'done').ok, true);
  assert.deepEqual(reg.noteDone(b.run, false), { ok: false, code: 'gate_alive' });
  assert.equal(b.run.status, 'ending');
  assert.equal(b.run.doneReceived, false);
  assert.match(b.run.error, /another program/);
  assert.equal(reg.settle(b.run).released, null);
  assert.equal(reg.claimOf(S1), b.run);
});

test('cancel: only a run nothing has used; its tokens die with it and the claim is gone', () => {
  const reg = createPhoneRegistry();
  const b = reg.begin('T1', S1);
  const g0 = reg.gen('T1');
  assert.equal(reg.cancel(b.run), true);
  assert.equal(reg.claimOf(S1), null);
  assert.equal(reg.runOfTab('T1'), null);
  assert.ok(reg.gen('T1') > g0);
  assert.equal(reg.redeem(b.gateToken, 'gate').code, 'bad_token');
  const b2 = reg.begin('T1', S1);
  assert.equal(reg.redeem(b2.gateToken, 'gate').ok, true);
  assert.equal(reg.cancel(b2.run), false); // a gate already used its ticket
  assert.equal(reg.claimOf(S1), b2.run);
});
