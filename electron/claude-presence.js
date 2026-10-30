// Is a Claude session whose turn has ENDED still running background work?
// Feeds the sidebar's "Waiting" label (Brett: "an agent running in the
// background ... a Codex review or a PR check it launched").
//
// The signal is Claude Code's own presence file, `<configDir>/sessions/<pid>.json`,
// which the CLI rewrites whenever its session state changes (verified in the
// 2.1.314 binary, the writer that also feeds `claude agents`):
//   - 'busy'    a turn is loading OR delegated work runs (a local/remote agent,
//               a teammate, a workflow), so it STAYS busy after the turn ends
//               while a background agent is still going
//   - 'shell'   idle, but a background shell (run_in_background Bash) is live
//   - 'waiting' a dialog waits for the user; 'idle' nothing at all
// No screen scraping and no new hook: a structured state the CLI maintains.
//
// Trust rules, because a wrong "Waiting" is worse than none:
//   - the file must name THIS process: same pid AND the same `procStart` as
//     `ps lstart` reports for it (a stale file from a crashed run or a reused
//     pid is ignored)
//   - the caller only asks after the HOOK says the turn ended, and only once
//     GRACE_MS has passed, so the CLI's own busy -> idle rewrite at the end of
//     a plain turn is never read as background work (accepted residual: a
//     rewrite stalled past the grace shows Waiting until the next read, at
//     most CACHE_MS later)
//   - the claude process must have been running when that turn ended: a
//     later claude in the same shell (hooks off, say) never inherits it
// Accepted residual: two claudes taking turns in ONE shell through job control
// (one suspended with Ctrl+Z mid-turn, another run and exited) leave a busy
// file that cannot be told apart from delegated work; the label may say
// Waiting for the suspended one. Two claudes alive together answer nothing.
// Accepted residual: the config dir is parsed from the process environment
// with the same rules as the account scan, so a CLAUDE_CONFIG_DIR=... string
// embedded in ANOTHER variable's value, naming a directory that holds a planted
// file with this exact pid and start time, could show a wrong "Waiting". That
// needs control of the user's own environment and files, and the cost is one
// label.
//   - any failure (no claude, binding unreadable, file missing or malformed,
//     a format this CLI does not write) answers null: the label falls back to
//     today's display.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const GRACE_MS = 3000;
const CACHE_MS = 4000;          // several windows poll the same tabs
const MAX_FILE_BYTES = 64 * 1024;

/**
 * Pure: what background work a presence record proves for this process.
 * @param {unknown} rec  parsed `<pid>.json`
 * @param {{pid:number, startedAt:number|null}} proc  from ps (lstart, ms)
 * @returns {'shells'|'agents'|null}
 */
export function backgroundFromPresence(rec, proc) {
  const m = matchPresence(rec, proc);
  if (m?.status === 'shell') return 'shells';
  if (m?.status === 'busy') return 'agents';
  return null;
}

/**
 * Pure: the presence record, if it is THIS process's: same pid and the same
 * `procStart` as ps reports (both are `ps lstart` text, "Tue Oct 27 13:39:54
 * 2026", so an exact match is expected; anything else is another process's).
 * @returns {{pid:number, startedAt:number, status:string, statusUpdatedAt:number|null}|null}
 */
export function matchPresence(rec, proc) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (!proc || !Number.isInteger(proc.pid) || rec.pid !== proc.pid) return null;
  if (typeof rec.procStart !== 'string' || !Number.isFinite(proc.startedAt)) return null;
  if (Date.parse(rec.procStart) !== proc.startedAt) return null;
  if (typeof rec.status !== 'string') return null;
  return {
    pid: proc.pid,
    startedAt: proc.startedAt,
    status: rec.status,
    statusUpdatedAt: Number.isFinite(rec.statusUpdatedAt) ? rec.statusUpdatedAt : null,
  };
}

