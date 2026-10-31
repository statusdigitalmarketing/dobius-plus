// Text-field editing for Claude Code's prompt inside the terminal: click to
// place the caret, select + Backspace/Delete, type or paste over a selection.
// Claude's default renderer has no mouse support, so we translate each gesture
// into the arrow keys and backspaces its input already understands.
// Pure so it is tested under plain node (electron/__tests__/prompt-edit.test.mjs);
// src/lib/prompt-edit-term.js wires it to a live xterm.
//
// The screen model only ever PROPOSES a count. Every deletion is preceded by a
// leg of arrow presses whose landing cell proves the count with Claude's own
// caret (planDelete), and the runtime aborts on any mismatch. Anything the
// model cannot read with certainty (dim placeholder or ghost text, emoji,
// combining marks, a caret off the text) makes it return null: do nothing
// rather than guess.
//
// A screen is { cols, cursorX, cursorY, rowCount, cell(x, y) } in viewport
// rows, where cell returns { ch, w, dim }: ch is '' for a never-written cell,
// w is xterm's cell width (0 for the right half of a wide character).

const PROMPT = '❯';
const RULE = '─';
const TEXT_COL = 2; // "❯ " on the first row, a two-space indent after it
const MAX_ROWS = 200;

// Characters whose width xterm and Claude agree on, by xterm's cell width.
// Everything else (emoji, ZWJ sequences, variation selectors, combining marks,
// ambiguous-width symbols) makes the box unreadable.
const NARROW = /^[\x20-\x7e -¬®-˿Ͱ-҂Ҋ-ԯ]$/;
const WIDE = /^[ᄀ-ᅟ⺀-〾ぁ-ゖ゠-ヿㄅ-ㄯㄱ-ㆎㆠ-ㆿㇰ-ㇿ㐀-䶿一-鿿ꀀ-ꒌ꒐-꓆가-힣豈-﫿︰-﹏！-｠￠-￦]$/;

export const KEY = {
  left: (app) => (app ? '\x1bOD' : '\x1b[D'),
  right: (app) => (app ? '\x1bOC' : '\x1b[C'),
  backspace: '\x7f',
};

// Claude draws the gap after "❯" as a no-break space.
const blank = (c) => !c || c.ch === '' || c.ch === ' ' || c.ch === '\u00a0';

function isRule(screen, y) {
  let n = 0;
  for (let x = 0; x < screen.cols; x++) {
    const c = screen.cell(x, y);
    if (blank(c)) continue;
    if (c.ch !== RULE) return false;
    n++;
  }
  return n >= screen.cols / 2 && screen.cell(0, y)?.ch === RULE;
}

/**
 * The rules above and below the caret with "❯" opening the first row between
 * them: Claude's prompt box, whether or not its contents are readable (a dim
 * placeholder or an emoji still count). { top, bottom } or null.
 */
export function promptFrame(screen) {
  const { cursorY: cy } = screen;
  if (!(cy >= 0 && cy < screen.rowCount)) return null;
  let top = -1;
  for (let y = cy - 1; y >= 0 && cy - y <= MAX_ROWS; y--) {
    if (isRule(screen, y)) { top = y; break; }
  }
  if (top < 0 || screen.cell(0, top + 1)?.ch !== PROMPT) return null;
  let bottom = -1;
  for (let y = cy + 1; y < screen.rowCount && y - top <= MAX_ROWS; y++) {
    if (isRule(screen, y)) { bottom = y; break; }
  }
  if (bottom < 0 || bottom - top < 2) return null;
  return { top, bottom };
}

/**
 * Reads Claude Code's input box around the caret.
 * Returns null unless the caret sits inside a box drawn as
 *   ────────
 *   ❯ text
 *     more text
 *   ────────
 * with only readable characters in it. Otherwise returns
 *   { top, bottom, chars, endPos, caret, n }
 * where chars[i] is the cell that shows character i (row separators are
 * virtual entries at the end of their row, which is where Claude shows the
 * caret before them), endPos is the caret cell after the last character, and
 * caret is the caret's offset.
 */
export function readPromptBox(screen) {
  const frame = promptFrame(screen);
  if (!frame) return null;
  const { top, bottom } = frame;
  const { cursorX: cx, cursorY: cy } = screen;

  const chars = [];
  let endPos = null;
  for (let y = top + 1; y < bottom; y++) {
    const c0 = screen.cell(0, y);
    if (y === top + 1 ? c0?.ch !== PROMPT : !blank(c0)) return null;
    if (!blank(screen.cell(1, y))) return null;
    let last = TEXT_COL - 1;
    for (let x = TEXT_COL; x < screen.cols; x++) {
      const c = screen.cell(x, y);
      if (c?.dim) return null; // placeholder, ghost suggestion
      if (!blank(c) || c?.w === 0) last = x;
    }
    // Blanks before the caret on its own row are typed spaces.
    const rowEnd = Math.max(last + 1, y === cy ? cx : 0);
    for (let x = TEXT_COL; x < rowEnd; x++) {
      const c = screen.cell(x, y);
      if (c?.w === 0) {
        if (screen.cell(x - 1, y)?.w !== 2) return null;
        continue;
      }
      if (blank(c)) { chars.push({ x, y }); continue; }
      if (c.w === 1 ? !NARROW.test(c.ch) : c.w === 2 ? !WIDE.test(c.ch) : true) return null;
      if (c.w === 2 && screen.cell(x + 1, y)?.w !== 0) return null;
      chars.push({ x, y });
    }
    if (y < bottom - 1) chars.push({ x: rowEnd, y, sep: true });
    else endPos = { x: rowEnd, y };
  }
  const n = chars.length;
  const caret = offsetOfCell(chars, endPos, cx, cy);
  if (caret < 0) return null;
  return { top, bottom, chars, endPos, caret, n };
}

