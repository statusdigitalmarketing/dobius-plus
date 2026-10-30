// chat-service submit queue: what reaches the PTY, in what order, and what is
// withheld. The phone's Chat view and the desktop Chat pane both send through
// this, so a regression here types into someone's live shell.
// Run: node --import ./electron/__tests__/chat-service-register.mjs ./electron/__tests__/chat-service.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writes, ptys, writeTerminal, emitOutput, emitRawOutput, closing, buffers, inputAges } from './fake-terminal-manager.mjs';

const { submitPromptToTab, writeRawInput, selectorToken, submitPending, selectorFingerprint, readSelectorForAnswer, answerSelector } = await import('../chat-service.js');
let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };
const reset = () => { writes.length = 0; ptys.clear(); closing.clear(); buffers.clear(); inputAges.clear(); };
const PASTE = (t) => `\x1b[200~${t}\x1b[201~`;

// 1. An idle tab is pasted into synchronously; Enter follows on its own.
reset(); ptys.set('a', {});
let p = submitPromptToTab('a', 'hello');
assert.deepEqual(writes, [['a', PASTE('hello')]]);
assert.equal(await p, true);
assert.deepEqual(writes, [['a', PASTE('hello')], ['a', '\r']]);
ok('idle tab: paste now, Enter after');

// 2. Overlapping submits serialize: never two pastes before one Enter.
reset(); ptys.set('a', {});
let r = await Promise.all([submitPromptToTab('a', 'one'), submitPromptToTab('a', 'two')]);
assert.deepEqual(r, [true, true]);
assert.deepEqual(writes.map((w) => w[1]), [PASTE('one'), '\r', PASTE('two'), '\r']);
ok('overlapping submits run one at a time');

// 3. The PTY is captured at accept time: a queued submit never lands in a
// shell that replaced it, and the in-flight one withholds its Enter.
reset(); ptys.set('a', { gen: 1 });
p = submitPromptToTab('a', 'first');
const q2 = submitPromptToTab('a', 'touch /tmp/marker');
ptys.set('a', { gen: 2 });
r = await Promise.all([p, q2]);
assert.deepEqual(r, [false, false]);
assert.deepEqual(writes.map((w) => w[1]), [PASTE('first')]);
ok('replaced PTY: no Enter, queued submit dropped');

// 4. The caller's check gates the paste; a paste that went out always gets
// its Enter (a phone that drops mid-submit must not leave half-typed text to
// be glued onto the next message).
reset(); ptys.set('a', {});
let allowed = true;
p = submitPromptToTab('a', 'x', () => allowed);
const p4 = submitPromptToTab('a', 'y', () => allowed);
allowed = false;
assert.deepEqual(await Promise.all([p, p4]), [true, false]);
assert.deepEqual(writes.map((w) => w[1]), [PASTE('x'), '\r']);
ok('stillOk gates the paste, never strands one without its Enter');

// 5. Rejected up front: no PTY, or not allowed.
reset();
assert.equal(await submitPromptToTab('none', 'x'), false);
ptys.set('a', {});
assert.equal(await submitPromptToTab('a', 'x', () => false), false);
assert.equal(writes.length, 0);
ok('no PTY / not allowed: nothing written');

// 6. A cancel key drops what is still queued, not what was already pasted.
reset(); ptys.set('a', {});
p = submitPromptToTab('a', 'echo first');
const p2 = submitPromptToTab('a', 'touch /tmp/second');
writeRawInput('a', '\x03');
r = await Promise.all([p, p2]);
assert.deepEqual(r, [false, false]);
assert.deepEqual(writes.map((w) => w[1]), [PASTE('echo first'), '\x03']);
ok('Ctrl+C goes at once, drops queued submits and withholds the pending Enter');

// 7. Ordinary keys and escape sequences do not cancel anything.
reset(); ptys.set('a', {});
p = submitPromptToTab('a', 'one');
const p3 = submitPromptToTab('a', 'two');
for (const k of ['a', '\x1b[A', '\x1b[I', ' ']) writeRawInput('a', k);
assert.deepEqual(await Promise.all([p, p3]), [true, true]);
await new Promise((r) => setTimeout(r, 200)); // the queued keys are paced
assert.deepEqual(writes.map((w) => w[1]), [PASTE('one'), '\r', PASTE('two'), '\r', 'a', '\x1b[A', '\x1b[I', ' ']);
ok('ordinary keys do not cancel, and wait behind the pending submits');

