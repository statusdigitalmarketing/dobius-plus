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
//     a plain turn is never read as background work
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
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (!proc || !Number.isInteger(proc.pid) || rec.pid !== proc.pid) return null;
  if (typeof rec.procStart !== 'string' || !Number.isFinite(proc.startedAt)) return null;
  // Both sides are `ps lstart` text ("Tue Oct 27 13:39:54 2026"), so an exact
  // match is expected; anything else is another process's file.
  if (Date.parse(rec.procStart) !== proc.startedAt) return null;
  if (rec.status === 'shell') return 'shells';
  if (rec.status === 'busy') return 'agents';
  return null;
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
  return ids.slice(0, cap).filter((id) => typeof id === 'string' && id.length <= 4096);
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
    const value = backgroundFromPresence(rec, info);
    return value ? { value, pid: info.pid, startedAt: info.startedAt, statusUpdatedAt: rec.statusUpdatedAt } : null;
  }

  /**
   * Background work in this tab's Claude, or null. Never throws.
   * @param {string} tabId
   * @param {{pid:number, startedAt:number}} [expected]  the claude the caller
   *   sees in the tab now; an answer read from any other process is dropped
   * @param {number} turnEndedAt  when the hook ended the turn. The process read
   *   must provably have been running then: ps truncates its start DOWN to the
   *   second, so only a start a full second before the turn ended proves it
   *   (a claude started in that same second may have replaced the one that
   *   finished).
   */
  return function backgroundForTab(tabId, turnEndedAt, expected) {
    const t = now();
    // One lookup per tab and turn at a time: concurrent asks (several windows,
    // bursts) share the pending one instead of each spawning ps. An entry is
    // reused only for the SAME turn, so an answer read while a new turn was
    // running can never be served once that turn has ended.
    let hit = cache.get(tabId);
    if (!hit || hit.turnEndedAt !== turnEndedAt || (hit.settled && t - hit.at >= CACHE_MS)) {
      const entry = { at: t, turnEndedAt, settled: false, pending: null };
      entry.pending = resolve(tabId).catch((err) => {
        console.warn('[claude-presence] lookup failed', tabId, err?.message);
        return null;
      }).finally(() => { entry.settled = true; entry.at = now(); });
      hit = entry;
      cache.set(tabId, hit);
      evictSettled(cache);
    }
    return hit.pending.then((found) => (
      found && Number.isFinite(found.startedAt) && found.startedAt + 1000 <= turnEndedAt
        // A cached answer is only for the claude the caller sees now.
        && (!expected || (found.pid === expected.pid && found.startedAt === expected.startedAt))
        // 'busy' after a turn means delegated work that was ALREADY running:
        // the CLI wrote busy when the turn started and has not changed it
        // since. A busy written after the turn ended is a new foreground turn
        // (one the hook never reported, e.g. a claude without hooks).
        && (found.value !== 'agents' || (Number.isFinite(found.statusUpdatedAt) && found.statusUpdatedAt <= turnEndedAt))
        ? found.value : null
    ));
  };
}

/**
 * Sidebar status for one tab, as main serves it on tabs:activity: the hook
 * status and turn timing checked against the claude in the tab, background
 * work once a turn has ended, and whether a window that owns the PTY has it
 * unread. Dependencies are injected so this is tested without Electron.
 * @param {object} deps
 * @param {{activityFor:Function, distrustTurnStart:Function, distrustLastTurn:Function}} deps.status
 * @param {(id:string)=>Promise<object|null>} deps.claudeInfo  cached lookup
 * @param {(id:string)=>Promise<object|null>} [deps.claudeInfoFresh]  uncached, for turn ends
 * @param {(id:string, turnEndedAt:number)=>Promise<string|null>} deps.backgroundForTab
 * @param {(id:string)=>boolean} deps.unreadAnywhere
 * @param {()=>number} [deps.now]
 */
export function createTabActivity({ status, claudeInfo, claudeInfoFresh = claudeInfo, backgroundForTab, unreadAnywhere, now = Date.now }) {
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
    const info = await (fresh ? claudeInfoFresh : claudeInfo)(id);
    const a = reconcileWithProcess(raw, info);
    // Remembered whatever the status became: a start disproved here stays
    // disproved even when the state was also found stale.
    if (raw.since && !a.since) status.distrustTurnStart(id, raw.since);
    if (raw.lastTurnMs && !a.lastTurnMs) status.distrustLastTurn(id, raw.turnEndedAt);
    return info;
  }

  /** Null when no PTY runs for the id (a closed tab shows its age). */
  async function tabActivity(id) {
    const raw = status.activityFor(id);
    if (!raw) return null;
    const info = await checkTurnAgainstProcess(id, raw);
    const a = info === undefined ? raw : reconcileWithProcess(raw, info);
    let background = null;
    // Only after the HOOK ended a turn, so a session with hooks off (or a
    // plain shell) never gets a Waiting it cannot prove. A hook-owned
    // 'working' is a new turn (Working wins anyway); plain output after the
    // turn (typing at the prompt) still asks. And only while a claude is
    // there: with none, a presence answer cached a moment ago describes a
    // process that is gone.
    if (info && a.turnEndedAt && a.status !== 'needs' && !(a.status === 'working' && a.hookOwned)
        && now() - a.turnEndedAt >= GRACE_MS) {
      background = await backgroundForTab(id, a.turnEndedAt, info);
      // The lookup awaited: if a new turn started (or this one's end changed)
      // meanwhile, the presence file may describe that turn instead.
      const after = status.activityFor(id);
      if (!after || after.turnEndedAt !== a.turnEndedAt || after.status === 'needs'
          || (after.status === 'working' && after.hookOwned)) {
        return after
          ? { id, activity: { ...reconcileWithProcess(after, await claudeInfo(id)), background: null }, unread: unreadAnywhere(id) }
          : null;
      }
    }
    return { id, activity: { ...a, background }, unread: unreadAnywhere(id) };
  }

  return { tabActivity, checkTurnAgainstProcess };
}
