import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readPromptBox, promptFrame, posOf, offsetAt, selectionOffsets, planClick, planDelete, classifyInput, macEditKey, textSpan, KEY,
} from '../../src/lib/prompt-edit.js';

// Builds a screen from text rows. '_' is a never-written cell (Ink positions
// words with cursor moves), CJK characters take two cells, rows listed in
// `dim` are drawn dim (Claude's placeholder / ghost text).
const WIDE = /[぀-ヿ一-鿿가-힣]/;
function screen(lines, cursor, { cols = 40, dim = [] } = {}) {
  const grid = lines.map((line, y) => {
    const cells = [];
    for (const ch of line) {
      if (WIDE.test(ch)) { cells.push({ ch, w: 2, dim: dim.includes(y) }, { ch: '', w: 0, dim: dim.includes(y) }); }
      else cells.push({ ch: ch === '_' ? '' : ch, w: 1, dim: dim.includes(y) });
    }
    while (cells.length < cols) cells.push({ ch: '', w: 1, dim: false });
    return cells;
  });
  return {
    cols, rowCount: lines.length, cursorX: cursor[0], cursorY: cursor[1],
    cell: (x, y) => grid[y]?.[x] ?? null,
  };
}
const RULE = '─'.repeat(40);
const L = KEY.left(false);
const R = KEY.right(false);

// Rows 0-1 are scrollback, 2 and 4 the box rules, 5 the status line.
const oneRow = (cursor = [25, 3]) => screen([
  '● earlier output here',
  '',
  RULE,
  '❯ hello world foo bar baz',
  RULE,
  '  ⏵⏵ auto mode on',
], cursor);

test('reads a one-row prompt and the caret offset', () => {
  const box = readPromptBox(oneRow());
  assert.equal(box.top, 2);
  assert.equal(box.bottom, 4);
  assert.equal(box.n, 23);
  assert.equal(box.caret, 23);
  assert.deepEqual(box.endPos, { x: 25, y: 3 });
  assert.equal(readPromptBox(oneRow([8, 3])).caret, 6);
});

test('Claude draws "❯" with a no-break space after it', () => {
  const box = readPromptBox(screen([RULE, '❯\u00a0hello', RULE], [7, 1]));
  assert.equal(box.n, 5);
});

test('blank cells inside the text are spaces even when never written', () => {
  const box = readPromptBox(screen([RULE, '❯ hello_world', RULE], [13, 1]));
  assert.equal(box.n, 11);
  assert.deepEqual(posOf(box, 5), { x: 7, y: 1 });
});

test('typed trailing spaces before the caret count', () => {
  const box = readPromptBox(screen([RULE, '❯ hi', RULE], [7, 1]));
  assert.equal(box.n, 5);
  assert.equal(box.caret, 5);
});

test('selection of "world" maps to offsets 6..11 and deletes with a proving leg', () => {
  const box = readPromptBox(oneRow());
  const sel = selectionOffsets(box, { start: { x: 8, y: 3 }, end: { x: 13, y: 3 } });
  assert.deepEqual(sel, { start: 6, end: 11 });
  const steps = planDelete(box, sel.start, sel.end);
  assert.deepEqual(steps, [
    { keys: L.repeat(17), expect: { x: 8, y: 3 } },
    { keys: R.repeat(5), expect: { x: 13, y: 3 } },
    { keys: '\x7f'.repeat(5), expect: null },
  ]);
});

test('a selection running to the end of the text proves its count leftward', () => {
  const box = readPromptBox(oneRow([2, 3]));
  const sel = selectionOffsets(box, { start: { x: 22, y: 3 }, end: { x: 39, y: 3 } });
  assert.deepEqual(sel, { start: 20, end: 23 });
  assert.deepEqual(planDelete(box, sel.start, sel.end), [
    { keys: R.repeat(23), expect: { x: 25, y: 3 } },
    { keys: L.repeat(3), expect: { x: 22, y: 3 } },
    { keys: R.repeat(3), expect: { x: 25, y: 3 } },
    { keys: '\x7f'.repeat(3), expect: null },
  ]);
});