/**
 * Pure: what a matched presence record says about a tab's hook record.
 *   - after an ended turn: 'shell' is background shells; 'busy' written
 *     BEFORE the turn ended is delegated work still running; anything written
 *     AFTER it (busy, a dialog) is a newer turn the hook never reported (a
 *     claude without hooks), so the row cannot claim the old Done: uncertain
 *   - during a hook 'working' or 'needs': any other state written after the
 *     last marker means it ended without its closing marker (an Esc
 *     interrupt, hooks switched off, a dialog answered): uncertain
 * The process start must precede the ended turn by a full second (ps
 * truncates it down), and the record must come from the claude seen now.
 * @param {object|null} found  matchPresence result
 * @param {{status:string, hookOwned:boolean, turnEndedAt:number, lastMarkerAt?:number}} a
 * @param {{pid:number, startedAt:number}|null} info  the claude in the tab now
 * @returns {{background:'shells'|'agents'|null, uncertain:boolean, over?:boolean, showAs?:'working'|'needs'}}
 *   `over`: the hook's turn ended without its marker (main ends it too).
 *   `showAs`: the turn continues but is in the other state than the hook said.
 */
export function judgePresence(found, a, info, now = Infinity) {
  const none = { background: null, uncertain: false };
  if (!found || !info || found.pid !== info.pid || found.startedAt !== info.startedAt) return none;
  const at = found.statusUpdatedAt;
  // A time from the future (a minute of clock slack) is not evidence.
  if (Number.isFinite(at) && Number.isFinite(now) && at > now + 60_000) return none;
  if ((a.status === 'working' || a.status === 'needs') && a.hookOwned) {
    // Only a state the CLI wrote AFTER the last marker says anything new.
    if (!Number.isFinite(at) || !a.lastMarkerAt || at <= a.lastMarkerAt) return none;
    // Still in the turn, just between the two: a dialog approved goes back to
    // 'busy' (the approved tool runs with no new marker), a dialog the hook
    // has not reported yet is 'waiting'. Show what the CLI says; the turn and
    // its clock continue.
    if (found.status === 'busy') return a.status === 'needs' ? { ...none, showAs: 'working' } : none;
    if (found.status === 'waiting') return a.status === 'working' ? { ...none, showAs: 'needs' } : none;
    // Idle, or a turn that ended with a background shell: the hook's turn is
    // over without its closing marker (hooks switched off, an interrupt). Not
    // before GRACE_MS has passed since the CLI wrote it, which gives a Stop
    // racing behind the presence write time to arrive; and never on a state
    // this CLI is not known to write.
    if (found.status !== 'idle' && found.status !== 'shell') return none;
    if (now - at < GRACE_MS) return none;
    return { background: null, uncertain: true, over: true };
  }
  const end = a.turnEndedAt;
  if (!end || !(found.startedAt + 1000 <= end)) return none;
  if (found.status === 'shell') return { background: 'shells', uncertain: false };
  if (found.status === 'busy' || found.status === 'waiting') {
    if (!Number.isFinite(at)) return none;
    if (at > end) return { background: null, uncertain: true };
    if (found.status === 'busy') return { background: 'agents', uncertain: false };
  }
  return none;
}

/**
 * Pure: check main's turn record against the claude process running in the
 * tab NOW, so a turn left behind by a claude that exited mid-turn (no Stop
 * hook ever came) never shows as live work or lends its start to the next
 * claude. Only removes claims, never adds one.
 * @param {{status:string, hookOwned:boolean, since:number|null, lastTurnMs:number, turnEndedAt:number}} a
 * @param {{pid:number, startedAt:number|null}|null} info  null = no claude in the tab
 */
export function reconcileWithProcess(a, info) {
  const out = { ...a };
  // The shell holds something that may be a claude besides (or instead of)
  // the one we would check against: nothing can be proven either way, so
  // nothing is changed and no live state is claimed.
  if (info?.ambiguous) { out.uncertain = true; return out; }
  if (!info) {
    // The hook says a turn runs but no claude is there to run it. (A claude
    // started through a wrapper is not a direct child and lands here too: it
    // shows its age, which is less than it could, never wrong.)
    // It may also be running unseen (behind a wrapper) right now, so no label
    // at all: not Working, and not an older turn's Done either.
    if (out.hookOwned) Object.assign(out, { status: 'idle', hookOwned: false, since: null, uncertain: true });
    return out;
  }
  if (Number.isFinite(info.startedAt)) {
    // ps truncates the start DOWN, so a start after a time proves this claude
    // was not running then. A hook state whose last marker came before this
    // claude started was left by an earlier one (it died without Stop): it is
    // not this claude's Input or Working.
    // The comparisons allow the truncated second: a claude cannot boot, take a
    // prompt and send a hook marker within one second of starting, so anything
    // inside the second it started in also came before it.
    const before = (t) => t < info.startedAt + 1000;
    // This claude may be working without hooks, so no label at all (not an
    // older turn's Done either).
    if (out.hookOwned && out.lastMarkerAt && before(out.lastMarkerAt)) {
      Object.assign(out, { status: 'idle', hookOwned: false, since: null, uncertain: true });
    }
    // This claude did not run the whole stretch, so its clock is unknown.
    if (out.since && before(out.since)) out.since = null;
    if (out.lastTurnMs && before(out.turnEndedAt - out.lastTurnMs)) out.lastTurnMs = 0;
    // The last turn ended before this claude started and it has sent no hook
    // since: it may be working without hooks, so not that older turn's Done.
    if (!out.hookOwned && out.turnEndedAt && before(out.turnEndedAt)) out.uncertain = true;
  }
  return out;
}