// 8. Control characters are stripped except tab and newline, so the paste
// cannot end its own bracket or carry an Enter.
reset(); ptys.set('a', {});
await submitPromptToTab('a', 'a\tb\nc\rd\x1b[201~e\x03f');
assert.equal(writes[0][1], PASTE('a\tb\ncd[201~ef'));
ok('control characters stripped');

// 9. Separate tabs do not wait on each other.
reset(); ptys.set('a', {}); ptys.set('b', {});
p = submitPromptToTab('a', 'A');
const pb = submitPromptToTab('b', 'B');
assert.deepEqual(writes.map((w) => w.join(':')), [`a:${PASTE('A')}`, `b:${PASTE('B')}`]);
await Promise.all([p, pb]);
ok('tabs are independent');

// 10. Selector token: same PTY and no input since, or it is stale.
reset(); ptys.set('a', {});
emitOutput('a');
const t1 = selectorToken('a');
assert.equal(selectorToken('a'), t1);
writeTerminal('a', '1'); // the phone answered
emitOutput('a');
assert.notEqual(selectorToken('a'), t1);
const t2 = selectorToken('a');
ptys.set('a', {}); // replaced PTY, same id
assert.notEqual(selectorToken('a'), t2);
ptys.clear();
assert.equal(selectorToken('a'), '');
ok('selector token goes stale on any input or a new PTY');

// 11. No token until the screen has repainted since the last input: a read
// taken before Claude redraws still shows the prompt that input answered.
reset(); ptys.set('a', {});
writeTerminal('a', '1');
assert.equal(selectorToken('a'), '');
emitOutput('a');
assert.notEqual(selectorToken('a'), '');
ok('no token on a screen not yet repainted after input');

// 12. Another writer during the Enter delay: the Enter is withheld, so it
// cannot run whatever is now on the line.
reset(); ptys.set('a', {});
p = submitPromptToTab('a', 'echo safe');
writeTerminal('a', 'touch /tmp/unreviewed');
assert.equal(await p, false);
assert.deepEqual(writes.map((w) => w[1]), [PASTE('echo safe'), 'touch /tmp/unreviewed']);
ok('input during the delay withholds the Enter');

// 13. Idle tab: raw keys go straight through; submitPending tracks the queue.
reset(); ptys.set('a', {});
writeRawInput('a', 'ls');
assert.deepEqual(writes.map((w) => w[1]), ['ls']);
assert.equal(submitPending('a'), false);
p = submitPromptToTab('a', 'x');
assert.equal(submitPending('a'), true);
await p;
assert.equal(submitPending('a'), false);
ok('idle raw input is immediate; submitPending follows the queue');

// 14. A tab being closed: the pending Enter and the queued submit are dropped.
reset(); ptys.set('a', {});
p = submitPromptToTab('a', 'echo first');
const pl = submitPromptToTab('a', 'touch /tmp/late');
closing.add('a');
assert.deepEqual(await Promise.all([p, pl]), [false, false]);
assert.deepEqual(writes.map((w) => w[1]), [PASTE('echo first')]);
assert.equal(await submitPromptToTab('a', 'x'), false);
ok('closing tab: no Enter, nothing more pasted');

// 15. Keys that waited behind a submit go out as separate writes with a gap.
reset(); ptys.set('a', {});
p = submitPromptToTab('a', 'one');
for (const k of ['o', 'k', '\r']) writeRawInput('a', k);
const stamps = [];
const origPush = writes.push.bind(writes);
writes.push = (w) => { stamps.push(Date.now()); return origPush(w); };
await p; await new Promise((r) => setTimeout(r, 200));
writes.push = origPush;
assert.deepEqual(writes.map((w) => w[1]), [PASTE('one'), '\r', 'o', 'k', '\r']);
for (let i = 2; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= 15, `gap ${stamps[i] - stamps[i - 1]}ms`);
ok('queued keys are paced, not one burst');

