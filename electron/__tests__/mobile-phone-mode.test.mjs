// The phone's phone-mode helpers (mobile/phone-mode.js): what a phoneState means for the screen and the answers each
// card sends, checked against the Mac's own validators so the two never disagree.
// Run: node --test electron/__tests__/mobile-phone-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneOffered, phoneKnown, sendOutcome, reconcileEchoes, pruneEchoes, ageEchoes, ECHO_TTL_MS, shownEchoes, waitingCount, MAX_OUTSTANDING, echoBaseline, readOutbox, writeOutbox, ARRIVAL_SKEW_MS, freshId, readPhoneState, questionAnswer, togglePick, permissionAnswer, planAnswer, refusalText } from '../../mobile/phone-mode.js';
import { validateAnswer, validatePhoneRequest } from '../phone-protocol.js';
import { answerMisfit } from '../phone-runner-core.mjs';

const T = 'term-/p/x-1';

test('offered only when the Mac says phone', () => {
  assert.equal(phoneOffered(['ack', 'phone']), true);
  assert.equal(phoneOffered(['ack', 'phoneGen']), false);
  assert.equal(phoneOffered(['ack']), false);
  assert.equal(phoneOffered(undefined), false);
});

test('known on a Mac that runs phone mode with the setting off; writes go without a generation only elsewhere (Codex r26)', () => {
  assert.equal(phoneKnown(['ack', 'phoneGen']), true);
  assert.equal(phoneKnown(['ack', 'phoneGen', 'phone']), true);
  assert.equal(phoneKnown(['ack', 'phone']), true);
  assert.equal(phoneKnown(['ack']), false);
  assert.equal(phoneKnown(null), false);
});

test('a send is failed only on a code that says it was not taken; anything else is unconfirmed (Codex r26)', () => {
  assert.equal(sendOutcome({ type: 'ack', op: 'phoneSend' }), 'sent');
  for (const code of ['busy', 'stale_run', 'not_live', 'revoked', 'off']) assert.equal(sendOutcome({ type: 'opError', code }), 'failed', code);
  for (const code of ['timeout', 'failed', 'something_new', undefined]) assert.equal(sendOutcome({ type: 'opError', code }), 'unconfirmed', String(code));
  assert.equal(sendOutcome(null), 'unconfirmed');
});

test('ids fit the Mac\'s sendId and reqId rules', () => {
  for (let i = 0; i < 50; i += 1) {
    const id = freshId('phone-send');
    assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
  }
  const req = { type: 'phoneSend', id: T, runId: 'a'.repeat(32), text: 'hi', sendId: freshId('s'), reqId: freshId('r') };
  assert.equal(validatePhoneRequest(req).ok, true);
});

test('readPhoneState: only this tab, off and on shapes, cards filtered', () => {
  assert.equal(readPhoneState({ type: 'phoneState', id: 'other', on: false }, T), null);
  assert.equal(readPhoneState({ type: 'selector', id: T }, T), null);
  assert.deepEqual(readPhoneState({ type: 'phoneState', id: T, on: false, gen: 3 }, T), { on: false, gen: 3 });
  const s = readPhoneState({ type: 'phoneState', id: T, on: true, gen: 4, runId: 'r', sessionId: 's', status: 'bogus', pending: [{ requestId: 'q1', kind: 'question' }, { kind: 'question' }, { requestId: 'x', kind: 'evil' }, null] }, T);
  assert.equal(s.status, 'starting', 'an unknown status is not trusted');
  assert.deepEqual(s.pending.map((c) => c.requestId), ['q1']);
  assert.equal(readPhoneState({ type: 'phoneState', id: T, on: false, gen: -1 }, T).gen, null);
});

