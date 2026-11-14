// The phone's phone-mode helpers (mobile/phone-mode.js): what a phoneState means for the screen and the answers each
// card sends, checked against the Mac's own validators so the two never disagree.
// Run: node --test electron/__tests__/mobile-phone-mode.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneOffered, phoneKnown, sendOutcome, freshId, readPhoneState, questionAnswer, togglePick, permissionAnswer, planAnswer, refusalText } from '../../mobile/phone-mode.js';
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
