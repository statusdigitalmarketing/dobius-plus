// /tabSend (dobius-send): a message into an EXISTING tab.
//
// Typed in raw chunks with '\r' straight behind them, a long or multi-line message reached Claude as one burst it read
// as a paste, so the Enter landed inside the paste as a new line and the message sat unsent while the reply said ok
// (bug report from another Mac, 2026-11-09). Now, by what is in the tab:
//   - Claude idle at an empty prompt: what /openTab and team delivery do. One bracketed paste, one Enter as its own
//     write, and the Enter confirmed taken (submitAfterPaste).
//   - Claude working: its screen never holds still, so nothing can be confirmed. The paste, then the Enter once the box
//     shows the pasted text (Claude queues it for after the turn), reported as not confirmed.
//   - Claude with a question or dialog on screen, or a draft in its box: nothing is typed (an Enter would answer the
//     question or send the draft).
//   - Claude running a command that holds the terminal (a tool reading the keyboard): nothing is typed.
//   - Anything else (a shell, Codex, a program): typed as before, with the Enter written on its own once the text has
//     gone out.
// ok is true only when Enter was pressed on the message; confirmed says whether Claude was seen taking it.
import { submitAfterPaste, promptBoxText, boxHoldsMessage } from './bridge-open-tab.js';
import { boxIsEmpty } from './team-deliver.js';

const CHUNK = 256;
const SHOWN_WAIT_MS = 4000;
const POLL_MS = 150;

const fail = (status, error, extra = {}) => ({ status, body: { ok: false, ...extra, error } });

/**
 * deps: tabAlive, ptyOf, claudeRunning(tabId, null), claudeLeads(tabId) (the same without the reader check), working(tabId), watch(tabId) -> { seq, keys, input, screen, stop },
 *       paste(tabId, text), submit(tabId), write(tabId, data), inputBusy(tabId), sleep(ms), now()
 * Resolves { status, body } for the HTTP reply.
 */
export async function sendToTab(deps, tabId, message) {
  if (!deps.tabAlive(tabId) || !deps.ptyOf(tabId)) return fail(404, 'no such tab (see dobius-tabs)');
  if (deps.inputBusy(tabId)) return fail(409, 'something else is typing into the tab right now; nothing was typed, try again');
  const pty = deps.ptyOf(tabId);
  const watch = deps.watch(tabId);
  try {
    const claude = await deps.claudeRunning(tabId, null);
    if (!claude) {
      // Claude leads the terminal but a command it started holds it readable (a tool running): keys could reach that
      // command, so nothing is typed. Only a tab Claude is not leading at all is typed into raw.
      if (await deps.claudeLeads(tabId)) return fail(409, 'Claude in that tab is running a command that holds the terminal; nothing was typed, try again when it finishes');
      return await typeRaw(deps, tabId, pty, message);
    }
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
    if (watch.keys() !== 0 || deps.inputBusy(tabId)) return fail(409, 'someone typed into the tab; nothing was typed');
    const working = deps.working(tabId);
    const seqAtPaste = watch.seq();
    deps.paste(tabId, message);
    if (!working) {
      const r = await submitAfterPaste(deps, tabId, pty, watch, seqAtPaste, message, null, { anyPaste: true });
      if (r.submitted) return { status: 200, body: { ok: true, sent: message.length, submitted: true, confirmed: true } };
      return { status: 200, body: { ok: false, sent: message.length, typed: true, submitted: false, note: r.note || 'typed into Claude\'s prompt but not confirmed sent; check the tab' } };
    }
    // Working: wait for the box to show the paste, then Enter.
    const end = deps.now() + SHOWN_WAIT_MS;
    let shown = false;
    while (!shown && deps.now() < end) {
      await deps.sleep(POLL_MS);
      let s;
      try { s = await watch.screen(); } catch { s = null; }
      shown = !!s && boxHoldsMessage(promptBoxText(s.lines, s.modes), message, true);
    }
    const typedOnly = (why) => ({ status: 200, body: { ok: false, sent: message.length, typed: true, submitted: false, note: `the message is typed into Claude's prompt but was not sent: ${why}; press Enter in the tab to send it` } });
    if (!shown) return typedOnly('Claude\'s prompt did not show it in time');
    if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) return typedOnly('the tab closed or its shell changed');
    if (watch.keys() !== 0 || deps.inputBusy(tabId)) return typedOnly('someone typed into the tab');
    deps.submit(tabId);
    return { status: 200, body: { ok: true, sent: message.length, submitted: true, confirmed: false, note: 'Claude was working, so the message was queued with Enter for after its turn; not confirmed' } };
  } finally {
    watch.stop();
  }
}

async function typeRaw(deps, tabId, pty, message) {
  for (let i = 0; i < message.length; i += CHUNK) deps.write(tabId, message.slice(i, i + CHUNK));
  // The Enter is its own write, after the text has had time to arrive: in one burst a program reading paste-like input
  // takes the Enter as part of the text.
  await deps.sleep(Math.min(1500, 80 + Math.ceil(message.length / 8)));
  if (!deps.tabAlive(tabId) || deps.ptyOf(tabId) !== pty) {
    return fail(409, 'the tab closed or its shell changed before Enter; it was not pressed', { sent: message.length, typed: true, submitted: false });
  }
  deps.submit(tabId);
  return { status: 200, body: { ok: true, sent: message.length, submitted: true, confirmed: false, note: 'Claude is not running in that tab, so the text was typed and Enter pressed without a check that it was taken' } };
}
