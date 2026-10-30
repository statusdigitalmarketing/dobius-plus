// Wires the prompt-edit model (src/lib/prompt-edit.js) to a live xterm.
// Only Claude Code's default renderer needs this: its fullscreen renderer
// takes the mouse itself (alternate buffer + mouse tracking), and does all of
// this natively, so we stand down there and in any other mouse-driven app.
import {
  readPromptBox, promptFrame, selectionOffsets, planDelete, planClick, classifyInput, macEditKey, textSpan,
} from './prompt-edit.js';

const SETTLE_MS = 30;        // quiet time after Claude's repaint before reading the caret
const STEP_TIMEOUT_MS = 800;
const ARM_TTL_MS = 1000;     // a selection snapshot belongs to the key that took it
const PASTE_WAIT_MS = 15000; // longest a pending image paste holds typing back
const AFTER_ENTER_MS = 1000; // a paste waits this long after an Enter for the screen to catch up
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const MID_EDIT = Symbol('selection made while an edit was running');

// The live page at the bottom of the buffer, where the cursor is (cursorY
// counts from baseY), whatever the user has scrolled to.
function screenOf(term) {
  const b = term.buffer.active;
  const scratch = b.getNullCell();
  return {
    cols: term.cols,
    rowCount: term.rows,
    cursorX: b.cursorX,
    cursorY: b.cursorY,
    cell(x, y) {
      const line = b.getLine(b.baseY + y);
      if (!line || x < 0 || x >= term.cols || !line.getCell(x, scratch)) return null;
      return { ch: scratch.getChars(), w: scratch.getWidth(), dim: !!scratch.isDim() };
    },
  };
}

// The box's rows exactly as drawn. Any repaint that changes them (Claude
// printing output above, a dialog replacing the prompt) ends an edit.
function signature(term, box) {
  const b = term.buffer.active;
  const rows = [b.baseY + box.top];
  for (let y = box.top; y <= box.bottom; y++) rows.push(b.getLine(b.baseY + y)?.translateToString(true));
  return JSON.stringify(rows);
}

// What a held image paste reports to main (an empty bracketed paste): it is
// a person's input, not a terminal reply.
const HELD_PASTE = '\x1b[200~\x1b[201~';
const PROMPT_ONLY = Object.freeze({ promptOnly: true });

/**
 * @param {import('@xterm/xterm').Terminal} term
 * @param {(data: string, opts?: { promptOnly: boolean }) => void} send writes to
 *   the PTY; promptOnly marks a paste meant only for Claude's prompt
 * @param {(data: string | null) => void} [held] input the queue HOLDS (behind
 *   an edit or a pending paste) reaches the PTY late, so nothing in main sees
 *   it yet: each such input is reported the moment it is accepted, and null
 *   once the queue has drained. /openTab counts it as a person typing.
 */
