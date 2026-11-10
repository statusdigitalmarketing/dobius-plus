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
// readAppended(sessionId, project, offset) -> { records, next } | null (data-service readTranscriptAppended): a command
// handed back and then run some other way (typed as `! cmd` into Claude, or Claude running it itself after a yes)
// leaves the list as run, told apart from Run here by `ranBy`. Optional: without it nothing is marked.
export function createHandoffCommands({ resolve, lastReply, processCwd, projectOf, readAppended = null, notify = () => {}, onAdded = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), newId }) {
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
        // sid / tproject / replyAt: where to look for it having run since (markRanElsewhere).
        let all = [...prior, ...added.map((c) => ({ id: newId(), text: c.text, why: c.why, state: 'waiting', cwd: cwdNow, reply, at: now(), sid: s.sessionId, tproject: best.project, replyAt: best.at }))];
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

  // ---- Run some other way: the session's own transcript says so. Only the EXACT command, in the folder the card
  // names, after the reply that handed it back, counts: `a && cmd` may never have reached cmd, and a match inside
  // quotes, a heredoc or a longer command is not a run (bugbot rounds 1 and 2). A wrong "ran" is the failure that
  // matters (the person then never runs a release or a login), so anything less certain stays waiting.
  // Bounded: each session is read incrementally (only appended bytes, at most 2MB a read), at most every
  // MIN_READ_MS, at most READS_PER_PASS sessions a pass (the longest unread first), and its state goes as soon as
  // nothing of it waits.
  const MIN_READ_MS = 5000;
  const READS_PER_PASS = 4;
  const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ');
  const dirOf = (d) => (typeof d === 'string' && d.length > 1 ? d.replace(/\/+$/, '') : d);
  const sessions = new Map(); // `${sid}|${project}` -> { offset, pending: Map, runs: [], readAt }
  let checking = null;
  let again = false;
  async function markRanElsewhere() {
    if (!readAppended) return;
    if (checking) { again = true; return checking; }
    checking = (async () => {
      do {
        again = false;
        const groups = new Map();
        for (const e of byTab.values()) for (const c of e.commands) {
          if (c.state !== 'waiting' || !c.sid || !c.tproject || !Number.isFinite(c.replyAt) || !c.cwd) continue;
          const k = `${c.sid}|${c.tproject}`;
          if (!groups.has(k)) groups.set(k, { sid: c.sid, project: c.tproject, cmds: [] });
          groups.get(k).cmds.push(c);
        }
        for (const k of [...sessions.keys()]) if (!groups.has(k)) sessions.delete(k);
        const due = [...groups].map(([k, g]) => [k, g, sessions.get(k)])
          .filter(([, , st]) => !st || now() - st.readAt >= MIN_READ_MS)
          .sort((x, y) => (x[2]?.readAt || 0) - (y[2]?.readAt || 0))
          .slice(0, READS_PER_PASS);
        let changed = false;
        for (const [k, g, st0] of due) {
          try {
            const st = st0 || { offset: null, pending: new Map(), runs: [], readAt: 0 };
            // Spaced like a good read even when it fails, or a failing transcript takes every slot every pass.
            st.readAt = now();
            sessions.set(k, st);
            const got = await readAppended(g.sid, g.project, st.offset);
            if (!got) continue;
            if (got.gap) st.pending.clear(); // a call and its result may sit on either side of the skipped bytes
            st.offset = got.next;
            st.runs.push(...commandRunsFrom(got.records, st.pending));
            if (st.runs.length > 200) st.runs.splice(0, st.runs.length - 200);
            sessions.set(k, st);
            // Oldest command first: each run accounts for one command, never two.
            for (const c of [...g.cmds].sort((x, y) => x.replyAt - y.replyAt)) {
              if (c.state !== 'waiting') continue; // Run or Dismiss while this read was out
              const r = st.runs.find((x) => !x.used && x.at >= c.replyAt && dirOf(x.cwd) === dirOf(c.cwd) && norm(x.text) === norm(c.text));
              if (!r) continue;
              r.used = true;
              Object.assign(c, { state: r.exit === null ? 'ran' : r.exit === 0 ? 'done' : 'failed', exit: r.exit, ranBy: r.by, ranErr: r.err || null, startedAt: r.at, endedAt: now() });
              changed = true;
            }
          } catch (err) {
            console.warn('[handoff-commands] could not check whether a command ran:', err?.message || err);
          }
        }
        if (changed) notify();
      } while (again);
    })().finally(() => { checking = null; });
    return checking;
  }
  let checkTimer = null;
  const soon = (ms = 1500) => {
    if (!readAppended || checkTimer) return;
    checkTimer = setTimeout(() => { checkTimer = null; void markRanElsewhere(); }, ms);
    checkTimer.unref?.();
  };
  // A `! cmd` typed into Claude fires no hook, so look now and then too, only while something is waiting.
  const poll = setInterval(() => { if ([...byTab.values()].some((e) => e.commands.some((c) => c.state === 'waiting' && c.sid))) soon(0); }, 20 * 1000);
  poll.unref?.();

  /** A hook state from a terminal (terminal-status onHookState). */
  function onHook(tabId, state, tag) {
    // A turn ending is when a run it made is on disk; tool-level hooks would only re-arm the check.
    if ((state === 'done' || state === 'needs') && byTab.get(tabId)?.commands.some((c) => c.state === 'waiting')) soon();
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
    soon(300); // an open list catches up with a command run meanwhile
    // Never sent to a window: the script's exit file, and the text that actually ran (an edited one may hold a key).
    return [...byTab.values()].sort((a, b) => b.at - a.at)
      .map((e) => ({ ...e, commands: e.commands.map(({ exitFile: _exitFile, ran: _ran, sid: _sid, tproject: _tp, replyAt: _ra, ...c }) => ({ ...c })) }));
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

  return { onHook, list, peek, take, startRun, running, finishRun, hasWaiting, markRanElsewhere };
}

/**
 * Commands that RAN, from transcript records in file order. `pending` (Map, kept by the caller across reads) holds
 * Claude's Bash calls whose result has not been seen yet. A run is:
 * - a `! cmd` the person typed into Claude (bash mode, a user record `<bash-input>cmd</bash-input>`), counted once its
 *   output record (`<bash-stdout>` / `<bash-stderr>`) is there, so one still running is not a run yet, nor one moved to
 *   the background (past 120s, or Ctrl+B). Its exit is not recorded (exit null: the card says "Ran", never a success);
 *   stderr's first line comes back as `err`, for display only. Any other record in between ends the wait (Esc);
 * - a Bash call of Claude's whose result came back fine (exit 0) or as "Exit code N" (exit null when Claude read a
 *   non-zero exit as no error, `returnCodeInterpretation`, e.g. grep's 1 for no match). A refused, blocked or
 *   interrupted call, a background one (run_in_background, or moved there: toolUseResult.backgroundTaskId) and one
 *   with no result yet did not run (or has not finished).
 * Each run carries where Claude's shell was: the folder of the call AND of its result must agree (a `cd` run beside it
 * in the same turn moves the shell between them), else cwd is null and it matches no card.
 */
// Only a command as short as a handed-back one can match, so longer ones are never kept; a kept one is a detached copy
// (a slice of the record's string would retain the whole record, NOTES 2026-09-15).
const BASH_MODE = '\0bash-mode'; // the `pending` key of a `! cmd` typed into Claude whose output is not in yet
const keepText = (t) => (typeof t === 'string' && t.length <= MAX_COMMAND_LEN * 2 ? Buffer.from(t, 'utf16le').toString('utf16le') : null);
export function commandRunsFrom(records, pending) {
  const runs = [];
  for (const e of Array.isArray(records) ? records : []) {
    if (!e || typeof e !== 'object') continue;
    const at = Date.parse(e.timestamp);
    const cwd = typeof e.cwd === 'string' ? e.cwd : null;
    const c = e.message?.content;
    if (e.type === 'user') {
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
          const u = pending.get(b.tool_use_id);
          pending.delete(b.tool_use_id);
          const tur = e.toolUseResult;
          if (tur && typeof tur === 'object' && (tur.backgroundTaskId || tur.interrupted === true)) continue;
          const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('') : '';
          const code = b.is_error === true ? t.slice(0, 64).match(/^\s*Exit code (\d+)/) : null;
          if (b.is_error === true && !code) continue;
          const unsure = !code && tur && typeof tur === 'object' && typeof tur.returnCodeInterpretation === 'string' && tur.returnCodeInterpretation;
          runs.push({ text: u.text, at: u.at, cwd: u.cwd && u.cwd === cwd ? u.cwd : null, by: 'claude', exit: code ? Number(code[1]) : unsure ? null : 0 });
        }
      }
      if (!e.isMeta) {
        const t = typeof c === 'string' ? c : '';
        const u = pending.get(BASH_MODE);
        pending.delete(BASH_MODE); // whatever this record is, it ends the wait for an earlier `! cmd`'s output
        const m = t.match(/^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/);
        if (m) {
          const text = Number.isFinite(at) ? keepText(m[1]) : null;
          if (text !== null) pending.set(BASH_MODE, { text, at, cwd: keepText(cwd) });
          continue;
        }
        // Its output: the bash-mode command finished (in the folder it started in, the same rule as a Bash call).
        if (u && /^\s*<bash-(stdout|stderr)>/.test(t) && !/moved to the background \(ID:/.test(t)) {
          // The record's own trailing stderr block, never one quoted inside the output.
          const tail = t.trimEnd();
          const so = tail.endsWith('</bash-stderr>') ? tail.lastIndexOf('<bash-stderr>') : -1;
          const se = so >= 0 ? [null, tail.slice(so + 13, -14)] : null;
          const errLine = se ? se[1].replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim().split('\n')[0].slice(0, 200) : '';
          runs.push({ text: u.text, at: u.at, cwd: u.cwd && u.cwd === cwd ? u.cwd : null, by: 'you', exit: null, err: errLine ? keepText(errLine) : null });
        }
      }
      continue;
    }
    if (e.type !== 'assistant' || !Array.isArray(c) || !Number.isFinite(at)) continue;
    for (const b of c) {
      if (b?.type !== 'tool_use' || b.name !== 'Bash' || typeof b.id !== 'string' || typeof b.input?.command !== 'string') continue;
      if (b.input.run_in_background === true) continue;
      const text = keepText(b.input.command);
      if (text === null) continue;
      pending.set(keepText(b.id), { text, at, cwd: keepText(cwd) });
      if (pending.size > 500) pending.delete(pending.keys().next().value);
    }
  }
  return runs;
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
    // A full path: a project .env may put its own `rm` first on PATH. Without -f, as a claim: if the file is already
    // gone, the Mac gave up on this run (a phone Run whose profile never finished takes it first, by rename), and
    // nothing runs. One rename and one unlink of the same file, so exactly one side wins (Codex phone tasks round 8).
    `/bin/rm -- "$0" 2>/dev/null || { ${dropCmd}; exit 0; }`,
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