test('the whole text still walks its length before deleting', () => {
  const box = readPromptBox(oneRow([10, 3]));
  const sel = selectionOffsets(box, { start: { x: 0, y: 3 }, end: { x: 0, y: 4 } });
  assert.deepEqual(sel, { start: 0, end: 23 });
  // Trailing spaces before a line break are invisible, so the model can
  // undercount; the walk back to offset 0 then falls short and stops it.
  assert.deepEqual(planDelete(box, 0, 23), [
    { keys: R.repeat(15), expect: { x: 25, y: 3 } },
    { keys: L.repeat(23), expect: { x: 2, y: 3 } },
    { keys: R.repeat(23), expect: { x: 25, y: 3 } },
    { keys: '\x7f'.repeat(23), expect: null },
  ]);
});

// Word wrap as Claude draws it: the space at the wrap is shown at the end of
// the first row (the caret sits there before it), then the indent.
const wrapped = (cursor) => screen([
  RULE,
  '❯ alpha beta gamma',
  '  delta epsilon',
  '  zeta',
  RULE,
], cursor);

test('wrapped rows: row ends are one character (the wrapped space or newline)', () => {
  const box = readPromptBox(wrapped([6, 3]));
  // alpha beta gamma = 16, +1 sep, delta epsilon = 13, +1 sep, zeta = 4
  assert.equal(box.n, 35);
  assert.equal(box.caret, 35);
  assert.deepEqual(posOf(box, 16), { x: 18, y: 1 });
  assert.deepEqual(posOf(box, 17), { x: 2, y: 2 });
  // "gamma" through "delta" crosses the first row end.
  const sel = selectionOffsets(box, { start: { x: 13, y: 1 }, end: { x: 7, y: 2 } });
  assert.deepEqual(sel, { start: 11, end: 22 });
});

test('a drag past the end of a row takes the row break with it', () => {
  const box = readPromptBox(wrapped([6, 3]));
  assert.deepEqual(selectionOffsets(box, { start: { x: 13, y: 1 }, end: { x: 30, y: 1 } }), { start: 11, end: 17 });
});

test('a click past the end of a row lands at that row end, not the next row', () => {
  const box = readPromptBox(wrapped([6, 3]));
  assert.equal(planClick(box, 35, 1), L.repeat(35 - 16));
  assert.equal(planClick(box, 0, 2), L.repeat(35 - 17));
  assert.equal(planClick(box, 30, 3), '');
  assert.equal(planClick(box, 5, 0), '', 'the rule is not text');
});

test('wide characters are one character over two cells', () => {
  const box = readPromptBox(screen([RULE, '❯ ab 日本語 cd', RULE], [14, 1]));
  assert.equal(box.n, 9);
  assert.deepEqual(posOf(box, 4), { x: 7, y: 1 });
  assert.deepEqual(posOf(box, 5), { x: 9, y: 1 });
  const sel = selectionOffsets(box, { start: { x: 5, y: 1 }, end: { x: 9, y: 1 } });
  assert.deepEqual(sel, { start: 3, end: 5 }, '日本');
  assert.equal(planClick(box, 8, 1), L.repeat(9 - 5), 'right half of 本 lands after it');
});

test('unreadable prompts are refused rather than guessed', () => {
  assert.equal(readPromptBox(screen([RULE, '❯ Try "fix lint"', RULE], [2, 1], { dim: [1] })), null, 'placeholder');
  assert.equal(readPromptBox(screen([RULE, '❯ hi 👍 there', RULE], [5, 1])), null, 'emoji');
  assert.equal(readPromptBox(screen([RULE, '❯ café', RULE], [7, 1])), null, 'combining mark');
  assert.equal(readPromptBox(screen([RULE, '❯ hello', RULE], [20, 0])), null, 'caret on the rule');
  assert.equal(readPromptBox(screen(['$ ls', 'file.txt', '$ '], [2, 2])), null, 'plain shell');
  assert.equal(readPromptBox(screen([RULE, '> hello', RULE], [7, 1])), null, 'no prompt glyph');
  assert.equal(readPromptBox(screen([RULE, '❯ hello', 'x more', RULE], [7, 1])), null, 'unindented row');
  assert.equal(readPromptBox(screen([RULE, '❯ hello', RULE], [5, 3])), null, 'caret below the box');
});