export function attachPromptEditing(term, send, held = () => {}) {
  // Everything bound for the PTY goes through one ordered queue: typed input
  // ({ data, sel }) and pending pastes ({ paste, sel }). An edit or a
  // paste still being saved holds everything behind it, so nothing overtakes
  // it, and when one fails everything queued behind it is dropped rather than
  // delivered to whatever replaced the prompt.
  const queue = [];
  let busy = false;
  let lastEnterAt = -Infinity; // when an Enter, Ctrl+C or Ctrl+D (submit or quit) last went out
  let disposed = false;
  let armed = null;
  let columnSelect = false; // xterm's Option+drag selects a rectangle, not a range
  let holding = false; // held input was reported and the drain was not yet
  const reserved = new Set(); // sends accepted elsewhere whose input is still to come
  const hold = (data) => { holding = true; held(data); };
  const drained = () => {
    if (holding && !busy && !queue.length && !reserved.size) { holding = false; held(null); }
  };
  const app = () => !!term.modes.applicationCursorKeysMode;

  const defaultRenderer = () => term.buffer.active.type === 'normal' && term.modes.mouseTrackingMode === 'none';
  const liveBox = () => (defaultRenderer() ? readPromptBox(screenOf(term)) : null);
  // Mouse gestures need the prompt on screen, not scrolled away.
  const currentBox = () => {
    const b = term.buffer.active;
    return b.viewportY === b.baseY ? liveBox() : null;
  };
  // Claude's prompt box (readable or not) is where the caret is. The only
  // place a pending paste is sent: it is the one destination we can check
  // again when the paste is ready.
  const inPrompt = () => defaultRenderer() && !!promptFrame(screenOf(term));

  // The current selection as offsets into the prompt, or null when any part
  // of it is outside the prompt's text (scrollback stays copy-only).
  const selectedRange = () => {
    const p = term.getSelectionPosition();
    if (!p || columnSelect) return null;
    const box = currentBox();
    if (!box) return null;
    const vy = term.buffer.active.viewportY;
    const r = selectionOffsets(box, { start: { x: p.start.x, y: p.start.y - vy }, end: { x: p.end.x, y: p.end.y - vy } });
    return r && { box, ...r, sig: signature(term, box), at: Date.now() };
  };

  // Snapshot the selection before xterm sees the key: xterm clears it on any
  // user input, before the input reaches onData. Mid-edit the screen is
  // moving, so a selection made then cannot be read; the key typed onto it is
  // dropped (MID_EDIT) instead of landing at the wrong place.
  const arm = () => {
    if (!term.hasSelection()) armed = null;
    else armed = busy || queue.length ? MID_EDIT : selectedRange();
  };

  const settle = (expect, sig) => new Promise((resolve) => {
    const t0 = performance.now();
    let last = t0;
    const writes = term.onWriteParsed(() => { last = performance.now(); });
    const timer = setInterval(() => {
      const now = performance.now();
      if (disposed || now - t0 > STEP_TIMEOUT_MS) return done(false);
      if (now - last < SETTLE_MS) return;
      const b = term.buffer.active;
      const box = liveBox(); // scrolling away mid-edit does not change the prompt
      if (box && b.cursorX === expect.x && b.cursorY === expect.y && signature(term, box) === sig) done(true);
    }, 10);
    function done(ok) { clearInterval(timer); writes.dispose(); resolve(ok); }
  });

  // Delete the selection with keys the prompt understands, then send what
  // replaces it. Stops before any backspace if the caret does not land where
  // the model said: Claude's caret is the only proof of the count.
  const replace = async (sel, text, opts) => {
    for (const step of planDelete(sel.box, sel.start, sel.end, app())) {
      if (step.keys) send(step.keys);
      if (step.expect && !(await settle(step.expect, sel.sig))) return false;
    }
    if (text && !disposed) send(text, opts);
    return true;
  };

  // A file path as a paste. Control characters (a file name can hold them)
  // are dropped so a name cannot end the bracketed paste or press Enter.
  const pasteData = (text) => {
    const t = text.replace(/[\x00-\x1f\x7f]/g, '');
    return term.modes.bracketedPasteMode ? `\x1b[200~${t}\x1b[201~` : t;
  };

  // One queued item. Returns false when it failed and the rest must go.
  const run = async (item) => {
    if (item.paste) {
      let timer;
      const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), PASTE_WAIT_MS); });
      const text = await Promise.race([item.paste, timedOut]);
      clearTimeout(timer);
      if (text === false || disposed) return false; // gave up waiting: drop what was typed after it
      // After an Enter or a quit key the screen may not show the result
      // yet: give it time before trusting it as the destination.
      const sinceEnter = performance.now() - lastEnterAt;
      if (sinceEnter < AFTER_ENTER_MS) await new Promise((r) => setTimeout(r, AFTER_ENTER_MS - sinceEnter));
      if (disposed || !inPrompt()) return false;    // the prompt it was pasted into is gone
      if (!text) return true;                       // nothing to paste (save failed)
      if (item.sel === MID_EDIT) return true;       // pasted onto a selection we could not read
      // Checked against Claude's prompt just now; main drops it rather than
      // deliver it late to whatever replaced the prompt.
      if (item.sel) return replace(item.sel, pasteData(text), PROMPT_ONLY);
      send(pasteData(text), PROMPT_ONLY);
      return true;
    }
    const { data, sel } = item;
    // Keys that can submit or quit: Enter, Ctrl+C, Ctrl+D. Option+Enter
    // (ESC CR) is a newline in Claude, not a submit.
    if (/(^|[^\x1b])\r|[\x03\x04]/.test(data) && classifyInput(data) === 'other') lastEnterAt = performance.now();
    if (sel === MID_EDIT) {
      if (classifyInput(data) === 'other') send(data);
      return true;
    }
    if (sel && Date.now() - sel.at < ARM_TTL_MS && classifyInput(data) !== 'other') {
      return replace(sel, classifyInput(data) === 'insert' ? data : '');
    }
    send(data);
    return true;
  };

  const pump = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !disposed) {
        if (!(await run(queue.shift()))) {
          console.debug(`[prompt-edit] prompt changed under an edit or paste; ${queue.length} queued input(s) dropped`);
          queue.length = 0;
          // A paced send still arriving loses its rest too, Enter included.
          for (const r of reserved) r.cancelled = true;
        }
      }
    } finally {
      busy = false;
      drained();
    }
  };

  function handleData(data) {
    const sel = armed;
    armed = null;
    // Behind a running edit or a pending paste this input waits, and on a
    // selection it STARTS an edit, which waits on Claude's caret before its
    // own keys go out (its first leg can be empty).
    const waits = busy || queue.length > 0 || sel !== null;
    queue.push({ data, sel });
    if (waits) hold(data);
    pump();
  }

  // An image paste resolves to a path only after the image is saved. It
  // takes its place in the queue now, so Enter typed meanwhile waits for it,
  // and it replaces the prompt selection the user had when they pasted.
  // Only into Claude's prompt, and only if that is still showing when the
  // paste is ready. Returns false (caller handles the paste) anywhere else.
  // `promise` resolves to the text to paste, or null.
  const pasteWhenReady = (promise) => {
    const paste = promise.catch((err) => {
      console.warn('[prompt-edit] paste failed:', err?.message || err);
      return null;
    });
    if (!inPrompt()) return false;
    let sel = null;
    if (term.hasSelection()) {
      sel = busy || queue.length ? MID_EDIT : selectedRange();
      // xterm never saw this paste (it was taken before reaching xterm), so
      // clear the selection it would have cleared: left up, it would point at
      // the pasted text once the paste lands.
      term.clearSelection();
    }
    queue.push({ paste, sel });
    hold(HELD_PASTE);
    pump();
    return true;
  };

  const cellAt = (e) => {
    const screen = term.element?.querySelector('.xterm-screen');
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / (r.width / term.cols));
    const y = Math.floor((e.clientY - r.top) / (r.height / term.rows));
    return x >= 0 && x < term.cols && y >= 0 && y < term.rows ? { x, y } : null;
  };

  // A plain click inside the prompt moves the caret there. Option+click is
  // xterm's own altClickMovesCursor, so it is left to xterm.
  const click = (e) => {
    if (busy || queue.length || e.button !== 0 || e.detail !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (term.hasSelection()) return;
    const cell = cellAt(e);
    const box = cell && currentBox();
    const keys = box ? planClick(box, cell.x, cell.y, app()) : '';
    if (keys) send(keys);
  };

  // Cmd+A inside a prompt that has text selects that text, like a text field.
  // Not while xterm is in rectangle mode: select() keeps that mode, so the
  // highlight would not be the range we would later delete.
  const selectInput = () => {
    const span = !columnSelect && textSpan(currentBox());
    if (!span) return false;
    term.select(span.x, term.buffer.active.viewportY + span.y, (span.end.y - span.y) * term.cols + span.end.x - span.x);
    return true;
  };

  term.attachCustomKeyEventHandler((e) => {
    if (!IS_MAC) return true;
    // Only in Claude's prompt: elsewhere (vim, less, even a shell's vi mode)
    // Ctrl+A/E/U are commands.
    const mapped = inPrompt() ? macEditKey(e) : null;
    if (mapped) {
      e.preventDefault();
      term.input(mapped);
      return false;
    }
    if (e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && selectInput()) {
      e.preventDefault();
      return false;
    }
    return true;
  });

  const el = term.element;
  const armEvents = ['keydown', 'paste', 'beforeinput'];
  for (const type of armEvents) el?.addEventListener(type, arm, true);
  // Rectangle mode starts with Option+drag and survives Shift+click extends
  // and right-clicks; only a new plain selection ends it.
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    if (e.altKey) columnSelect = true;
    else if (!e.shiftKey) columnSelect = false;
  };
  el?.addEventListener('mousedown', onMouseDown, true);

  return {
    handleData,
    click,
    pasteWhenReady,
    /** True when the selection is (all) inside the prompt's text. */
    selectionInInput: () => term.hasSelection() && !!selectedRange(),
    /**
     * A send accepted now whose input arrives later, paced (the command bar):
     * reported as held at once, and held until release(). Its input goes in
     * through write(); once the queue drops what it held (the prompt changed
     * under an edit or a paste), the rest of the send is dropped too.
     */
    reserve(data) {
      const r = { cancelled: false };
      reserved.add(r);
      hold(data);
      return {
        write: (d) => { if (!r.cancelled && !disposed) handleData(d); },
        release: () => { if (reserved.delete(r)) drained(); },
      };
    },
    dispose() {
      disposed = true;
      for (const type of armEvents) el?.removeEventListener(type, arm, true);
      el?.removeEventListener('mousedown', onMouseDown, true);
      queue.length = 0;
      reserved.clear();
      if (holding) { holding = false; held(null); }
    },
  };
}