/**
 * Renderer-supplied id list, cut to `cap` BEFORE anything walks it: a sparse
 * array with a huge length is a tiny IPC message that filter() would walk
 * index by index on the main thread. Strings up to 4096 chars only.
 */
export function boundedIds(ids, cap) {
  if (!Array.isArray(ids)) return [];
  // The prototype's slice, never the array's own: an own `slice` property
  // survives IPC serialization, and calling it would throw in main.
  return Array.prototype.slice.call(ids, 0, cap).filter((id) => typeof id === 'string' && id.length <= 4096);
}

// Bound a lookup cache by dropping its oldest SETTLED entry: dropping a
// pending one would let the next ask start a second lookup beside it.
function evictSettled(cache, max = 512) {
  if (cache.size <= max) return;
  for (const [k, v] of cache) {
    if (v.settled) { cache.delete(k); return; }
  }
}

/**
 * Run `fn(id)` for a burst of triggers at most once at a time per id, with one
 * trailing run for everything that arrived meanwhile, and at least
 * `minIntervalMs` between starts. For checks fired from the PTY data path: a
 * chatty tab (or anything printing the status escape) must not fan out into
 * concurrent process scans. `fn` reads current state itself when it runs.
 * Errors go to `onError(id, err)`; nothing is thrown.
 */
export function coalescePerTab(fn, minIntervalMs, { now = Date.now, setTimer = setTimeout, onError } = {}) {
  const state = new Map(); // id -> { running, queued, lastStart, timer }
  const run = (id, st) => {
    st.running = true;
    st.queued = false;
    st.lastStart = now();
    Promise.resolve().then(() => fn(id))
      .catch((err) => { try { onError?.(id, err); } catch { /* a logger must not break the loop */ } })
      .finally(() => {
        st.running = false;
        if (st.queued) schedule(id, st);
        else if (state.size > 1024) sweep();
      });
  };
  // Bound the map by dropping only entries whose interval has passed: an
  // entry deleted early forgets its last start and lets the next trigger
  // through immediately (so a tab could defeat the throttle).
  const sweep = () => {
    const t = now();
    for (const [k, v] of state) {
      if (!v.running && !v.timer && !v.queued && t - v.lastStart >= minIntervalMs) state.delete(k);
    }
  };
  const schedule = (id, st) => {
    if (st.timer) return;
    const wait = Math.max(0, st.lastStart + minIntervalMs - now());
    if (wait === 0) { run(id, st); return; }
    st.timer = setTimer(() => { st.timer = null; run(id, st); }, wait);
  };
  return (id) => {
    let st = state.get(id);
    if (!st) { st = { running: false, queued: false, lastStart: -Infinity, timer: null }; state.set(id, st); }
    if (st.running || st.timer) { st.queued = true; return; }
    schedule(id, st);
  };
}

/**
 * Cache an async per-tab lookup briefly and share the pending call, so several
 * windows polling every few seconds cost one pgrep/ps per tab.
 */
export function cachedPerTab(fn, ttlMs, now = Date.now) {
  const cache = new Map();
  return (id) => {
    const t = now();
    const hit = cache.get(id);
    // A lookup still running is shared however long it takes, so a slow one
    // never has a second started beside it.
    if (hit && (!hit.settled || t - hit.at < ttlMs)) return hit.pending;
    const entry = { at: t, settled: false, pending: null };
    entry.pending = Promise.resolve().then(() => fn(id)).catch(() => null)
      .finally(() => { entry.settled = true; entry.at = now(); });
    cache.set(id, entry);
    evictSettled(cache);
    return entry.pending;
  };
}

