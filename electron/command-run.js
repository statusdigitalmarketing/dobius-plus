// Run a handed-back command (Tasks > Commands): the checks and the start, shared by the Mac's Run (handoffCommands:prepare,
// then terminal:create redeeming its one-time token) and the phone's Run (mobile-tasks commandsRun). Pure apart from what
// comes in, so the guards are tested without Electron (electron/__tests__/phone-tasks.test.mjs).
//
// Nothing here is ever typed into a shell: the command goes into a 0600 file in <userData>/run that a fresh login shell
// runs as its startup program (main's writeRunScript, shared/new-tab.js loginShellSpawn).
import { extractCommands } from './handoff-commands.js';
import { commandPlaceholder } from '../shared/handoff.js';

/**
 * Whether a WAITING command (handoffCommands.peek) may run, and the text that runs. `edited`: the person changed it on
 * the card first (it must still be exactly one plain `! ` command line). `asIs`: the person said the flagged
 * placeholder is real syntax. `syntaxOk(text)`: bash -n, warnings included. `shell`: $SHELL.
 * Returns { ok:true, text } or { ok:false, code, error }: `code` is fixed (what the phone gets), `error` is the Mac's
 * sentence (the placeholder one names the placeholder, so it only goes to the Mac's own window).
 */
export function checkCommandRun({ cmd, edited, asIs = false, syntaxOk, shell }) {
  if (!cmd) return { ok: false, code: 'not-waiting', error: 'That command is no longer waiting.' };
  let text = cmd.text;
  if (edited !== undefined && edited !== null) {
    const e = typeof edited === 'string' ? edited.trim() : '';
    const parsed = extractCommands(`! ${e}`);
    if (!e || parsed.length !== 1 || parsed[0] !== e) return { ok: false, code: 'bad-edit', error: 'The edited command must be one line of plain text.' };
    text = e;
  }
  const hole = commandPlaceholder(text);
  if (hole && asIs !== true) return { ok: false, code: 'placeholder', error: `Fill in ${hole} first (Edit).` };
  if (!syntaxOk(text)) {
    return { ok: false, code: edited != null ? 'bad-edit-syntax' : 'syntax', error: edited != null ? 'That edit is not a complete shell command (check quotes and brackets).' : 'That command has a shell syntax error; Copy it and fix it, or ask the session again.' };
  }
  const sh = String(shell || '/bin/zsh').split('/').pop();
  if (sh !== 'zsh' && sh !== 'bash') return { ok: false, code: 'shell', error: `Run works with zsh and bash (your shell is ${sh}): use Copy.` };
  return { ok: true, text };
}

/** What the run tab prints as the command: the card's version, marked when it was edited (an edit may hold a key). */
export const shownCommand = (cmd, text) => (text === cmd.text ? cmd.text : `${cmd.text}   (edited)`);

/**
 * After the spawn: the command becomes Running in `termId` only if the PTY really started; otherwise its files go and
 * it stays waiting. deps: { startRun(tabId, id, termId, text, exitFile), track(termId, files), unlink(file) }.
 */
export function afterRunSpawn(created, run, termId, { startRun, track, unlink }) {
  if (created && run) {
    startRun(run.tabId, run.id, termId, run.text, run.exitFile);
    track(termId, [run.file, run.cmdFile]);
    return true;
  }
  for (const f of [run?.file, run?.cmdFile]) if (f) { try { unlink(f); } catch { /* cleared by pruneRunScripts */ } }
  return false;
}

/**
 * The phone's Run, in one synchronous call: the pairing, the command (still waiting) and the checks are all decided
 * right before the spawn, so nothing can change in between and a second tap finds it already running. The desktop needs
 * a one-time token only because its decision (prepare) and its spawn (terminal:create) are two calls from a window.
 * deps: { stillOk(), peek(), syntaxOk, shell, newTerminalId(), writeRunScript(text, cwd, shown), spawn(termId, script,
 * cmd), startRun, track, unlink, authorizeTab(termId), watchStart(termId, run) }. Returns { ok, termId } or { ok:false, error }.
 */
export function phoneRun({ tabId, id, edited, asIs }, deps) {
  if (!deps.stillOk()) return { ok: false, error: 'unavailable' };
  const cmd = deps.peek(tabId, id);
  const check = checkCommandRun({ cmd, edited, asIs, syntaxOk: deps.syntaxOk, shell: deps.shell });
  if (!check.ok) return { ok: false, error: check.code };
  // The syntax check ran bash: look at the pairing again right before anything is written or started.
  if (!deps.stillOk()) return { ok: false, error: 'unavailable' };
  if (typeof deps.newTerminalId !== 'function') return { ok: false, error: 'unavailable' };
  const termId = deps.newTerminalId();
  let run;
  try {
    run = { tabId, id, text: check.text, ...deps.writeRunScript(check.text, cmd.cwd, shownCommand(cmd, check.text)) };
  } catch {
    return { ok: false, error: 'write-failed' };
  }
  let created = null;
  try {
    created = deps.spawn(termId, run.file, cmd);
  } catch {
    created = null;
  } finally {
    afterRunSpawn(created, run, termId, deps);
  }
  if (!created) return { ok: false, error: 'spawn-failed' };
  // A phone's run terminal has no window anyone will close: if its shell never gets to the script (a login profile
  // waiting for input), the files (an edited key among them) must not wait there for good. main kills it after a while.
  try { deps.watchStart?.(termId, run); } catch { /* pruneRunScripts is the backstop */ }
  try { deps.authorizeTab?.(termId); } catch { /* the phone can still open it from the board */ }
  return { ok: true, termId };
}
