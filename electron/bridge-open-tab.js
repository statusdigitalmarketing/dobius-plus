// /openTab on the local bridge: open a VISIBLE tab in a project's window,
// as a New Tab that starts Claude (tool 'claude', whatever the user's New
// Tab default is; no flags, the user's own settings), wait until its prompt is
// really on screen, type a message (one bracketed paste, so its line breaks
// stay input) and then press Enter ONCE, separately, so Claude starts on it.
// Built for Brett's inbox board: his click on a card is the OK, so nothing
// here asks for a YES. Claude's permission mode is the user's own, in every
// mode including bypass (Sam's decision, docs/bridge-open-tab.md Security).
//
// Pure module (no electron import). Everything that touches windows, PTYs or
// the screen emulator comes in as `deps` from main.js, so the request logic,
// the dedupe and the readiness wait are unit tested with fakes:
// electron/__tests__/bridge-open-tab.test.mjs. Docs: docs/bridge-open-tab.md.

import { isTerminalReply } from './terminal-reply.js';
import { parseSelectorFromScreen } from './selector-parser.js';
import { shQuote } from '../shared/sh-quote.js';

// Mouse reports (X10, SGR, urxvt) are what a pointer over a fullscreen
// Claude sends; they are not someone typing. Neither are the terminal's
// own replies (focus, cursor reports).
const MOUSE_RE = /\x1b\[M[\s\S]{3}|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M/g;
// The terminal's own answers to a program's queries, wherever they sit in a
// chunk: focus, cursor and status reports (ESC[0n, ESC[r;cR), device
// attributes, mode reports, OSC answers. A cursor report can equal a
// modified F3; missing such a key press here only means a stray Shift+F3
// does not count as someone typing, which is harmless.
const REPLY_RE = /\x1b\[[IO]|\x1b\[\??\d+(?:;\d+)*R|\x1b\[\d*n|\x1b\[[?>=][\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Any input a PERSON made (keys, mouse clicks and wheel): only the
// terminal's own replies are left out. Between the paste and the Enter even a
// wheel turn counts: Claude can bind it to recall history into the box.
export function isUserInput(data) {
  if (typeof data !== 'string' || !data) return false;
  if (isTerminalReply(data)) return false;
  return data.replace(REPLY_RE, '').length > 0;
}

export function isKeyboardInput(data) {
  if (typeof data !== 'string' || !data) return false;
  if (isTerminalReply(data)) return false;
  return data.replace(MOUSE_RE, '').replace(REPLY_RE, '').length > 0;
}

// The board's own id for a card click: letters, digits and . _ : - only, so
// it can never smuggle anything into a log line or a map key.
export const OPEN_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const MAX_OPEN_MESSAGE_BYTES = 32 * 1024;
const MAX_PROJECT_PATH = 4096;

// Remembered request ids. A repeat of a remembered id brings its tab to the
// front instead of opening another. Oldest settled entries go first.
export const MAX_REMEMBERED_REQUESTS = 500;
// Opens running at once (distinct ids). Each one holds a window, a PTY and a
// Claude startup, so a runaway caller is refused instead of queued.
export const MAX_OPENS_IN_FLIGHT = 4;

export const READY_TIMEOUT_MS = 60_000;
// After the paste: Claude must redraw (its echo of the text), then stay
// quiet for SUBMIT_QUIET_POLLS polls, within SUBMIT_SETTLE_MAX_MS.
const SUBMIT_POLL_MS = 100;
const SUBMIT_QUIET_POLLS = 3;
const SUBMIT_SETTLE_MAX_MS = 5000;
// Claude reads these as the first character of its input as a MODE, not a
// message: ! runs the rest as a shell command with no permission prompt,
// / runs a slash command, # writes memory, & sends to the background. A card
// starting with one is typed but never sent automatically.
const MODE_LEAD_RE = /^\s*[!/#&]/;
// A message ending in a backslash: Claude reads backslash + Enter as "new
// line", so the Enter would not send it. Typed, never sent automatically.
const TRAILING_BACKSLASH_RE = /\\\s*$/;
const READY_POLL_MS = 250;
// After the Enter: Claude empties its input box when it takes a message.
const SUBMIT_CONFIRM_MS = 3000;

/**
 * Make a message safe to type into Claude's prompt as ONE bracketed paste.
 * Line breaks survive as \n (Claude puts them in the input box, it does not
 * submit on a pasted newline); \r\n and a lone \r become \n so no carriage
 * return can act as Enter. Escape sequences are removed whole (an ESC [201~
 * would end the paste early and let the rest drive the TUI as keys), then any
 * remaining C0/C1 control character except tab and newline is dropped.
 * Returns { text } or { error }.
 */
export function sanitizeOpenMessage(message) {
  if (typeof message !== 'string') return { error: 'message must be a string' };
  if (Buffer.byteLength(message, 'utf8') > MAX_OPEN_MESSAGE_BYTES) {
    return { error: `message is larger than ${MAX_OPEN_MESSAGE_BYTES} bytes` };
  }
  const text = message
    .replace(/\r\n?/g, '\n')
    // OSC / DCS / APC / PM / SOS strings, to BEL or ST (or the end).
    .replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    // CSI with its parameters and final byte.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]?/g, '')
    // SS2/SS3 (ESC O A is an arrow key) and ESC with intermediates (ESC ( B).
    .replace(/\x1b(?:[NO]|[ -/]+)[\s\S]?/g, '')
    // Any other two-byte escape (ESC 7, ESC c ...).
    .replace(/\x1b[\s\S]?/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g, '');
  if (!text.trim()) return { error: 'message is empty' };
  return { text };
}

/** Validate a /openTab body. Returns { requestId, projectPath, message } or { error }. */
export function validateOpenTabBody(body) {
  const { projectPath, message, requestId } = body || {};
  if (typeof requestId !== 'string' || !OPEN_REQUEST_ID_RE.test(requestId)) {
    return { error: 'requestId must be 1-128 characters: letters, digits, . _ : - (starting with a letter or digit)' };
  }
  if (typeof projectPath !== 'string' || !projectPath) return { error: 'projectPath must be a non-empty string' };
  if (!projectPath.startsWith('/')) return { error: 'projectPath must be an absolute path' };
  if (projectPath.length > MAX_PROJECT_PATH || /[\x00-\x1f\x7f]/.test(projectPath)) {
    return { error: 'projectPath is too long or contains control characters' };
  }
  const m = sanitizeOpenMessage(message);
  if (m.error) return { error: m.error };
  return { requestId, projectPath, message: m.text };
}

// A horizontal rule row: Claude draws one above and one below its prompt.
const RULE_RE = /^\s*─{8,}/;
// The prompt row itself. Told from a selector row ("❯ 1. Yes") by where the
// caret is (caretInBox); a screen with no cursor position (tests that pass
// plain rows) falls back to refusing any numbered row.
const PROMPT_ROW_RE = /^\s*[❯>](?:\s|$)/;
const OPTION_ROW_RE = /^\s*[❯>]\s*\d+[.)]\s/;
// Older Claude Code: a rounded box, "│ > ..." inside it.
const BOX_TOP_RE = /^\s*╭─+╮\s*$/;
const BOX_PROMPT_RE = /^\s*│\s*>(?:\s|│|$)/;
const BOX_BOTTOM_RE = /^\s*╰─+╯\s*$/;
// Claude keeps its prompt at the bottom of what it draws: at most a footer,
// a status line and a short list below it. A lookalike higher up (a file
// being shown, an old screen) does not count.
export const PROMPT_BOTTOM_ROWS = 12;
// Tallest input box accepted (a typed multi-line message grows it).
const MAX_BOX_ROWS = 60;

/**
 * Is Claude's input prompt on screen and taking input? `lines` is the
 * emulated screen (screen-render.js) and `modes` its terminal modes. Two
 * signals must agree: the program turned bracketed paste ON (it is reading
 * the keyboard in raw mode and will treat our paste as a paste, not keys),
 * and the prompt box is drawn: a rule, a prompt row, and a closing rule a few
 * rows below, within the bottom PROMPT_BOTTOM_ROWS rows of drawn content. A
 * trust dialog, a login screen or a permission prompt is NOT ready: none of
 * them draws a prompt row right under a rule. This is the SCREEN half only;
 * the service also requires claude to be the tab's foreground process.
 */
export function isClaudePromptReady(lines, modes) {
  return promptBoxText(lines, modes) !== null;
}

// A dialog on screen (a permission question, a selector): an Enter there
// ANSWERS it. Its footer or a numbered selector anywhere means not ready,
// whatever box-like rows it quotes (a heredoc can contain a rule and a ❯).
const DIALOG_RE = /Esc to cancel|Enter to (?:confirm|select)|Do you want to |Would you like to /i;
function dialogOnScreen(lines) {
  if (lines.some((l) => DIALOG_RE.test(String(l || '')))) return true;
  try { return !!parseSelectorFromScreen(lines); } catch { return true; }
}

// Is the terminal cursor in this box's TEXT? Claude's default renderer keeps
// it on the input caret: right of the prompt character, on a row between the
// rules. A selector parks it ON its ❯ (column 0 or 1), and a lookalike box
// drawn elsewhere (a chained status line printing a rule, "❯ main", a rule)
// does not hold it at all. modes.cursor comes from screen-render.js.
function caretInBox(cursor, top, bottom, firstRow) {
  if (!cursor) return null; // unknown: the caller falls back to row text
  const glyph = String(firstRow).search(/[❯>]/);
  return Number.isInteger(cursor.y) && cursor.y > top && cursor.y < bottom
    && Number.isInteger(cursor.x) && cursor.x >= glyph + 2;
}

/**
 * The text inside Claude's input box (prompt row with the ❯ removed, then any
 * further rows), or null when the screen is not an idle Claude prompt. The box
 * is the one holding the caret, not merely the lowest lookalike: rows Claude
 * draws under its box (a status line) can draw boxes too.
 */
export function promptBoxText(lines, modes) {
  if (!Array.isArray(lines) || !modes?.bracketedPaste) return null;
  let last = lines.length - 1;
  while (last >= 0 && !String(lines[last] || '').trim()) last -= 1;
  // The box's CLOSING edge must be near the bottom; its top is the nearest
  // rule above it, with the prompt row right under that. The box may be
  // tall once a message is typed into it.
  for (let j = last; j >= 1 && j >= last - PROMPT_BOTTOM_ROWS; j -= 1) {
    const flat = RULE_RE.test(lines[j]);
    if (!flat && !BOX_BOTTOM_RE.test(lines[j])) continue;
    const isTop = flat ? (r) => RULE_RE.test(r) : (r) => BOX_TOP_RE.test(r);
    let top = j - 1;
    while (top >= 0 && j - top <= MAX_BOX_ROWS && !isTop(lines[top] || '')) top -= 1;
    if (top < 0 || top === j - 1 || j - top > MAX_BOX_ROWS) continue;
    const row = lines[top + 1] || '';
    const caret = caretInBox(modes.cursor, top, j, row);
    if (caret === false) continue;
    if (flat ? (PROMPT_ROW_RE.test(row) && (caret || !OPTION_ROW_RE.test(row))) : BOX_PROMPT_RE.test(row)) {
      // A dialog anywhere OUTSIDE the box (the box's own text is the
      // message, which may well say "Do you want to ...").
      if (dialogOnScreen([...lines.slice(0, top + 1), ...lines.slice(j)])) return null;
      // Only Claude's own chrome is stripped: the prompt character on the
      // FIRST row, and the side borders of the older boxed prompt. A later
      // row starting with ">" or "│" in the flat prompt is message text.
      const lead = k0 => (flat ? (k0 ? /^\s*[❯>]?\s?/ : /^\s*/) : (k0 ? /^\s*│?\s*>?\s?/ : /^\s*│?\s*/));
      const rows = lines.slice(top + 1, j).map((r, k) => String(r).replace(lead(k === 0), '').replace(flat ? /\s+$/ : /\s*│?\s*$/, ''));
      return rows.join('\n');
    }
  }
  return null;
}

/**
 * Does the box hold the message just pasted? Claude shows a short paste as
 * text and a long one as "[Pasted text #1 +N lines]". Checked before the
 * Enter, so it can only ever send the box when it holds what was pasted.
 */
// The box holds exactly this message: same text with all whitespace removed
// (Claude wraps rows, draws a tab as spaces, indents continuation rows), or
// only Claude's own marker for a long paste. EXACT, not a prefix: anything
// else in the box (a recalled history entry, a person's text) means the
// Enter would send something the card did not say.
const squash = (x) => String(x).replace(/\s+/g, '');
// Claude's marker for a long paste names the paste's number in the session
// and its extra lines. The tab is brand new, so the card is paste #1, and the
// line count must be the card's: an older entry recalled into the box (shown
// as some other marker) never passes.
const PASTE_MARKER_RE = /^\[Pasted text #(\d+)(?: \+(\d+) lines?)?\]$/;
function boxIsMessage(boxText, message) {
  if (typeof boxText !== 'string') return false;
  const marker = PASTE_MARKER_RE.exec(boxText.trim());
  if (marker) {
    const lines = message.split('\n').length;
    const extra = marker[2] === undefined ? null : Number(marker[2]);
    return marker[1] === '1' && (extra === null ? lines === 1 : (extra === lines - 1 || extra === lines));
  }
  const want = squash(message);
  return want.length > 0 && squash(boxText) === want;
}
export const boxHoldsMessage = boxIsMessage;
// After the Enter: is the message still sitting there? Same exact test, so
// a message the Enter only split in two ("he" / "llo", Enter bound to a new
// line) still counts as NOT sent, while an empty box or Claude's
// placeholder ("Try ...") counts as sent.
export const boxStillHasMessage = boxIsMessage;

/**
 * The /openTab service. deps:
 *   resolveProject(path) -> Promise<{ path } | { error, status? }>
 *   openTab(projectPath) -> Promise<{ tabId, keyCounter } | { error, tabId? }>   window + visible
 *                                     tab whose shell starts Claude (New Tab, tool 'claude')
 *   tabAlive(tabId) -> boolean        the tab still exists in a live window
 *   focusTab(tabId) -> boolean        bring its window and the tab to the front
 *   ptyOf(tabId) -> object|null       PTY identity (a replaced shell is a new object)
 *   claudeRunning(tabId, projectPath) -> Promise<boolean>  claude leads the FOREGROUND process
 *                                     group of the tab's terminal, working in the project
 *   watchOutput(tabId, keyCounter) -> { seq(), keys(), input(), screen(): Promise<{ lines, modes } | null>, stop() }
 *                                     the tab's output since its PTY started, emulated;
 *                                     seq() counts chunks;
 *                                     keys() counts a PERSON's keyboard writes into the tab
 *                                     (not ours, not mouse reports or terminal replies)
 *   paste(tabId, text) -> void        one bracketed paste, no Enter, written now
 *   submit(tabId) -> void             one Enter, its own write
 *   inputBusy(tabId) -> boolean       another surface is mid-submit into the tab
 *   sleep(ms), now()
 */
export function createOpenTabService(deps, opts = {}) {
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const requests = new Map(); // requestId -> { projectPath, promise, settled, tabId }
  let inFlight = 0;

  function remember(requestId, entry) {
    requests.set(requestId, entry);
    if (requests.size <= MAX_REMEMBERED_REQUESTS) return;
    for (const [id, e] of requests) {
      if (requests.size <= MAX_REMEMBERED_REQUESTS) break;
      if (e.settled) requests.delete(id);
    }
  }

  // Polls the emulated screen. Ready only on two polls in a row, so a frame
  // caught mid-repaint cannot count, and only while a claude process runs in
  // the tab: a shell prompt drawn with rules and a ❯ (a prompt theme's ruler)
  // must never receive the paste. Fails as soon as the tab or its shell is
  // gone, never typing into a replacement.
  async function waitReady(tabId, pty, watch, projectPath) {
    const end = deps.now() + readyTimeoutMs;
    let hits = 0;
    while (deps.now() < end) {
      if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return 'gone';
      const seqAtRead = watch.seq();
      let screen;
      try { screen = await watch.screen(); } catch { screen = null; }
      const drawn = !!screen && isClaudePromptReady(screen.lines, screen.modes);
      hits = drawn && (await deps.claudeRunning(tabId, projectPath)) ? hits + 1 : 0;
      // Ready means: the screen that was judged is still the screen, checked
      // AFTER the process check. Any output since the read (Claude exiting
      // and the shell redrawing, a dialog opening) sends us round again. The
      // caller pastes in the same tick as this return: no output or exit can
      // be processed in between.
      if (hits >= 2 && watch.seq() === seqAtRead && deps.ptyOf(tabId) === pty) return 'ready';
      if (watch.seq() !== seqAtRead) hits = Math.min(hits, 1);
      await deps.sleep(READY_POLL_MS);
    }
    return 'timeout';
  }

  // Brett: "after it types the message, press Enter so Claude starts right
  // away". The Enter is the ONLY submit (the message cannot contain one) and
  // goes out as its own write, only after Claude has visibly taken the paste
  // (its echo, then quiet), and only while everything that cleared the paste
  // still holds: claude in the foreground, its prompt box on screen, no
  // output since that was read, and nothing else typed into the tab since the
  // paste (a person's keys, or their mouse over a fullscreen Claude). Any
  // doubt leaves the message typed and unsent: { ok, submitted: false }.
  async function submitPasted(tabId, pty, watch, seqAtPaste, message, projectPath) {
    // Any person's input from here on (a wheel turn included) can change what
    // the box holds, so it withholds the Enter and voids the confirmation.
    const inputAtPaste = watch.input();
    const typedOnly = (why) => ({ ok: true, tabId, submitted: false, note: `the message is typed into Claude's prompt but was not sent: ${why}; press Enter in the tab to send it` });
    const end = deps.now() + SUBMIT_SETTLE_MAX_MS;
    let last = seqAtPaste;
    let quiet = 0;
    while (quiet < SUBMIT_QUIET_POLLS) {
      if (deps.now() >= end) return typedOnly('Claude did not show the pasted text in time');
      await deps.sleep(SUBMIT_POLL_MS);
      const seq = watch.seq();
      quiet = seq > seqAtPaste && seq === last ? quiet + 1 : 0;
      last = seq;
    }
    const seqAtRead = watch.seq();
    let screen;
    try { screen = await watch.screen(); } catch { screen = null; }
    const box = screen ? promptBoxText(screen.lines, screen.modes) : null;
    const holds = boxHoldsMessage(box, message);
    const claude = holds && (await deps.claudeRunning(tabId, projectPath));
    // Same tick from here to the Enter.
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return typedOnly('the tab closed or its shell changed');
    if (!holds) return typedOnly('Claude\'s prompt did not show the message (a dialog may be open)');
    if (!claude) return typedOnly('Claude was not in the foreground with its prompt on screen');
    if (watch.seq() !== seqAtRead) return typedOnly('the screen changed while it was being checked');
    if (watch.keys() !== 0 || deps.inputBusy(tabId)) return typedOnly('someone typed into the tab');
    if (watch.input() !== inputAtPaste) return typedOnly('someone used the mouse or keyboard in the tab after the paste');
    // Security review (HIGH, "a token holder can submit a prompt"), kept on
    // purpose: Brett asked for the send, and /tabSend with the same token
    // already writes message + Enter into ANY tab, plain shells included.
    // This route adds no capability the token lacks and is narrower: a fresh
    // tab, claude verified as its foreground process, and the session's own
    // permission mode (in bypass there are no prompts: Sam's decision). See
    // docs/bridge-open-tab.md, Security.
    deps.submit(tabId);
    // Did Claude take it? A submit empties the box; an Enter bound to "new
    // line" (Claude supports that) leaves the message sitting there.
    const confirmEnd = deps.now() + SUBMIT_CONFIRM_MS;
    while (deps.now() < confirmEnd) {
      await deps.sleep(SUBMIT_POLL_MS);
      let after;
      try { after = await watch.screen(); } catch { after = null; }
      // Someone typed meanwhile (a Ctrl+C can clear an unsent draft): an
      // empty box no longer proves Claude took it.
      if (watch.keys() !== 0 || watch.input() !== inputAtPaste) return { ok: true, tabId, submitted: false, note: 'Enter was pressed, but someone typed or used the mouse in the tab before Claude was seen taking the message; check the tab' };
      // A closing window sends Ctrl+C straight to the PTY (no key counted),
      // which also empties the box.
      if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return { ok: true, tabId, submitted: false, note: 'Enter was pressed, but the tab closed before Claude was seen taking the message' };
      if (!after) continue; // a failed read proves nothing
      // Only an input box that is SEEN and no longer holds the message
      // confirms the send; a frame with no recognisable box proves nothing.
      const box = promptBoxText(after.lines, after.modes);
      if (box !== null && !boxStillHasMessage(box, message)) return { ok: true, tabId, submitted: true };
    }
    return { ok: true, tabId, submitted: false, note: 'Enter was pressed but the message is still in Claude\'s prompt (is Enter set to insert a new line?); press the key that sends it' };
  }

  async function run(projectPath, message) {
    const resolved = await deps.resolveProject(projectPath);
    if (resolved.error) return { ok: false, status: resolved.status || 400, error: resolved.error };
    const opened = await deps.openTab(resolved.path);
    // A tab that was added but whose shell never started is still named, so
    // the board can tell the person which tab to close.
    if (opened.error) return { ok: false, status: 500, error: opened.error, ...(opened.tabId ? { tabId: opened.tabId } : {}) };
    const { tabId } = opened;
    const pty = deps.ptyOf(tabId);
    // The tab was asked for with tool 'claude' (store.openNewTab): its login
    // shell starts Claude itself as its first command (shared/new-tab.js),
    // whatever the user's New Tab default is. Nothing is typed to launch it.
    // Watched before anything can return, so stop() always releases the key
    // counter openTab started (and its reload listener).
    const watch = deps.watchOutput(tabId, opened.keyCounter);
    try {
      if (!pty) return { ok: false, status: 500, tabId, error: 'the tab\'s shell exited before Claude could start' };
      // A person typing into the new tab has taken it over: whatever they
      // typed (and an Enter of theirs still on its way) must never carry
      // the card's text. Mouse movement does not count.
      const typedIn = { ok: false, status: 409, tabId, error: 'someone typed into the tab, so the message was not typed' };
      const state = await waitReady(tabId, pty, watch, resolved.path);
      const gone = { ok: false, status: 409, tabId, error: 'the tab was closed, its shell exited or Claude stopped before the message could be typed; nothing was typed' };
      if (state === 'gone') return gone;
      if (state === 'timeout') {
        return { ok: false, status: 504, tabId, error: `Claude's prompt did not appear within ${Math.round(readyTimeoutMs / 1000)}s (a trust or login question may be waiting in the tab); the tab is open and nothing was typed` };
      }
      // No await between the last process check (inside waitReady) and the
      // paste, so nothing can change in between.
      if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return gone;
      if (watch.keys() !== 0) return typedIn;
      if (deps.inputBusy(tabId)) return { ok: false, status: 409, tabId, error: 'something else was typing into the tab; nothing was typed' };
      const outputBeforePaste = watch.seq();
      deps.paste(tabId, message);
      const lead = MODE_LEAD_RE.exec(message);
      if (lead) return { ok: true, tabId, submitted: false, note: `the message is typed into Claude's prompt but was not sent: it starts with "${lead[0].trim()}", which Claude treats as a command rather than a message; check it and press Enter in the tab yourself` };
      if (TRAILING_BACKSLASH_RE.test(message)) return { ok: true, tabId, submitted: false, note: 'the message is typed into Claude\'s prompt but was not sent: it ends with a backslash, which Claude reads as a line continuation; press Enter in the tab yourself' };
      return await submitPasted(tabId, pty, watch, outputBeforePaste, message, resolved.path);
    } finally {
      watch.stop();
    }
  }

  /** Handle one /openTab body. Resolves { status, body }. */
  async function open(rawBody) {
    const v = validateOpenTabBody(rawBody);
    if (v.error) return { status: 400, body: { ok: false, error: v.error } };
    const { requestId, projectPath, message } = v;

    const prior = requests.get(requestId);
    if (prior) {
      if (prior.projectPath !== projectPath) {
        return { status: 409, body: { ok: false, error: 'requestId was already used for a different projectPath' } };
      }
      // A concurrent duplicate waits for the first call instead of opening
      // a second tab, and shares its outcome even when that failed: a slow
      // window or shell must not turn one click into two tabs.
      const concurrent = !prior.settled;
      const first = await prior.promise;
      const { status, ...remembered } = first;
      if (concurrent && !first.ok) return { status, body: remembered };
      // A repeat reports what the first call did, not a fresh success: a
      // tab whose card was never typed (504, 409) or never sent says so.
      if (first.tabId && deps.tabAlive(first.tabId)) {
        deps.focusTab(first.tabId);
        return { status: first.ok ? 200 : status, body: { ...remembered, existing: true } };
      }
      if (concurrent) return { status: 200, body: { ...remembered, existing: true } };
      // A later click whose tab is gone (closed since): open a new one.
      if (requests.get(requestId) === prior) requests.delete(requestId);
      return open(rawBody);
    }

    if (inFlight >= MAX_OPENS_IN_FLIGHT) {
      return { status: 429, body: { ok: false, error: 'too many tabs are opening right now; try again in a moment' } };
    }
    inFlight += 1;
    const entry = { projectPath, settled: false, promise: null };
    entry.promise = run(projectPath, message)
      .catch((err) => ({ ok: false, status: 500, error: `could not open the tab: ${err?.message || err}` }))
      .finally(() => { inFlight -= 1; entry.settled = true; });
    remember(requestId, entry);
    const result = await entry.promise;
    // Nothing was opened: forget the id so the board can simply retry.
    if (!result.tabId && requests.get(requestId) === entry) requests.delete(requestId);
    const { status, ...body } = result;
    return { status: result.ok ? 200 : status, body };
  }

  return { open, _requests: requests };
}

/** The bash script installed as dobius-open. */
export function buildOpenCliScript({ port, tokenFile }) {
  return `#!/bin/bash
# dobius-open: open a new Dobius+ tab in a project, start Claude in it and
# type a message into Claude's prompt, then press Enter once to send it.
# Usage: dobius-open <project-folder> <request-id> "<message>"
#        dobius-open <project-folder> <request-id> - < message.txt
# Use the stdin form for anything private: a message given as an argument is
# visible to other local users (ps) while the command runs.
# The same request id again brings that tab to the front instead.
# Prints the bridge's JSON reply; exits 0 only when it says ok.
set -e
if [ $# -lt 3 ]; then
  echo 'usage: dobius-open <project-folder> <request-id> "<message>" (or - to read stdin)' >&2
  exit 1
fi
command -v python3 >/dev/null 2>&1 || { echo "dobius-open: python3 not found on PATH" >&2; exit 3; }
command -v curl >/dev/null 2>&1 || { echo "dobius-open: curl not found on PATH" >&2; exit 3; }
TOKEN=$(cat ${shQuote(tokenFile)} 2>/dev/null) || { echo "dobius-open: bridge token unreadable (is Dobius+ running?)" >&2; exit 2; }
if [ "$3" = "-" ]; then MESSAGE=$(cat); else MESSAGE="$3"; fi
# The token and the message never go on a command line (any local user can
# read argv with ps): the header comes from a 0600 temp file, the body from
# stdin, and python reads the fields from its environment.
# ensure_ascii=False: \\u escapes would triple a non-ASCII message past the
# bridge's 64KB body limit.
BODY=$(PYTHONIOENCODING=utf-8 OPEN_PROJECT="$1" OPEN_ID="$2" OPEN_MESSAGE="$MESSAGE" python3 -c 'import json,os; print(json.dumps({"projectPath": os.environ["OPEN_PROJECT"], "requestId": os.environ["OPEN_ID"], "message": os.environ["OPEN_MESSAGE"]}, ensure_ascii=False))')
HDR=$(mktemp) || exit 3
trap 'rm -f "$HDR"' EXIT
chmod 600 "$HDR"
printf 'Authorization: Bearer %s\\n' "$TOKEN" > "$HDR"
# --noproxy: an http_proxy in the environment must never see the token.
RESPONSE=$(printf '%s' "$BODY" | curl -sS --noproxy '*' --max-time 180 -X POST "http://127.0.0.1:${port}/openTab" \\
  -H "Host: 127.0.0.1:${port}" \\
  -H @"$HDR" \\
  -H "Content-Type: application/json" \\
  --data-binary @-)
echo "$RESPONSE"
printf '%s' "$RESPONSE" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") else 1)'
`;
}