/**
 * @param {object} deps
 * @param {(tabId:string)=>Promise<{pid:number,startedAt:number|null}|null>} deps.claudeInfo
 * @param {(pid:number)=>Promise<string|null>} deps.configDirOf
 * @param {(file:string)=>Promise<string>} [deps.readFile]
 * @param {()=>number} [deps.now]
 */
export function createPresenceReader({ claudeInfo, configDirOf, readFile, now = Date.now }) {
  // One open file handle for the checks AND the read, so the file cannot be
  // swapped for a device or a huge file in between. No symlinks, and
  // non-blocking so a FIFO planted there cannot hang a worker thread.
  const read = readFile || (async (file) => {
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
    const fh = await fsp.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error('not a presence file');
      const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new Error('presence file too large');
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      await fh.close();
    }
  });
  // A process keeps its environment for life, so its config dir is cached
  // per pid + start time; bounded by pruning to the processes seen recently.
  const dirByProc = new Map();
  const cache = new Map(); // tabId -> { at, value }

  async function resolve(tabId) {
    const info = await claudeInfo(tabId);
    if (!info || !Number.isInteger(info.pid)) return null;
    const key = `${info.pid}:${info.startedAt}`;
    let dir = dirByProc.get(key);
    if (!dir) {
      dir = await configDirOf(info.pid);
      // Only a proven dir is kept: an unreadable binding may read next time.
      if (dir) dirByProc.set(key, dir);
      if (dirByProc.size > 256) dirByProc.delete(dirByProc.keys().next().value);
    }
    if (!dir) return null;
    let rec;
    try { rec = JSON.parse(await read(path.join(dir, 'sessions', `${info.pid}.json`))); }
    catch { return null; } // CLI without presence files, or mid-rewrite: no claim
    return matchPresence(rec, info);
  }

  /**
   * This tab's claude's presence record (matchPresence), or null. Never
   * throws. One lookup per tab and `key` at a time: concurrent asks (several
   * windows, bursts) share the pending one. An entry is reused only for the
   * SAME key (the turn or marker it was asked about), so an answer read for
   * one turn is never served for the next. Judge it with judgePresence.
   */
  return function presenceForTab(tabId, key) {
    const t = now();
    let hit = cache.get(tabId);
    if (!hit || hit.key !== key || (hit.settled && t - hit.at >= CACHE_MS)) {
      const entry = { at: t, key, settled: false, pending: null };
      entry.pending = resolve(tabId).catch((err) => {
        console.warn('[claude-presence] lookup failed', tabId, err?.message);
        return null;
      }).finally(() => { entry.settled = true; entry.at = now(); });
      hit = entry;
      cache.set(tabId, hit);
      evictSettled(cache);
    }
    return hit.pending;
  };
}

/**
 * Sidebar status for one tab, as main serves it on tabs:activity: the hook
 * status and turn timing checked against the claude in the tab, background
 * work once a turn has ended, and whether a window that owns the PTY has it
 * unread. Dependencies are injected so this is tested without Electron.
 * @param {object} deps
 * @param {{activityFor:Function, distrustTurnStart:Function, distrustLastTurn:Function, abandonTurn:Function, adoptHookState:Function, markHooklessTurn:Function}} deps.status
 * @param {(id:string)=>Promise<object|null>} deps.claudeInfo  cached lookup
 * @param {(id:string)=>Promise<object|null>} [deps.claudeInfoFresh]  uncached, for turn ends
 * @param {(id:string, key:string)=>Promise<object|null>} deps.presenceForTab
 * @param {(id:string)=>boolean} deps.unreadAnywhere
 * @param {()=>number} [deps.now]
 */
