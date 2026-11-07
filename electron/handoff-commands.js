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
// What the card could hide or a shell could read differently from what is shown: control and format characters,
// invisible (default-ignorable) ones, unassigned and private-use code points. Broken UTF-16 is refused separately.
const HIDDEN_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cn}\p{Co}]/u;

/**
 * The `! ` commands in a reply, in order, without duplicates: the same lines shared/handoff.js treats as a handback.
 * A line inside an inline backtick drops the closing one; a trailing ` \` joins the next line. A command holding a
 * character the card could hide is left out.
 */
export function extractCommands(text) {
  if (typeof text !== 'string') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length && out.length < MAX_COMMANDS; i += 1) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    let cmd = m[2];
    if (m[1] === '`') cmd = cmd.replace(/`\s*$/, '');
    // Shell line continuation: `cmd \` then the rest on the next line(s).
    while (/(^|[^\\])\\\s*$/.test(cmd) && i + 1 < lines.length) {
      i += 1;
      cmd = `${cmd.replace(/\\\s*$/, '').trimEnd()} ${lines[i].trim()}`;
    }
    cmd = cmd.trim();
    if (!cmd || cmd.length > MAX_COMMAND_LEN || HIDDEN_RE.test(cmd) || !cmd.isWellFormed()) continue;
    if (!out.includes(cmd)) out.push(cmd);
  }
  return out;
}

export function createHandoffCommands({ resolve, lastReply, processCwd, projectOf, notify = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), newId }) {
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
        const commands = extractCommands(best.text);
        if (!commands.length) continue;
        const projectPath = tabProject || s.sessionProject || folder || best.project;
        // Always an explicit folder: unknown Claude folder means the project folder, named, never "wherever a new
        // shell starts" (a login profile may cd).
        byTab.set(tabId, { tabId, projectPath, cwd: folder || projectPath, at: now(), commands: commands.map((c) => ({ id: newId(), text: c })) });
        notify();
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
      gen.delete(tabId);
      if (byTab.delete(tabId)) notify();
      return;
    }
    if (state === 'working') {
      // A new turn: what the tab handed back before is no longer what it is waiting on.
      if (!turnStart.has(tabId)) turnStart.set(tabId, now());
      bump(tabId);
      if (byTab.delete(tabId)) notify();
      return;
    }
    if (state === 'done') turnStart.delete(tabId);
  }

  /** Every tab's pending commands, newest first (the renderer shows its own project's). */
  function list() {
    return [...byTab.values()].sort((a, b) => b.at - a.at).map((e) => ({ ...e, commands: e.commands.map((c) => ({ ...c })) }));
  }

  /** One command and where it runs, still listed. */
  function peek(tabId, id) {
    const e = byTab.get(tabId);
    const c = e?.commands.find((x) => x.id === id);
    return c ? { tabId, projectPath: e.projectPath, cwd: e.cwd, text: c.text } : null;
  }

  /** Remove one command (run or dismissed). Returns it, or null. */
  function take(tabId, id) {
    const found = peek(tabId, id);
    if (!found) return null;
    const e = byTab.get(tabId);
    e.commands = e.commands.filter((x) => x.id !== id);
    if (!e.commands.length) byTab.delete(tabId);
    notify();
    return found;
  }

  return { onHook, list, peek, take };
}

/**
 * The script a Run tab starts with (run by /bin/bash after the login profile, shared/new-tab.js loginShellSpawn): it
 * deletes itself, enters the folder the card names or stops there, shows the command, then runs it as its own last
 * line, so everything in it (`&`, `;`, pipes) runs in that folder. Nothing of it is ever typed into a shell.
 */
export function runScriptText(text, cwd, quote) {
  return [
    '/bin/rm -f -- "$0"', // a full path: a project .env may put its own `rm` first on PATH
    `builtin cd -- ${quote(cwd)} || { printf 'Dobius: could not open %s, nothing was run.\\n' ${quote(cwd)}; exit 1; }`,
    `printf '\\033[2m$ %s\\033[0m\\n' ${quote(text)}`,
    text,
    '',
  ].join('\n');
}
