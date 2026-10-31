// Chat-view plumbing shared by the mobile WS server and the desktop Chat pane:
// the live selector popup, a plain-text tail of the screen, and the
// paste-then-Enter submit. Main-process only.

import { randomBytes } from 'node:crypto';
import { getTerminalBuffer, writeTerminal, terminalInstance, terminalInputSeq, terminalInputAgeMs, terminalRawOutputSeq, terminalSettledSinceInput, terminalClosing } from './terminal-manager.js';
import { parseSelector, parseSelectorFromScreen, stripAnsi, selectorFingerprint, spinnerStatus } from './selector-parser.js';
export { selectorFingerprint };
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
  return selector ? { selector, token: `${token}|${selectorFingerprint(selector)}` } : null;
}

/**
 * Answer a card read by readSelectorForAnswer: `data` is written only while
 * neither input nor output has reached the tab since that read, no submit is
 * typing into it, and a fresh parse still shows the prompt the card showed.
 * `beforeWrite` runs after every check passes (main cancels a queued resume).
 * Returns { ok, stale?, token? } with the token for the next key on this prompt.
 */
export async function answerSelector(id, data, token, stillOk = () => true, beforeWrite = () => {}) {
  if (typeof data !== 'string' || !data || data.length > 16 || typeof token !== 'string') return { ok: false };
  const [base, fp] = token.split('|');
  const unchanged = () => !!base && !!fp && selectorToken(id) === base && !submitPending(id) && stillOk();
  if (!unchanged()) return { ok: false, stale: true };
  let live;
  try { live = await liveSelectorForTab(id); } catch { live = null; }
  if (!unchanged() || selectorFingerprint(live) !== fp) return { ok: false, stale: true };
  beforeWrite();
  writeRawInput(id, data, stillOk);
  const next = selectorToken(id);
  return { ok: true, token: next ? `${next}|${fp}` : '' };
}

const SUBMIT_ENTER_DELAY_MS = 250;
const RAW_KEY_GAP_MS = 20;
// Input a terminal window still holds back for the tab (prompt editing: an
// image paste being saved, the keys typed after it). A submit waits for it at
// the head of this queue, so its paste never lands between that input's
// parts. main.js wires the check (bridge-open-main.js inputHeld).
let inputHeld = () => false;
// And marks the window's current hold as having lost input, so its drain
// cancels every submit waiting on it, including ones accepted later.
let markHeldLost = () => {};
export function setInputHeldCheck(fn, lost) {
  inputHeld = typeof fn === 'function' ? fn : () => false;
  markHeldLost = typeof lost === 'function' ? lost : () => {};
}

/**
 * A key a window took but still holds (bridge-open-main.js terminal:inputHeld).
 * A cancel key among it cancels queued submits NOW, as it would on arrival:
 * the window may still drop it (its paste timed out) and never send it.
 */
export function noteHeldInput(id, data) {
  const q = submitQueues.get(id);
  if (q && typeof data === 'string' && isCancelKey(data)) q.gen += 1;
}

/**
 * A window that held input for the tab is gone (crashed, reloaded, closed)
 * with that input half sent: queued submits are cancelled, never appended
 * to whatever part of it reached the terminal.
 */
export function cancelQueuedSubmits(id) {
  const q = submitQueues.get(id);
  if (q) q.gen += 1;
}

/**
 * Input the person meant to go first was dropped before it reached the
 * terminal (a prompt-only paste): submits not yet pasted are dropped, the
 * one already in the box (which that input never touched) keeps its Enter.
 */
export function dropUnpastedSubmits(id) {
  const q = submitQueues.get(id);
  if (q) q.dropGen += 1;
}
const HELD_WAIT_MS = 16_000; // prompt editing gives up on a paste after 15s
const HELD_POLL_MS = 50;
// When this queue last delivered an Enter to each tab (a submit's, or a key
// that waited behind one: the window that typed it cannot see when it really
// went out). A prompt-only paste arriving within PROMPT_SETTLE_MS of it is
// dropped (writeRawInput).
const lastSubmitEnterAt = new Map();
const PROMPT_SETTLE_MS = 1000; // src/lib/prompt-edit-term.js AFTER_ENTER_MS
// tabId -> { running, items, gen, dropGen }. gen bumps on a cancel key; an item queued
// under an older gen is dropped instead of written. dropGen bumps when a
// prompt-only paste is dropped; it drops only submits not yet pasted.
const submitQueues = new Map();