const card = {
  requestId: 'q', kind: 'question', tool: 'AskUserQuestion', canAlways: false,
  questions: [
    { index: 0, question: 'Color?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] },
    { index: 1, question: 'Toppings?', header: 'Top', multiSelect: true, options: [{ label: 'Ham' }, { label: 'Egg' }] },
  ],
};

test('a question answer: every question, labels joined, own words added, and the Mac accepts it', () => {
  const r = questionAnswer(card, { 'Color?': { labels: ['Blue'] }, 'Toppings?': { labels: ['Ham', 'Egg'], own: ' extra cheese ' } });
  assert.deepEqual(r.answer.answers, { 'Color?': 'Blue', 'Toppings?': 'Ham, Egg, extra cheese' });
  const v = validateAnswer(r.answer);
  assert.equal(v.ok, true);
  assert.equal(answerMisfit(card, v.value), null, 'the runner takes it as fitting the card');
});

test('a question answer: own words alone count; nothing at all names the question', () => {
  assert.equal(questionAnswer(card, { 'Color?': { own: 'green' }, 'Toppings?': { labels: ['Egg'] } }).answer.answers['Color?'], 'green');
  assert.deepEqual(questionAnswer(card, { 'Color?': { labels: ['Red'] } }), { missing: 'Toppings?' });
  assert.equal(questionAnswer(card, { 'Color?': { labels: ['Red', 'Blue'] }, 'Toppings?': { labels: ['Egg'] } }).answer.answers['Color?'], 'Red', 'a single choice sends one');
});

test('togglePick: single replaces, several add and remove', () => {
  assert.deepEqual(togglePick(['Red'], 'Blue', false), ['Blue']);
  assert.deepEqual(togglePick(['Red'], 'Red', false), []);
  assert.deepEqual(togglePick(['Ham'], 'Egg', true), ['Ham', 'Egg']);
  assert.deepEqual(togglePick(['Ham', 'Egg'], 'Ham', true), ['Egg']);
});

test('permission and plan answers pass the Mac\'s checks', () => {
  for (const a of [permissionAnswer(true), permissionAnswer(true, { always: true }), permissionAnswer(false, { note: ' no ' }), permissionAnswer(false, { always: true })]) {
    assert.equal(validateAnswer(a).ok, true, JSON.stringify(a));
  }
  assert.equal(permissionAnswer(false, { always: true }).always, undefined, 'always only with allow');
  assert.equal(permissionAnswer(true, { note: '   ' }).note, undefined);
  for (const a of [planAnswer(true), planAnswer(true, { mode: 'acceptEdits' }), planAnswer(false, { note: 'smaller steps' }), planAnswer(false, { mode: 'acceptEdits' })]) {
    assert.equal(validateAnswer(a).ok, true, JSON.stringify(a));
  }
  assert.equal(planAnswer(true, { mode: 'bypassPermissions' }).mode, undefined, 'only the modes the Mac offers');
});

test('refusal text: the Mac\'s sentence, capitalised and ended; a known code otherwise', () => {
  assert.equal(refusalText('working', 'Claude is working; move it when the turn is over'), 'Claude is working; move it when the turn is over.');
  assert.equal(refusalText('off', ''), 'Phone mode is off on this Mac.');
  assert.equal(refusalText('weird'), 'It could not be moved right now.');
  assert.equal(refusalText('x', 'y'.repeat(400)), 'It could not be moved right now.', 'an overlong message is not shown');
});

test('a phone message arrives only by a row that was not there when it was sent (Codex r27, r28)', () => {
  const echoArrived = (e, rows) => reconcileEchoes([e], rows).length === 0;
  const since = Date.parse('2026-11-14T16:00:00Z');
  const recent = { id: 'u1', role: 'user', content: 'continue', timestamp: '2026-11-14T15:59:50Z' };
  const echo = { content: 'continue', sendId: 's1', since, ...echoBaseline('continue', [recent, { role: 'user', content: 'other', id: 'u0' }]) };
  assert.deepEqual([echo.known, echo.knownQueued], [['u1'], 0]);
  assert.equal(echoArrived(echo, [recent]), false, 'a row from 10 s before the send is an earlier message');
  assert.equal(echoArrived(echo, [{ id: 'u0', role: 'user', content: 'continue', timestamp: '2026-11-14T15:00:00Z' }]), false, 'an older page');
  assert.equal(echoArrived(echo, [recent, { id: 'u2', role: 'user', content: ' continue ', timestamp: '2026-11-14T16:00:05Z' }]), true);
  assert.equal(echoArrived(echo, [{ id: 'u3', role: 'user', content: 'continue', timestamp: new Date(since - ARRIVAL_SKEW_MS + 1).toISOString() }]), true, 'a Mac clock a little behind');
  assert.equal(echoArrived(echo, [{ role: 'user', content: 'continue', queued: true }]), true);
  assert.equal(echoArrived({ ...echo, knownQueued: 1 }, [{ role: 'user', content: 'continue', queued: true }]), false, 'a queued one that was already there');
  assert.equal(echoArrived(echo, [{ id: 'u4', role: 'assistant', content: 'continue', timestamp: '2026-11-14T16:00:05Z' }]), false);
  assert.equal(echoArrived(echo, [{ role: 'user', content: 'continue', timestamp: '2026-11-14T16:00:05Z' }]), false, 'no id, not queued: not proof');
});

test('the outbox keeps unanswered phone messages across visits, bounded, and brings them back as not confirmed (Codex r28)', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const e = (i, extra = {}) => ({ content: `m${i}`, sendId: `s${i}`, runId: 'r'.repeat(32), since: now - i, known: ['x'], knownQueued: 0, ...extra });
  let map = writeOutbox({}, 'T', [e(1), e(2, { acked: true }), e(3, { fail: 'failed' })], now);
  assert.deepEqual(map.T.map((x) => x.sendId), ['s1', 's3'], 'a message the Mac took is not kept');
  const back = readOutbox(map, 'T', now);
  assert.deepEqual(back.map((x) => [x.sendId, x.fail]), [['s1', 'unconfirmed'], ['s3', 'failed']]);
  map = writeOutbox(map, 'T', Array.from({ length: 9 }, (_, i) => e(i)), now);
  assert.equal(map.T.length, 5);
  map = writeOutbox(map, 'T', [], now);
  assert.equal('T' in map, false);
  let many = {};
  for (let i = 0; i < 30; i++) many = writeOutbox(many, `T${i}`, [e(i)], now);
  assert.equal(Object.keys(many).length, 20);
  assert.deepEqual(readOutbox({ T: [e(1, { since: now - 8 * 86_400_000 })] }, 'T', now), [], 'older than a week');
  assert.deepEqual(readOutbox({ T: [{ content: 5 }, null, e(1, { runId: 7 })] }, 'T', now), [], 'garbage is dropped');
  assert.deepEqual(readOutbox(null, 'T', now), []);
});