function offsetOfCell(chars, endPos, x, y) {
  if (endPos.x === x && endPos.y === y) return chars.length;
  return chars.findIndex((c) => c.x === x && c.y === y);
}

/** The caret cell for offset i. */
export function posOf(box, i) {
  return i >= box.n ? box.endPos : { x: box.chars[i].x, y: box.chars[i].y };
}

function isTextRow(box, y) { return y > box.top && y < box.bottom; }

/**
 * Offset of the caret position at or after cell (x, y): the first character
 * whose cell is at or right of x on row y, else whatever follows the row.
 * A click left of the text lands at the row start, right of it at the row end.
 */
export function offsetAt(box, x, y) {
  if (!isTextRow(box, y)) return null;
  const i = box.chars.findIndex((c) => (c.y === y && c.x >= x) || c.y > y);
  return i < 0 ? box.n : i;
}

/**
 * Offsets [start, end) covered by an xterm selection (viewport rows, end
 * exclusive), or null unless the whole selection is inside the box's text.
 * A selection that runs on to column 0 of the rule under the box (a line
 * select) ends at the end of the text.
 */
export function selectionOffsets(box, sel) {
  if (!box || !sel) return null;
  const { start, end } = sel;
  if (!isTextRow(box, start.y)) return null;
  let e;
  if (end.y === box.bottom && end.x === 0) e = box.n;
  else if (isTextRow(box, end.y)) e = offsetAt(box, end.x, end.y);
  else return null;
  const s = offsetAt(box, start.x, start.y);
  if (s === null || e === null || e <= s) return null;
  return { start: s, end: e };
}

function moveKeys(from, to, app) {
  return to > from ? KEY.right(app).repeat(to - from) : KEY.left(app).repeat(from - to);
}

/**
 * Keys that put the caret on the clicked cell, or '' when nothing to do. A
 * click past the end of a row lands at that row's end, like a text field.
 */
export function planClick(box, x, y, app = false) {
  if (!box || !isTextRow(box, y)) return '';
  const rowEnd = box.chars.find((c) => c.y === y && c.sep) || (box.endPos.y === y ? box.endPos : null);
  const i = offsetAt(box, rowEnd ? Math.min(x, rowEnd.x) : x, y);
  return i === null ? '' : moveKeys(box.caret, i, app);
}

/**
 * Steps that delete [start, end). Each step sends `keys` and then expects the
 * caret on `expect`; the runtime stops at the first miss. Before any
 * backspace, one leg walks the selection's full length and must land on its
 * far edge: that is Claude's own caret confirming the count. The leg ends on
 * an edge the caret could overshoot, never the text's end, where extra
 * presses do nothing and would hide an overcount. A selection that reaches
 * the end walks back to its start instead; when that start is offset 0 an
 * overcount is hidden there too, but the only effect is a no-op backspace at
 * offset 0, while an undercount (text the screen cannot show, such as
 * trailing spaces before a line break) still misses and stops the edit.
 */
export function planDelete(box, start, end, app = false) {
  const k = end - start;
  const steps = [];
  if (end < box.n) {
    steps.push({ keys: moveKeys(box.caret, start, app), expect: posOf(box, start) });
    steps.push({ keys: KEY.right(app).repeat(k), expect: posOf(box, end) });
  } else {
    steps.push({ keys: moveKeys(box.caret, end, app), expect: posOf(box, end) });
    steps.push({ keys: KEY.left(app).repeat(k), expect: posOf(box, start) });
    steps.push({ keys: KEY.right(app).repeat(k), expect: posOf(box, end) });
  }
  steps.push({ keys: KEY.backspace.repeat(k), expect: null });
  return steps;
}

/** Cells to hand xterm's select(): the box's text, first cell to last. */
export function textSpan(box) {
  if (!box || box.n === 0) return null;
  const first = box.chars[0];
  return { x: first.x, y: first.y, end: box.endPos };
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const DELETES = new Set(['\x7f', '\b', '\x1b[3~', '\x15', '\x1b\x7f', '\x17']);

/**
 * What a chunk of terminal input does to a selection: 'delete' (Backspace,
 * Delete, word/line deletes), 'insert' (typed text or a bracketed paste:
 * replaces it), or 'other' (arrows, Enter, Ctrl+C, replies: leave it alone).
 */
export function classifyInput(data) {
  if (DELETES.has(data)) return 'delete';
  if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) return 'insert';
  return data && !/[\x00-\x1f\x7f]/.test(data) ? 'insert' : 'other';
}

/**
 * macOS text-field keys a terminal does not send on its own: Cmd+Left/Right
 * to the line's start/end, Cmd+Backspace to delete to the line start. Same
 * bytes Ghostty sends for them by default.
 */
export function macEditKey(e) {
  if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  if (e.key === 'ArrowLeft') return '\x01';
  if (e.key === 'ArrowRight') return '\x05';
  if (e.key === 'Backspace') return '\x15';
  return null;
}