export function createTabActivity({ status, claudeInfo, claudeInfoFresh = claudeInfo, presenceForTab, unreadAnywhere, now = Date.now }) {
  /**
   * Check a tab's hook record against the claude running in it and remember
   * what that disproves (terminal-status distrustTurnStart). Returns the
   * claude info (null = none), or undefined when the record has no hook state
   * to check (a plain shell costs nothing).
   */
  async function checkTurnAgainstProcess(id, raw, { fresh = false } = {}) {
    if (!raw.hookOwned && !raw.lastTurnMs && !raw.turnEndedAt) return undefined;
    // At a turn's end the process must be read NOW: a cached identity can be
    // the claude that died just before this turn's claude started.
    let info = await (fresh ? claudeInfoFresh : claudeInfo)(id);
    // An absence is only evidence when read now: a cached "no claude" can
    // predate the claude that just started this turn.
    if (!info && !fresh && raw.hookOwned && raw.since) info = await claudeInfoFresh(id);
    const a = reconcileWithProcess(raw, info);
    // A claude's start time proves a time wrong. Finding NO claude proves a
    // still-running turn was abandoned (or runs behind a wrapper, where an
    // unknown length is the safe answer), but nothing about a turn that ended
    // meanwhile: claude exiting normally after it is not evidence.
    if (raw.since && !a.since) status.distrustTurnStart(id, raw.since, { runningOnly: !info });
    if (info && raw.lastTurnMs && !a.lastTurnMs) status.distrustLastTurn(id, raw.turnEndedAt);
    return info;
  }

  // The hook record a lookup was based on has moved on (a marker arrived
  // while it awaited): its answer may describe another moment.
  const moved = (id, raw) => {
    const now2 = status.activityFor(id);
    return !now2 || now2.turnEndedAt !== raw.turnEndedAt || now2.lastMarkerAt !== raw.lastMarkerAt
      || now2.status !== raw.status || now2.hookOwned !== raw.hookOwned;
  };
  const shape = (id, a, extra) => ({
    id,
    activity: { ...a, background: null, ...(a.hooklessTurn ? { uncertain: true } : {}), ...extra },
    unread: unreadAnywhere(id),
  });
  // Answer from the CURRENT record without a presence read.
  const settleOnCurrent = async (id) => {
    // The process read awaits too, so re-check after it; a few rounds, then
    // the record as it stands with no process claim beyond it.
    for (let i = 0; i < 3; i += 1) {
      const cur = status.activityFor(id);
      if (!cur) return null;
      const info = await claudeInfo(id);
      if (!moved(id, cur)) return shape(id, reconcileWithProcess(cur, info));
    }
    const cur = status.activityFor(id);
    return cur ? shape(id, cur, { uncertain: true }) : null;
  };

  /** Null when no PTY runs for the id (a closed tab shows its age). */
  async function tabActivity(id) {
    const raw = status.activityFor(id);
    if (!raw) return null;
    const info = await checkTurnAgainstProcess(id, raw);
    if (moved(id, raw)) return settleOnCurrent(id);
    const a = info === undefined ? raw : reconcileWithProcess(raw, info);
    const t = now();
    const hookWorking = a.status === 'working' && a.hookOwned;
    const hookLive = (hookWorking || a.status === 'needs') && a.hookOwned;
    // Ask the presence file only with a claude in the tab (a cached answer
    // describes a process, and with none there is nothing to describe):
    //   - after the HOOK ended a turn, for Waiting (or a newer hookless turn);
    //     plain output after the turn (typing at the prompt) still asks
    //   - during a hook 'working' or 'needs' gone quiet, whether it moved on
    //     without a marker
    const ended = !!info && a.turnEndedAt && !hookLive && !a.hooklessTurn
      && t - a.turnEndedAt >= GRACE_MS;
    const quietWorking = !!info && hookLive && a.lastMarkerAt && t - a.lastMarkerAt >= GRACE_MS;
    if (!ended && !quietWorking) return shape(id, a);
    const found = await presenceForTab(id, ended ? `e:${a.turnEndedAt}` : `w:${a.lastMarkerAt}`);
    if (moved(id, raw)) return settleOnCurrent(id);
    const j = judgePresence(found, a, info, t);
    if (j.showAs) {
      // Kept in the record, so losing the presence signal later cannot bring
      // back the state it disproved (an approved dialog as Input again).
      status.adoptHookState(id, a.lastMarkerAt, j.showAs);
      return shape(id, { ...a, status: j.showAs });
    }
    if (j.uncertain) {
      // Kept in the record too, so a later failed read cannot revive what this
      // one disproved: a hook turn that ended without its marker is ended
      // there; a hookless turn after an ended one hides that turn's Done.
      if (j.over) status.abandonTurn(id, a.lastMarkerAt);
      else if (ended) status.markHooklessTurn(id, a.turnEndedAt);
      return shape(id, a, { uncertain: true });
    }
    return shape(id, a, { background: j.background });
  }

  return { tabActivity, checkTurnAgainstProcess };
}
