/**
 * Commands a Claude session handed back for the person to run (Tasks > Commands, 2026-11-07). Sam: "per project
 * session there is also commands that need to be run we need like a per project commands to be run button".
 *
 * A turn that ends handing the person a `! command` turns its tab red (shared/handoff.js, the Stop hook's
 * needs;handoff). Then this reads THAT turn's reply (a reply written before the turn began is refused: a Stop can land
 * before its reply is on disk, and argv can still name the session before a /clear), keeps each `! ` line as a command
 * for that tab, and lists them per project with the folder the Claude process works in. Running one opens a new shell
 * tab; main types `cd <folder> && { <command> }` there (runLine), and only then the command leaves the list. Typing into
 * the session's own Claude prompt is not used: a pasted `!` does not reliably enter Claude Code's bash mode.
 *
 * Pure apart from what comes in:
 *   resolve(tabId) -> Promise<{ sessionId, sessionProject, pid } | null>   the session running in the tab now
 *   lastReply(sessionId, projectPath) -> Promise<{ text, at } | null>      that session's last assistant reply
 *   processCwd(pid) -> Promise<string|null>                                the Claude process's folder
 *   projectOf(tabId) -> string|null                                        the project the tab belongs to (null: phone)
 *   notify()                                                                the list changed
 *   now(), sleep(ms), newId()
 */
export const MAX_COMMANDS = 10;
export const MAX_COMMAND_LEN = 2000;
const LINE_RE = /^[ ]*(?:[-*] |\d+\. )?(`?)! (\S.*)$/;
const NO_TURN_WINDOW_MS = 10 * 60 * 1000; // no turn start seen (the app started mid-turn): the last 10 minutes
// The transcript's own order is the turn boundary (a prompt after a reply makes it an earlier turn's); time is only a
// backstop, loose enough that hook markers processed late (a busy main thread) still find their turn's reply.
const HOOK_LATENESS_MS = 30 * 1000;
const MAX_WAITING = 12; // handed-back commands kept waiting per tab
// What the card could hide or a shell could read differently from what is shown: control and format characters,
// invisible (default-ignorable) ones, unassigned and private-use code points. Broken UTF-16 is refused separately.
const HIDDEN_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cn}\p{Co}]/u;

/**
 * The `! ` commands in a reply, in order, without duplicates: the same lines shared/handoff.js treats as a handback.
 * A line inside an inline backtick drops the closing one; a trailing ` \` joins the next line. A command holding a
 * character the card could hide is left out.
 */
export function extractCommands(text) {
  return extractCommandsWithContext(text).map((c) => c.text);
}

/** The same commands, each with `why`: what Claude wrote right around it (instructions, what it does). */
export function extractCommandsWithContext(text) {
  if (typeof text !== 'string') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length && out.length < MAX_COMMANDS; i += 1) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const first = i;
    let cmd = m[2];
    if (m[1] === '`') cmd = cmd.replace(/`\s*$/, '');
    // Shell line continuation: `cmd \` then the rest on the next line(s).
    while (/(^|[^\\])\\\s*$/.test(cmd) && i + 1 < lines.length) {
      i += 1;
      cmd = `${cmd.replace(/\\\s*$/, '').trimEnd()} ${lines[i].trim()}`;
    }
    cmd = cmd.trim();
    if (!cmd || cmd.length > MAX_COMMAND_LEN || HIDDEN_RE.test(cmd) || !cmd.isWellFormed()) continue;
    if (out.some((c) => c.text === cmd)) continue;
    out.push({ text: cmd, why: contextAround(lines, first, i) });
  }
  return out;
}

const FENCE_RE = /^\s*```/;
// Shown, never run: markdown markers off, anything the card could hide turned into a space.
const plain = (l) => l.replace(HIDDEN_RE, ' ').replace(/^\s*(?:#+\s+|[-*]\s+|\d+\.\s+)/, '').replace(/\*\*|`/g, '').trim();

/**
 * The paragraph just before a command (up to 4 lines, back to a blank line or another command) and the lines just
 * after it (up to 2, to a blank line or the next command): where Claude says what it is for and what to do first.
 */
