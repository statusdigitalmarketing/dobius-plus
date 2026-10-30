// "Waiting" in the Tabs sidebar: Claude's turn is over (the hook said 'done')
// but work it started is still running in the background (Brett: "a Codex
// review or a PR check it launched").
//
// The signal is Claude Code's own presence file, `<configDir>/sessions/<pid>.json`,
// which the CLI rewrites whenever its session state changes (verified in the
// 2.1.314 binary, the same file `claude agents` reads):
//   - 'shell'   idle, with a background shell (run_in_background Bash) live
//   - 'busy'    a turn is loading OR delegated work runs (an agent, a
//               teammate, a workflow); it stays busy after the turn ends while
//               a background agent is still going
//   - 'waiting' a dialog is open; 'idle' nothing at all
//
// It fails closed: Waiting is shown only when every check passes, otherwise
// the row shows Done or its age. Never a guess:
//   - one claude in the tab's shell (two answer nothing), and the file must
//     name that process: same pid AND the same start time as ps reports
//   - that claude was already running when the turn ended (ps truncates its
//     start to the second, hence the full second)
//   - GRACE_MS has passed since the hook's 'done', so the CLI's own busy ->
//     idle rewrite at the end of a plain turn is never read as background work
//   - a 'busy' must have been written GRACE_MS before the 'done' arrived (a
//     busy written later is a new turn the hook did not report, or cannot be
//     placed against a Stop that reached us late)
// Accepted residuals: a claude run through a wrapper (not a direct child of
// the shell), or a config dir changed inside the shell, simply never shows
// Waiting.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const GRACE_MS = 3000;
const CACHE_MS = 4000; // several windows poll the same tabs
const MAX_FILE_BYTES = 64 * 1024;

/**
 * Pure: what background work a presence record proves for a turn that ended.
 * @param {unknown} rec  parsed `<pid>.json`
 * @param {{pid:number, startedAt:number|null}|null} proc  the tab's claude (ps)
 * @param {number} doneAt  when the hook's 'done' arrived
 * @param {number} now
 * @returns {'shells'|'agents'|null}
 */
export function waitingFrom(rec, proc, doneAt, now) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (!proc || !Number.isInteger(proc.pid) || rec.pid !== proc.pid) return null;
  if (typeof rec.procStart !== 'string' || !Number.isFinite(proc.startedAt)) return null;
  // Both sides are `ps lstart` text ("Tue Oct 27 13:39:54 2026").
  if (Date.parse(rec.procStart) !== proc.startedAt) return null;
  if (!(doneAt > 0) || proc.startedAt + 1000 > doneAt || now - doneAt < GRACE_MS) return null;
  if (rec.status === 'shell') return 'shells';
  if (rec.status === 'busy' && Number.isFinite(rec.statusUpdatedAt) && rec.statusUpdatedAt <= doneAt - GRACE_MS) {
    return 'agents';
  }
  return null;
}

/** Read a presence file through one handle: no symlinks, size capped. */
async function readPresenceFile(file) {
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
}

/**
 * Background work for a tab whose hook status is 'done', or null. One lookup
 * per tab in flight (concurrent asks share it), answers cached CACHE_MS and
 * only for the same 'done'. Never throws.
 * @param {object} deps
 * @param {(tabId:string)=>Promise<{pid:number,startedAt:number|null}|null>} deps.claudeInfo
 *   the ONE claude in the tab's shell, or null
 * @param {(tabId:string)=>string|null} deps.configDirFor  the tab's CLAUDE_CONFIG_DIR, null = default
 * @param {(file:string)=>Promise<string>} [deps.readFile]
 * @param {()=>number} [deps.now]
 */
export function createWaitingReader({ claudeInfo, configDirFor, readFile = readPresenceFile, now = Date.now }) {
  const cache = new Map(); // tabId -> { at, doneAt, pending }

  async function lookup(tabId, doneAt) {
    // Sample only after the grace: the CLI's busy -> idle rewrite at the end
    // of a plain turn must already be on disk when the file is read.
    const sampledAt = now();
    if (sampledAt - doneAt < GRACE_MS) return null;
    const info = await claudeInfo(tabId);
    if (!info || !Number.isInteger(info.pid)) return null;
    const dir = configDirFor(tabId) || path.join(os.homedir(), '.claude');
    // A relative dir is resolved by the CLI against its own cwd, which is not
    // known here: no claim.
    if (!path.isAbsolute(dir)) return null;
    let rec;
    try { rec = JSON.parse(await readFile(path.join(dir, 'sessions', `${info.pid}.json`))); }
    catch { return null; } // no presence file, or mid-rewrite: no claim
    return waitingFrom(rec, info, doneAt, sampledAt);
  }

  return function waitingForTab(tabId, doneAt) {
    const t = now();
    const hit = cache.get(tabId);
    if (hit && hit.doneAt === doneAt && (!hit.settled || t - hit.at < CACHE_MS)) return hit.pending;
    const entry = { at: t, doneAt, settled: false, pending: null };
    entry.pending = lookup(tabId, doneAt)
      .catch((err) => { console.warn('[claude-presence] lookup failed', tabId, err?.message); return null; })
      .finally(() => { entry.settled = true; entry.at = now(); });
    cache.set(tabId, entry);
    if (cache.size > 512) {
      for (const [k, v] of cache) { if (v.settled) { cache.delete(k); break; } }
    }
    return entry.pending;
  };
}

/**
 * One tabs:activity row: main's status and stretch timing, Waiting for a
 * 'done' tab, unread. The Waiting lookup awaits, so the answer is taken from
 * the status as it is AFTER it, and the Waiting is kept only if that same
 * 'done' still stands. Null when no PTY runs for the id.
 */
export async function activityRow(id, { activityFor, waitingForTab, unreadAnywhere }) {
  const before = activityFor(id);
  if (!before) return null;
  let background = before.status === 'done' ? await waitingForTab(id, before.doneAt) : null;
  const activity = activityFor(id);
  if (!activity) return null;
  if (activity.status !== 'done' || activity.doneAt !== before.doneAt) background = null;
  return { id, activity: { ...activity, background }, unread: unreadAnywhere(id) };
}

/**
 * Re-read every row's status once all of a request's rows are in: one row
 * can settle while another's lookup is still pending, and its tab may have
 * moved on meanwhile. Synchronous, so the reply matches the status now.
 */
export function freshenRows(rows, activityFor) {
  const out = [];
  for (const row of rows) {
    if (!row) continue;
    const now = activityFor(row.id);
    if (!now) continue;
    const same = now.status === 'done' && now.doneAt === row.activity.doneAt;
    out.push({ ...row, activity: { ...now, background: same ? row.activity.background : null } });
  }
  return out;
}

/**
 * Renderer-supplied id list, cut to `cap` BEFORE anything walks it (a sparse
 * array with a huge length is a tiny IPC message), using the prototype's slice
 * (own properties survive IPC). Strings up to 4096 chars only.
 */
export function boundedIds(ids, cap) {
  if (!Array.isArray(ids)) return [];
  // A plain indexed loop: slice/filter consult an own `constructor`, which
  // survives IPC and can make them throw.
  const out = [];
  const n = Math.min(ids.length, cap);
  for (let i = 0; i < n; i += 1) {
    const id = ids[i];
    if (typeof id === 'string' && id.length <= 4096) out.push(id);
  }
  return out;
}