const isCancelKey = (data) => data === '\x1b' || data.includes('\x03') || data.includes('\x15');

function queueFor(id) {
  let q = submitQueues.get(id);
  if (!q) { q = { running: false, items: [], gen: 0, dropGen: 0 }; submitQueues.set(id, q); }
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
    q.items.push({ clean, pty, stillOk, gen: q.gen, dropGen: q.dropGen, resolve, onStranded });
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
export function writeRawInput(id, data, stillOk = () => true, { promptOnly = false } = {}) {
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
  // A submit waiting for held input lets keys through: that input arriving
  // is what it waits for, and it was taken before the submit.
  // Prompt editing checked that Claude's prompt was showing when it sent
  // this (a file path pasted into it). Behind a submit it would land later,
  // maybe in the shell a "/exit" left behind; and just after a submit's
  // Enter that check may have read the screen from before it: dropped.
  // (Prompt editing waits the same second after its own Enter.)
  // A dropped paste is input lost: queued submits are cancelled with it,
  // never sent without the attachment the person meant to go first.
  // Only submits not yet pasted (dropGen): the one already in the box is
  // what the box holds, the dropped paste never reached it.
  const dropPaste = () => { if (q) q.dropGen += 1; markHeldLost(id); return Promise.resolve(refused('prompt_dropped')); };
  if (promptOnly && Date.now() - (lastSubmitEnterAt.get(id) ?? -Infinity) < PROMPT_SETTLE_MS) return dropPaste();
  if (!q || !q.running || q.waitingHeld) { const r = written(); writeTerminal(id, data); return Promise.resolve(r); }
  if (promptOnly) return dropPaste();
  return new Promise((resolve) => {
    q.items.push({ raw: data, pty: terminalInstance(id), stillOk, gen: q.gen, resolve });
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
        if (it.raw.includes('\r')) lastSubmitEnterAt.set(id, Date.now());
        it.resolve(DONE);
        continue;
      }
      if (inputHeld(id)) {
        // Keys already queued behind this submit came while that input was
        // held: they go now, in order, ahead of the keys still to come, and
        // paced like any queued key (a burst would read as a paste, its Enter
        // as a newline). Keys arriving meanwhile queue behind them.
        for (let k; (k = q.items.findIndex((x) => x.raw !== undefined)) >= 0;) {
          const [x] = q.items.splice(k, 1);
          await new Promise((r) => setTimeout(r, RAW_KEY_GAP_MS));
          const xSkip = skipReason(id, q, x);
          if (xSkip) { x.resolve(refused(xSkip)); continue; }
          try {
            writeTerminal(id, x.raw);
          } catch (err) {
            // Spliced out of the queue, so the catch below would not reach it.
            x.resolve({ ...refused('write_failed'), uncertain: true });
            throw err;
          }
          if (x.raw.includes('\r')) lastSubmitEnterAt.set(id, Date.now());
          x.resolve(DONE);
        }
        q.waitingHeld = true;
        const end = Date.now() + HELD_WAIT_MS;
        while (inputHeld(id) && Date.now() < end && it.gen === q.gen && terminalInstance(id) === it.pty && !terminalClosing(id)) {
          await new Promise((r) => setTimeout(r, HELD_POLL_MS));
        }
        q.waitingHeld = false;
        // Still held, cancelled (Ctrl+C), or the shell replaced meanwhile:
        // nothing is typed, so nothing about it is uncertain.
        skip = skipReason(id, q, it) || (inputHeld(id) ? 'cancelled' : '');
        if (skip) { it.resolve(refused(skip)); continue; }
      }
      // A prompt-only paste was dropped since this was accepted (writeRawInput):
      // the person's attachment never went in, so this does not go either.
      if (it.dropGen !== q.dropGen) { it.resolve(refused('cancelled')); continue; }
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
      lastSubmitEnterAt.set(id, Date.now());
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
    q.waitingHeld = false;
    q.running = false;
    if (submitQueues.get(id) === q) submitQueues.delete(id);
  }
}
