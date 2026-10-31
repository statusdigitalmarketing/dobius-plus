// Phone WS tab ops: every authorizeTab / input / submitPrompt gets an answer,
// and an ack means the text is in the PTY. Wired to the REAL chat-service over
// the recording terminal-manager fake, so "ack after write" is the actual queue.
// Run: node --import ./electron/__tests__/chat-service-register.mjs ./electron/__tests__/mobile-tab-ops.test.mjs
import assert from 'node:assert/strict';
import { writes, ptys, writeTerminal, closing } from './fake-terminal-manager.mjs';

const { writeRawInput, submitPromptDetailed, setInputHeldCheck } = await import('../chat-service.js');
const { handleTabOp, tabCandidates, validReqId, MAX_CANDIDATES } = await import('../mobile-tab-ops.js');

let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };
const PASTE = (t) => `\x1b[200~${t}\x1b[201~`;
const A = 'term-/Users/x/Projects (Code)/better-telehealth-83';
const B = 'term-/Users/y/work/better-telehealth-83';
const C = 'term-/Users/x/Projects (Code)/dobius-plus-2';

function harness({ live = [A, C], authed = [], allowed = () => true, maxBytes = 100 } = {}) {
  writes.length = 0; ptys.clear(); closing.clear();
  for (const id of live) ptys.set(id, { id });
  const sent = [];
  const accepted = [];
  const deps = {
    // Snapshot what the PTY had received at the moment of each reply.
    send: (obj) => sent.push({ ...obj, writesAtReply: writes.map((w) => w[1]) }),
    isLive: (id) => ptys.has(id),
    liveIds: () => [...ptys.keys()],
    authed: new Set(authed),
    maxBytes,
    stillOk: () => allowed(),
    writeRawInput,
    submitPrompt: submitPromptDetailed,
    onAccepted: (op, id) => accepted.push([op, id]),
  };
  return { deps, sent, accepted, run: (msg) => handleTabOp(msg, deps) };
}

// 1. A short id is never mapped: unknown_tab with the candidates, nothing
// written, even when exactly one live tab ends in it.
{
  const h = harness({ live: [A, C], authed: [A] });
  await h.run({ type: 'submitPrompt', id: 'better-telehealth-83', text: 'hi', reqId: 'r1' });
  assert.equal(h.sent.length, 1);
  const [e] = h.sent;
  assert.equal(e.type, 'opError');
  assert.equal(e.op, 'submitPrompt');
  assert.equal(e.code, 'unknown_tab');
  assert.equal(e.id, 'better-telehealth-83');
  assert.equal(e.reqId, 'r1');
  assert.deepEqual(e.candidates, [A]);
  assert.deepEqual(writes, []);
  assert.deepEqual(h.accepted, []);
  ok('short id with one candidate: unknown_tab, candidates, nothing written');
}
{
  const h = harness({ live: [A, B, C], authed: [A, B] });
  await h.run({ type: 'input', id: 'better-telehealth-83', data: 'x' });
  assert.equal(h.sent[0].code, 'unknown_tab');
  assert.deepEqual(h.sent[0].candidates, [A, B]);
  assert.equal(h.sent[0].reqId, null);
  assert.deepEqual(writes, []);
  await h.run({ type: 'input', id: 'term-better-telehealth-83', data: 'x' });
  assert.deepEqual(h.sent[1].candidates, [A, B]);
  await h.run({ type: 'input', id: 'term-/gone/better-telehealth-83', data: 'x' });
  assert.deepEqual(h.sent[2].candidates, []);
  ok('shared suffix: both projects listed, never picked');
}
{
  const many = Array.from({ length: 9 }, (_, i) => `term-/p${i}/proj-1`);
  assert.equal(tabCandidates('proj-1', many).length, MAX_CANDIDATES);
  assert.deepEqual(tabCandidates('', many), []);
  assert.deepEqual(tabCandidates('/proj-1', many), []);
  ok('candidates are capped');
}

