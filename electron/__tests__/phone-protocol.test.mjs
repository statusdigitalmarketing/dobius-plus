import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePhoneRequest, validateAnswer, viewGenOf, MAX_TEXT } from '../phone-protocol.js';

const RUN = 'a'.repeat(32);
const SID = '01234567-89ab-cdef-0123-456789abcdef';
const ID = 'term-/Users/x/proj-3';

test('phoneTake: needs a session id and a generation, keeps only checked fields', () => {
  const r = validatePhoneRequest({ type: 'phoneTake', id: ID, sessionId: SID, gen: 4, extra: 'x' });
  assert.deepEqual(r, { ok: true, value: { type: 'phoneTake', id: ID, sessionId: SID, gen: 4 } });
  assert.equal(validatePhoneRequest({ type: 'phoneTake', id: ID, sessionId: 'nope', gen: 4 }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneTake', id: ID, sessionId: SID }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneTake', id: ID, sessionId: SID, gen: -1 }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneTake', id: ID, sessionId: SID, gen: 1.5 }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneTake', id: ID, sessionId: SID.toUpperCase(), gen: 0 }).ok, false);
});

test('tab id is required and bounded', () => {
  assert.equal(validatePhoneRequest({ type: 'phoneStateGet' }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneStateGet', id: '' }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneStateGet', id: 'x'.repeat(4097) }).ok, false);
  assert.deepEqual(validatePhoneRequest({ type: 'phoneStateGet', id: ID }), { ok: true, value: { type: 'phoneStateGet', id: ID } });
});

test('phoneSend: non-blank text within the cap and a send id', () => {
  const ok = validatePhoneRequest({ type: 'phoneSend', id: ID, runId: RUN, text: 'hi', sendId: 's_1-a' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.text, 'hi');
  assert.equal(validatePhoneRequest({ type: 'phoneSend', id: ID, runId: RUN, text: '   \n', sendId: 's' }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneSend', id: ID, runId: RUN, text: 'x'.repeat(MAX_TEXT + 1), sendId: 's' }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneSend', id: ID, runId: RUN, text: 'x'.repeat(MAX_TEXT), sendId: 's' }).ok, true);
  assert.equal(validatePhoneRequest({ type: 'phoneSend', id: ID, runId: RUN, text: 'hi', sendId: 'has space' }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneSend', id: ID, runId: RUN, text: 'hi' }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneSend', id: ID, runId: 'A'.repeat(32), text: 'hi', sendId: 's' }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneSend', id: ID, text: 'hi', sendId: 's' }).ok, false);
});

test('phoneStop and phoneGiveBack need only a run id', () => {
  for (const type of ['phoneStop', 'phoneGiveBack']) {
    assert.deepEqual(validatePhoneRequest({ type, id: ID, runId: RUN }), { ok: true, value: { type, id: ID, runId: RUN } });
    assert.equal(validatePhoneRequest({ type, id: ID, runId: RUN + 'a' }).ok, false);
  }
});

test('unknown types and non-objects are refused', () => {
  assert.equal(validatePhoneRequest(null).ok, false);
  assert.equal(validatePhoneRequest([]).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneEval', id: ID }).code, 'bad_request');
});

test('phoneAnswer: a question answer is copied onto a null-prototype object', () => {
  const r = validatePhoneRequest({
    type: 'phoneAnswer', id: ID, runId: RUN, requestId: 'toolu_01AbC',
    answer: { kind: 'question', answers: JSON.parse('{"__proto__":"Red","Size?":"Large"}') },
  });
  assert.equal(r.ok, true);
  assert.equal(Object.getPrototypeOf(r.value.answer.answers), null);
  assert.equal(r.value.answer.answers.__proto__, 'Red');
  assert.equal(r.value.answer.answers['Size?'], 'Large');
  assert.equal(validatePhoneRequest({ type: 'phoneAnswer', id: ID, runId: RUN, requestId: 'has space', answer: { kind: 'plan', approve: true } }).ok, false);
  assert.equal(validatePhoneRequest({ type: 'phoneAnswer', id: ID, runId: RUN, answer: { kind: 'plan', approve: true } }).ok, false);
});

test('question answers: 1 to 20, text only, bounded', () => {
  assert.equal(validateAnswer({ kind: 'question', answers: {} }).ok, false);
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, 'a']));
  assert.equal(validateAnswer({ kind: 'question', answers: many }).ok, false);
  assert.equal(validateAnswer({ kind: 'question', answers: { q: 1 } }).ok, false);
  assert.equal(validateAnswer({ kind: 'question', answers: { q: 'x'.repeat(MAX_TEXT + 1) } }).ok, false);
  assert.equal(validateAnswer({ kind: 'question', answers: { ['x'.repeat(MAX_TEXT + 1)]: 'a' } }).ok, false);
  assert.equal(validateAnswer({ kind: 'question', answers: ['a'] }).ok, false);
});

test('permission answers: always only with allow, note bounded', () => {
  assert.deepEqual(validateAnswer({ kind: 'permission', allow: true }), { ok: true, value: { kind: 'permission', allow: true, always: false, note: '' } });
  assert.deepEqual(validateAnswer({ kind: 'permission', allow: true, always: true }).value.always, true);
  assert.equal(validateAnswer({ kind: 'permission', allow: false, always: true }).ok, false);
  assert.equal(validateAnswer({ kind: 'permission', allow: 'yes' }).ok, false);
  assert.equal(validateAnswer({ kind: 'permission', allow: true, always: 'yes' }).ok, false);
  assert.equal(validateAnswer({ kind: 'permission', allow: false, note: 'x'.repeat(MAX_TEXT + 1) }).ok, false);
  assert.equal(validateAnswer({ kind: 'permission', allow: false, note: 'use the other file' }).value.note, 'use the other file');
});

test('plan answers: only the offered modes, and only on approve', () => {
  assert.equal(validateAnswer({ kind: 'plan', approve: true, mode: 'acceptEdits' }).value.mode, 'acceptEdits');
  assert.equal(validateAnswer({ kind: 'plan', approve: true }).value.mode, null);
  assert.equal(validateAnswer({ kind: 'plan', approve: true, mode: 'bypassPermissions' }).ok, false);
  assert.equal(validateAnswer({ kind: 'plan', approve: false, mode: 'default' }).ok, false);
  assert.equal(validateAnswer({ kind: 'plan', approve: 1 }).ok, false);
  assert.equal(validateAnswer({ kind: 'shell' }).ok, false);
});

test('viewGenOf: a non-negative safe integer or null', () => {
  assert.equal(viewGenOf({ gen: 3 }), 3);
  assert.equal(viewGenOf({ gen: 0 }), 0);
  assert.equal(viewGenOf({ gen: '3' }), null);
  assert.equal(viewGenOf({ gen: -1 }), null);
  assert.equal(viewGenOf({}), null);
  assert.equal(viewGenOf(null), null);
});
