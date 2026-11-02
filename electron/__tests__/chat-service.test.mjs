// chat-service submit queue: what reaches the PTY, in what order, and what is
// withheld. The phone's Chat view and the desktop Chat pane both send through
// this, so a regression here types into someone's live shell.
// Run: node --import ./electron/__tests__/chat-service-register.mjs ./electron/__tests__/chat-service.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writes, ptys, writeTerminal, emitOutput, emitRawOutput, closing, buffers, inputAges, cols, altAtStart, trimmed } from './fake-terminal-manager.mjs';

const { submitPromptToTab, writeRawInput, selectorToken, submitPending, selectorFingerprint, readSelectorForAnswer, answerSelector } = await import('../chat-service.js');
let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };
const reset = () => { writes.length = 0; ptys.clear(); closing.clear(); buffers.clear(); inputAges.clear(); trimmed.clear(); };
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

// 22b. A permission prompt with Claude's unattended-session timer repaints
// every second. The timer ticking down is the one output that does not make
// a card stale (Sam: every phone tap said "the prompt changed"). A prompt
// whose timer started over, any input, or a prompt that reads differently
// still does. (Accepted risk: an identical replacement in the same timer
// second is indistinguishable and gets the tap; see answerSelector.)
{
  const frame = (t, cmd = 'mv a b') => [
    '', ' Bash command', '', `   ${cmd}`, '   Move the file aside', '',
    ` \x1b[33m\u26a0 Claude Code will automatically block this request in ${t}, to avoid holding up an unattended session\x1b[39m`, '',
    ' Do you want to proceed?', ' \u276f 1. Yes', '   2. No', '', ' Esc to cancel \u00b7 Tab to amend', '',
  ].join('\r\n');
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  // An ordinary 120 x 40 terminal: a full redraw fits what a read replays.
  const open = (t, cmd) => { reset(); ptys.set('a', {}); cols.set('a', 120); buffers.set('a', frame(t, cmd)); emitOutput('a'); };
  const tick = (t, cmd) => { buffers.set('a', frame(t, cmd)); emitRawOutput('a'); };
  try {
    open('1:26');
    const r = await readSelectorForAnswer('a');
    assert.ok(r && r.token, 'the timed prompt parses with a token');
    clock += 1000; tick('1:25');
    const later = await readSelectorForAnswer('a');
    assert.equal(later.token.split('|')[1], r.token.split('|')[1], 'the timer is not part of the fingerprint');
    clock += 3000; tick('1:22');
    const ans = await answerSelector('a', '1', r.token);
    assert.equal(ans.ok, true, 'a tap four seconds later still lands');
    assert.deepEqual([...writes], [['a', '1']]);

    // The timer starting over, or off by more than the slack.
    open('1:26');
    const r2 = await readSelectorForAnswer('a');
    clock += 2000; tick('1:30');
    assert.deepEqual(await answerSelector('a', '1', r2.token), { ok: false, stale: true });
    tick('1:15');
    assert.deepEqual(await answerSelector('a', '1', r2.token), { ok: false, stale: true });
    // A different command under the same timer.
    tick('1:24', 'rm -rf b');
    assert.deepEqual(await answerSelector('a', '1', r2.token), { ok: false, stale: true });
    // Input from anywhere, even with the timer exactly right.
    buffers.set('a', frame('1:24')); writeTerminal('a', 'x'); emitOutput('a');
    assert.deepEqual(await answerSelector('a', '1', r2.token), { ok: false, stale: true });
    assert.deepEqual([...writes], [['a', 'x']]);
    // A token this Mac never handed out has no reading to go by.
    open('1:26');
    const r3 = await readSelectorForAnswer('a');
    const [b3, f3] = r3.token.split('|');
    const forged = `${b3.slice(0, b3.lastIndexOf(':'))}:999|${f3}`;
    clock += 1000; tick('1:25');
    assert.deepEqual(await answerSelector('a', '1', forged), { ok: false, stale: true });
    // A screen too big for a full redraw to fit what a read replays keeps
    // the strict rule, timer or not.
    open('1:26'); cols.set('a', 1000);
    const big = await readSelectorForAnswer('a');
    clock += 1000; tick('1:25');
    assert.deepEqual(await answerSelector('a', '1', big.token), { ok: false, stale: true });
    // Accented text redrawn many times (thousands of combining marks over the
    // session) while the replay holds everything: the tap lands (Codex,
    // round 24: a history-wide budget refused it).
    const accents = (t2) => `${'cafe\u0301 '.repeat(3000)}\r\n${frame(t2)}`;
    open('1:26'); buffers.set('a', accents('1:26')); emitOutput('a');
    const ac = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', accents('1:25')); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', ac.token)).ok, true, 'accents alone are fine');
    writes.length = 0;
    // Marks that really push the command out of a trimmed replay: the
    // coverage check refuses it.
    const pushed = (cmd, t2) => `${cmd}\r\n${'\u0301'.repeat(300000)}\x1b[3;1H${frame(t2).replace(/^\r\n/, '')}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', pushed('rm -rf ./cache', '1:26')); emitOutput('a');
    const pm = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', pushed('rm -rf ./vault', '1:25')); emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', pm.token), { ok: false, stale: true });
    // A link longer than the replay, so the cut lands inside its URL.
    const huge = `\x1b]8;;https://x/${'a'.repeat(300000)}\x07L\x1b]8;;\x07`;
    open('1:26'); buffers.set('a', `rm -rf ./cache\r\n${huge}\r\n${frame('1:26')}`); emitOutput('a');
    const cut = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', `rm -rf ./vault\r\n${huge}\r\n${frame('1:25')}`); emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', cut.token), { ok: false, stale: true });
    // Visible output from before the replay (a flood of style resets pushed
    // the command out of it, in a buffer that has dropped its start): not
    // every cell was redrawn in the replay, so strict again.
    const flood = (cmd, t2) => `${cmd}\r\n${'\x1b[0m'.repeat(70000)}\x1b[3;1H${frame(t2).replace(/^\r\n/, '')}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', flood('rm -rf ./cache', '1:26')); emitOutput('a');
    const fl = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', flood('rm -rf ./vault', '1:25')); emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', fl.token), { ok: false, stale: true });
    // A long session whose buffer was trimmed but whose replay redrew the
    // whole screen (enough output scrolled every row through it): the tap
    // lands. (Fewer lines than that leave the ends of rows from before.)
    const scrolled = (t2) => `${'older line\r\n'.repeat(200)}${frame(t2)}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', scrolled('1:26')); emitOutput('a');
    const sc = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', scrolled('1:25')); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', sc.token)).ok, true, 'a fully redrawn screen');
    writes.length = 0;
    // An erase that redraws the screen only from where the replay happens to
    // start (the top-left) proves nothing: the real cursor stood elsewhere.
    const erase = (cmd, t2) => `${cmd}\r\n\x1b[3;1H${'\x1b[0m'.repeat(70000)}\x1b[J\x1b[5;1H${frame(t2).replace(/^\r\n/, '')}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', erase('rm -rf ./cache', '1:26')); emitOutput('a');
    const er = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', erase('rm -rf ./vault', '1:25')); emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', er.token), { ok: false, stale: true });
    // The alternate screen already active where the replay begins: a further
    // switch keeps the real content but shows a blank screen in the replay.
    const alt = (t2) => `\x1b[?1049hrm -rf ./cache\r\n${'\x1b[0m'.repeat(70000)}\x1b[?1049h\x1b[5;1H${frame(t2).replace(/^\r\n/, '')}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', alt('1:26')); emitOutput('a');
    const al = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', alt('1:25')); emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', al.token), { ok: false, stale: true });
    // A session that simply runs on the alternate screen (no further switch
    // in the replay), fully redrawn: the tap lands.
    const altRun = (t2) => `\x1b[?1049h${'older line\r\n'.repeat(200)}${frame(t2)}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', altRun('1:26')); emitOutput('a');
    const ar = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', altRun('1:25')); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', ar.token)).ok, true, 'a session on the alternate screen');
    writes.length = 0;
    // A combined mode list switching buffers after an alternate-screen cut.
    const comb = (t2) => `\x1b[?1049hrm -rf ./cache\r\n${'\x1b[0m'.repeat(70000)}\x1b[?25;1049h\x1b[5;1H${frame(t2).replace(/^\r\n/, '')}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', comb('1:26')); emitOutput('a');
    const cb = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', comb('1:25')); emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', cb.token), { ok: false, stale: true });
    // A cursor restore with no save in the replay: the save was before it.
    const restore = (t2) => `rm -rf ./cache\r\n\x1b[3;1H\x1b7${'\x1b[0m'.repeat(70000)}\x1b8\x1b[J${frame(t2).replace(/^\r\n/, '')}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', restore('1:26')); emitOutput('a');
    const rr = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', restore('1:25')); emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', rr.token), { ok: false, stale: true });
    // A restore whose save was cut off, then Claude entering and redrawing
    // the alternate screen: fully redrawn, the tap lands.
    const late = (t2) => `\x1b7${'\x1b[0m'.repeat(70000)}\x1b8\x1b[?1049h${'older line\r\n'.repeat(200)}${frame(t2)}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', late('1:26')); emitOutput('a');
    const lt = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', late('1:25')); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', lt.token)).ok, true, 'a cut-off restore, then a full redraw');
    writes.length = 0;
    // Claude's own save then restore inside the replay is fine.
    const paired = (t2) => `${'older line\r\n'.repeat(200)}\x1b7\x1b[2;1Hx\x1b8${frame(t2)}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', paired('1:26')); emitOutput('a');
    const pr = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', paired('1:25')); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', pr.token)).ok, true, 'a save and restore inside the replay');
    writes.length = 0;
    // Claude quit and started again in an alternate-screen session: leave,
    // then enter, clears the alternate screen in both; the tap lands.
    const restart = (t2) => `\x1b[?1049hold screen\r\n${'\x1b[0m'.repeat(70000)}\x1b[?1049l$ claude\r\n\x1b[?1049h${'older line\r\n'.repeat(200)}${frame(t2)}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', restart('1:26')); emitOutput('a');
    const rsx = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', restart('1:25')); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', rsx.token)).ok, true, 'Claude restarted on the alternate screen');
    writes.length = 0;
    // A narrowed scroll region in the replay: strict. Claude's own reset to
    // the full screen (ESC [ r) is not.
    const region = (t2) => `${'older line\r\n'.repeat(200)}\x1b[2;30r${frame(t2)}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', region('1:26')); emitOutput('a');
    const rg = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', region('1:25')); emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', rg.token), { ok: false, stale: true });
    const reset = (t2) => `${'older line\r\n'.repeat(200)}\x1b[r${frame(t2)}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', reset('1:26')); emitOutput('a');
    const rs = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', reset('1:25')); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', rs.token)).ok, true, "Claude's scroll-region reset");
    writes.length = 0;
    // A long fullscreen session: a static header drawn long before the replay
    // (never redrawn), the prompt's own box (under its rule) drawn inside it.
    // Only the box has to be covered: the tap lands.
    const rule = '\u2500'.repeat(60);
    // Drawn as Claude 2.1.316 does: to the frame's top, erase below, write.
    const boxed = (t2, cmd = 'mv a b') => `\x1b[1;1H Claude Code v2.1.316 header${'\x1b[0m'.repeat(70000)}\x1b[8;1H\x1b[J${rule}\r\n${frame(t2, cmd).replace(/^\r\n/, '')}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', boxed('1:26')); emitOutput('a');
    const bx = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', boxed('1:25')); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', bx.token)).ok, true, 'static header, box redrawn in the replay');
    writes.length = 0;
    // A real icon-font glyph (U+E000) in the box is output, not a marker.
    open('1:26'); trimmed.add('a'); buffers.set('a', boxed('1:26', 'echo \ue000 icon')); emitOutput('a');
    const gl = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', boxed('1:25', 'echo \ue000 icon')); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', gl.token)).ok, true, 'a U+E000 glyph in the box');
    writes.length = 0;
    // The box's top (its rule and command) drawn BEFORE the replay, only the
    // timer and options after: the box is not covered, strict.
    const split = (cmd, t2) => `\x1b[8;1H${rule}\r\n Bash command\r\n\r\n   ${cmd}${'\x1b[0m'.repeat(70000)}\x1b[13;1H\x1b[J ${frame(t2).split('\r\n').slice(6).join('\r\n')}`;
    open('1:26'); trimmed.add('a'); buffers.set('a', split('rm -rf ./cache', '1:26')); emitOutput('a');
    const sp = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', split('rm -rf ./vault', '1:25')); emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', sp.token), { ok: false, stale: true });
    // An ordinary file link costs nothing: the tap still lands.
    open('1:26'); buffers.set('a', `\x1b]8;;file:///Users/x/a.js\x07a.js\x1b]8;;\x07\r\n${frame('1:26')}`); emitOutput('a');
    const small = await readSelectorForAnswer('a');
    clock += 1000; buffers.set('a', `\x1b]8;;file:///Users/x/a.js\x07a.js\x1b]8;;\x07\r\n${frame('1:25')}`); emitRawOutput('a');
    assert.equal((await answerSelector('a', '1', small.token)).ok, true);
    writes.length = 0;
    // A prompt WITHOUT the timer keeps the strict rule: any output is stale.
    reset(); ptys.set('a', {}); buffers.set('a', frame('1:26').replace(/ \x1b\[33m\u26a0 Claude Code[^\r]*/, '')); emitOutput('a');
    const r4 = await readSelectorForAnswer('a');
    assert.ok(r4 && r4.token);
    emitRawOutput('a');
    assert.deepEqual(await answerSelector('a', '1', r4.token), { ok: false, stale: true });
    assert.deepEqual([...writes], []);
    // A command that only MENTIONS the timer's words is not a timer: two
    // different such commands never share a fingerprint.
    const { selectorCountdown } = await import('../selector-parser.js');
    const mention = (n) => ({ prompt: `rm -rf 'automatically block this request in 1:${n}'`, options: [{ num: 1, label: 'Yes' }] });
    assert.equal(selectorCountdown(mention(26)), null);
    // The sentence wrapped onto a second row still reads as the timer.
    const row = (n) => ` \u26a0 Claude Code will automatically block this request in 1:${n}, to avoid holding up an unattended`;
    const wrapped = (n) => ({ prompt: `${row(n).trim()}\nsession`, context: `${row(n)}\n session`, contextColored: [true, true], options: [{ num: 1, label: 'Yes' }] });
    assert.equal(selectorCountdown(wrapped(26)), 86);
    assert.equal(selectorFingerprint(wrapped(26)), selectorFingerprint(wrapped(25)));
    // The same sentence INSIDE a command (a heredoc row, indented like every
    // command row) is not the timer, and its digits stay in the fingerprint.
    const heredoc = (n) => ({ prompt: 'cat <<X', context: ` Bash command\n\n   cat <<X\n   \u26a0 Claude Code will automatically block this request in 1:${n}, to avoid holding up an unattended session\n   X`, options: [{ num: 1, label: 'Yes' }] });
    assert.equal(selectorCountdown(heredoc(26)), null);
    // A quoted copy in a command next to Claude's real timer: the real one
    // still counts (Codex, round 23).
    const both = { prompt: 'x', chromeIndent: 1, contextColored: [false, false, false, false, true, false], context: [' Bash command', '   cat <<X', '   \u26a0 Claude Code will automatically block this request in 9:99, to avoid holding up an unattended session', '   X', ' \u26a0 Claude Code will automatically block this request in 1:26, to avoid holding up an unattended session', ' Do you want to proceed?'].join('\n'), options: [{ num: 1, label: 'Yes' }] };
    assert.equal(selectorCountdown(both), 86, 'the real timer beside a quoted copy');
    // The card's text cut off partway into the timer row: still masked.
    const cutRow = (n) => ({ prompt: `request in 1:${n}, to avoid holding up an unattended session\nDo you want to proceed?`, chromeIndent: 1, contextColored: [true, false], context: ` \u26a0 Claude Code will automatically block this request in 1:${n}, to avoid holding up an unattended session\n Do you want to proceed?`, options: [{ num: 1, label: 'Yes' }] });
    assert.equal(selectorFingerprint(cutRow(26)), selectorFingerprint(cutRow(25)), 'a truncated timer row in the card text');
    const midTime = (n) => ({ ...cutRow(n), prompt: `${n}, to avoid holding up an unattended session\nDo you want to proceed?` });
    assert.equal(selectorFingerprint(midTime(26)), selectorFingerprint(midTime(25)), 'cut inside the time itself');
    // Above a long edit preview (a denial-limit prompt draws it there): still
    // the timer, wherever it sits above the options (Codex, round 22).
    const far = { prompt: 'x', chromeIndent: 1, contextColored: Array(8).fill(true), context: [' \u26a0 Claude Code will automatically block this request in 1:26, to avoid holding up an unattended session', ' a', ' b', ' c', ' d', ' e', '', ' Do you want to proceed?'].join('\n'), options: [{ num: 1, label: 'Yes' }] };
    assert.equal(selectorCountdown(far), 86);
    assert.equal(selectorCountdown({ ...far, context: far.context.replace(/ a\n b\n c\n d\n e\n/, '') }), 86);
    // Only the whole sentence counts, and never in a question dialog.
    const near = far.context.replace(/ a\n b\n c\n d\n e\n/, '');
    assert.equal(selectorCountdown({ ...far, context: near.replace(', to avoid holding up an unattended session', '') }), null, 'a fragment of the words');
    assert.equal(selectorCountdown({ ...far, context: near, steps: { current: 0, total: 1 } }), null, 'a question dialog');
    // The same row drawn plain (question or command text) is not the timer,
    // and neither is a parse without colour information.
    assert.equal(selectorCountdown({ ...far, context: near, contextColored: Array(8).fill(false) }), null, 'plain text');
    assert.equal(selectorCountdown({ ...far, context: near, contextColored: null }), null, 'no colour data');
    // Further in than the cursor row: not Claude's chrome.
    assert.equal(selectorCountdown({ ...far, chromeIndent: 0, context: far.context.replace(/ a\n b\n c\n d\n e\n/, '') }), null);
    assert.notEqual(selectorFingerprint(heredoc(26)), selectorFingerprint(heredoc(25)));
  } finally {
    Date.now = realNow;
  }
}
ok('a ticking timer does not make a card stale, a new prompt does');

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

// The Chat view's fallback shows the rendered SCREEN, not every frame a TUI
// drew (Bryan, Asana 1220098108555131: stray "Doodling…" frames, blank gaps).
{
  const { terminalScreenText, terminalTextTail } = await import('../chat-service.js');
  const id = 'term-screen-1';
  // Claude repaints its spinner line in place, then replaces it.
  buffers.set(id, 'Brewed earlier\r\n✻ Doodling…\r\n\x1b[1A\x1b[2K✻ Doodling… (2s)\r\n\x1b[1A\x1b[2K⏺ Done for real\r\n');
  cols.set(id, 80);
  assert.ok(terminalTextTail(id).includes('Doodling'), 'the raw stream keeps the stale frames');
  assert.equal(await terminalScreenText(id), 'Brewed earlier\n⏺ Done for real');
  ok('fallback text is the rendered screen, not the stale frames');
  buffers.set(id, '');
  assert.equal(await terminalScreenText(id), '');
  ok('an empty tab reads as empty');
}
{
  const { terminalScreenText, screenTailStart } = await import('../chat-service.js');
  const id = 'term-screen-2';
  // At the tab's own width: an 80-column row wraps before the erase.
  buffers.set(id, `${'A'.repeat(80)}B\r\x1b[2KDone\r\n`);
  cols.set(id, 80);
  assert.equal(await terminalScreenText(id), `${'A'.repeat(80)}\nDone`);
  ok('rendered at the tab\'s own width, not 220 columns');
  // A cut that drops a full-screen program's ENTRY: its screen must not stay.
  const before = 'shell prompt $ \r\n';
  const big = `${before}\x1b[?1049h${'file line\r\n'.repeat(30000)}\x1b[?1049l$ back at the shell\r\n`;
  buffers.set(id, big);
  assert.ok(!(await terminalScreenText(id)).includes('file line'), 'the editor screen is gone after it exits');
  ok('a full-screen program whose entry was cut off leaves no screen behind');
  // A stray `tput rmcup` in ordinary shell output (no entry before the cut)
  // must not throw that output away.
  const plain = `${'shell output line\r\n'.repeat(20000)}\x1b[?1049lstill visible\r\n`;
  buffers.set(id, plain);
  // (The exit restores the cursor to the top, as a real terminal does, so the
  // line after it lands above the rows shown; what matters is that the
  // shell's output is not replayed into an alternate screen and discarded.)
  assert.ok((await terminalScreenText(id)).includes('shell output line'));
  ok('a stray alt-screen exit in plain output keeps the output');
  // The editor's entry trimmed out of the buffer altogether: the terminal's
  // record of the state at the buffer start decides.
  buffers.set(id, `${'editor line\r\n'.repeat(500)}\x1b[?1049l$ shell again\r\n`);
  altAtStart.add(id);
  assert.ok(!(await terminalScreenText(id)).includes('editor line'));
  altAtStart.delete(id);
  ok('an editor whose entry was trimmed from the buffer leaves no screen behind');
  // A cut inside a long OSC title starts after it, never in its payload.
  const title = `\x1b]0;${'T'.repeat(1024)}\x07`;
  const raw = `${'x'.repeat(100)}${title}after\r\n`;
  const cut = screenTailStart(raw, raw.length - 100 - 600); // lands 600 chars into the title
  assert.equal(raw.slice(cut), 'after\r\n');
  // A short CSI cut in half backs up to its ESC.
  const csi = `${'y'.repeat(50)}\x1b[31mred`;
  assert.equal(csi.slice(screenTailStart(csi, csi.length - 52)), '\x1b[31mred');
  ok('the cut never starts inside an escape sequence or a long title');
}

console.log(`\n${pass} passed`);