// 2. authorizeTab: a live id is acked with the full id and recorded; an
// unknown one is refused and NOT recorded (it used to pre-authorize any string).
{
  const h = harness({ live: [A] });
  await h.run({ type: 'authorizeTab', id: 'better-telehealth-83', reqId: 7 });
  assert.equal(h.sent[0].code, 'unknown_tab');
  assert.equal(h.sent[0].reqId, 7);
  assert.equal(h.deps.authed.has('better-telehealth-83'), false);
  await h.run({ type: 'authorizeTab', id: A, reqId: 'a-1' });
  assert.deepEqual({ ...h.sent[1], writesAtReply: undefined }, { type: 'ack', op: 'authorizeTab', id: A, reqId: 'a-1', writesAtReply: undefined });
  assert.equal(h.deps.authed.has(A), true);
  ok('authorizeTab: ack for a live tab, unknown_tab (and no grant) otherwise');
}

// 3. A live tab this socket never authorized: refused, nothing written.
{
  const h = harness({ live: [A] });
  await h.run({ type: 'input', id: A, data: 'rm -rf ~\r', reqId: 'i' });
  await h.run({ type: 'submitPrompt', id: A, text: 'hello', reqId: 's' });
  assert.deepEqual(h.sent.map((m) => [m.type, m.code, m.reqId]), [['opError', 'not_authorized', 'i'], ['opError', 'not_authorized', 's']]);
  assert.deepEqual(writes, []);
  ok('unauthorized input and submit: not_authorized, nothing written');
}

// 4. Bad shapes, empty and oversized text. The cap is BYTES: 40 three-byte
// characters are 120 bytes against a 100-byte cap.
{
  const h = harness({ live: [A], authed: [A] });
  await h.run({ type: 'input', id: 5, data: 'x' });
  await h.run({ type: 'input', id: A, data: 5 });
  await h.run({ type: 'submitPrompt', id: A, text: 'x', reqId: { a: 1 } });
  await h.run({ type: 'submitPrompt', id: A, text: 'x', reqId: 'r'.repeat(65) });
  await h.run({ type: 'submitPrompt', id: A, text: '   \n ' });
  await h.run({ type: 'input', id: A, data: '' });
  await h.run({ type: 'submitPrompt', id: A, text: '€'.repeat(40) });
  await h.run({ type: 'input', id: A, data: 'x'.repeat(101) });
  assert.deepEqual(h.sent.map((m) => m.code),
    ['bad_request', 'bad_request', 'bad_request', 'bad_request', 'empty_text', 'empty_text', 'too_large', 'too_large']);
  assert.equal(h.sent[0].id, null);
  assert.equal(h.sent[2].reqId, null); // an invalid reqId is not echoed
  assert.ok(h.sent.every((m) => m.type === 'opError' && typeof m.message === 'string' && m.message.length > 0));
  assert.deepEqual(writes, []);
  assert.deepEqual(h.accepted, []);
  assert.equal(validReqId('r'.repeat(64)), true);
  assert.equal(validReqId(1.5), false);
  ok('bad types, empty and oversized text: each its own code, nothing written');
}

