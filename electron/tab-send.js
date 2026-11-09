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
//   - Anything else (a shell, Codex, a program): typed as before, with the Enter written on its own once the text has
//     gone out, and only when nobody typed meanwhile.
// One send per tab at a time, and none into a tab /openTab is still delivering to: two pastes would land in one box.
// ok is true only when Enter was pressed on the message and, where it can be seen (Claude), it was seen taken;
// confirmed says whether it was seen.
import { promptBoxText, boxHoldsMessage, TRAILING_BACKSLASH_RE, openTabBusy } from './bridge-open-tab.js';
import { boxIsEmpty } from './team-deliver.js';

const CHUNK = 256;
const STILL_MS = 3000;
const SUBMIT_WAIT_MS = 6000;
const CONFIRM_MS = 3000;
const POLL_MS = 150;

const fail = (status, error, extra = {}) => ({ status, body: { ok: false, ...extra, error } });
const sending = new Set();

/**
 * deps: tabAlive, ptyOf, claudeRunning(tabId, null), claudeLeads(tabId) (the same without the reader check; throws when
 *       the process checks fail), working(tabId), needs(tabId) (a permission prompt is open), watch(tabId) -> { seq,
 *       keys, input, screen, stop }, paste(tabId, text), submit(tabId), write(tabId, data) (counted as Dobius's own, not
 *       a person's), inputBusy(tabId), onSubmit(tabId) (Enter was pressed on a message), sleep(ms), now()
 * Resolves { status, body } for the HTTP reply.
 */
export async function sendToTab(deps, tabId, message) {
  if (!deps.tabAlive(tabId) || !deps.ptyOf(tabId)) return fail(404, 'no such tab (see dobius-tabs)');
  if (sending.has(tabId) || openTabBusy.has(tabId)) return fail(409, 'another message is being sent to that tab right now; nothing was typed, try again');
  sending.add(tabId);
  try {
    return await send(deps, tabId, message);
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

async function send(deps, tabId, message) {
  if (deps.inputBusy(tabId)) return fail(409, 'something else is typing into the tab right now; nothing was typed, try again');
  const pty = deps.ptyOf(tabId);
  const watch = deps.watch(tabId);
  try {
    const claude = await deps.claudeRunning(tabId, null);
    if (!claude) {
      let leads;
      try { leads = await deps.claudeLeads(tabId); } catch { return fail(409, 'could not check what is running in that tab; nothing was typed, try again'); }
      // Claude leads the terminal but a command it started holds it readable (a tool running): keys could reach that
      // command, so nothing is typed. Only a tab Claude is not leading at all is typed into raw.
      if (leads) return fail(409, 'Claude in that tab is running a command that holds the terminal; nothing was typed, try again when it finishes');
      const s = await stillScreen(deps, watch, deps.now() + STILL_MS);
      if (s && promptBoxText(s.lines, s.modes) !== null) return fail(409, 'that tab shows Claude\'s prompt, but Claude could not be confirmed running there; nothing was typed, try again');
      return typeRaw(deps, tabId, pty, watch, message);
    }
    if (TRAILING_BACKSLASH_RE.test(message)) return fail(409, 'the message ends with a backslash, which Claude reads as a line continuation; nothing was typed');
    const screen = await stillScreen(deps, watch, deps.now() + STILL_MS);
    // Same tick from the read to the paste.
    if (!screen) return fail(409, 'the screen in that tab did not hold still long enough to check Claude\'s prompt; nothing was typed, try again');
    if (!boxIsEmpty(screen)) {
      return promptBoxText(screen.lines, screen.modes) === null
        ? fail(409, 'Claude in that tab is not at its prompt (a question or a dialog may be open); nothing was typed')
        : fail(409, 'Claude\'s prompt in that tab already holds typed text; nothing was typed');
    }
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return fail(409, 'the tab closed or its shell changed; nothing was typed');
    if (watch.keys() !== 0 || deps.inputBusy(tabId) || deps.needs(tabId)) return fail(409, 'someone typed into the tab, or Claude is asking something; nothing was typed');
    deps.paste(tabId, message);
    return await submitPasted(deps, tabId, pty, watch, message, watch.input());
  } finally {
    watch.stop();
  }
}

async function submitPasted(deps, tabId, pty, watch, message, inputAtPaste) {
  const typedOnly = (why) => ({ status: 200, body: { ok: false, sent: message.length, typed: true, submitted: false, note: `the message is typed into Claude's prompt but was not sent: ${why}; press Enter in the tab to send it` } });
  const end = deps.now() + SUBMIT_WAIT_MS;
  let ready = false;
  while (!ready) {
    if (deps.now() >= end) return typedOnly('Claude\'s prompt did not show it on a still screen in time');
    await deps.sleep(POLL_MS);
    // Before the read: a command Claude started may have opened the terminal for reading since the paste.
    if (!(await deps.claudeRunning(tabId, null))) return typedOnly('Claude was not in front at its prompt (a command it started may be reading the terminal)');
    const s = await stillScreen(deps, watch, 0);
    ready = !!s && boxHoldsMessage(promptBoxText(s.lines, s.modes), message, true);
    // Same tick from the checks below to the Enter.
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return typedOnly('the tab closed or its shell changed');
    if (watch.keys() !== 0 || deps.inputBusy(tabId) || watch.input() !== inputAtPaste) return typedOnly('someone used the tab');
    if (deps.needs(tabId)) return typedOnly('Claude is asking something');
  }
  const queued = deps.working(tabId);
  deps.submit(tabId);
  deps.onSubmit?.(tabId);
  const unconfirmed = (why) => ({ status: 200, body: { ok: false, sent: message.length, typed: true, submitted: false, note: `Enter was pressed, but ${why}; check the tab` } });
  const confirmEnd = deps.now() + CONFIRM_MS;
  while (deps.now() < confirmEnd) {
    await deps.sleep(POLL_MS);
    // A window closing sends Ctrl+C straight to the PTY, which empties the box without the message being sent.
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return unconfirmed('the tab closed before Claude was seen taking the message');
    if (watch.keys() !== 0 || watch.input() !== inputAtPaste) return unconfirmed('someone used the tab before Claude was seen taking the message');
    let after;
    try { after = await watch.screen(); } catch { after = null; }
    if (!after) continue;
    const box = promptBoxText(after.lines, after.modes);
    // Taken: the box no longer holds it (while Claude works, it shows it above the box until the turn ends).
    if (box !== null && !boxHoldsMessage(box, message, true)) {
      return { status: 200, body: { ok: true, sent: message.length, submitted: true, confirmed: true, ...(queued ? { note: 'Claude was working, so the message is queued for after its turn' } : {}) } };
    }
  }
  return unconfirmed('the message is still in Claude\'s prompt (is Enter set to insert a new line?)');
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
