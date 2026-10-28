// Chat-view plumbing shared by the mobile WS server and the desktop Chat pane:
// the live selector popup, a plain-text tail of the screen, and the
// paste-then-Enter submit. Main-process only.

import { getTerminalBuffer, writeTerminal, terminalInstance, terminalInputSeq, terminalSettledSinceInput } from './terminal-manager.js';
import { parseSelector, parseSelectorFromScreen, stripAnsi } from './selector-parser.js';
import { renderScreenLines } from './screen-render.js';

// The live selector for a tab, via the headless-xterm SCREEN render (v1.0.62).
// The old strip-and-regex path missed Ink's incremental repaints entirely: on
// a multi-question AskUserQuestion, question two never formed complete lines
// in a linear strip, so its popup never appeared on the phone (Sam, 8/14).
// The emulator's verdict is authoritative when it renders (including "no
// selector": it honors the erase sequences that REMOVE answered prompts, so
// it also kills the stale-popup class); the regex path remains only for a
// render failure.
export async function liveSelectorForTab(id) {
  const raw = getTerminalBuffer(id) || '';
  const lines = await renderScreenLines(raw.slice(-262144));
  if (lines) return parseSelectorFromScreen(lines);
  return parseSelector(raw);
}

// Plain-text tail of the tab's output for tabs with no transcript to show
// (plain shells, a Claude that has not linked its session yet). Trailing blank
// padding per line and the all-blank tail are dropped.
export function terminalTextTail(id, maxLines = 60) {
  const raw = stripAnsi(getTerminalBuffer(id) || '');
  const lines = raw.split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-maxLines).join('\n');
}

// A selector read is stamped with the PTY and the count of writes it has
// received (from any surface: desktop terminal, Chat, phone, auto-resume). An
// answer is only delivered while both still match, so a prompt answered
// elsewhere can never be "answered" again into whatever prompt replaced it.
const ptySerials = new WeakMap();
let nextPtySerial = 1;

/**
 * `<pty serial>:<input count>` for the tab right now, or '' with no PTY, or
 * while the tab has produced no output since its last input: the screen may
 * still show a prompt that input already answered, and a fresh token on that
 * stale screen would let its option answer whatever prompt comes next.
 */
export function selectorToken(id) {
  const pty = terminalInstance(id);
  if (!pty || !terminalSettledSinceInput(id)) return '';
  if (!ptySerials.has(pty)) ptySerials.set(pty, nextPtySerial++);
  return `${ptySerials.get(pty)}:${terminalInputSeq(id)}`;
}

const SUBMIT_ENTER_DELAY_MS = 250;
// tabId -> { running, items, gen }. gen bumps on a cancel key; an item queued
// under an older gen is dropped instead of written.
const submitQueues = new Map();

const isCancelKey = (data) => data === '\x1b' || data.includes('\x03') || data.includes('\x15');

function queueFor(id) {
  let q = submitQueues.get(id);
  if (!q) { q = { running: false, items: [], gen: 0 }; submitQueues.set(id, q); }
  return q;
}

/**
 * Type a chat message into a tab the way a human would: bracketed-paste the
 * text, then press Enter as a DISCRETE keypress once the paste settles. One
 * `text\r` chunk reads as a paste to Claude's Ink TUI, so the \r became a
 * newline inside the input box and the message sat there unsubmitted (Sam's
 * v1.0.51 mobile bug 3). A bare shell prompt honors the same sequence, which is
 * how "Start Claude" launches.
 *
 * Submits to one tab run one at a time, and raw input that arrives while one
 * is pending queues behind it (writeRawInput), so keys always land in the
 * order they were sent. An idle tab is pasted into synchronously. The PTY is
 * captured when the submit is ACCEPTED: nothing is pasted or confirmed into a
 * shell that replaced it meanwhile, and nothing is pasted once `stillOk()`
 * (the caller's ownership or pairing check) says no. The Enter goes out only
 * if NOTHING else reached the tab during the delay: a cancel key or another
 * writer means the line is no longer the text that was pasted, and an Enter
 * would run whatever is there now.
 *
 * @returns {Promise<boolean>} whether the Enter was sent
 */
export function submitPromptToTab(id, text, stillOk = () => true) {
  // Strip control chars except \t and \n (multi-line paste is legitimate); \r
  // goes too so the only Enter is the discrete one sent below.
  const clean = String(text).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  const pty = terminalInstance(id);
  if (!pty || !stillOk()) return Promise.resolve(false);
  const q = queueFor(id);
  return new Promise((resolve) => {
    q.items.push({ clean, pty, stillOk, gen: q.gen, resolve });
    if (!q.running) drainSubmits(id, q);
  });
}

/**
 * Raw keys from a terminal or the phone. Written at once unless a submit is
 * pending on the tab, in which case they wait their turn behind it. A cancel
 * key (Ctrl+C, Ctrl+U, a bare Esc) always goes at once and drops everything
 * still queued, as it would have when every paste went out immediately.
 */
export function writeRawInput(id, data, stillOk = () => true) {
  if (typeof data !== 'string' || !data) return;
  const q = submitQueues.get(id);
  if (isCancelKey(data)) {
    if (q) q.gen += 1;
    writeTerminal(id, data);
    return;
  }
  if (!q || !q.running) { writeTerminal(id, data); return; }
  q.items.push({ raw: data, pty: terminalInstance(id), stillOk, gen: q.gen, resolve: () => {} });
}

/** A submit is typing into this tab right now (or queued behind one). */
export function submitPending(id) {
  return !!submitQueues.get(id)?.running;
}

async function drainSubmits(id, q) {
  q.running = true;
  while (q.items.length > 0) {
    const it = q.items.shift();
    if (it.gen !== q.gen || terminalInstance(id) !== it.pty || !it.stillOk()) { it.resolve(false); continue; }
    if (it.raw !== undefined) { writeTerminal(id, it.raw); it.resolve(true); continue; }
    writeTerminal(id, `\x1b[200~${it.clean}\x1b[201~`);
    const pastedAt = terminalInputSeq(id);
    await new Promise((r) => setTimeout(r, SUBMIT_ENTER_DELAY_MS));
    if (terminalInstance(id) !== it.pty || it.gen !== q.gen || terminalInputSeq(id) !== pastedAt) { it.resolve(false); continue; }
    writeTerminal(id, '\r');
    it.resolve(true);
  }
  q.running = false;
  if (submitQueues.get(id) === q) submitQueues.delete(id);
}