// 16. A queued key whose sender lost its pairing during the pacing gap is
// dropped: the check runs again after the wait, not only before it.
reset(); ptys.set('a', {});
writes.push = Array.prototype.push;
let keyOk = true;
p = submitPromptToTab('a', 'one');
writeRawInput('a', 'k', () => keyOk);
await p; // the drain has taken 'k' and is waiting out the gap
keyOk = false;
await new Promise((r) => setTimeout(r, 100));
assert.deepEqual(writes.map((w) => w[1]), [PASTE('one'), '\r']);
ok('queued key rechecks its sender after the gap');

// 17. A revoked sender's raw frame is dropped outright, even a cancel key
// (which would otherwise also discard another surface's pending submit).
reset(); ptys.set('a', {});
writeRawInput('a', 'ls', () => false);
p = submitPromptToTab('a', 'desk');
writeRawInput('a', '\x03', () => false);
assert.equal(await p, true);
assert.deepEqual(writes.map((w) => w[1]), [PASTE('desk'), '\r']);
ok('revoked sender: no raw write, no cancel');

// 18. A selector's fingerprint is its question and options, not its cursor:
// an arrow key keeps it, a different prompt (even with equal labels) does not.
{
  const A = { prompt: 'Pick a color', options: [{ num: 1, label: 'Red' }, { num: 2, label: 'Blue' }], selectedIndex: 0 };
  assert.equal(selectorFingerprint(A), selectorFingerprint({ ...A, selectedIndex: 1 }));
  assert.notEqual(selectorFingerprint(A), selectorFingerprint({ ...A, prompt: 'Delete these files?' }));
  assert.notEqual(selectorFingerprint(A), selectorFingerprint({ ...A, options: [{ num: 1, label: 'Yes' }, { num: 2, label: 'Blue' }] }));
  assert.equal(selectorFingerprint(null), '');
  assert.equal(selectorFingerprint(A).length, 16);
}
ok('selector fingerprint tracks the prompt, not the cursor');

