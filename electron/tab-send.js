// /tabSend (dobius-send): a message into an EXISTING tab.
//
// Typed in raw chunks with '\r' straight behind them, a long or multi-line message reached Claude as one burst it read
// as a paste, so the Enter landed inside the paste as a new line and the message sat unsent while the reply said ok
// (bug report from another Mac, 2026-11-09). Now, by what is in the tab:
//   - Claude idle at an empty prompt: what /openTab and team delivery do. One bracketed paste, one Enter as its own
//     write, and the Enter confirmed taken (submitAfterPaste).
//   - Claude working: its screen never holds still, so submitAfterPaste's wait for a quiet screen never ends. The paste,
//     then Enter on a screen read with nothing new arriving while it was read, its box holding the message and no
//     permission prompt open; then the box must empty (Claude queues it for after the turn).
//   - Claude with a question or dialog on screen, or a draft in its box: nothing is typed (an Enter would answer the
//     question or send the draft). Nor when Claude leads the terminal but a command it started holds it readable, or
//     when the process checks fail: either could put the keys somewhere else.
//   - Anything else (a shell, Codex, a program): typed as before, with the Enter written on its own once the text has
//     gone out, and only when nobody typed meanwhile.
// One send per tab at a time: two at once would both see an empty box and paste into each other.
// ok is true only when Enter was pressed on the message and, where it can be seen (Claude), it was seen taken;
// confirmed says whether it was seen.
import { submitAfterPaste, promptBoxText, boxHoldsMessage, TRAILING_BACKSLASH_RE } from './bridge-open-tab.js';
import { boxIsEmpty } from './team-deliver.js';

const CHUNK = 256;
const WORKING_WAIT_MS = 6000;
const CONFIRM_MS = 3000;
const POLL_MS = 150;

const fail = (status, error, extra = {}) => ({ status, body: { ok: false, ...extra, error } });
const sending = new Set();

/**
 * deps: tabAlive, ptyOf, claudeRunning(tabId, null), claudeLeads(tabId) (the same without the reader check; throws when
 *       the process checks fail), working(tabId), needs(tabId) (a permission prompt is open), watch(tabId) -> { seq,
 *       keys, input, screen, stop }, paste(tabId, text), submit(tabId), write(tabId, data) (counted as Dobius's own, not
 *       a person's), inputBusy(tabId), sleep(ms), now()
 * Resolves { status, body } for the HTTP reply.
 */
export async function sendToTab(deps, tabId, message) {
  if (!deps.tabAlive(tabId) || !deps.ptyOf(tabId)) return fail(404, 'no such tab (see dobius-tabs)');
  if (sending.has(tabId)) return fail(409, 'another message is being sent to that tab right now; nothing was typed, try again');
  sending.add(tabId);
  try {
    return await send(deps, tabId, message);
  } finally {
    sending.delete(tabId);
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
      return await typeRaw(deps, tabId, pty, watch, message);
    }
    if (TRAILING_BACKSLASH_RE.test(message)) return fail(409, 'the message ends with a backslash, which Claude reads as a line continuation; nothing was typed');
    let screen;
    try { screen = await watch.screen(); } catch { screen = null; }
    if (!boxIsEmpty(screen)) {
      const box = screen ? promptBoxText(screen.lines, screen.modes) : null;
      return box === null
        ? fail(409, 'Claude in that tab is not at its prompt (a question or a dialog may be open); nothing was typed')
        : fail(409, 'Claude\'s prompt in that tab already holds typed text; nothing was typed');
    }
    // No await from here to the paste.
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return fail(409, 'the tab closed or its shell changed; nothing was typed');
    if (watch.keys() !== 0 || deps.inputBusy(tabId) || deps.needs(tabId)) return fail(409, 'someone typed into the tab, or Claude is asking something; nothing was typed');
    const working = deps.working(tabId);
    const seqAtPaste = watch.seq();
    deps.paste(tabId, message);
    if (!working) {
      const r = await submitAfterPaste(deps, tabId, pty, watch, seqAtPaste, message, null, { anyPaste: true });
      if (r.submitted) return { status: 200, body: { ok: true, sent: message.length, submitted: true, confirmed: true } };
      return { status: 200, body: { ok: false, sent: message.length, typed: true, submitted: false, note: r.note || 'typed into Claude\'s prompt but not confirmed sent; check the tab' } };
    }
    return await submitWhileWorking(deps, tabId, pty, watch, message);
  } finally {
    watch.stop();
  }
}