test('one transcript row confirms one phone message, never two with the same words (Codex r29)', () => {
  const since = Date.parse('2026-11-14T16:00:00Z');
  const a = { content: 'continue', sendId: 'sa', since, known: [], knownQueued: 0 };
  const b = { content: 'continue', sendId: 'sb', since: since + 1000, known: [], knownQueued: 0 };
  const row = (id) => ({ id, role: 'user', content: 'continue', timestamp: '2026-11-14T16:00:05Z' });
  const shown = (list) => shownEchoes(list).map((e) => e.sendId);
  assert.deepEqual(shown(reconcileEchoes([a, b], [row('u1')])), ['sb'], 'one row, the older send');
  assert.deepEqual(reconcileEchoes([a, b], [row('u1'), row('u2')]), [], 'two rows, both, and nothing kept hidden');
  const q = { role: 'user', content: 'continue', queued: true };
  assert.deepEqual(shown(reconcileEchoes([a, b], [q])), ['sb'], 'one queued row, one send');
  assert.deepEqual(reconcileEchoes([a, b], [q, q]), []);
  const refused = { ...b, fail: 'failed' };
  assert.deepEqual(shown(reconcileEchoes([a, refused], [row('u1'), row('u2')])), ['sb'], 'a refused send stays for Send again');
  const local = { content: 'continue', at: since };
  const same = [local];
  assert.equal(reconcileEchoes(same, [row('u1')]), same, 'nothing cleared: the same array back');
});

test('the row a confirmed message used stays its own on every later poll (Codex r29, ship-test)', () => {
  const since = Date.parse('2026-11-14T16:00:00Z');
  const a = { content: 'grape', sendId: 'sa', since, known: [], knownQueued: 0, acked: true };
  const b = { content: 'grape', sendId: 'sb', since: since + 150, known: [], knownQueued: 0, fail: 'unconfirmed' };
  const rows = [{ id: 'g1', role: 'user', content: 'grape', timestamp: '2026-11-14T16:00:02Z' }];
  let list = reconcileEchoes([a, b], rows);
  for (let poll = 0; poll < 3; poll++) list = reconcileEchoes(list, rows);
  assert.deepEqual(shownEchoes(list).map((e) => e.sendId), ['sb'], 'the waiting one is still shown after more polls');
  assert.equal(waitingCount(list), 1);
  assert.equal(reconcileEchoes(list, rows), list, 'a settled list comes back as the same array (no re-render, no outbox write per poll)');
  // Queued first, then written as a real row: the hidden one follows it.
  let q = reconcileEchoes([{ ...a, acked: false }, b], [{ role: 'user', content: 'grape', queued: true }]);
  q = reconcileEchoes(q, rows);
  assert.deepEqual(shownEchoes(q).map((e) => e.sendId), ['sb']);
  // Once nothing with those words waits, the hidden one goes.
  assert.deepEqual(reconcileEchoes(list.filter((e) => e.sendId !== 'sb'), rows), []);
});