// 19. A paste whose Enter is withheld reports itself stranded (its text sits
// in the input line); one dropped before pasting, or into a gone PTY, does not.
reset(); ptys.set('a', {});
let strandedA = 0, strandedB = 0;
p = submitPromptToTab('a', 'one', undefined, () => { strandedA += 1; });
const pB = submitPromptToTab('a', 'two', undefined, () => { strandedB += 1; });
writeRawInput('a', '\x1b'); // a cancel key during the Enter delay
assert.deepEqual(await Promise.all([p, pB]), [false, false]);
assert.deepEqual([strandedA, strandedB], [1, 0]);
reset(); ptys.set('a', { gen: 1 });
let strandedC = 0;
p = submitPromptToTab('a', 'x', undefined, () => { strandedC += 1; });
ptys.set('a', { gen: 2 });
assert.equal(await p, false);
assert.equal(strandedC, 0);
reset(); ptys.set('a', {});
let strandedD = 0;
p = submitPromptToTab('a', 'y', undefined, () => { strandedD += 1; });
writeRawInput('a', '\x03'); // Ctrl+C erases the pasted line: nothing is left behind
assert.equal(await p, false);
assert.equal(strandedD, 0);
ok('a withheld Enter reports the paste as stranded');
// 20. Ctrl+U then Esc: the Esc is the latest cancel, but the line was still
// erased, so the paste must not be reported as sitting in the terminal.
reset(); ptys.set('a', {});
let strandedE = 0;
p = submitPromptToTab('a', 'deploy notes', undefined, () => { strandedE += 1; });
writeRawInput('a', '\x15');
writeRawInput('a', '\x1b');
assert.equal(await p, false);
assert.equal(strandedE, 0);
ok('an erasing cancel followed by Esc is not stranded');
// 21. Another writer's Enter during the delay may have SENT the paste before a
// Ctrl+U arrived: the line being cleared afterwards does not prove it unsent,
// so it is reported stranded (check the terminal), never "not sent".
reset(); ptys.set('a', {});
let strandedF = 0;
p = submitPromptToTab('a', 'ship it', undefined, () => { strandedF += 1; });
writeTerminal('a', '\r'); // e.g. the desktop terminal or /tabSend pressed Enter
writeRawInput('a', '\x15');
assert.equal(await p, false);
assert.equal(strandedF, 1);
ok('a foreign write before the erase is stranded, not unsent');
// 22. The shared answer path: a card read off a real prompt answers it once;
// any output after the read, even one that draws nothing printable, makes the
// card stale and nothing is written (Codex Critical: two prompts can look the
// same, so only "nothing reached the tab since" proves it is the same one).
{
  const ASKQ = readFileSync(new URL('./fixtures/askq-2.1.224-raw.txt', import.meta.url), 'utf8');
  reset(); ptys.set('a', {}); buffers.set('a', ASKQ); emitOutput('a');
  const r = await readSelectorForAnswer('a');
  assert.ok(r && r.selector && r.selector.options.length > 1, 'fixture parses as a selector');
  assert.equal(typeof r.token, 'string');
  emitRawOutput('a'); // a repaint after the read
  assert.deepEqual(await answerSelector('a', '1', r.token), { ok: false, stale: true });
  assert.deepEqual([...writes], []);
  const r2 = await readSelectorForAnswer('a');
  const done = await answerSelector('a', '1', r2.token);
  assert.equal(done.ok, true);
  assert.deepEqual([...writes], [['a', '1']]);
  assert.equal(done.token, ''); // not repainted since that key: no next token
  // The same token cannot answer twice.
  emitOutput('a');
  assert.deepEqual(await answerSelector('a', '1', r2.token), { ok: false, stale: true });
  assert.deepEqual([...writes], [['a', '1']]);
  // Not settled since input: the card stays, unanswerable, and the prompt
  // comes along for display only (an older phone keeps showing it).
  writeTerminal('a', 'x');
  const u = await readSelectorForAnswer('a');
  assert.equal(u.unsettled, true);
  assert.equal(u.token, undefined);
  assert.ok(u.selector.options.length > 1);
  // A key that drew nothing: after a long quiet the screen counts as current.
  inputAges.set('a', 3000);
  const q = await readSelectorForAnswer('a');
  assert.equal(typeof q.token, 'string');
  emitRawOutput('a'); // ...but a late repaint still makes that card stale
  assert.deepEqual(await answerSelector('a', '1', q.token), { ok: false, stale: true });
  inputAges.delete('a');
  // A revoked caller gets nothing back and writes nothing.
  emitOutput('a');
  assert.equal(await readSelectorForAnswer('a', () => false), null);
  const r3 = await readSelectorForAnswer('a');
  assert.deepEqual(await answerSelector('a', '1', r3.token, () => false), { ok: false, stale: true });
  assert.deepEqual(await answerSelector('a', '1'.repeat(17), r3.token), { ok: false });
  assert.equal(writes.length, 2);
}
ok('a card answers once, and never after the tab moved');

// 23. One frame holding Enter AND Ctrl+U (an Enter that sent the paste, then
// an erase) is another writer's input, so the paste is stranded, not unsent.
reset(); ptys.set('a', {});
let strandedG = 0;
p = submitPromptToTab('a', 'echo once', undefined, () => { strandedG += 1; });
writeRawInput('a', '\r\x15');
assert.equal(await p, false);
assert.equal(strandedG, 1);
ok('an Enter riding with a cancel key is not counted as our own erase');

// 24. The activity read replays a 64KB tail through the screen emulator. A cut
// inside an escape sequence must not print its leftover bytes in front of the
// spinner (the anchored parse then finds nothing).
{
  const { activityForTab } = await import('../chat-service.js');
  reset(); ptys.set('a', {});
  const spin = '\r\x1b[2K\x1b[31m\u2733 Proofing\u2026 (40s \u00b7 \u2193 900 tokens)\x1b[0m';
  // Put the 64KB cut two characters into "\x1b[31m" (just after "\x1b["),
  // padding after the spinner with BEL, which prints nothing.
  const head = 'x'.repeat(100) + spin;
  const cut = 100 + spin.indexOf('\x1b[31m') + 2;
  const raw = head + '\x07'.repeat(65536 - (head.length - cut));
  assert.equal(raw.slice(-65536).slice(0, 3), '31m', 'the cut lands inside the escape');
  buffers.set('a', raw);
  const act = await activityForTab('a');
  assert.equal(act?.verb, 'Proofing');
  assert.equal(act?.seconds, 40);
  assert.equal(act?.tokens, 900);
  ok('an activity read cut inside an escape still finds the spinner');
}

