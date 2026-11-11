// The window's screen for a tab (electron/window-screen.js): asked of the window that owns the tab, answered only by
// that window about that tab, bounded and never left hanging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initWindowScreen, requestWindowScreen, validSnapshot, _pendingCount } from '../window-screen.js';
import { boxIsEmpty } from '../team-deliver.js';
import { renderScreenLines } from '../screen-render.js';
import { rowFacts } from '../../shared/screen-rows.js';

const listeners = new Map();
const ipcMain = { on: (ch, fn) => listeners.set(ch, fn) };
initWindowScreen(ipcMain);
const reply = (wc, ...args) => listeners.get('terminal:screenReply')({ sender: wc }, ...args);
let ids = 0;
function fakeWc(answer) {
  const wc = { id: ids += 1, sent: [], destroyed: false, isDestroyed: () => wc.destroyed };
  wc.send = (ch, nonce, id) => { wc.sent.push([ch, nonce, id]); if (answer) setTimeout(() => answer(wc, nonce, id), 0); };
  return wc;
}
const SNAP = { lines: ['out', '────────', '❯ ', '────────'], cursor: { x: 2, y: 2 } };

test('the owning window answers with its screen', async () => {
  const wc = fakeWc((w, nonce, id) => reply(w, nonce, id, SNAP));
  const s = await requestWindowScreen('tab-a', wc);
  assert.deepEqual(s, SNAP);
  assert.equal(wc.sent[0][0], 'terminal:screenRequest');
  assert.equal(wc.sent[0][2], 'tab-a');
});

test('another window, or an answer about another tab, is ignored; the request then times out to null', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const other = fakeWc();
  const wc = fakeWc();
  const p = requestWindowScreen('tab-b', wc);
  const [, nonce] = wc.sent[0];
  reply(other, nonce, 'tab-b', SNAP);
  reply(wc, nonce, 'tab-other', SNAP);
  t.mock.timers.tick(1500);
  assert.equal(await p, null);
  assert.equal(_pendingCount(), 0);
});

test('no window, a closed window, or a window that throws on send: null at once', async () => {
  assert.equal(await requestWindowScreen('x', null), null);
  const closed = fakeWc(); closed.destroyed = true;
  assert.equal(await requestWindowScreen('x', closed), null);
  const throws = fakeWc(); throws.send = () => { throw new Error('gone'); };
  assert.equal(await requestWindowScreen('x', throws), null);
  assert.equal(_pendingCount(), 0);
});

test('requests waiting on a window that never answers are capped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const silent = fakeWc();
  const ps = [];
  for (let i = 0; i < 40; i += 1) ps.push(requestWindowScreen(`t${i}`, silent));
  assert.equal(_pendingCount(), 32);
  assert.equal(silent.sent.length, 32, 'past the cap nothing is even asked');
  t.mock.timers.tick(1500);
  const got = await Promise.all(ps);
  assert.ok(got.every((g) => g === null));
  assert.equal(_pendingCount(), 0);
});

test('a malformed answer is null, and a cursor off the screen is dropped', () => {
  assert.equal(validSnapshot(null), null);
  assert.equal(validSnapshot({ lines: 'x' }), null);
  assert.equal(validSnapshot({ lines: [] }), null);
  assert.equal(validSnapshot({ lines: [1, 2] }), null);
  assert.equal(validSnapshot({ lines: Array(501).fill('') }), null);
  assert.equal(validSnapshot({ lines: ['x'.repeat(2001)] }), null);
  assert.deepEqual(validSnapshot({ lines: ['a'], cursor: { x: 1, y: 5 } }), { lines: ['a'], cursor: null });
  assert.deepEqual(validSnapshot({ lines: ['a'], cursor: { x: 1.5, y: 0 } }), { lines: ['a'], cursor: null });
});

// Sam, 2026-11-11: "there's suggested wording that displays in the text bar so it thinks it's busy". Claude draws its
// ghost suggestion dim; it is not typed text, on the rebuilt screen and on the window's alike.
const C = String.fromCharCode;
const EDGE = C(0x2500).repeat(30);
const CARET = C(0x276f);
const ESC = C(27);
const GHOST = `${EDGE}\r\n${CARET}${C(0xa0)}${ESC}[2mRun bash ~/.claude/fleet-board/approve-prompts.sh and nothing else.${ESC}[22m\r\n${EDGE}\r\n${ESC}[2;3H${ESC}[?2004h`;

test('a dim ghost suggestion in the box is an empty box on the rebuilt screen', async () => {
  const lines = await renderScreenLines(GHOST, { cols: 80 });
  assert.equal(boxIsEmpty({ lines, modes: { ...lines.modes, bracketedPaste: true } }), true);
  const typed = await renderScreenLines(GHOST.replace(`${ESC}[2m`, ''), { cols: 80 });
  assert.equal(boxIsEmpty({ lines: typed, modes: { ...typed.modes, bracketedPaste: true } }), false, 'the same words typed are a draft');
});

test('the window sends the same row facts, so its ghost suggestion is an empty box too', async () => {
  const lines = await renderScreenLines(GHOST, { cols: 80 });
  const snap = validSnapshot({ lines: [...lines], cursor: lines.modes.cursor, ends: lines.ends, dimFrom: lines.dimFrom, firstWords: lines.firstWords, firstColored: lines.firstColored });
  assert.equal(boxIsEmpty({ lines: snap.lines, modes: { cursor: snap.cursor, bracketedPaste: true } }), true);
  // Without the facts (an older page, or a malformed set) the ghost reads as text: refused, never sent over it.
  const bare = validSnapshot({ lines: [...lines], cursor: lines.modes.cursor, dimFrom: [1] });
  assert.equal(bare.lines.dimFrom, undefined);
  assert.equal(boxIsEmpty({ lines: bare.lines, modes: { cursor: bare.cursor, bracketedPaste: true } }), false);
});

test('rowFacts reads a buffer the way the render does', () => {
  const cell = (ch, dim) => ({ getWidth: () => 1, getChars: () => ch, isDim: () => dim, isFgDefault: () => true });
  const row = (cells) => ({ getCell: (x) => cells[x] });
  const f = rowFacts((i) => [row([cell(CARET, false), cell(' ', false), cell('R', true), cell('u', true)])][i], 1, 4);
  assert.deepEqual(f, { ends: [4], dimFrom: [2], firstWords: [1], firstColored: [false] });
});