test('across a visit, a taken or confirmed message still holds its row (Codex r29)', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const run = 'r'.repeat(32);
  const a = { content: 'grape', sendId: 'sa', runId: run, since: now - 2000, known: [], knownQueued: 0, acked: true };
  const b = { content: 'grape', sendId: 'sb', runId: run, since: now - 1000, known: [], knownQueued: 0, fail: 'unconfirmed' };
  const back = readOutbox(writeOutbox({}, 'T', [a, b], now), 'T', now);
  assert.deepEqual(back.map((e) => [e.sendId, !!e.done]), [['sa', true], ['sb', false]]);
  const rows = [{ id: 'g1', role: 'user', content: 'grape', timestamp: new Date(now - 500).toISOString() }];
  assert.deepEqual(shownEchoes(reconcileEchoes(back, rows)).map((e) => e.sendId), ['sb']);
  assert.deepEqual(readOutbox(writeOutbox({}, 'T', [a], now), 'T', now), [], 'alone, a taken one is not kept');
});

test('the outbox keeps every message the composer lets wait (Codex r29)', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const waiting = Array.from({ length: MAX_OUTSTANDING }, (_, i) => ({ content: `m${i}`, sendId: `s${i}`, runId: 'r'.repeat(32), since: now - i, known: [], knownQueued: 0 }));
  const back = readOutbox(writeOutbox({}, 'T', waiting, now), 'T', now);
  assert.deepEqual(back.map((e) => e.sendId), waiting.map((e) => e.sendId));
});

test('pruneEchoes keeps a confirmed one hidden and says so, the same array only when nothing changed (ship-test r29)', () => {
  const since = Date.parse('2026-11-14T22:24:24Z');
  const t = 'Reply with only the word peach.';
  const a = { content: t, sendId: 'a', since, at: since, known: [], knownQueued: 0, acked: true };
  const b = { content: t, sendId: 'b', since: since + 380, at: since + 380, known: [], knownQueued: 0, fail: 'unconfirmed' };
  const rows = [{ role: 'user', content: t, timestamp: '2026-11-14T22:24:25Z', id: '60cb90' }, { role: 'assistant', content: 'peach' }];
  const cur = [a, b];
  const next = pruneEchoes(cur, rows, undefined, since + 4000);
  assert.notEqual(next, cur, 'two in, two out, but one is now hidden: that is a change');
  assert.deepEqual(shownEchoes(next).map((e) => e.sendId), ['b']);
  assert.equal(pruneEchoes(next, rows, undefined, since + 8000), next, 'settled: the same array');
  const local = { content: 'hi', at: since };
  assert.deepEqual(pruneEchoes([local], [{ role: 'user', content: 'hi' }], undefined, since + 1000), [], 'a local echo goes once its words show');
  assert.deepEqual(pruneEchoes([local], [], undefined, since + ECHO_TTL_MS + 1), [], 'and after the wait');
  const failed = { ...b, fail: 'failed', at: since - 10 * ECHO_TTL_MS };
  assert.deepEqual(pruneEchoes([failed], [], undefined, since).map((e) => e.sendId), ['b'], 'a failed one stays');
});

test('past the wait, a taken phone message still holds its row while one with the same words waits', () => {
  const t0 = Date.parse('2026-11-14T22:30:00Z');
  const a = { content: 'go', sendId: 'a', since: t0, at: t0, known: [], knownQueued: 0, acked: true };
  const b = { content: 'go', sendId: 'b', since: t0 + 100, at: t0 + 100, known: [], knownQueued: 0, fail: 'unconfirmed' };
  const aged = ageEchoes([a, b], undefined, t0 + ECHO_TTL_MS + 1);
  assert.deepEqual(aged.map((e) => [e.sendId, !!e.done]), [['a', true], ['b', false]]);
  const late = [{ id: 'r1', role: 'user', content: 'go', timestamp: new Date(t0 + 200_000).toISOString() }];
  assert.deepEqual(shownEchoes(pruneEchoes(aged, late, undefined, t0 + 200_001)).map((e) => e.sendId), ['b'], 'the late row is the taken one\'s');
  assert.deepEqual(ageEchoes([a], undefined, t0 + ECHO_TTL_MS + 1), [], 'alone, it just goes');
  const fresh = [a, b];
  assert.equal(ageEchoes(fresh, undefined, t0 + 10), fresh, 'nothing due: the same array');
});