// 25. A restart must never reissue a token from before it: two module
// instances (two app processes) with identical counters mint different tokens.
{
  reset(); ptys.set('a', {}); emitOutput('a');
  const a = (await import('../chat-service.js?boot=a')).selectorToken('a');
  const b = (await import('../chat-service.js?boot=b')).selectorToken('a');
  assert.ok(a && b, 'both settled');
  assert.notEqual(a, b, 'same counters, different process');
  ok('tokens from another app process never match');
}

// A window still holds input for the tab (prompt editing: an image paste
// being saved, keys typed after it). A Chat send, from the desktop or the
// phone, waits for it at the head of the queue, in order, and is cancelled
// by Ctrl+C or a replaced shell meanwhile.
{
  const { setInputHeldCheck } = await import('../chat-service.js');
  let held = true;
  setInputHeldCheck((id) => id === 'h' && held);
  const tick = (ms) => new Promise((res) => setTimeout(res, ms));
  reset(); ptys.set('h', {});
  const a = submitPromptToTab('h', 'A');
  const b = submitPromptToTab('h', 'B');
  await tick(120);
  assert.equal(writes.length, 0, 'nothing pasted while input is held');
  assert.equal(submitPending('h'), true);
  writeRawInput('h', "\x1b[200~'/tmp/shot.png'\x1b[201~"); // the held paste arrives first
  writeRawInput('h', '\r');
  held = false;
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.deepEqual(writes.map((w) => w[1]), ["\x1b[200~'/tmp/shot.png'\x1b[201~", '\r', PASTE('A'), '\r', PASTE('B'), '\r']);

  held = true;
  reset(); ptys.set('h', {});
  const c = submitPromptToTab('h', 'C');
  await tick(80);
  writeRawInput('h', '\x03');
  held = false;
  assert.equal(await c, false, 'Ctrl+C while it waited cancels it');
  assert.deepEqual(writes.map((w) => w[1]), ['\x03']);

  held = true;
  reset(); ptys.set('h', { gen: 1 });
  const d = submitPromptToTab('h', 'echo reviewed');
  await tick(80);
  ptys.set('h', { gen: 2 }); // the shell was replaced while it waited
  held = false;
  assert.equal(await d, false);
  assert.equal(writes.length, 0, 'nothing typed into the replacement');
  // Keys queued behind a submit that then waits for held input go first, in
  // order, before keys that come later (no suffix ahead of its prefix).
  const { noteHeldInput } = await import('../chat-service.js');
  held = false;
  reset(); ptys.set('h', {});
  const e1 = submitPromptToTab('h', 'one');
  const e2 = submitPromptToTab('h', 'two');
  writeRawInput('h', 'ab'); // queued behind both while "one" is running
  held = true;
  await tick(400); // "one" done; "two" now waits for the held input
  writeRawInput('h', 'cd');
  held = false;
  assert.deepEqual(await Promise.all([e1, e2]), [true, true]);
  assert.deepEqual(writes.map((w) => w[1]), [PASTE('one'), '\r', 'ab', 'cd', PASTE('two'), '\r']);

  // A cancel key the window took and holds cancels a waiting submit at once,
  // even if the window later drops it.
  held = true;
  reset(); ptys.set('h', {});
  const f = submitPromptToTab('h', 'F');
  await tick(80);
  noteHeldInput('h', '\x03');
  held = false;
  assert.equal(await f, false);
  assert.equal(writes.length, 0);

  // A path prompt editing pasted into Claude's prompt is dropped, not
  // delivered after a submit that may end Claude (/exit); idle it goes.
  reset(); ptys.set('h', {});
  const g = submitPromptToTab('h', '/exit');
  writeRawInput('h', "\x1b[200~'/p/deploy.sh'\x1b[201~", () => true, { promptOnly: true });
  writeRawInput('h', '\r');
  await g;
  await tick(100);
  assert.deepEqual(writes.map((w) => w[1]), [PASTE('/exit'), '\r', '\r'], 'the path never went out');
  // ...and so is one that comes just after the submit's Enter, even with the
  // queue finished (the screen it was checked on may predate that Enter).
  writeRawInput('h', "\x1b[200~'/p/a.png'\x1b[201~", () => true, { promptOnly: true });
  assert.equal(writes.length, 3, 'within a second of the Enter: dropped');
  await tick(1050);
  writeRawInput('h', "\x1b[200~'/p/a.png'\x1b[201~", () => true, { promptOnly: true });
  assert.equal(writes.at(-1)[1], "\x1b[200~'/p/a.png'\x1b[201~", 'later it goes');

  // Keys flushed ahead of a waiting submit are paced like queued keys: an
  // Enter right behind its text would read as a pasted newline.
  const stamps = [];
  const push0 = writes.push;
  writes.push = function (...a) { stamps.push(Date.now()); return push0.apply(this, a); };
  held = false;
  reset(); ptys.set('h', {});
  const k1 = submitPromptToTab('h', 'one');
  const k2 = submitPromptToTab('h', 'two');
  writeRawInput('h', 'x');
  writeRawInput('h', '\r');
  held = true;
  await tick(400);
  held = false;
  await Promise.all([k1, k2]);
  writes.push = push0;
  const order = writes.map((w) => w[1]);
  assert.deepEqual(order, [PASTE('one'), '\r', 'x', '\r', PASTE('two'), '\r']);
  assert.ok(stamps[2] - stamps[1] >= 15 && stamps[3] - stamps[2] >= 15, `paced: ${stamps.map((t) => t - stamps[0])}`);

  // An Enter this queue delivered late (a key that waited behind a submit)
  // starts the same one-second window: the window that typed it could not
  // see when it went out.
  held = false;
  reset(); ptys.set('h', {});
  const s1 = submitPromptToTab('h', 'A');
  for (const k of 'abcdefghijklmnopqrstuvwxyz') writeRawInput('h', k);
  writeRawInput('h', '\r');
  await s1;
  await tick(1100); // A's Enter is over a second old; the queued Enter is not
  writeRawInput('h', "\x1b[200~'/p/deploy.sh'\x1b[201~", () => true, { promptOnly: true });
  assert.equal(writes.at(-1)[1], '\r', 'dropped: the queued Enter went out under a second ago');

  // A prompt-only paste main drops cancels the submit waiting for it: never
  // sent without the attachment.
  held = false;
  await tick(1100); // clear of the previous case's Enter
  reset(); ptys.set('h', {});
  const t1 = submitPromptToTab('h', 'A');
  const t2 = submitPromptToTab('h', 'Describe this image');
  held = true; // an image paste is accepted while A waits for its Enter
  await t1;
  await tick(100); // B waits for the held paste
  writeRawInput('h', "\x1b[200~'/p/shot.png'\x1b[201~", () => true, { promptOnly: true }); // within a second of A's Enter
  held = false;
  assert.equal(await t2, false);
  assert.deepEqual(writes.map((w) => w[1]), [PASTE('A'), '\r']);

  // The drop also marks the window's hold as lost, for submits accepted later.
  const lostMarks = [];
  setInputHeldCheck((id) => id === 'h' && held, (id) => lostMarks.push(id));
  await tick(1100);
  reset(); ptys.set('h', {});
  await submitPromptToTab('h', 'C');
  writeRawInput('h', "\x1b[200~'/p/2.png'\x1b[201~", () => true, { promptOnly: true });
  assert.deepEqual(lostMarks, ['h']);

  // A window that held input is gone with it half sent: a waiting submit is
  // cancelled, never appended to the half.
  const { cancelQueuedSubmits } = await import('../chat-service.js');
  held = true;
  reset(); ptys.set('h', {});
  const w = submitPromptToTab('h', './backup.sh');
  await tick(80);
  held = false;
  cancelQueuedSubmits('h');
  assert.equal(await w, false);
  assert.equal(writes.length, 0);
  setInputHeldCheck(() => false);
  ok('a Chat send waits for held input, keeps its order, and is cancelled by Ctrl+C or a new shell');
}

console.log(`\n${pass} passed`);
