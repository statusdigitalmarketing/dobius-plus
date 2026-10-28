// chat-service submit queue: what reaches the PTY, in what order, and what is
// withheld. The phone's Chat view and the desktop Chat pane both send through
// this, so a regression here types into someone's live shell.
// Run: node --import ./electron/__tests__/chat-service-register.mjs ./electron/__tests__/chat-service.test.mjs
import assert from 'node:assert/strict';
import { writes, ptys, writeTerminal, emitOutput } from './fake-terminal-manager.mjs';

const { submitPromptToTab, writeRawInput, selectorToken, submitPending } = await import('../chat-service.js');
let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };
const reset = () => { writes.length = 0; ptys.clear(); };
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

console.log(`\n${pass} passed`);
