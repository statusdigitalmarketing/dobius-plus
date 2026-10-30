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
//   - any failure (no claude, binding unreadable, file missing or malformed,
//     a format this CLI does not write) answers null: the label falls back to
//     today's display.

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
 * @param {object} deps
 * @param {(tabId:string)=>Promise<{pid:number,startedAt:number|null}|null>} deps.claudeInfo
 * @param {(pid:number)=>Promise<string|null>} deps.configDirOf
 * @param {(file:string)=>Promise<string>} [deps.readFile]
 * @param {()=>number} [deps.now]
 */
export function createPresenceReader({ claudeInfo, configDirOf, readFile, now = Date.now }) {
  const read = readFile || (async (file) => {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error('not a presence file');
    return fsp.readFile(file, 'utf8');
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
    return backgroundFromPresence(rec, info);
  }

  /** Background work in this tab's Claude, or null. Never throws. */
  return async function backgroundForTab(tabId) {
    const t = now();
    const hit = cache.get(tabId);
    if (hit && t - hit.at < CACHE_MS) return hit.value;
    let value = null;
    try { value = await resolve(tabId); }
    catch (err) { console.warn('[claude-presence] lookup failed', tabId, err?.message); }
    cache.set(tabId, { at: t, value });
    if (cache.size > 512) cache.delete(cache.keys().next().value);
    return value;
  };
}