// 5. The submit ack goes out only after the Enter is in the PTY, and carries
// the reqId; input ack after its write.
{
  const h = harness({ live: [A], authed: [A] });
  await h.run({ type: 'submitPrompt', id: A, text: 'hello', reqId: 'abc' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'ack');
  assert.equal(h.sent[0].op, 'submitPrompt');
  assert.equal(h.sent[0].id, A);
  assert.equal(h.sent[0].reqId, 'abc');
  assert.deepEqual(h.sent[0].writesAtReply, [PASTE('hello'), '\r']);
  await h.run({ type: 'input', id: A, data: '1', reqId: 2 });
  assert.equal(h.sent[1].type, 'ack');
  assert.equal(h.sent[1].reqId, 2);
  assert.deepEqual(h.sent[1].writesAtReply, [PASTE('hello'), '\r', '1']);
  assert.deepEqual(h.accepted, [['submitPrompt', A], ['input', A]]);
  ok('ack only after the write, reqId echoed');
}

// 6. Several in flight: replies match their own reqId, in order, and a key
// queued behind a submit is acked only once it is written.
{
  const h = harness({ live: [A], authed: [A] });
  const p1 = h.run({ type: 'submitPrompt', id: A, text: 'one', reqId: 'p1' });
  const p2 = h.run({ type: 'input', id: A, data: 'k', reqId: 'k1' });
  const p3 = h.run({ type: 'submitPrompt', id: A, text: 'two', reqId: 'p2' });
  await Promise.all([p1, p2, p3]);
  const by = Object.fromEntries(h.sent.map((m) => [m.reqId, m]));
  assert.deepEqual(Object.keys(by).sort(), ['k1', 'p1', 'p2']);
  assert.ok(h.sent.every((m) => m.type === 'ack'));
  assert.ok(by.k1.writesAtReply.includes('k'));
  assert.deepEqual(writes.map((w) => w[1]), [PASTE('one'), '\r', 'k', PASTE('two'), '\r']);
  ok('concurrent requests: each reply carries its own reqId');
}

// 7. The tab exits before a queued write: tab_exited, not an ack.
{
  const h = harness({ live: [A], authed: [A] });
  const first = h.run({ type: 'submitPrompt', id: A, text: 'first', reqId: 'f' });
  const second = h.run({ type: 'submitPrompt', id: A, text: 'second', reqId: 's' });
  const key = h.run({ type: 'input', id: A, data: 'z', reqId: 'z' });
  ptys.delete(A); // the PTY exits while the first paste waits for its Enter
  await Promise.all([first, second, key]);
  const by = Object.fromEntries(h.sent.map((m) => [m.reqId, m.code]));
  assert.deepEqual(by, { f: 'tab_exited', s: 'tab_exited', z: 'tab_exited' });
  // f was pasted before the tab went: unknowable whether something submitted it.
  assert.deepEqual(h.sent.map((m) => [m.reqId, m.uncertain === true]).sort(), [['f', true], ['s', false], ['z', false]]);
  assert.ok(h.sent.every((m) => m.type === 'opError'));
  assert.deepEqual(writes.map((w) => w[1]), [PASTE('first')]);
  ok('tab exits before the write: tab_exited for every queued request');
}
{
  const h = harness({ live: [A], authed: [A] });
  closing.add(A);
  await h.run({ type: 'submitPrompt', id: A, text: 'x', reqId: 'c' });
  assert.equal(h.sent[0].code, 'tab_exited');
  assert.deepEqual(writes, []);
  ok('closing tab: tab_exited up front');
}

// 8. Revoked while queued, and a stranded paste.
{
  let allowed = true;
  const h = harness({ live: [A], authed: [A], allowed: () => allowed });
  const first = h.run({ type: 'submitPrompt', id: A, text: 'one', reqId: 'a' });
  const queued = h.run({ type: 'submitPrompt', id: A, text: 'two', reqId: 'b' });
  allowed = false;
  await Promise.all([first, queued]);
  const by = Object.fromEntries(h.sent.map((m) => [m.reqId, m.type === 'ack' ? 'ack' : m.code]));
  assert.deepEqual(by, { a: 'ack', b: 'revoked' });
  ok('revoked while queued: revoked; the paste already out still gets its Enter and ack');
}
{
  const h = harness({ live: [A], authed: [A] });
  const p = h.run({ type: 'submitPrompt', id: A, text: 'hello', reqId: 'x' });
  writeTerminal(A, 'q'); // another writer types during the Enter delay
  await p;
  assert.equal(h.sent[0].code, 'stranded');
  assert.equal(h.sent[0].uncertain, true); // that writer may have pressed Enter on it
  ok('foreign input during the Enter delay: stranded, uncertain');
}
{
  // Esc alone leaves the paste in the input line, where a person may still
  // press Enter on it: a caller must not resend it as unsent.
  const h = harness({ live: [A], authed: [A] });
  const p = h.run({ type: 'submitPrompt', id: A, text: 'hello', reqId: 'x' });
  writeRawInput(A, '\x1b');
  await p;
  assert.equal(h.sent[0].code, 'stranded');
  assert.equal(h.sent[0].uncertain, true);
  ok('Esc during the Enter delay: stranded, uncertain');
}
{
  const h = harness({ live: [A], authed: [A] });
  const p = h.run({ type: 'submitPrompt', id: A, text: 'hello', reqId: 'x' });
  const q = h.run({ type: 'submitPrompt', id: A, text: 'next', reqId: 'y' });
  await h.run({ type: 'input', id: A, data: '\x03', reqId: 'c' });
  await Promise.all([p, q]);
  const by = Object.fromEntries(h.sent.map((m) => [m.reqId, m.type === 'ack' ? 'ack' : m.code]));
  assert.deepEqual(by, { c: 'ack', x: 'cancelled', y: 'cancelled' });
  assert.ok(h.sent.every((m) => m.uncertain === undefined)); // erased: definitely unsent
  ok('Ctrl+C: acked, and the submits it dropped report cancelled');
}

// writeRawInput itself: a write to a tab with no PTY is not reported written.
{
  harness({ live: [A] });
  assert.deepEqual(await writeRawInput('term-/none-1', 'x'), { ok: false, reason: 'tab_exited' });
  assert.deepEqual(await writeRawInput(A, 'x'), { ok: true });
  assert.deepEqual(await writeRawInput(A, 'x', () => false), { ok: false, reason: 'not_allowed' });
  ok('writeRawInput reports a missing PTY, a write, and a revoked sender');
}

// 9. A throwing writer still answers.
{
  const h = harness({ live: [A], authed: [A] });
  h.deps.writeRawInput = () => { throw new Error('boom'); };
  await h.run({ type: 'input', id: A, data: 'x', reqId: 'w' });
  assert.equal(h.sent[0].code, 'write_failed');
  assert.equal(h.sent[0].uncertain, true);
  ok('a writer that throws: write_failed, still answered');
}

// 10. A PTY write that throws inside the queue answers every queued request
// and releases the queue for the next one.
{
  const h = harness({ live: [A], authed: [A] });
  const p1 = h.run({ type: 'submitPrompt', id: A, text: 'one', reqId: 'p1' });
  const k1 = h.run({ type: 'input', id: A, data: 'x', reqId: 'k1' });
  ptys.get(A).throwOnWrite = true; // the delayed Enter throws
  await Promise.all([p1, k1]);
  // p1 was pasted (maybe in the line); k1 was never written: plainly unsent.
  assert.deepEqual(h.sent.map((m) => [m.reqId, m.code, m.uncertain]).sort(), [['k1', 'write_failed', undefined], ['p1', 'write_failed', true]]);
  ptys.get(A).throwOnWrite = false;
  await h.run({ type: 'submitPrompt', id: A, text: 'after', reqId: 'p2' });
  assert.equal(h.sent[2].type, 'ack');
  ok('a throwing queued write: every request answered, queue released');
}

// 11. Back-to-back awaited submits: the second is queued in the same turn the
// first resolves in, and must still be written and settle.
{
  harness({ live: [A] });
  assert.deepEqual(await submitPromptDetailed(A, 'one'), { ok: true });
  const second = await Promise.race([submitPromptDetailed(A, 'two'), new Promise((r) => setTimeout(() => r('hung'), 2000))]);
  assert.deepEqual(second, { ok: true });
  assert.deepEqual(writes.map((w) => w[1]), [PASTE('one'), '\r', PASTE('two'), '\r']);
  ok('sequential awaited submits both land');
}

// 12. A cancel whose write throws did not erase anything: the paste it never
// cleared is uncertain, not "cancelled".
{
  const h = harness({ live: [A], authed: [A] });
  const p = h.run({ type: 'submitPrompt', id: A, text: 'deploy', reqId: 'd' });
  ptys.get(A).throwOnWrite = true;
  await h.run({ type: 'input', id: A, data: '\x15', reqId: 'u' });
  ptys.get(A).throwOnWrite = false;
  await p;
  const by = Object.fromEntries(h.sent.map((m) => [m.reqId, [m.code, m.uncertain === true]]));
  assert.deepEqual(by, { u: ['write_failed', true], d: ['stranded', true] });
  ok('a cancel that failed to write is not an erase');
}

// 13. Once the PTY is replaced, a cancel on the new one proves nothing about
// the paste in the old one.
{
  const h = harness({ live: [A], authed: [A] });
  const p = h.run({ type: 'submitPrompt', id: A, text: 'deploy', reqId: 'd' });
  ptys.set(A, { replacement: true });
  writeRawInput(A, '\x15');
  await p;
  assert.deepEqual([h.sent[0].code, h.sent[0].uncertain], ['tab_exited', true]);
  ok('replaced PTY: tab_exited stays uncertain whatever the new one sees');
}

// 14. release/2.0.0 paths report in the result scheme. A prompt-only paste
// behind a running submit is dropped (its own reason), and a submit queued
// behind it is cancelled, nothing pasted, nothing uncertain.
{
  // A tab that has never had an Enter, so only the running-submit rule applies.
  const F = 'term-/Users/x/fresh-1';
  harness({ live: [F] });
  const first = submitPromptDetailed(F, 'one');
  const queued = submitPromptDetailed(F, 'two');
  const paste = await writeRawInput(F, '/tmp/shot.png ', () => true, { promptOnly: true });
  assert.deepEqual(paste, { ok: false, reason: 'prompt_dropped' });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await queued, { ok: false, reason: 'cancelled' });
  assert.deepEqual(writes.map((w) => w[1]), [PASTE('one'), '\r']);
  ok('prompt-only paste dropped; the submit behind it is cancelled, not uncertain');
}
{
  // Within the settle window after an Enter, a prompt-only paste is dropped
  // even on an idle tab.
  harness({ live: [A] });
  await submitPromptDetailed(A, 'one');
  assert.deepEqual(await writeRawInput(A, '/tmp/x ', () => true, { promptOnly: true }), { ok: false, reason: 'prompt_dropped' });
  ok('prompt-only paste just after an Enter: prompt_dropped');
}
// 15. Held input: keys go straight through while a submit waits for it (a
// resolved result), and a Ctrl+C during the wait cancels the submit plainly.
{
  const h = harness({ live: [A], authed: [A] });
  let held = true;
  setInputHeldCheck(() => held, () => {});
  try {
    const sub = h.run({ type: 'submitPrompt', id: A, text: 'later', reqId: 's' });
    await new Promise((r) => setTimeout(r, 120)); // the submit is now waiting
    const key = await writeRawInput(A, 'k');
    assert.deepEqual(key, { ok: true });
    await h.run({ type: 'input', id: A, data: '\x03', reqId: 'c' });
    await sub;
    const by = Object.fromEntries(h.sent.map((m) => [m.reqId, [m.type, m.code, m.uncertain]]));
    assert.deepEqual(by, { c: ['ack', undefined, undefined], s: ['opError', 'cancelled', undefined] });
    assert.deepEqual(writes.map((w) => w[1]), ['k', '\x03']);
  } finally {
    held = false;
    setInputHeldCheck(() => false, () => {});
  }
  ok('held input: keys pass with a result; Ctrl+C cancels the waiting submit');
}

// 16. A Ctrl+C whose write throws still cancels a submit waiting on held
// input (release/2.0.0), and a key queued after the PTY exited reports so.
{
  harness({ live: [A] });
  let held = true;
  setInputHeldCheck(() => held, () => {});
  try {
    const sub = submitPromptDetailed(A, 'deploy');
    await new Promise((r) => setTimeout(r, 120));
    ptys.get(A).throwOnWrite = true;
    assert.throws(() => writeRawInput(A, '\x03'));
    ptys.get(A).throwOnWrite = false;
    held = false;
    assert.deepEqual(await sub, { ok: false, reason: 'cancelled' });
    assert.deepEqual(writes.map((w) => w[1]), []);
  } finally {
    held = false;
    setInputHeldCheck(() => false, () => {});
  }
  ok('a cancel that failed to write still cancels a waiting submit');
}
{
  harness({ live: [A] });
  const sub = submitPromptDetailed(A, 'one');
  ptys.delete(A); // exits during the Enter delay
  assert.deepEqual(await writeRawInput(A, 'k'), { ok: false, reason: 'tab_exited' });
  await sub;
  ok('a key behind a submit on an exited PTY: tab_exited, not ok');
}

console.log(`\n${pass} passed`);
