// The phone's phone-mode helpers (mobile/phone-mode.js): what a phoneState means for the screen and the answers each
// card sends, checked against the Mac's own validators so the two never disagree.
// Run: node --test electron/__tests__/mobile-phone-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneOffered, phoneKnown, sendOutcome, reconcileEchoes, pruneEchoes, ageEchoes, ECHO_TTL_MS, waitingCount, MAX_OUTSTANDING, OUTBOX_TABS, outboxFull, echoBaseline, loadOutbox, saveOutbox, ARRIVAL_SKEW_MS, freshId, readPhoneState, questionAnswer, togglePick, permissionAnswer, planAnswer, refusalText } from '../../mobile/phone-mode.js';
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

// localStorage's methods over a Map, for the outbox tests.
function fakeStorage() {
  const m = new Map();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}
const BASE = 'dobius-mobile-phone-msg:pair1';
const RUN = 'r'.repeat(32);

test('the outbox keeps unanswered phone messages across visits and brings them back as not confirmed (Codex r28)', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const st = fakeStorage();
  const e = (i, extra = {}) => ({ content: `m${i}`, sendId: `s${i}`, runId: RUN, since: now - 100 + i, known: ['x'], knownQueued: 0, ...extra });
  saveOutbox(st, BASE, 'term-/p/a b:1', [e(1), e(2, { acked: true }), e(3, { fail: 'failed' })], new Set());
  assert.equal(st.keys().length, 2, 'a message the Mac took is not kept');
  const back = loadOutbox(st, BASE, 'term-/p/a b:1', now);
  assert.deepEqual(back.map((x) => [x.sendId, x.fail]), [['s1', 'unconfirmed'], ['s3', 'failed']]);
  assert.deepEqual(loadOutbox(st, BASE, 'term-/p/other', now), [], 'only this tab');
  saveOutbox(st, BASE, 'term-/p/a b:1', [], new Set(['s1', 's3']));
  assert.equal(st.keys().length, 0, 'settled ones are removed');
  st.setItem(`${BASE}|T|s9`, JSON.stringify(e(9, { sendId: 's9', since: now - 8 * 86_400_000 })));
  st.setItem(`${BASE}|T|s8`, '{not json');
  st.setItem(`${BASE}|T|s7`, JSON.stringify(e(7, { sendId: 'other' })));
  assert.deepEqual(loadOutbox(st, BASE, 'T', now), []);
  assert.equal(st.keys().length, 0, 'old, unreadable or mislabelled entries are removed on load');
  st.setItem('dobius-mobile-phone-msg:pair2|T|s1', JSON.stringify(e(1)));
  assert.deepEqual(loadOutbox(st, BASE, 'T', now), [], 'another pairing is not this one');
});

test('two pages on one phone never lose each other\'s messages, however their saves interleave (Codex r31, r32)', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const st = fakeStorage();
  const msg = (id, extra = {}) => ({ content: id, sendId: id, runId: RUN, since: now, known: [], knownQueued: 0, ...extra });
  // Both pages opened with nothing stored; each sends one whose answer is lost.
  const ownedA = new Set(); const ownedB = new Set();
  ownedA.add('A'); ownedB.add('B');
  saveOutbox(st, BASE, 'T', [msg('A', { fail: 'unconfirmed' })], ownedA);
  saveOutbox(st, BASE, 'T', [msg('B', { fail: 'unconfirmed' })], ownedB);
  assert.deepEqual(loadOutbox(st, BASE, 'T', now).map((e) => e.sendId).sort(), ['A', 'B']);
  // Page A's message is answered: only A's key goes.
  saveOutbox(st, BASE, 'T', [msg('A', { acked: true })], ownedA);
  assert.deepEqual(loadOutbox(st, BASE, 'T', now).map((e) => e.sendId), ['B']);
});

test('the composer keeps messages for at most OUTBOX_TABS tabs, never dropping one tab\'s for another\'s (Codex r30)', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const st = fakeStorage();
  const msg = (i) => ({ content: `m${i}`, sendId: `s${i}`, runId: RUN, since: now, known: [], knownQueued: 0 });
  for (let i = 0; i < OUTBOX_TABS; i++) saveOutbox(st, BASE, `T${i}`, [msg(i), msg(i + 100)], new Set());
  assert.equal(outboxFull(st, BASE, 'new', now), true, 'a new tab may not start keeping messages');
  assert.equal(outboxFull(st, BASE, 'T3', now), false, 'a tab that already keeps some may add more (its own cap applies)');
  saveOutbox(st, BASE, 'extra', [msg(99)], new Set()); // past the limit only by a race
  assert.equal(outboxFull(st, BASE, 'T3', now), false, 'even past the limit, a tab already keeping some is never refused');
  assert.equal(loadOutbox(st, BASE, 'T0', now).length, 2, 'nothing was evicted');
  saveOutbox(st, BASE, 'T4', [], new Set(['s4', 's104']));
  saveOutbox(st, BASE, 'extra', [], new Set(['s99']));
  assert.equal(outboxFull(st, BASE, 'new', now), false, 'room again once one is settled');
  st.setItem(`${BASE}|T5|s5`, JSON.stringify({ ...msg(5), since: now - 8 * 86_400_000 }));
  st.setItem(`${BASE}|T5|s105`, JSON.stringify({ ...msg(105), since: now - 8 * 86_400_000 }));
  saveOutbox(st, BASE, 'T4', [msg(4)], new Set());
  assert.equal(outboxFull(st, BASE, 'new', now), false, 'expired ones do not count');
  assert.equal(outboxFull(fakeStorage(), BASE, 'new', now), false);
});

test('a waiting message is rewritten only when it changed', () => {
  const st = fakeStorage();
  let writes = 0;
  const set = st.setItem; st.setItem = (k, v) => { writes += 1; set(k, v); };
  const m = { content: 'x', sendId: 's1', runId: RUN, since: 1, known: [], knownQueued: 0, fail: 'unconfirmed' };
  saveOutbox(st, BASE, 'T', [m], new Set());
  saveOutbox(st, BASE, 'T', [m], new Set(['s1']));
  assert.equal(writes, 1);
  saveOutbox(st, BASE, 'T', [{ ...m, fail: 'failed' }], new Set(['s1']));
  assert.equal(writes, 2);
});


test('expired entries of tabs never opened again are removed by the next scan (Codex r33)', () => {
  const now = Date.parse('2026-11-14T16:00:00Z');
  const st = fakeStorage();
  const old = (i) => ({ content: `m${i}`, sendId: `s${i}`, runId: RUN, since: now - 8 * 86_400_000, known: [], knownQueued: 0 });
  for (let i = 0; i < 100; i++) st.setItem(`${BASE}|T${i}|s${i}`, JSON.stringify(old(i)));
  st.setItem(`${BASE}|Tx|bad`, '{nope');
  st.setItem('unrelated', 'kept');
  assert.equal(outboxFull(st, BASE, 'new', now), false);
  assert.deepEqual(st.keys(), ['unrelated'], 'only what is not ours stays');
});
