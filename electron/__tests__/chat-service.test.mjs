// chat-service submit queue: what reaches the PTY, in what order, and what is
// withheld. The phone's Chat view and the desktop Chat pane both send through
// this, so a regression here types into someone's live shell.
// Run: node --import ./electron/__tests__/chat-service-register.mjs ./electron/__tests__/chat-service.test.mjs
import assert from 'node:assert/strict';
import { writes, ptys, writeTerminal, emitOutput, closing } from './fake-terminal-manager.mjs';

const { submitPromptToTab, writeRawInput, selectorToken, submitPending, selectorFingerprint } = await import('../chat-service.js');
let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };
const reset = () => { writes.length = 0; ptys.clear(); closing.clear(); };
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

console.log(`\n${pass} passed`);