async function submitWhileWorking(deps, tabId, pty, watch, message) {
  const typedOnly = (why) => ({ status: 200, body: { ok: false, sent: message.length, typed: true, submitted: false, note: `the message is typed into Claude's prompt but was not sent: ${why}; press Enter in the tab to send it` } });
  const inputAtPaste = watch.input();
  const end = deps.now() + WORKING_WAIT_MS;
  let ready = false;
  while (!ready) {
    if (deps.now() >= end) return typedOnly('Claude\'s prompt did not show it on a still screen in time');
    await deps.sleep(POLL_MS);
    // The read counts only if nothing new reached the terminal while it was read: the screen judged is the screen now
    // (a permission dialog drawn during the read would otherwise be answered by the Enter).
    const seqAtRead = watch.seq();
    let s;
    try { s = await watch.screen(); } catch { s = null; }
    ready = !!s && watch.seq() === seqAtRead && boxHoldsMessage(promptBoxText(s.lines, s.modes), message, true);
    // Same tick from the checks below to the Enter.
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return typedOnly('the tab closed or its shell changed');
    if (watch.keys() !== 0 || deps.inputBusy(tabId) || watch.input() !== inputAtPaste) return typedOnly('someone used the tab');
    if (deps.needs(tabId)) return typedOnly('Claude is asking something');
  }
  deps.submit(tabId);
  const confirmEnd = deps.now() + CONFIRM_MS;
  while (deps.now() < confirmEnd) {
    await deps.sleep(POLL_MS);
    if (watch.keys() !== 0 || watch.input() !== inputAtPaste) return { status: 200, body: { ok: false, sent: message.length, typed: true, submitted: false, note: 'Enter was pressed, but someone used the tab before Claude was seen taking the message; check the tab' } };
    let after;
    try { after = await watch.screen(); } catch { after = null; }
    if (!after) continue;
    const box = promptBoxText(after.lines, after.modes);
    // Queued: the box no longer holds it (Claude shows it above the box until the turn ends).
    if (box !== null && !boxHoldsMessage(box, message, true)) return { status: 200, body: { ok: true, sent: message.length, submitted: true, confirmed: true, note: 'Claude was working, so the message is queued for after its turn' } };
  }
  return { status: 200, body: { ok: false, sent: message.length, typed: true, submitted: false, note: 'Enter was pressed but the message is still in Claude\'s prompt (is Enter set to insert a new line?); check the tab' } };
}

async function typeRaw(deps, tabId, pty, watch, message) {
  for (let i = 0; i < message.length; i += CHUNK) deps.write(tabId, message.slice(i, i + CHUNK));
  // The Enter is its own write, after the text has had time to arrive: in one burst a program reading paste-like input
  // takes the Enter as part of the text.
  await deps.sleep(Math.min(1500, 80 + Math.ceil(message.length / 8)));
  const notPressed = (why) => fail(409, `the text was typed but Enter was not pressed: ${why}`, { sent: message.length, typed: true, submitted: false });
  if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return notPressed('the tab closed or its shell changed');
  // A person typing meanwhile: their text and this one are on one line now, and Enter would send both.
  if (watch.keys() !== 0 || deps.inputBusy(tabId)) return notPressed('someone typed into the tab meanwhile');
  deps.submit(tabId);
  return { status: 200, body: { ok: true, sent: message.length, submitted: true, confirmed: false, note: 'Claude is not running in that tab, so the text was typed and Enter pressed without a check that it was taken' } };
}
