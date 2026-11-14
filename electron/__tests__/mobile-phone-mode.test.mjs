// The phone's phone-mode helpers (mobile/phone-mode.js): what a phoneState means for the screen and the answers each
// card sends, checked against the Mac's own validators so the two never disagree.
// Run: node --test electron/__tests__/mobile-phone-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneOffered, phoneKnown, sendOutcome, reconcileEchoes, pruneEchoes, ageEchoes, ECHO_TTL_MS, waitingCount, MAX_OUTSTANDING, OUTBOX_TABS, outboxFull, echoBaseline, readOutbox, writeOutbox, ARRIVAL_SKEW_MS, freshId, readPhoneState, questionAnswer, togglePick, permissionAnswer, planAnswer, refusalText } from '../../mobile/phone-mode.js';
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
  const echo = { content: 'continue', sendId: 's1', acked: true, since, ...echoBaseline('continue', [recent, { role: 'user', content: 'other', id: 'u0' }]) };
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
  map = writeOutbox(map, 'T', Array.from({ length: 25 }, (_, i) => e(i)), now);
  assert.equal(map.T.length, 20, 'a hard ceiling per tab (the composer keeps one page to 5)');
  map = writeOutbox(map, 'T', [], now);
  assert.equal('T' in map, false);
  let many = {};
  for (let i = 0; i < 50; i++) many = writeOutbox(many, `T${i}`, [e(i)], now);
  assert.equal(Object.keys(many).length, 40, 'a hard ceiling only a race past the composer can reach');
  assert.deepEqual(readOutbox({ T: [e(1, { since: now - 8 * 86_400_000 })] }, 'T', now), [], 'older than a week');
  assert.deepEqual(readOutbox({ T: [{ content: 5 }, null, e(1, { runId: 7 })] }, 'T', now), [], 'garbage is dropped');
  assert.deepEqual(readOutbox(null, 'T', now), []);
});

test('one transcript row clears one acked phone message, oldest first (Codex r29)', () => {
  const since = Date.parse('2026-11-14T16:00:00Z');
  const a = { content: 'continue', sendId: 'sa', since, known: [], knownQueued: 0, acked: true };
  const b = { content: 'continue', sendId: 'sb', since: since + 1000, known: [], knownQueued: 0, acked: true };
  const row = (id) => ({ id, role: 'user', content: 'continue', timestamp: '2026-11-14T16:00:05Z' });
  assert.deepEqual(reconcileEchoes([a, b], [row('u1')]).map((e) => e.sendId), ['sb']);
  assert.deepEqual(reconcileEchoes([a, b], [row('u1'), row('u2')]), []);
  const q = { role: 'user', content: 'continue', queued: true };
  assert.deepEqual(reconcileEchoes([a, b], [q]).map((e) => e.sendId), ['sb']);
  assert.deepEqual(reconcileEchoes([a, b], [q, q]), []);
  const same = [a];
  assert.equal(reconcileEchoes(same, []), same, 'nothing cleared: the same array back');
});

test('a row never clears a message the Mac did not say it took: only its own sendId settles it (Codex r29, r30)', () => {
  const since = Date.parse('2026-11-14T16:00:00Z');
  const rows = [{ id: 'q1', role: 'user', content: 'continue', timestamp: '2026-11-14T16:05:00Z' }];
  const lost = { content: 'continue', sendId: 'sa', since, known: [], knownQueued: 0, fail: 'unconfirmed' };
  const refused = { ...lost, sendId: 'sb', fail: 'failed' };
  const pending = { ...lost, sendId: 'sc', fail: null };
  // Another phone sent the same words and its row arrived: none of these is that message.
  assert.deepEqual(reconcileEchoes([lost, refused, pending], rows).map((e) => e.sendId), ['sa', 'sb', 'sc']);
  assert.deepEqual(reconcileEchoes([lost, refused, pending], [{ role: 'user', content: 'continue', queued: true }]).map((e) => e.sendId), ['sa', 'sb', 'sc']);
  // Send again answered (ack or duplicate): now it is the Mac's word, and a row may clear it.
  assert.deepEqual(reconcileEchoes([{ ...lost, fail: null, acked: true }], rows), []);
  assert.equal(waitingCount([lost, refused, pending, { ...lost, sendId: 'sd', acked: true, fail: null }]), 3);
});

