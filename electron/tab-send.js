// /tabSend (dobius-send): a message into an EXISTING tab.
//
// Typed in raw chunks with '\r' straight behind them, a long or multi-line message reached Claude as one burst it read
// as a paste, so the Enter landed inside the paste as a new line and the message sat unsent while the reply said ok
// (bug report from another Mac, 2026-11-09). Now, by what is in the tab:
//   - Claude at an empty prompt, idle or working: one bracketed paste, then Enter as its own write on a screen read
//     with nothing new arriving and nobody using the tab while it was read, the box holding the message, Claude still
//     in front with no command of its holding the terminal, and no permission prompt open. Then the box must empty
//     (while Claude works it queues the message for after the turn). One path for both: a turn can start or end at any
//     moment, so which one the tab is in decides nothing.
//   - Claude with a question or dialog on screen, or a draft in its box: nothing is typed (an Enter would answer the
//     question or send the draft). Nor when Claude leads the terminal but a command it started holds it readable, when
//     the process checks fail, or when the process checks say no but the screen shows Claude's prompt (a check can
//     time out into "no").
//   - The tab's own shell at its prompt, or Codex: typed as before, with the Enter written on its own once the text has
//     gone out, and only when nobody typed meanwhile, and not when the screen never holds still for 3 s.
//   - Any other program (tmux, ssh, docker exec, an editor, a REPL): nothing is typed. Claude can sit behind one unseen.
// One send per tab at a time, and none into a tab /openTab is still delivering to: two pastes would land in one box.
// ok is true only when Enter was pressed on the message and, where it can be seen (Claude), it was seen taken;
// confirmed says whether it was seen.
import { promptBoxText, boxHoldsMessage, TRAILING_BACKSLASH_RE, openTabBusy, openTabsStarting, stripControls, defangHarnessTags } from './bridge-open-tab.js';
export { defangHarnessTags };
import { boxIsEmpty } from './team-deliver.js';

const CHUNK = 256;
const STILL_MS = 3000;
const SUBMIT_WAIT_MS = 6000;
const CONFIRM_MS = 5000;
const POLL_MS = 150;

