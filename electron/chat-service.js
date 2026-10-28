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
const submitChains = new Map(); // tabId -> tail promise of queued submits

/**
 * Type a chat message into a tab the way a human would: bracketed-paste the
 * text, then press Enter as a DISCRETE keypress once the paste settles. One
 * `text\r` chunk reads as a paste to Claude's Ink TUI, so the \r became a
 * newline inside the input box and the message sat there unsubmitted (Sam's
 * v1.0.51 mobile bug 3). A bare shell prompt honors the same sequence, which is
 * how "Start Claude" launches.
 *
 * Submits to one tab run one at a time: two overlapping ones would land both
 * pastes before the first Enter and send them as a single message. The Enter
 * is withheld when the tab's PTY was replaced meanwhile or `stillOk()` (the
 * caller's ownership recheck) now says no, so a message can never be
 * confirmed into a different shell than the one it was pasted into.
 *
 * @returns {Promise<boolean>} whether the Enter was sent
 */
export function submitPromptToTab(id, text, stillOk = () => true) {
  // Strip control chars except \t and \n (multi-line paste is legitimate); \r
  // goes too so the only Enter is the discrete one sent below.
  const clean = String(text).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  const prev = submitChains.get(id) || Promise.resolve();
  const run = prev.then(async () => {
    const pty = terminalInstance(id);
    if (!pty || !stillOk()) return false;
    writeTerminal(id, `\x1b[200~${clean}\x1b[201~`);
    await new Promise((r) => setTimeout(r, SUBMIT_ENTER_DELAY_MS));
    if (terminalInstance(id) !== pty || !stillOk()) return false;
    writeTerminal(id, '\r');
    return true;
  });
  const tail = run.catch(() => false);
  submitChains.set(id, tail);
  tail.then(() => { if (submitChains.get(id) === tail) submitChains.delete(id); });
  return run;
}