test('pruneEchoes: acked ones by their rows, local ones by their words, the rest by age; the same array when nothing changed', () => {
  const since = Date.parse('2026-11-14T22:24:24Z');
  const t = 'Reply with only the word peach.';
  const a = { content: t, sendId: 'a', since, at: since, known: [], knownQueued: 0, acked: true };
  const b = { content: t, sendId: 'b', since: since + 380, at: since + 380, known: [], knownQueued: 0, fail: 'unconfirmed' };
  const rows = [{ role: 'user', content: t, timestamp: '2026-11-14T22:24:25Z', id: '60cb90' }, { role: 'assistant', content: 'peach' }];
  const next = pruneEchoes([a, b], rows, undefined, since + 4000);
  assert.deepEqual(next.map((e) => e.sendId), ['b']);
  assert.equal(pruneEchoes(next, rows, undefined, since + 8000), next, 'settled: the same array');
  assert.equal(pruneEchoes(next, rows, undefined, since + 10 * ECHO_TTL_MS), next, 'a message never confirmed does not age out');
  const local = { content: 'hi', at: since };
  assert.deepEqual(pruneEchoes([local], [{ role: 'user', content: 'hi' }], undefined, since + 1000), [], 'a local echo goes once its words show');
  assert.deepEqual(ageEchoes([local], since + ECHO_TTL_MS + 1), [], 'and after the wait');
  assert.deepEqual(ageEchoes([a], since + ECHO_TTL_MS + 1), [], 'an acked one whose row never came goes after the wait: the Mac has it');
});

test('the outbox keeps every message the composer lets wait, and no tab\'s are dropped for another\'s (Codex r29, r30)', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const msg = (i) => ({ content: `m${i}`, sendId: `s${i}`, runId: 'r'.repeat(32), since: now - i, known: [], knownQueued: 0 });
  const waiting = Array.from({ length: MAX_OUTSTANDING }, (_, i) => msg(i));
  assert.deepEqual(readOutbox(writeOutbox({}, 'T', waiting, now), 'T', now).map((e) => e.sendId), waiting.map((e) => e.sendId));
  let map = {};
  for (let i = 0; i < OUTBOX_TABS; i++) map = writeOutbox(map, `T${i}`, [msg(i)], now);
  assert.equal(outboxFull(map, 'new', now), true, 'a new tab may not start keeping messages');
  assert.equal(outboxFull(map, 'T3', now), false, 'a tab that already keeps some may add more (its own cap applies)');
  const over = writeOutbox(map, 'extra', [msg(99)], now); // past the limit only by a race
  assert.equal(outboxFull(over, 'T3', now), false, 'even past the limit, a tab already keeping some is never refused');
  assert.equal(outboxFull(writeOutbox(map, 'T3', [], now), 'new', now), false, 'room again once one is settled');
  assert.equal(outboxFull({ ...map, T0: [{ ...msg(0), since: now - 8 * 86_400_000 }] }, 'new', now), false, 'expired ones do not count');
  assert.equal(outboxFull(null, 'new', now), false);
});

test('a save replaces only the messages this page owns, never another open page\'s (Codex r31)', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const msg = (id, extra = {}) => ({ content: id, sendId: id, runId: 'r'.repeat(32), since: now - 10, known: [], knownQueued: 0, ...extra });
  // Page A sent A and saved it; page B, opened before, sends B and saves.
  let map = writeOutbox({}, 'T', [msg('A')], now, new Set(['A']));
  map = writeOutbox(map, 'T', [msg('B', { since: now })], now, new Set(['B']));
  assert.deepEqual(map.T.map((e) => e.sendId), ['A', 'B'], 'A survives B\'s save');
  // Page A settles A (taken): only A goes.
  map = writeOutbox(map, 'T', [{ ...msg('A'), acked: true }], now, new Set(['A']));
  assert.deepEqual(map.T.map((e) => e.sendId), ['B']);
  // Page B removes B: the tab is empty again.
  map = writeOutbox(map, 'T', [], now, new Set(['B']));
  assert.equal('T' in map, false);
  // Without an owner set the tab's entries are replaced outright.
  assert.deepEqual(writeOutbox({ T: [msg('A')] }, 'T', [msg('B')], now).T.map((e) => e.sendId), ['B']);
  // Two pages together can hold more than one page's five; reading keeps them all, up to the hard ceiling.
  let many = {};
  for (let i = 0; i < 8; i++) many = writeOutbox(many, 'T', [msg(`m${i}`, { since: now + i })], now, new Set([`m${i}`]));
  assert.equal(readOutbox(many, 'T', now).length, 8);
});
