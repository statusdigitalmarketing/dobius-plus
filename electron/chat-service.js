// Chat-view plumbing shared by the mobile WS server and the desktop Chat pane:
// the live selector popup, a plain-text tail of the screen, and the
// paste-then-Enter submit. Main-process only.

import { randomBytes } from 'node:crypto';
import { getTerminalBuffer, writeTerminal, terminalInstance, terminalInputSeq, terminalInputAgeMs, terminalRawOutputSeq, terminalSettledSinceInput, terminalClosing, terminalCols, terminalRows, terminalAltAtBufferStart, terminalBufferTrimmed } from './terminal-manager.js';
import { parseSelector, parseSelectorFromScreen, stripAnsi, selectorFingerprint, selectorCountdown, spinnerStatus } from './selector-parser.js';
export { selectorFingerprint };
import { renderScreenLines, FILL } from './screen-render.js';

// The live selector for a tab, via the headless-xterm SCREEN render (v1.0.62).
// The old strip-and-regex path missed Ink's incremental repaints entirely: on
// a multi-question AskUserQuestion, question two never formed complete lines
// in a linear strip, so its popup never appeared on the phone (Sam, 8/14).
// The emulator's verdict is authoritative when it renders (including "no
// selector": it honors the erase sequences that REMOVE answered prompts, so
// it also kills the stale-popup class); the regex path remains only for a
// render failure.
// How much of a tab's output a selector read replays: enough to hold a full
// redraw of its screen (cells x a generous 24 bytes for colour codes), at
// least 256KB, and never more than an idle tab keeps (512KB).
const SELECTOR_TAIL = 262144;
const BYTES_PER_CELL = 24;
const MAX_REPLAY = 512 * 1024;
const MAX_REPLAY_ROWS = 400; // screen-render's own cap
function screenCells(id) {
  const c = terminalCols(id);
  const r = terminalRows(id);
  return Number.isInteger(c) && Number.isInteger(r) && c > 0 && r > 0 && r <= MAX_REPLAY_ROWS ? c * r : null;
}
function selectorTailChars(id) {
  const cells = screenCells(id);
  return cells ? Math.min(MAX_REPLAY, Math.max(SELECTOR_TAIL, cells * BYTES_PER_CELL)) : SELECTOR_TAIL;
}
// Whether a full redraw of the tab's screen is sure to be inside what a read
// replays. A replacement prompt is a fresh full redraw, so then any visible
// difference reaches the fingerprint; on a screen too big for that, a timer
// is no reason to accept output (Codex Critical, round 7).
function screenFitsReplay(id) {
  const cells = screenCells(id);
  if (!cells || cells * BYTES_PER_CELL > MAX_REPLAY) return false;
  // A cut INSIDE a control string (a hyperlink's hidden URL, a title)
  // leaves its payload with no introducer, so the replay prints it as text
  // and may cover cells the real screen never showed it in (Codex High,
  // round 11). A long run up to the first terminator with no escape before it
  // is that payload. (A plain bell after plain text reads the same and only
  // costs the strict rule.) Everything else that pushes visible content out
  // of the replay is caught by the coverage check (screenCovered), so marks
  // and link payloads are no longer budgeted here (Codex, round 24).
  const tail = (getTerminalBuffer(id) || '').slice(-selectorTailChars(id));
  const firstEnd = tail.search(/\x07|\x1b\\|\x9c/);
  if (firstEnd > MAX_HIDDEN_CHARS && !/[\x1b\x90\x98\x9d\x9e\x9f]/.test(tail.slice(0, firstEnd))) return false;
  return true;
}
// The longest control-string payload a replay may begin inside.
const MAX_HIDDEN_CHARS = 64 * 1024;
// Whether the replay a read is built from accounts for EVERY visible cell:
// it holds everything the tab ever printed, or replaying it over a screen
// filled with a marker leaves no marker behind. A cell it never wrote shows
// output from before the replay, which no fingerprint saw: whatever pushed it
// out (styling floods, hidden payloads, anything else), a timer is then no
// reason to accept output (Codex High, round 12).
async function screenCovered(id, box = null) {
  const buffer = getTerminalBuffer(id) || '';
  const raw = buffer.slice(-selectorTailChars(id));
  if (!terminalBufferTrimmed(id) && raw.length === buffer.length) return true;
  // Terminal state a replay cannot reproduce from a cut (Codex High, round
  // 13). The alternate screen already active where the replay begins, and
  // the replay switching buffers again: the real terminal keeps (or returns
  // to) content from before the cut, while the replay shows a blank or
  // marker-filled one. Staying on one screen is fine: the replay's stands in
  // for it, and a switch the replay itself makes from the normal screen
  // clears the alternate one in both (Claude Code 2.1.31x runs there).
  // Origin mode, or a scroll region narrower than the screen, moves output
  // where the replay does not; Claude only ever resets the region (ESC [ r),
  // which is the replay's own default.
  // Mode switches may be combined (ESC [ ? 25 ; 1049 h): any list naming one
  // counts (Codex High, round 14).
  const before = buffer.slice(0, buffer.length - raw.length);
  let sw = null;
  for (const m of before.matchAll(ALT_SWITCH_ALL_RE)) sw = m[1];
  const altAtCut = sw ? sw === 'h' : terminalAltAtBufferStart(id);
  if (altAtCut) {
    // Unless the last switch in the replay ENTERS the alternate screen from
    // the normal one (leave, then enter: Claude quitting and starting again):
    // that entry clears the alternate screen in the real terminal and the
    // replay alike, so everything after it is the replay's own (Codex P2,
    // round 20).
    const seq = [...raw.matchAll(ALT_SWITCH_ALL_RE)].map((m) => m[1]);
    const n = seq.length;
    if (n > 0 && !(seq[n - 1] === 'h' && n >= 2 && seq[n - 2] === 'l')) return false;
  }
  if (ORIGIN_MODE_RE.test(raw)) return false;
  const height = terminalRows(id);
  for (const m of raw.matchAll(SCROLL_REGION_RE)) {
    const top = Number(m[1]) || 1;
    const bottom = Number(m[2]) || height;
    if (top !== 1 || bottom !== height) return false;
  }
  // From both corners, the cursor AND its saved position: where the real
  // ones stood when the replay begins is unknown (an erase or a restore whose
  // save came before the cut: Codex, rounds 13, 14 and 21).
  const size = { cols: terminalCols(id), rows: terminalRows(id), exact: true, exactRows: true };
  for (const fillStart of ['top', 'bottom']) {
    let lines = null;
    let plain = null;
    try {
      lines = await renderScreenLines(raw, { ...size, fillCheck: true, fillStart });
      // The same replay without the markers, from the same corner: where the
      // prompt's box lands (it depends on the start), and which marker-looking
      // characters are real output (an icon-font glyph is U+E000 too: Codex,
      // round 25).
      plain = await renderScreenLines(raw, { ...size, startAt: fillStart });
    } catch { lines = null; }
    if (!lines || !plain) return false;
    // Only the prompt's own box when the parse found one: Claude draws all of
    // it when the prompt appears (well inside the replay), so a different
    // prompt differs there, while a long fullscreen session's untouched
    // header and margins would otherwise refuse every tap (Codex, round 23).
    let top = 0;
    let bottom = lines.length - 1;
    if (box) {
      let s = null;
      try { s = parseSelectorFromScreen(plain); } catch { s = null; }
      if (!s?.boxRows) return false; // no box where this replay puts the prompt
      ({ top, bottom } = s.boxRows);
    }
    for (let r = top; r <= bottom; r += 1) {
      const filled = String(lines[r] ?? '');
      const shown = String(plain[r] ?? '');
      for (let i = 0; i < filled.length; i += 1) {
        if (filled[i] === FILL && shown[i] !== FILL) return false; // a cell the replay never wrote
      }
    }
  }
  return true;
}
const ALT_SWITCH_RE = /\x1b\[\?(?:[0-9;]*;)?(?:47|1047|1049)(?:;[0-9;]*)?[hl]/;
const ALT_SWITCH_ALL_RE = /\x1b\[\?(?:[0-9;]*;)?(?:47|1047|1049)(?:;[0-9;]*)?([hl])/g;
const ORIGIN_MODE_RE = /\x1b\[\?(?:[0-9;]*;)?6(?:;[0-9;]*)?[hl]/;
const SCROLL_REGION_RE = /\x1b\[([0-9]*);?([0-9]*)r/g;


export async function liveSelectorForTab(id) {
  const raw = getTerminalBuffer(id) || '';
  // The tab's real size: a card is matched against the whole visible screen
  // (a narrower or shorter emulator wraps long rows and drops the top ones).
  // At exactly its height too: absolute moves to the last row ("row 999")
  // land where the real terminal puts them (Codex High, round 15).
  const lines = await renderScreenLines(raw.slice(-selectorTailChars(id)), { cols: terminalCols(id), rows: terminalRows(id), exactRows: true });
  if (lines) return parseSelectorFromScreen(lines);
  return parseSelector(raw);
}


// What Claude's spinner says right now ("Whirlpooling…", 1m 12s, 2.3k
// tokens), or null. Callers ask only while the tab is working: the line lingers
// in scrollback after the turn ends. Read off the emulated SCREEN: Claude
// repaints only the cells that changed ("\r\x1b[13G(40s ...)"), so a stripped
// byte stream keeps showing the first full line it drew (Codex Medium). The
// strip path is the fallback when the render fails. ~7ms for the 64KB tail.
const ACTIVITY_TAIL_CHARS = 65536;
// Longest escape sequence the cut is backed up over (OSC titles run long).
const ESC_BACKUP_CHARS = 512;
export async function activityForTab(id) {
  const raw = getTerminalBuffer(id) || '';
  // A cut inside an escape sequence would print its leftover bytes ("31m")
  // in front of the spinner and every counter-only repaint keeps them there,
  // so the anchored parse fails (Codex Medium). Back the cut up to the ESC
  // that starts the sequence it lands in. Never skip FORWARD to the next ESC:
  // that one can sit after the spinner text and drop it.
  let start = Math.max(0, raw.length - ACTIVITY_TAIL_CHARS);
  if (start > 0) {
    const esc = raw.lastIndexOf('\x1b', start);
    if (esc !== -1 && start - esc <= ESC_BACKUP_CHARS) start = esc;
  }
  const tail = raw.slice(start);
  let lines;
  try { lines = await renderScreenLines(tail); } catch { lines = null; }
  return spinnerStatus(lines ? lines.join('\n') : raw);
}

// Plain-text tail of the tab's output for tabs with no transcript to show
// (plain shells, a Claude that has not linked its session yet). Trailing blank
// padding per line and the all-blank tail are dropped.
export function terminalTextTail(id, maxLines = 60) {
  return textTailOf(getTerminalBuffer(id) || '', maxLines);
}

function textTailOf(rawBuffer, maxLines) {
  const raw = stripAnsi(rawBuffer);
  const lines = raw.split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-maxLines).join('\n');
}

/**
 * What the tab's terminal SHOWS right now, as text: the output replayed
 * through the screen emulator at the tab's own width (screen-render.js), so a
 * TUI that repaints in place (Claude's spinner, its prompt box) reads as its
 * screen, not as every frame it ever drew. The stripped byte stream it
 * replaces printed stray spinner frames ("Doodling…") with blank gaps between
 * them (Bryan, Asana 1220098108555131). Falls back to that stream only when
 * the render fails.
 */
export async function terminalScreenText(id, maxLines = 60) {
  const raw = getTerminalBuffer(id) || '';
  const start = screenTailStart(raw, 262144);
  let tail = raw.slice(start);
  // Inside a full-screen program (vim, less) at the cut, whose ENTRY is not in
  // the tail: replay it as entered, or its screen paints the normal buffer and
  // stays there after it exits. The state at the cut comes from the part of
  // the buffer before it, else from what the terminal recorded when it
  // trimmed its buffer (the entry may be gone from the buffer altogether).
  const before = lastAltScreenSwitch(raw.slice(0, start));
  const inAltAtCut = before ? before === 'h' : terminalAltAtBufferStart(id);
  if (inAltAtCut) tail = `\x1b[?1049h${tail}`;
  let lines;
  try { lines = await renderScreenLines(tail, { cols: terminalCols(id), exact: true }); } catch { lines = null; }
  if (!lines) return textTailOf(raw, maxLines);
  const rows = lines.map((l) => String(l).replace(/\s+$/, ''));
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  while (rows.length && !rows[0]) rows.shift();
  return rows.slice(-maxLines).join('\n');
}

// Where to cut a raw tail so it never starts inside an escape sequence: back
// up to a nearby ESC that opens a short sequence, and skip FORWARD past the end
// of a long control string (an OSC title can run past any backup limit) whose
// opening ESC is before the cut and whose terminator is after it.
export function screenTailStart(raw, max) {
  let start = Math.max(0, raw.length - max);
  if (start === 0) return 0;
  const esc = raw.lastIndexOf('\x1b', start - 1);
  if (esc === -1) return start;
  const kind = raw[esc + 1];
  if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
    // A control string: is it still open at the cut?
    const body = raw.slice(esc + 2, start);
    if (!/\x07|\x1b\\/.test(body)) {
      const rest = raw.slice(start);
      const m = /\x07|\x1b\\/.exec(rest);
      return m ? start + m.index + m[0].length : raw.length;
    }
    return start;
  }
  return start - esc <= ESC_BACKUP_CHARS ? esc : start;
}

// 'h' (entered) or 'l' (left) for the last alternate-screen switch, or null.
export function lastAltScreenSwitch(text) {
  let last = null;
  for (const m of text.matchAll(ALT_SWITCH_ALL_RE)) last = m[1];
  return last;
}

// A selector read is stamped with the PTY and the count of writes it has
// received (from any surface: desktop terminal, Chat, phone, auto-resume). An
// answer is only delivered while both still match, so a prompt answered
// elsewhere can never be "answered" again into whatever prompt replaced it.
const ptySerials = new WeakMap();
let nextPtySerial = 1;

/**
 * `<pty serial>:<input count>:<output count>` for the tab right now, or '' with no PTY, or
 * while the tab has produced no output since its last input: the screen may
 * still show a prompt that input already answered, and a fresh token on that
 * stale screen would let its option answer whatever prompt comes next.
 */
// A key that drew nothing (Claude ignored it) never "settles" the tab; after
// this long with no output the screen is taken as current. Safe because the
// token still carries the output count: a late repaint makes it stale.
const QUIET_SETTLE_MS = 3000;

// Every counter in a token restarts with the app, so a token queued on the
// phone before a restart could match the new process's counters exactly
// (Codex Critical, round 13). This process's own random id rules that out.
const BOOT_NONCE = randomBytes(6).toString('hex');

export function selectorToken(id) {
  const pty = terminalInstance(id);
  if (!pty || !(terminalSettledSinceInput(id) || terminalInputAgeMs(id) >= QUIET_SETTLE_MS)) return '';
  if (!ptySerials.has(pty)) ptySerials.set(pty, nextPtySerial++);
  // Output is part of it: Claude can draw its NEXT prompt with no input at all
  // (another surface answered, or the screen was cleared and redrawn), and two
  // prompts can look identical on screen (Codex Critical, three lenses). So a
  // card is answerable only while neither input nor output reached the tab
  // since it was read. Idle Claude Code is silent, which is also what the
  // tab-status settler relies on.
  return `${BOOT_NONCE}:${ptySerials.get(pty)}:${terminalInputSeq(id)}:${terminalRawOutputSeq(id)}`;
}

/**
 * Read the live selector for a card that can answer it: null (no prompt),
 * { unsettled: true } (the screen cannot be trusted right now: not repainted
 * since the last input, or something reached the tab during the read), or
 * { selector, token }. Shared by the desktop Chat pane and the phone, so both
 * answer prompts under the same rules. `stillOk` re-checks the caller's right
 * to the tab after the render await.
 */
export async function readSelectorForAnswer(id, stillOk = () => true) {
  // Stamp BEFORE rendering: anything that lands meanwhile makes the read stale.
  const token = selectorToken(id);
  let selector;
  try { selector = await liveSelectorForTab(id); } catch { selector = null; }
  if (!stillOk()) return null;
  // No token, or the tab moved during the read: { unsettled } keeps the card
  // on screen, disabled. It carries the prompt for DISPLAY only (an older
  // phone shows it, as it always did); nothing can answer it without a token.
  // A read that found no prompt hides the card, which is always safe.
  if (!token || selectorToken(id) !== token) return selector && terminalInstance(id) ? { unsettled: true, selector } : null;
  if (!selector) return null;
  const full = `${token}|${selectorFingerprint(selector)}`;
  const countdown = selectorCountdown(selector);
  stampRead(id, full, countdown);
  // timed: the card's token moves with every tick of its timer, so the
  // clients' press guard compares such cards by fingerprint (chat-rows).
  return { selector: countdown != null ? { ...selector, timed: true } : selector, token: full };
}

// When each card was read, and the seconds its unattended-session timer
// showed then. A prompt with that timer repaints every second, which moves
// the output count in its token, so without this every tap that took more
// than a second to arrive was refused as "the prompt changed" (Sam, phone).
// Kept here, never in the token, so a client cannot claim a reading time.
const readStamps = new Map(); // tab id -> Map(token -> { at, countdown })
// Enough for a press held through several reads (each read stamps one).
const STAMPS_PER_TAB = 32;
const STAMP_TTL_MS = 10 * 60_000;

function stampRead(id, token, countdown) {
  const now = Date.now();
  // Expired readings go for every tab, so tabs long closed leave nothing.
  for (const [tab, tm] of readStamps) {
    for (const [k, v] of tm) if (now - v.at > STAMP_TTL_MS) tm.delete(k);
    if (tm.size === 0) readStamps.delete(tab);
  }
  let m = readStamps.get(id);
  if (!m) { m = new Map(); readStamps.set(id, m); }
  m.delete(token);
  m.set(token, { at: now, countdown });
  while (m.size > STAMPS_PER_TAB) m.delete(m.keys().next().value);
}

// How far the timer may be from where a steady countdown would have it: it
// shows whole seconds, and each of the two readings can be up to a second off.
const COUNTDOWN_SLACK_S = 2;

// The token minus its output count: same app run, same PTY, same input count.
const withoutOutput = (base) => base.slice(0, base.lastIndexOf(':'));

/**
 * Answer a card read by readSelectorForAnswer: `data` is written only while
 * no input has reached the tab since that read, no submit is typing into it,
 * a fresh parse still shows the prompt the card showed, and no output landed
 * either, except the prompt's own unattended-session timer ticking down.
 * `beforeWrite` runs after every check passes (main cancels a queued resume).
 * Returns { ok, stale?, token? } with the token for the next key on this prompt.
 */
export async function answerSelector(id, data, token, stillOk = () => true, beforeWrite = () => {}) {
  if (typeof data !== 'string' || !data || data.length > 16 || typeof token !== 'string') return { ok: false };
  const [base, fp] = token.split('|');
  if (!base || !fp) return { ok: false, stale: true };
  // The prompt's own timer ticking is the one kind of output allowed since
  // the card was read: nothing typed anywhere (the input count is in the
  // token), the prompt reading exactly the same apart from the timer, and the
  // timer down by just the time that passed (one that started over is a
  // later prompt).
  //
  // ACCEPTED RISK (Sam, 2026-11-02, over a Codex Critical): a prompt replaced
  // without any input by a second one that reads word for word the same, in
  // the same timer second, gets the tap. Nothing on screen can tell the two
  // apart (Claude can queue identical requests, and a hook can approve one
  // with no typing). A prompt that reads differently in any way is refused.
  const stamp = readStamps.get(id)?.get(token);
  const ticking = !!stamp && stamp.countdown != null && screenFitsReplay(id);
  let live = null;
  let now = '';
  // A tick can land while the screen is being read; read it again then
  // (a ticking prompt only), rather than refuse a good tap.
  // Each attempt reads the screen and, when output moved, checks the timer
  // and that the replay covers the screen. A tick landing during any of
  // those reads it all again (a ticking prompt only) rather than refusing a
  // good tap (Codex, rounds 2 and 22).
  let settled = false;
  for (let attempt = 0; attempt < 3 && !settled; attempt += 1) {
    now = selectorToken(id);
    if (!now || submitPending(id) || !stillOk()) return { ok: false, stale: true };
    if (now !== base && !(ticking && withoutOutput(now) === withoutOutput(base))) return { ok: false, stale: true };
    try { live = await liveSelectorForTab(id); } catch { live = null; }
    // Nothing at all may land while the screen is being read: what was read
    // is what gets answered.
    if (selectorToken(id) !== now) { if (!ticking) return { ok: false, stale: true }; live = null; continue; }
    if (!live || submitPending(id) || !stillOk() || selectorFingerprint(live) !== fp) return { ok: false, stale: true };
    if (now !== base) {
      const left = selectorCountdown(live);
      const expected = stamp.countdown - (Date.now() - stamp.at) / 1000;
      if (left == null || left > stamp.countdown || Math.abs(left - expected) > COUNTDOWN_SLACK_S) return { ok: false, stale: true };
      // Same buffer as the read just made (checked again right after), so
      // the coverage answer is about the screen just matched.
      const covered = await screenCovered(id, live.boxRows || null);
      if (selectorToken(id) !== now) { live = null; continue; }
      if (!covered) return { ok: false, stale: true };
    }
    settled = true;
  }
  if (!settled || !live || selectorToken(id) !== now || submitPending(id) || !stillOk()) return { ok: false, stale: true };
  beforeWrite();
  writeRawInput(id, data, stillOk);
  const next = selectorToken(id);
  if (!next) return { ok: true, token: '' };
  // The next key on this prompt (an arrow, then Enter) is read as of now.
  stampRead(id, `${next}|${fp}`, selectorCountdown(live));
  return { ok: true, token: `${next}|${fp}` };
}

const SUBMIT_ENTER_DELAY_MS = 250;
const RAW_KEY_GAP_MS = 20;
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
export function submitPromptToTab(id, text, stillOk = () => true, onStranded = () => {}) {
  return submitPromptDetailed(id, text, stillOk, onStranded).then((r) => r.ok);
}

/**
 * submitPromptToTab with the reason a submit did not go through, for callers
 * that answer a remote client (the phone WS acks). `reason` is one of
 * 'tab_exited' (no PTY, closing, or replaced), 'not_allowed' (stillOk said no),
 * 'cancelled' (a cancel key dropped or erased it) or 'stranded' (pasted, but
 * the Enter was withheld: the text sits in the input line, see onStranded).
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export function submitPromptDetailed(id, text, stillOk = () => true, onStranded = () => {}) {
  // Strip control chars except \t and \n (multi-line paste is legitimate); \r
  // goes too so the only Enter is the discrete one sent below.
  const clean = String(text).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  const pty = terminalInstance(id);
  if (!pty || terminalClosing(id)) return Promise.resolve(refused('tab_exited'));
  if (!stillOk()) return Promise.resolve(refused('not_allowed'));
  const q = queueFor(id);
  return new Promise((resolve) => {
    q.items.push({ clean, pty, stillOk, gen: q.gen, resolve, onStranded });
    if (!q.running) drainSubmits(id, q);
  });
}

const DONE = Object.freeze({ ok: true });
const refused = (reason) => ({ ok: false, reason });

/**
 * Raw keys from a terminal or the phone. Written at once unless a submit is
 * pending on the tab, in which case they wait their turn behind it. A cancel
 * key (Ctrl+C, Ctrl+U, a bare Esc) always goes at once and drops everything
 * still queued, as it would have when every paste went out immediately.
 *
 * Resolves once the keys are written ({ ok: true }) or dropped ({ ok: false,
 * reason }, reasons as for submitPromptDetailed), so a remote caller can ack
 * the write itself rather than its arrival. "Written" is handed to the PTY
 * writer: node-pty drains it into the kernel asynchronously, and no PTY-level
 * signal says the program read it (docs/mobile-ws-protocol.md). Callers that
 * do not care ignore it.
 */
export function writeRawInput(id, data, stillOk = () => true) {
  if (typeof data !== 'string' || !data) return Promise.resolve(refused('empty'));
  // A frame already in flight when its phone was revoked: not even a cancel
  // key, which would also throw away the desktop's pending submit.
  if (!stillOk()) return Promise.resolve(refused('not_allowed'));
  // writeTerminal is a no-op without a PTY; report that instead of a write.
  const written = () => (terminalInstance(id) ? DONE : refused('tab_exited'));
  const q = submitQueues.get(id);
  if (isCancelKey(data)) {
    // Ctrl+C and Ctrl+U erase the input line; a bare Esc leaves it as typed.
    // cancelWrites counts the queue's own writes, so the Enter check below can
    // tell them apart from another writer's input.
    // Only a frame of nothing but cancel keys counts as the queue's own: one
    // that also carries an Enter ("\r\x15") may have sent the paste first
    // (Codex High), so it counts as another writer.
    // Written FIRST: a cancel whose write throws must not be counted as an
    // erase, or the pending paste it never cleared reads as unsent (Codex High).
    const r = written();
    writeTerminal(id, data);
    if (q) {
      q.gen += 1;
      if (/^[\x03\x15\x1b]+$/.test(data)) q.cancelWrites = (q.cancelWrites || 0) + 1;
      if (data !== '\x1b') q.clearedGen = q.gen;
    }
    return Promise.resolve(r);
  }
  if (!q || !q.running) { const r = written(); writeTerminal(id, data); return Promise.resolve(r); }
  // No PTY to queue for (it exited under a running submit): nothing would be
  // written, so say so now rather than report a write of nothing.
  const pty = terminalInstance(id);
  if (!pty) return Promise.resolve(refused('tab_exited'));
  return new Promise((resolve) => {
    q.items.push({ raw: data, pty, stillOk, gen: q.gen, resolve });
  });
}

/** A submit is typing into this tab right now (or queued behind one). */
export function submitPending(id) {
  return !!submitQueues.get(id)?.running;
}

// Why a queued item must not be written now, or '' when it may be.
function skipReason(id, q, it) {
  if (terminalInstance(id) !== it.pty || terminalClosing(id)) return 'tab_exited';
  if (it.gen !== q.gen) return 'cancelled';
  return it.stillOk() ? '' : 'not_allowed';
}

async function drainSubmits(id, q) {
  q.running = true;
  // The cleanup runs in the SAME turn the loop ends in: an await between them
  // let a caller queue another submit (seeing running) that the cleanup then
  // dropped, never written and never settled (Codex Medium).
  try {
    while (q.items.length > 0) {
      const it = q.items.shift();
      q.current = it;
      let skip = skipReason(id, q, it);
      if (skip) { it.resolve(refused(skip)); continue; }
      if (it.raw !== undefined) {
        // Keys that waited behind a submit go out as separate keystrokes, not
        // one burst Claude would read as a paste (an Enter in it becomes a newline).
        await new Promise((r) => setTimeout(r, RAW_KEY_GAP_MS));
        skip = skipReason(id, q, it);
        if (skip) { it.resolve(refused(skip)); continue; }
        it.touched = true;
        writeTerminal(id, it.raw);
        it.resolve(DONE);
        continue;
      }
      it.touched = true;
      writeTerminal(id, `\x1b[200~${it.clean}\x1b[201~`);
      const pastedAt = terminalInputSeq(id);
      const cancelsAt = q.cancelWrites || 0;
      await new Promise((r) => setTimeout(r, SUBMIT_ENTER_DELAY_MS));
      // No stillOk() here on purpose: a paste that went out gets its Enter even
      // if the phone that sent it dropped, or its text would sit half-typed and
      // be glued onto the next message (test 4).
      // Withheld, the pasted text stays in the prompt's input line: tell the
      // caller, so it says so instead of offering the text back to send twice.
      if (terminalInstance(id) !== it.pty || it.gen !== q.gen || terminalInputSeq(id) !== pastedAt || terminalClosing(id)) {
        // Any Ctrl+C/Ctrl+U since this item queued erased the pasted line, even if
        // a later Esc was the most recent cancel. Only when nothing ELSE wrote to
        // the tab: another writer's Enter (a terminal, /tabSend) may have sent
        // the paste before the erase, and reporting it unsent would offer the
        // text back to be sent twice (Codex High). Then it is stranded: check
        // the terminal.
        const gone = terminalInstance(id) !== it.pty || terminalClosing(id);
        const foreign = (terminalInputSeq(id) - pastedAt) - ((q.cancelWrites || 0) - cancelsAt);
        // Never an erase once the PTY is gone: a replacement's counters say
        // nothing about what reached the old one (Codex High).
        const erased = !gone && foreign === 0 && (q.clearedGen ?? -1) > it.gen;
        if (!gone && !erased) it.onStranded();
        // uncertain: unless it was erased, the paste is in the tab and may yet
        // be submitted: by another writer's input during the delay, by the
        // tab going away with its counters, or by a person pressing Enter on
        // the line later. A remote caller must not treat it as unsent and
        // resend it (Codex High, rounds 3 and 4).
        const uncertain = !erased;
        it.resolve({ ...refused(gone ? 'tab_exited' : erased ? 'cancelled' : 'stranded'), ...(uncertain ? { uncertain: true } : {}) });
        continue;
      }
      writeTerminal(id, '\r');
      it.resolve(DONE);
    }
  } catch (err) {
    // A throwing PTY write must not wedge the tab's queue or leave a request
    // unanswered. Only the item being written can have reached the tab (it is
    // uncertain, and the desktop is told its text may be in the input line);
    // the ones queued behind it were never touched and are plainly unsent.
    console.error('[chat-service] submit queue failed:', err?.message || err);
    const cur = q.current;
    if (cur?.touched && terminalInstance(id) === cur.pty) cur.onStranded?.();
    cur?.resolve({ ...refused('write_failed'), ...(cur.touched ? { uncertain: true } : {}) });
    for (const it of q.items.splice(0)) it.resolve(refused('write_failed'));
  } finally {
    q.current = null;
    q.running = false;
    if (submitQueues.get(id) === q) submitQueues.delete(id);
  }
}