const fail = (status, error, extra = {}) => ({ status, body: { ok: false, ...extra, error } });
// A one-line shell command that starts Claude (`claude`, `claude --resume <id>`, `cd <dir> && claude -c`, `exec claude`).
// Meant for the tab's shell: sent to a tab where Claude already runs, it reached that Claude as a prompt and was queued
// as a message (bug report 2026-11-11). Narrow on purpose: a message that merely mentions claude is a message.
// Read with a linear scanner, never one big regex: the regex this replaced backtracked exponentially on a 200-character
// message and would have frozen the main process (Codex P1, PR 7). Accepted as a launch: prefixes a shell runs the
// command through (exec, command, builtin, nohup, env and its options, `env -S "<command>"`, VAR=value), a file path
// (/, ~/, ./, ../; never a URL) or a backslash before the name, a quoted name, options after it (each may take one
// value; a bare word first is a message), and one trailing ; or &.
const PREFIX_WORDS = new Set(['exec', 'command', 'builtin', 'nohup']);
const ENV_VALUE_OPTS = new Set(['-u', '-C', '--unset', '--chdir']);
function shellWords(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    const q = text[i];
    if (q === '"' || q === "'") {
      const end = text.indexOf(q, i + 1);
      if (end < 0) return null; // unterminated quote: not a command we can read
      out.push({ text: text.slice(i + 1, end), quoted: true });
      i = end + 1;
      if (i < text.length && !/\s/.test(text[i])) return null; // a quote glued to more text: too clever, a message
    } else {
      let j = i;
      while (j < text.length && !/\s/.test(text[j])) j += 1;
      const w = text.slice(i, j);
      if (w.includes('"') || w.includes("'")) return null;
      out.push({ text: w, quoted: false });
      i = j;
    }
  }
  return out;
}
function isClaudeProgram(name) {
  let n = name.startsWith('\\') ? name.slice(1) : name;
  if (n.includes('/')) {
    if (!/^(?:~|\.{1,2})?\//.test(n) || n.includes(':')) return false;
    n = n.slice(n.lastIndexOf('/') + 1);
  }
  return n === 'claude';
}
export function startsClaude(message, depth = 0) {
  let s = String(message ?? '').trim();
  if (!s || s.length > 2000 || depth > 2 || /[\n\r`|]/.test(s)) return false;
  if (s.endsWith(';') || (s.endsWith('&') && !s.endsWith('&&'))) s = s.slice(0, -1).trim();
  if (/^cd\s/.test(s)) {
    const k = s.indexOf('&&');
    if (k < 0) return false;
    s = s.slice(k + 2).trim();
  }
  if (/[;&]/.test(s)) return false; // anything chained after it is more than a launch
  const words = shellWords(s);
  if (!words || !words.length) return false;
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (!w.quoted && PREFIX_WORDS.has(w.text)) { i += 1; continue; }
    if (!w.quoted && /^[A-Za-z_]\w*=/.test(w.text)) { i += 1; continue; }
    if (!w.quoted && w.text === 'env') {
      i += 1;
      while (i < words.length && !words[i].quoted && words[i].text.startsWith('-')) {
        const o = words[i].text;
        if (o === '-S' || o === '--split-string') {
          const v = words[i + 1];
          if (!v) return false;
          return startsClaude([v.text, ...words.slice(i + 2).map((x) => (x.quoted ? `'${x.text}'` : x.text))].join(' '), depth + 1);
        }
        i += ENV_VALUE_OPTS.has(o) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  if (i >= words.length || !isClaudeProgram(words[i].text)) return false;
  const args = words.slice(i + 1);
  let prevOption = false;
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (!a.quoted && a.text.startsWith('-')) { prevOption = true; continue; }
    if (!prevOption) return false; // a bare word where an option belongs: it is a message (`claude is great`)
    prevOption = false;
  }
  return true;
}
const sending = new Set();
// Every paste this route made that was not followed by its Enter, per tab. Two uses:
// 1. Never paste twice. Until a send SEES Claude's box hold text after it (`seen`), the paste may still be queued in the
//    PTY (Claude can stop reading for a while), so an empty box is never pasted into (`reason: 'pending'`). Input written
//    after it (a click, a mouse report) queues BEHIND it and proves nothing (Codex rounds 2 to 5).
// 2. Finish a half-sent message (bug report from Muzikmaker's Mac, 2026-11-10). Sending the SAME message again presses
//    Enter on it, only after a send that timed out waiting to see its own paste (`retryable`), and only while NOTHING has
//    been written to the tab since that paste (inputSeq, every source): a person's paste of the same length shows the
//    same "[Pasted text #N +L lines]" marker, so the screen alone cannot tell it is ours.
// Bounded by live tabs: one entry per tab, swept on every send (closed or respawned tabs, expired entries). No count cap:
// evicting a live entry would drop the protection in (1) (Codex round 5). Accepted: a paste Claude read and a person
// cleared with no send seeing it in between blocks that tab's sends for PENDING_MS.
const typedNotSent = new Map(); // tabId -> { pty, message, at, seq, retryable, seen }
const TYPED_KEEP_MS = 15 * 60 * 1000;
const PENDING_MS = 5 * 60 * 1000;
function sweepTyped(deps) {
  for (const [id, t] of typedNotSent) {
    if (!deps.tabAlive(id) || deps.ptyOf(id) !== t.pty || deps.now() - t.at >= TYPED_KEEP_MS) typedNotSent.delete(id);
  }
}

/**
 * deps: tabAlive, ptyOf, claudeRunning(tabId, null), claudeLeads(tabId) (the same without the reader check; throws when
 *       the process checks fail), working(tabId), needs(tabId) (a permission prompt is open), watch(tabId) -> { seq,
 *       keys, input, screen, stop }, paste(tabId, text), submit(tabId), write(tabId, data) (counted as Dobius's own, not
 *       a person's), inputBusy(tabId), claudeInTab(tabId) (a claude process anywhere in the tab; true when unsure),
 *       frontKind(tabId) ('shell' | 'codex' | 'other', what leads the terminal), onSubmit(tabId) (Enter was pressed
 *       on a message), sleep(ms), now()
 * Resolves { status, body } for the HTTP reply.
 */
export async function sendToTab(deps, tabId, message, { claudeOnly = false } = {}) {
  sweepTyped(deps);
  if (!deps.tabAlive(tabId) || !deps.ptyOf(tabId)) return fail(404, 'no such tab (see dobius-tabs)');
  // Every caller (dobius-send, phone voice, dobius-project tell): no escape sequence or control key ever reaches the
  // terminal as text. An ESC [201~ would end the bracketed paste early and the rest would drive the TUI as keys.
  // No size limit here: /tabSend keeps the bridge's own (an /openTab card's 32KB cap is not this route's).
  message = typeof message === 'string' ? stripControls(message) : '';
  if (!message.trim()) return fail(400, 'message is empty');
  // openTabsStarting: a tab /openTab is creating can already be listed before it is marked as its own.
  if (sending.has(tabId) || openTabBusy.has(tabId) || openTabsStarting() > 0) return fail(409, 'another message is being sent to that tab right now; nothing was typed, try again');
  sending.add(tabId);
  try {
    return await send(deps, tabId, message, claudeOnly);
  } finally {
    sending.delete(tabId);
  }
}

// A screen read that counts: nothing reached the terminal and nobody used it while it was rendered. Resolves the screen
// (the caller acts on it in the same tick) or null once `until` passes.
async function stillScreen(deps, watch, until) {
  for (;;) {
    const seq = watch.seq();
    const input = watch.input();
    let s;
    try { s = await watch.screen(); } catch { s = null; }
    if (s && watch.seq() === seq && watch.input() === input) return s;
    if (deps.now() >= until) return null;
    await deps.sleep(POLL_MS);
  }
}

// claudeOnly (dobius-project tell): only ever a paste into Claude's prompt. A tab whose Claude has exited is back at a
// shell, and typing the message there would run it as a command.
async function send(deps, tabId, message, claudeOnly = false) {
  if (deps.inputBusy(tabId)) return fail(409, 'something else is typing into the tab right now; nothing was typed, try again');
  const pty = deps.ptyOf(tabId);
  const watch = deps.watch(tabId);
  // A red left over from a prompt already answered must not block every send: the screen is what says a dialog is open.
  // Only a permission prompt that appears during the send stops it.
  const needsAtStart = deps.needs(tabId);
  try {
    const claude = await deps.claudeRunning(tabId, null);
    if (!claude) {
      if (claudeOnly) return fail(409, 'Claude is not at its prompt in that tab (it may have exited or be busy with a command); nothing was typed');
      let leads;
      try { leads = await deps.claudeLeads(tabId); } catch { return fail(409, 'could not check what is running in that tab; nothing was typed, try again'); }
      // Claude leads the terminal but a command it started holds it readable (a tool running): keys could reach that
      // command, so nothing is typed. Only a tab Claude is not leading at all is typed into raw.
      if (leads) return fail(409, 'Claude in that tab is running a command that holds the terminal; nothing was typed, try again when it finishes');
      // A check that timed out says "not Claude" too: a running claude process anywhere in the tab (that check answers
      // yes when it cannot tell), or its prompt box at the bottom of the screen, means it is Claude's after all, and raw
      // text plus Enter could answer its dialog. Not the red dot or dialog-like words on screen: a suspended Claude
      // leaves both behind over a working shell (Codex round 5).
      if (await deps.claudeInTab(tabId)) return fail(409, 'Claude is running in that tab but could not be confirmed at its prompt; nothing was typed, try again');
      // Only the tab's own shell or Codex is typed into raw: behind any other program (tmux, ssh, docker exec, ...) the
      // keys can reach a Claude no check here can see.
      let front;
      try { front = await deps.frontKind(tabId); } catch { front = 'other'; }
      if (front !== 'shell' && front !== 'codex') return fail(409, 'a program other than the shell, Claude or Codex is running in that tab, so Dobius cannot tell where the keys would go; nothing was typed');
      const s = await stillScreen(deps, watch, deps.now() + STILL_MS);
      // A screen that never held still (a busy program, or a spinner) is not typed into blind.
      if (!s) return fail(409, 'the screen in that tab kept changing, so what is running there could not be checked; nothing was typed, try again when it settles');
      if (promptBoxText(s.lines, s.modes) !== null) return fail(409, 'that tab shows Claude\'s prompt, but Claude could not be confirmed running there; nothing was typed, try again');
      // Awaited here, never returned bare: the finally below would stop the watch before typeRaw's pause, and keys typed
      // during it would go unseen (Codex round 3).
      return await typeRaw(deps, tabId, pty, watch, message);
    }
    if (startsClaude(message)) return fail(409, 'Claude is already running in that tab, so a command that starts Claude would reach it as a prompt; nothing was typed', { reason: 'claude-running' });
    // Into Claude only (a shell's `cat <file` keeps its redirect): no harness markup posing as system text.
    message = defangHarnessTags(message);
    if (TRAILING_BACKSLASH_RE.test(message)) return fail(409, 'the message ends with a backslash, which Claude reads as a line continuation; nothing was typed');
    const screen = await stillScreen(deps, watch, deps.now() + STILL_MS);
    // Same tick from the read to the paste.
    if (!screen) return fail(409, 'the screen in that tab did not hold still long enough to check Claude\'s prompt; nothing was typed, try again');
    // The record (see typedNotSent): `unread` = our paste may still be on its way; `ours` = Enter may finish it.
    const t = typedNotSent.get(tabId);
    const live = !!t && t.pty === pty;
    const unread = live && !t.seen && deps.now() - t.at < PENDING_MS;
    const ours = live && t.retryable && deps.inputSeq(tabId) === t.seq && deps.now() - t.at < TYPED_KEEP_MS;
    let resend = false;
    if (boxIsEmpty(screen)) {
      if (unread && !(ours && t.message === message)) return fail(409, 'an earlier message typed into that tab has not shown up in Claude\'s prompt yet; nothing was typed, try again shortly or press Enter in the tab once it shows', { reason: 'pending' });
      resend = unread && ours; // the same message, still on its way: wait for it to show, then Enter
      if (!resend) typedNotSent.delete(tabId); // seen earlier and gone now (sent or cleared by a person)
    } else {
      const box = promptBoxText(screen.lines, screen.modes);
      if (box === null) {
        return screen.modes?.bracketedPaste
          ? fail(409, 'Claude in that tab is not at its prompt (a question or a dialog may be open); nothing was typed', { reason: 'no-prompt-box' })
          : fail(409, 'Claude in that tab has paste mode off, so it is not at its prompt; nothing was typed', { reason: 'paste-mode-off' });
      }
      // Claude has read input since our paste (the box shows text): ours is no longer on its way.
      if (live) t.seen = true;
      // Our own earlier message, typed but not sent: Enter on it, nothing typed again.
      resend = ours && t.message === message && boxHoldsMessage(box, message, true);
      if (!resend && live && !ours) typedNotSent.delete(tabId);
      if (!resend) return fail(409, 'Claude\'s prompt in that tab already holds typed text; nothing was typed', { reason: 'draft' });
    }
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return fail(409, 'the tab closed or its shell changed; nothing was typed');
    // Any input of a person's since the send began (a wheel turn can recall an old prompt whose redraw is still to come).
    if (watch.keys() !== 0 || watch.input() !== 0 || deps.inputBusy(tabId) || (deps.needs(tabId) && !needsAtStart)) return fail(409, 'someone used the tab, or Claude is asking something; nothing was typed, try again');
    // Recorded BEFORE the wait below, and kept until Enter is pressed: whatever ends this attempt, a later send must know
    // a paste of ours may be on its way (Codex rounds 3 and 5). A resend keeps the original record.
    if (!resend) {
      deps.paste(tabId, message);
      // Read right after our own write: anything written later (a person in the wait below) no longer matches.
      typedNotSent.set(tabId, { pty, message, at: deps.now(), seq: deps.inputSeq(tabId), retryable: false, seen: false });
    }
    const rec = typedNotSent.get(tabId);
    const r = await submitPasted(deps, tabId, pty, watch, message, watch.input(), needsAtStart, () => { if (rec) rec.seen = true; }, rec?.seq);
    if (r.body?.ok || r.body?.submitted || r.body?.enterPressed) typedNotSent.delete(tabId);
    else if (rec && typedNotSent.get(tabId) === rec) rec.retryable = rec.retryable || !!r.retryable;
    delete r.retryable;
    return r;
  } finally {
    watch.stop();
  }
}

async function submitPasted(deps, tabId, pty, watch, message, inputAtPaste, needsAtStart, onSeen = () => {}, seqAtPaste = null) {
  // Only a send that never saw its own paste may be finished by sending it again; one stopped by a person, a command or
  // a question may not (whatever they did is in the box now).
  const typedOnly = (why, retryable = false) => ({ status: 200, retryable, body: { ok: false, sent: message.length, typed: true, submitted: false, note: `the message is typed into Claude's prompt but was not sent: ${why}; ${retryable ? 'send the same message again to send it, or press Enter in the tab' : 'press Enter in the tab to send it'}` } });
  const end = deps.now() + SUBMIT_WAIT_MS;
  let ready = false;
  while (!ready) {
    if (deps.now() >= end) return typedOnly('Claude\'s prompt did not show it on a still screen in time', true);
    await deps.sleep(POLL_MS);
    // Before the read: a command Claude started may have opened the terminal for reading since the paste.
    if (!(await deps.claudeRunning(tabId, null))) return typedOnly('Claude was not in front at its prompt (a command it started may be reading the terminal)');
    const s = await stillScreen(deps, watch, 0);
    const box = s ? promptBoxText(s.lines, s.modes) : null;
    if (s && box !== null && !boxIsEmpty(s)) onSeen(); // the box shows typed text (not a dim suggestion): our paste was read
    ready = !!s && boxHoldsMessage(box, message, true);
    // Same tick from the checks below to the Enter.
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return typedOnly('the tab closed or its shell changed');
    // Every source, Dobius's own writes too: another delivery pasting behind ours is not in watch.input() (Codex round 6).
    if (watch.keys() !== 0 || deps.inputBusy(tabId) || watch.input() !== inputAtPaste
      || (seqAtPaste != null && deps.inputSeq(tabId) !== seqAtPaste)) return typedOnly('someone used the tab');
    if (deps.needs(tabId) && !needsAtStart) return typedOnly('Claude is asking something');
  }
  const queued = deps.working(tabId);
  deps.submit(tabId);
  deps.onSubmit?.(tabId);
  const unconfirmed = (why) => ({ status: 200, body: { ok: false, sent: message.length, typed: true, submitted: false, enterPressed: true, note: `Enter was pressed, but ${why}; check the tab` } });
  const confirmEnd = deps.now() + CONFIRM_MS;
  let emptyBefore = false;
  while (deps.now() < confirmEnd) {
    await deps.sleep(POLL_MS);
    // A window closing sends Ctrl+C straight to the PTY, which empties the box without the message being sent.
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return unconfirmed('the tab closed before Claude was seen taking the message');
    if (watch.keys() !== 0 || watch.input() !== inputAtPaste) return unconfirmed('someone used the tab before Claude was seen taking the message');
    // Taken: the box is empty on a still read, or on two reads in a row while a spinner keeps the screen moving (while
    // Claude works it shows the message above the box until the turn ends). Not merely "no longer the message": a
    // repaint caught halfway can show part of it.
    let after;
    const seqBefore = watch.seq();
    try { after = await watch.screen(); } catch { after = null; }
    const empty = !!after && boxIsEmpty(after);
    const still = watch.seq() === seqBefore;
    const taken = empty && (still || emptyBefore);
    emptyBefore = empty;
    if (taken) {
      return { status: 200, body: { ok: true, sent: message.length, submitted: true, confirmed: true, ...(queued ? { note: 'Claude was working, so the message is queued for after its turn' } : {}) } };
    }
  }
  return unconfirmed(emptyBefore ? 'Claude\'s screen never held still long enough to confirm it was taken; look before sending it again' : 'the message is still in Claude\'s prompt (is Enter set to insert a new line?)');
}

async function typeRaw(deps, tabId, pty, watch, message) {
  // Checked before a single character goes out: the tab may have changed, or someone typed, during the process checks.
  if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return fail(409, 'the tab closed or its shell changed; nothing was typed');
  if (watch.keys() !== 0 || deps.inputBusy(tabId)) return fail(409, 'someone typed into the tab; nothing was typed, try again');
  for (let i = 0; i < message.length; i += CHUNK) deps.write(tabId, message.slice(i, i + CHUNK));
  // The Enter is its own write, after the text has had time to arrive: in one burst a program reading paste-like input
  // takes the Enter as part of the text.
  await deps.sleep(Math.min(1500, 80 + Math.ceil(message.length / 8)));
  const notPressed = (why) => fail(409, `the text was typed but Enter was not pressed: ${why}`, { sent: message.length, typed: true, submitted: false });
  if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return notPressed('the tab closed or its shell changed');
  // A person typing meanwhile: their text and this one are on one line now, and Enter would send both.
  if (watch.keys() !== 0 || deps.inputBusy(tabId)) return notPressed('someone typed into the tab meanwhile');
  deps.submit(tabId);
  deps.onSubmit?.(tabId);
  return { status: 200, body: { ok: true, sent: message.length, submitted: true, confirmed: false, note: 'Claude is not running in that tab, so the text was typed and Enter pressed without a check that it was taken' } };
}
