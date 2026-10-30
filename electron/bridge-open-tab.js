// /openTab on the local bridge: open a VISIBLE tab in a project's window,
// start Claude in it the way a user would, wait until Claude's prompt is
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

// The file a node/bun/deno claude actually runs, once symlinks are resolved:
// the npm package's cli.js, or a native install's versioned entry.
export const CLAUDE_SCRIPT_RE = /\/(?:@anthropic-ai\/claude-code\/cli|claude\/versions\/[^/]+\/cli)\.(?:js|mjs|cjs)$/;

// Mouse reports (X10, SGR, urxvt) are what a pointer over a fullscreen
// Claude sends; they are not someone typing. Neither are the terminal's
// own replies (focus, cursor reports).
const MOUSE_RE = /\x1b\[M[\s\S]{3}|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M/g;
export function isKeyboardInput(data) {
  if (typeof data !== 'string' || !data) return false;
  if (isTerminalReply(data)) return false;
  return data.replace(MOUSE_RE, '').length > 0;
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
const READY_POLL_MS = 250;
// Shell readiness: some output, then this many quiet polls in a row.
const SHELL_QUIET_POLLS = 3;
const SHELL_POLL_MS = 100;
const SHELL_WAIT_MAX_MS = 10_000;
const LAUNCH_CHECK_TRIES = 5;
const LAUNCH_CHECK_GAP_MS = 300;
const LAUNCH_WAIT_MAX_MS = 10_000;
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
// The prompt row itself. A selector row ("❯ 1. Yes") is an option, not the prompt.
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

/**
 * The text inside Claude's input box (prompt row with the ❯ removed, then any
 * further rows), or null when the screen is not an idle Claude prompt.
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
    if (flat ? (PROMPT_ROW_RE.test(row) && !OPTION_ROW_RE.test(row)) : BOX_PROMPT_RE.test(row)) {
      // A dialog anywhere OUTSIDE the box (the box's own text is the
      // message, which may well say "Do you want to ...").
      if (dialogOnScreen([...lines.slice(0, top + 1), ...lines.slice(j)])) return null;
      const rows = lines.slice(top + 1, j).map((r) => String(r).replace(/^\s*│?\s*[❯>]?\s?/, '').replace(/\s*│?\s*$/, ''));
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
// After the Enter: is any of the message still in the box? Looser than
// boxHoldsMessage on purpose (whitespace ignored, anywhere in the box), so
// a message the Enter only split in two ("he" / "llo", a cursor moved by a
// click and Enter bound to a new line) still counts as NOT sent. An empty
// box, or Claude's placeholder, counts as sent.
export function boxStillHasMessage(boxText, message) {
  if (typeof boxText !== 'string') return false;
  if (/\[Pasted text #\d+/.test(boxText)) return true;
  const squash = (x) => x.replace(/\s+/g, '');
  const want = squash(message.split('\n').find((l) => l.trim()) || '').slice(0, 20);
  return want.length > 0 && squash(boxText).includes(want);
}

export function boxHoldsMessage(boxText, message) {
  if (typeof boxText !== 'string') return false;
  if (/\[Pasted text #\d+/.test(boxText)) return true;
  // Whitespace compared loosely: a pasted tab is drawn as spaces.
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const want = norm(message.split('\n').find((l) => l.trim()) || '').slice(0, 20).trim();
  return want.length > 0 && norm(boxText).startsWith(want);
}

/**
 * The /openTab service. deps:
 *   resolveProject(path) -> Promise<{ path } | { error, status? }>
 *   openTab(projectPath) -> Promise<{ tabId } | { error, tabId? }>   window + visible tab + its PTY
 *   tabAlive(tabId) -> boolean        the tab still exists in a live window
 *   focusTab(tabId) -> boolean        bring its window and the tab to the front
 *   ptyOf(tabId) -> object|null       PTY identity (a replaced shell is a new object)
 *   outputSeq(tabId) -> number        count of output chunks so far
 *   claudeRunning(tabId, projectPath) -> Promise<boolean>  claude leads the FOREGROUND process
 *                                     group of the tab's terminal, working in the project
 *   shellForeground(tabId) -> Promise<boolean>  the shell itself owns the terminal (no job running)
 *   shellInProject(tabId, path) -> Promise<boolean>  the shell's cwd is the project folder now
 *   typeLaunch(tabId) -> void         type `claude` + Enter at the shell prompt
 *   watchOutput(tabId) -> { mark(), seq(), keys(), screen(): Promise<{ lines, modes } | null>, stop() }
 *                                     the tab's output from now on, emulated; mark()
 *                                     forgets everything received so far; seq() counts chunks;
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

  async function waitShell(tabId) {
    const pty = deps.ptyOf(tabId);
    const end = deps.now() + SHELL_WAIT_MAX_MS;
    let last = -1;
    let quiet = 0;
    while (deps.now() < end) {
      if (deps.ptyOf(tabId) !== pty || !pty) return false;
      const seq = deps.outputSeq(tabId);
      quiet = seq > 0 && seq === last ? quiet + 1 : 0;
      if (quiet >= SHELL_QUIET_POLLS) return true;
      last = seq;
      await deps.sleep(SHELL_POLL_MS);
    }
    // A prompt that keeps redrawing (a clock in it) never goes quiet: the
    // shell is up, type anyway. The PTY is still the one we were given.
    return deps.ptyOf(tabId) === pty;
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
      if (!after) continue; // a failed read proves nothing
      if (!boxStillHasMessage(promptBoxText(after.lines, after.modes), message)) return { ok: true, tabId, submitted: true };
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
    if (!pty) return { ok: false, status: 500, tabId, error: 'the tab\'s shell exited before Claude could start' };
    // Only output from here on can make the tab "ready" (and, once the
    // launch is typed, only output after it): a prompt lookalike in the
    // shell's startup text cannot.
    const watch = deps.watchOutput(tabId, opened.keyCounter);
    try {
      if (!(await waitShell(tabId))) return { ok: false, status: 500, tabId, error: 'the tab\'s shell exited before Claude could start' };
      // Claude already runs in the tab (a "new tabs start Claude" setting,
      // say): never type the launch command into it. Re-check the shell after
      // the await: never type into a replacement.
      // Only the shell may receive `claude` + Enter: a program a login script
      // started (Codex, say) would take it as input. And Claude must start IN
      // the project: a login script may `cd` away. The three checks are
      // async, so they only count when the tab drew nothing while they ran
      // (a program starting draws); otherwise they are taken again.
      let already = false;
      let shellOwns = false;
      let inProject = false;
      let settled = false;
      // A startup job still in the foreground (a slow login script) is
      // waited out too, up to LAUNCH_WAIT_MAX_MS.
      const launchEnd = deps.now() + LAUNCH_WAIT_MAX_MS;
      let changes = 0;
      for (let i = 0; ; i += 1) {
        if (i > 0) await deps.sleep(LAUNCH_CHECK_GAP_MS);
        const seqBefore = watch.seq();
        already = await deps.claudeRunning(tabId, resolved.path);
        inProject = !already && (await deps.shellInProject(tabId, resolved.path));
        shellOwns = !already && (await deps.shellForeground(tabId));
        settled = watch.seq() === seqBefore;
        if (!settled) changes += 1;
        if (settled && (already || shellOwns)) break;
        if (changes >= LAUNCH_CHECK_TRIES || deps.now() >= launchEnd) break;
      }
      if (!settled) return { ok: false, status: 409, tabId, error: 'the tab kept changing while Claude was being started; nothing was typed' };
      if (!already && !shellOwns) return { ok: false, status: 409, tabId, error: 'another program is running in the tab\'s terminal, so Claude was not started; nothing was typed' };
      if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return { ok: false, status: 409, tabId, error: 'the tab was closed or its shell was replaced before Claude could start; nothing was typed' };
      // A person typing into the new tab has taken it over: whatever they
      // typed (and an Enter of theirs still on its way) must never carry
      // the card's text. Mouse movement does not count.
      const typedIn = { ok: false, status: 409, tabId, error: 'someone typed into the tab, so the message was not typed' };
      if (watch.keys() !== 0) return typedIn;
      if (shellOwns && !inProject) return { ok: false, status: 500, tabId, error: 'the tab\'s shell is not in the project folder (a login script changed directory); nothing was typed' };
      if (shellOwns) {
        watch.mark();
        deps.typeLaunch(tabId);
      }
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
      if (concurrent && !first.ok) {
        const { status, ...body } = first;
        return { status, body };
      }
      if (first.tabId && deps.tabAlive(first.tabId)) {
        deps.focusTab(first.tabId);
        return { status: 200, body: { ok: true, tabId: first.tabId, existing: true } };
      }
      if (concurrent) return { status: 200, body: { ok: true, tabId: first.tabId, existing: true } };
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

const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

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
RESPONSE=$(printf '%s' "$BODY" | curl -sS --max-time 180 -X POST "http://127.0.0.1:${port}/openTab" \\
  -H "Host: 127.0.0.1:${port}" \\
  -H @"$HDR" \\
  -H "Content-Type: application/json" \\
  --data-binary @-)
echo "$RESPONSE"
printf '%s' "$RESPONSE" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") else 1)'
`;
}