export function contextAround(lines, first, last) {
  const before = [];
  for (let j = first - 1; j >= 0 && before.length < 4; j -= 1) {
    if (FENCE_RE.test(lines[j])) continue;
    if (LINE_RE.test(lines[j])) break;
    if (!lines[j].trim()) { if (before.length) break; continue; }
    before.unshift(plain(lines[j]));
  }
  const after = [];
  for (let j = last + 1; j < lines.length && after.length < 2; j += 1) {
    if (FENCE_RE.test(lines[j])) continue;
    if (LINE_RE.test(lines[j]) || !lines[j].trim()) break;
    // A line that leads straight into the next command introduces THAT one, not this.
    let k = j + 1;
    while (k < lines.length && FENCE_RE.test(lines[k])) k += 1;
    if (k < lines.length && LINE_RE.test(lines[k])) break;
    after.push(plain(lines[j]));
  }
  return [...before, ...after].filter(Boolean).join('\n').slice(0, 600);
}

/** The whole reply for "Show full reply": shown as text only, capped, nothing hidden. */
export const replyForDisplay = (text) => String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(HIDDEN_RE, ' ')).join('\n').slice(0, 6000);


// onAdded(tabId): at least one NEW waiting command was listed for that tab (the phone notifier's "handed back" event;
// it gets the tab id only, never the command).
export function createHandoffCommands({ resolve, lastReply, processCwd, projectOf, notify = () => {}, onAdded = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), newId }) {
  const byTab = new Map(); // tabId -> { tabId, projectPath, cwd, at, commands: [{ id, text }] }
  const gen = new Map(); // tabId -> generation, so a slow read cannot land after the tab moved on
  const turnStart = new Map(); // tabId -> when its current turn's first hook came

  const bump = (tabId) => { const g = (gen.get(tabId) || 0) + 1; gen.set(tabId, g); return g; };

  async function capture(tabId, g, since) {
    // The Stop hook can run a moment before the turn's final reply is on disk, when an earlier message of the same
    // turn is still the last one there. So a reply is taken only once two reads a second apart agree on it.
    let prev = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(attempt ? 1000 : 700);
      if (gen.get(tabId) !== g) return;
      try {
        const s = await resolve(tabId);
        if (!s?.sessionId) continue; // a record mid-rewrite, a link not made yet: read again
        const cwd = (Number.isInteger(s.pid) ? await processCwd(s.pid) : null) || s.recordCwd || null;
        const folder = typeof cwd === 'string' && cwd.startsWith('/') ? cwd : null;
        const tabProject = projectOf(tabId);
        // Where the transcript may be: the session's own project, the folder Claude runs in, the tab's project. The
        // newest reply from this turn wins; one from before it is never taken.
        let best = null;
        for (const p of [...new Set([s.sessionProject, folder, tabProject].filter(Boolean))]) {
          const r = await lastReply(s.sessionId, p);
          if (r && !r.promptAfter && Number.isFinite(r.at) && r.at >= since - HOOK_LATENESS_MS && (!best || r.at > best.at)) best = { ...r, project: p };
        }
        if (gen.get(tabId) !== g) return;
        const key = best ? `${best.at}|${best.text}` : null;
        const settled = key !== null && key === prev;
        prev = key;
        if (!settled) continue;
        const commands = extractCommandsWithContext(best.text);
        if (!commands.length) continue;
        const projectPath = tabProject || s.sessionProject || folder || best.project;
        // Everything handed back earlier stays until it is run, dismissed or the tab closes (Sam, 2026-11-07: a
        // background agent's hand-back started a new turn and the command he still had to run vanished). This
        // turn's commands are added; one already waiting with the same text keeps its place.
        if (prune()) notify(); // an expired one must not hide the same command handed back again
        const prior = byTab.get(tabId)?.commands || [];
        const waitingTexts = new Set(prior.filter((c) => c.state === 'waiting').map((c) => c.text));
        const added = commands.filter((c) => !waitingTexts.has(c.text));
        // Always an explicit folder: unknown Claude folder means the project folder, named, never "wherever a new
        // shell starts" (a login profile may cd).
        // Each command keeps the folder and reply it came with: one run earlier stays labelled as it ran, under a newer
        // turn's commands.
        const cwdNow = folder || projectPath;
        const reply = replyForDisplay(best.text);
        let all = [...prior, ...added.map((c) => ({ id: newId(), text: c.text, why: c.why, state: 'waiting', cwd: cwdNow, reply, at: now() }))];
        // At most MAX_WAITING waiting per tab: the oldest waiting ones go first.
        const waiting = all.filter((c) => c.state === 'waiting');
        if (waiting.length > MAX_WAITING) { const drop = new Set(waiting.slice(0, waiting.length - MAX_WAITING)); all = all.filter((c) => !drop.has(c)); }
        byTab.set(tabId, { tabId, projectPath, cwd: cwdNow, at: now(), reply, commands: all });
        notify();
        // A turn that handed back only commands already waiting reports that too, as a repeat (not news for a phone).
        if (added.length || commands.length) { try { onAdded(tabId, added.length ? undefined : { repeat: true }); } catch (err) { console.warn('[handoff-commands] onAdded failed:', err?.message || err); } }
        return;
      } catch (err) {
        console.warn('[handoff-commands] could not read the handed-back command:', err?.message || err);
        return;
      }
    }
  }

  /** A hook state from a terminal (terminal-status onHookState). */
  function onHook(tabId, state, tag) {
    if (state === 'needs' && tag === 'handoff') {
      // When this turn began (its first hook), as a loose backstop; the transcript order decides (promptAfter).
      const since = turnStart.get(tabId) ?? now() - NO_TURN_WINDOW_MS;
      turnStart.delete(tabId); // the turn is over
      void capture(tabId, bump(tabId), since);
      return;
    }
    if (state === 'exit') {
      turnStart.delete(tabId);
      bump(tabId); // a read still in flight for this tab is dropped
      gen.delete(tabId);
      let changed = dropWaiting(tabId);
      // A Run tab closed before its command finished.
      // A Run tab closed: 'closed' until its exit file says otherwise (it may have finished just before).
      for (const e of byTab.values()) for (const c of e.commands) {
        if (c.state === 'running' && c.runTabId === tabId) { c.state = 'closed'; c.endedAt = now(); changed = true; }
        // A finished command's terminal going away changes nothing on its card, but a phone offers "Open terminal"
        // only while that terminal is there: tell the lists to look again.
        else if (c.runTabId === tabId) changed = true;
      }
      if (changed) notify();
      return;
    }
    if (state === 'working') {
      // A new turn cancels a read of the last reply that has not settled yet (it could now see this turn's reply),
      // but it does NOT clear what was already handed back: that may be a background agent reporting in, or the
      // person talking about something else, while the command still waits to be run (Sam, 2026-11-07).
      if (!turnStart.has(tabId)) turnStart.set(tabId, now());
      bump(tabId);
      return;
    }
    if (state === 'done') turnStart.delete(tabId);
  }

  function dropWaiting(tabId) {
    const e = byTab.get(tabId);
    if (!e) return false;
    const before = e.commands.length;
    e.commands = e.commands.filter((c) => c.state !== 'waiting');
    if (!e.commands.length) byTab.delete(tabId);
    return e.commands.length !== before;
  }

  // A finished one stays on its card for an hour; a waiting one for a day (then it is surely stale), then they go.
  const DONE_KEEP_MS = 60 * 60 * 1000;
  const WAITING_KEEP_MS = 24 * 60 * 60 * 1000;
  // Returns whether anything left, so a caller outside list() can tell the windows.
  function prune() {
    let changed = false;
    for (const [tabId, e] of byTab) {
      const before = e.commands.length;
      e.commands = e.commands.filter((c) => (c.endedAt ? now() - c.endedAt < DONE_KEEP_MS : c.state !== 'waiting' || !c.at || now() - c.at < WAITING_KEEP_MS));
      if (e.commands.length !== before) changed = true;
      if (!e.commands.length) byTab.delete(tabId);
    }
    return changed;
  }
  // Expired cards leave open lists and the badge too, without waiting for some other change.
  const expiry = setInterval(() => { if (prune()) notify(); }, 10 * 60 * 1000);
  expiry.unref?.();

  /** Every tab's commands (waiting, running, finished), newest first; the renderer shows its own project's. */
  function list() {
    prune();
    // Never sent to a window: the script's exit file, and the text that actually ran (an edited one may hold a key).
    return [...byTab.values()].sort((a, b) => b.at - a.at)
      .map((e) => ({ ...e, commands: e.commands.map(({ exitFile: _exitFile, ran: _ran, ...c }) => ({ ...c })) }));
  }

  /** One WAITING command and where it runs. */
  function peek(tabId, id) {
    if (prune()) notify(); // an expired command is gone even if the list on screen was not refreshed
    const e = byTab.get(tabId);
    const c = e?.commands.find((x) => x.id === id && x.state === 'waiting');
    return c ? { tabId, projectPath: e.projectPath, cwd: c.cwd || e.cwd, text: c.text } : null;
  }

  /** Remove one command, any state (Dismiss). Returns true when it was there. */
  function take(tabId, id) {
    const e = byTab.get(tabId);
    if (!e || !e.commands.some((x) => x.id === id)) return false;
    e.commands = e.commands.filter((x) => x.id !== id);
    if (!e.commands.length) byTab.delete(tabId);
    notify();
    return true;
  }

  /** Run started in `runTabId` (text: what actually runs, edited or not). Only a waiting command. */
  // No expiry check here: peek() checked it just before the run tab was started, and a command now running must
  // keep its card (Running, then Done or Failed) even if it crossed the deadline meanwhile.
  function startRun(tabId, id, runTabId, text, exitFile) {
    const c = byTab.get(tabId)?.commands.find((x) => x.id === id && x.state === 'waiting');
    if (!c) return false;
    Object.assign(c, { state: 'running', runTabId, ran: text, edited: text !== c.text, startedAt: now(), exitFile });
    notify();
    return true;
  }

  /** Exit files to check: running commands, and ones whose tab closed (it may have finished just before). */
  const running = () => [...byTab.values()].flatMap((e) => e.commands.filter((c) => (c.state === 'running' || c.state === 'closed') && c.exitFile).map((c) => ({ tabId: e.tabId, id: c.id, exitFile: c.exitFile })));

  /** A command finished with `code` (its script wrote it): its real result, even if its tab has closed since. */
  function finishRun(tabId, id, code) {
    const c = byTab.get(tabId)?.commands.find((x) => x.id === id && (x.state === 'running' || x.state === 'closed'));
    if (!c) return false;
    Object.assign(c, { state: code === 0 ? 'done' : 'failed', exit: code, endedAt: now(), exitFile: null });
    notify();
    return true;
  }

  /** Whether a command handed back in this tab is still waiting to be run (not run, dismissed or expired). */
  function hasWaiting(tabId) {
    if (prune()) notify();
    return !!byTab.get(tabId)?.commands.some((c) => c.state === 'waiting');
  }

  return { onHook, list, peek, take, startRun, running, finishRun, hasWaiting };
}