test('a caret that is not on a character cell refuses the box', () => {
  assert.equal(readPromptBox(screen([RULE, '❯ ab 日本 cd', RULE], [6, 1])), null, 'right half of a wide char');
  assert.equal(readPromptBox(screen([RULE, '❯ hello', '  there', RULE], [1, 2])), null, 'in the indent');
  // Blanks before the caret on ITS row are typed spaces, even above a break.
  assert.equal(readPromptBox(screen([RULE, '❯ hello', '  there', RULE], [10, 1])).caret, 8);
});

test('selections that leave the prompt stay copy-only', () => {
  const box = readPromptBox(oneRow());
  assert.equal(selectionOffsets(box, { start: { x: 2, y: 0 }, end: { x: 8, y: 3 } }), null, 'starts in scrollback');
  assert.equal(selectionOffsets(box, { start: { x: 2, y: 3 }, end: { x: 5, y: 5 } }), null, 'runs into the status line');
  assert.equal(selectionOffsets(box, { start: { x: 0, y: 2 }, end: { x: 5, y: 3 } }), null, 'starts on the rule');
  assert.equal(selectionOffsets(box, { start: { x: 30, y: 3 }, end: { x: 35, y: 3 } }), null, 'empty tail');
  assert.equal(selectionOffsets(null, { start: { x: 2, y: 3 }, end: { x: 5, y: 3 } }), null);
});

test('application cursor mode uses SS3 arrows', () => {
  const box = readPromptBox(oneRow([24, 3]));
  assert.equal(planClick(box, 2, 3, true), '\x1bOD'.repeat(22));
  assert.equal(planClick(box, 30, 3, true), '\x1bOC');
});

test('textSpan covers the prompt text for Cmd+A', () => {
  assert.deepEqual(textSpan(readPromptBox(wrapped([6, 3]))), { x: 2, y: 1, end: { x: 6, y: 3 } });
  assert.equal(textSpan(readPromptBox(screen([RULE, '❯ ', RULE], [2, 1]))), null, 'empty prompt');
  assert.equal(textSpan(null), null);
});

test('classifyInput', () => {
  for (const d of ['\x7f', '\b', '\x1b[3~', '\x15', '\x1b\x7f', '\x17']) assert.equal(classifyInput(d), 'delete', JSON.stringify(d));
  for (const d of ['a', 'X', ' ', '日本', 'hello world', '\x1b[200~line1\rline2\x1b[201~']) assert.equal(classifyInput(d), 'insert', JSON.stringify(d));
  for (const d of ['', '\r', '\x03', '\x1b', '\x1b[A', '\x1b[D', '\t', 'a\r', '\x1b[200~unterminated', '\x1b[?1;2c']) assert.equal(classifyInput(d), 'other', JSON.stringify(d));
});

test('macEditKey maps the Cmd text-field keys only', () => {
  const k = (key, mods = {}) => macEditKey({ type: 'keydown', key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(k('ArrowLeft'), '\x01');
  assert.equal(k('ArrowRight'), '\x05');
  assert.equal(k('Backspace'), '\x15');
  assert.equal(k('ArrowLeft', { shiftKey: true }), null);
  assert.equal(k('ArrowLeft', { metaKey: false }), null);
  assert.equal(k('ArrowLeft', { type: 'keyup' }), null);
  assert.equal(k('v'), null);
  assert.equal(k('ArrowUp'), null);
});

test('promptFrame finds the box even when its contents are unreadable', () => {
  assert.deepEqual(promptFrame(screen([RULE, '❯ Try "fix lint"', RULE], [2, 1], { dim: [1] })), { top: 0, bottom: 2 });
  assert.deepEqual(promptFrame(screen([RULE, '❯ hi 👍', RULE], [7, 1])), { top: 0, bottom: 2 });
  assert.equal(promptFrame(screen(['$ ls', RULE, '$ x', RULE], [3, 2])), null, 'rules around a shell line');
});
