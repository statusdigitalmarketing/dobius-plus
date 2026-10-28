// Chat-view plumbing shared by the mobile WS server and the desktop Chat pane:
// the live selector popup, a plain-text tail of the screen, and the
// paste-then-Enter submit. Main-process only.

import { getTerminalBuffer, writeTerminal, terminalInstance } from './terminal-manager.js';
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

const SUBMIT_ENTER_DELAY_MS = 250;
// tabId -> { running, items, gen }. gen bumps on a cancel key; an item queued
// under an older gen is dropped instead of pasted.
const submitQueues = new Map();

/**
 * Type a chat message into a tab the way a human would: bracketed-paste the
 * text, then press Enter as a DISCRETE keypress once the paste settles. One
 * `text\r` chunk reads as a paste to Claude's Ink TUI, so the \r became a
 * newline inside the input box and the message sat there unsubmitted (Sam's
 * v1.0.51 mobile bug 3). A bare shell prompt honors the same sequence, which is
 * how "Start Claude" launches.
 *
 * Submits to one tab run one at a time: two overlapping ones would land both
 * pastes before the first Enter and send them as a single message. An idle
 * tab is pasted into synchronously, so raw input that arrives right after
 * (a Ctrl+U in the same WebSocket read) still lands after the paste, as it
 * always did. The PTY is captured when the submit is ACCEPTED: nothing is
 * pasted or confirmed into a shell that replaced it meanwhile, and nothing is
 * sent once `stillOk()` (the caller's ownership or connection check) says no.
 *
 * @returns {Promise<boolean>} whether the Enter was sent
 */
export function submitPromptToTab(id, text, stillOk = () => true) {
  // Strip control chars except \t and \n (multi-line paste is legitimate); \r
  // goes too so the only Enter is the discrete one sent below.
  const clean = String(text).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  const pty = terminalInstance(id);
  if (!pty || !stillOk()) return Promise.resolve(false);
  let q = submitQueues.get(id);
  if (!q) { q = { running: false, items: [], gen: 0 }; submitQueues.set(id, q); }
  return new Promise((resolve) => {
    q.items.push({ clean, pty, stillOk, gen: q.gen, resolve });
    if (!q.running) drainSubmits(id, q);
  });
}

async function drainSubmits(id, q) {
  q.running = true;
  while (q.items.length > 0) {
    const it = q.items.shift();
    const live = () => terminalInstance(id) === it.pty && it.stillOk();
    if (it.gen !== q.gen || !live()) { it.resolve(false); continue; }
    writeTerminal(id, `\x1b[200~${it.clean}\x1b[201~`);
    await new Promise((r) => setTimeout(r, SUBMIT_ENTER_DELAY_MS));
    if (!live()) { it.resolve(false); continue; }
    writeTerminal(id, '\r');
    it.resolve(true);
  }
  q.running = false;
  if (submitQueues.get(id) === q) submitQueues.delete(id);
}

/**
 * Raw input that cancels (Ctrl+C, Ctrl+U, a bare Esc) also drops submits that
 * are still queued behind another one, as it would have when every paste went
 * out at once. The submit already pasted is left to the shell or TUI, which
 * the same key just cleared.
 */
export function noteRawInput(id, data) {
  if (typeof data !== 'string') return;
  if (data !== '\x1b' && !data.includes('\x03') && !data.includes('\x15')) return;
  const q = submitQueues.get(id);
  if (q) q.gen += 1;
}