/**
 * The script a Run tab starts with (run by /bin/bash after the login profile, shared/new-tab.js loginShellSpawn): it
 * deletes itself, enters the folder the card names or stops there, shows the command, runs the COMMAND FILE (the
 * command alone, written next to it) with its own /bin/bash -p, deletes that file, and writes the exit status for the
 * card. Nothing of it is ever typed into a shell.
 * - A separate file and bash: nothing in the command (an unterminated heredoc, `exec`, `exit`, `set -e`, an EXIT trap)
 *   can reach this script, and its real status is what is reported.
 * - Ctrl+C or a closed tab (INT, TERM, HUP) stops the command; this script carries on to clean up and report (a
 *   handled trap is reset to the default in the child, so the command itself still gets the signal).
 * - `shown` is what the tab prints as the command: the version the card showed (an edited one may hold a pasted key).
 * - The status is written to a temp name and renamed in, so the card never reads a half-written one.
 */
export function runScriptText(cmdFile, cwd, quote, exitFile = null, shown = '') {
  const report = (code) => (exitFile ? `printf '%s' ${code} > ${quote(`${exitFile}.tmp`)} && /bin/mv -f -- ${quote(`${exitFile}.tmp`)} ${quote(exitFile)}` : ':');
  const dropCmd = `/bin/rm -f -- ${quote(cmdFile)}`;
  return [
    '/bin/rm -f -- "$0"', // a full path: a project .env may put its own `rm` first on PATH
    "trap ':' INT TERM HUP",
    `builtin cd -- ${quote(cwd)} || { printf 'Dobius: could not open %s, nothing was run.\\n' ${quote(cwd)}; ${dropCmd}; ${report(127)}; exit 1; }`,
    `printf '\\033[2m$ %s\\033[0m\\n' ${quote(shown)}`,
    `/bin/bash -p -- ${quote(cmdFile)}`,
    'code=$?',
    dropCmd,
    report('"$code"'),
    '',
  ].join('\n');
}
