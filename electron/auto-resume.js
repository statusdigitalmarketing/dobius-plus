/**
 * auto-resume.js, v1.0.30.
 *
 * On app launch, after every project window has restored and its tabs have
 * been recreated, walk every live terminal and re-engage the Claude session
 * that was running in it at quit time. Staggered so 14 PTYs don't spawn
 * `claude --resume <id>` simultaneously and overwhelm the API / SSD / Mac.
 *
 * Data sources:
 *   - sessionTabMap (config) records every {sessionId -> tabId, projectPath}
 *     link, captured by store.resumeSession AND by setupSessionTabCapture's
 *     15s background scan in main.js. So a tab the user resumed once gets
 *     its mapping persisted across quit.
 *   - listTerminals() (terminal-manager) reports which PTYs are alive in
 *     the new launch.
 *   - getSessionSize(sessionId, projectPath) (data-service) probes both
 *     encoder forms of the project dir and stats the transcript file.
 *
 * Per-tab status flows on the existing tabStatus channel:
 *   'queued'  -> dot is purple, scheduled but not yet sent
 *   'working' -> set when the `claude --resume` write fires
 *   The 'done' / 'needs' transitions are owned by the OSC hook in
 *   useTabActivity once Claude responds, so we don't push them here.
 *
 * Cancellation:
 *   - Per-tab: cancelTabIfPending(tabId) called from terminal:write IPC
 *     when the user types BEFORE the scheduled write fires.
 *   - Global: cancelAll() called from a Cmd+Shift+R IPC.
 *   - Window close: caller invokes cancelTabsForProject(projectPath).
 */

import { getAutoResume, getSessionTabMap, loadConfig } from './config-manager.js';
import { listTerminals, writeTerminal } from './terminal-manager.js';
import { getSessionSize } from './data-service.js';
import { BrowserWindow } from 'electron';

// Per-tab queue entry: tabId -> { sessionId, projectPath, timer }
// `timer` is the setTimeout handle so we can cancel before it fires.
const queue = new Map();
let started = false;

/**
 * Push a tabStatus update to every open window so the dot reflects the
 * current state. Renderer Zustand store reacts to 'tab:status' on the
 * existing channel (see useTabActivity's setTabStatus path).
 */
function broadcastStatus(tabId, status) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('tab:status', { tabId, status });
  }
}

/**
 * Build a shell-safe `cd '<project>' && claude --resume <id>\r` command.
 * Single-quote escape the project path; abort if the path or sessionId
 * smell wrong. Matches the shape the renderer's store.resumeSession uses.
 */
function buildResumeCommand(projectPath, sessionId) {
  if (!projectPath || !projectPath.startsWith('/')) return null;
  if (/[\x00-\x1F\x7F]/.test(projectPath)) return null;
  if (!sessionId || !/^[a-zA-Z0-9][\w-]*$/.test(sessionId)) return null;
  const safeProject = projectPath.replace(/'/g, "'\\''");
  return `cd '${safeProject}' && claude --resume ${sessionId}\r`;
}

/**
 * Entry point. Wait `startupDelayMs` so windows have fully mounted and
 * the renderer's terminal mounts have settled, then resolve every live
 * tab's prior session and schedule a staggered write for each.
 * Idempotent: only runs once per app launch.
 */
export async function startAutoResume({ startupDelayMs = 1500 } = {}) {
  if (started) return;
  started = true;

  const cfg = getAutoResume();
  if (!cfg.enabled) {
    console.log('[auto-resume] disabled in config, skipping');
    return;
  }

  // Build the target tabId -> best-session map ONCE upfront (sessionTabMap
  // is stable across the poll window since we haven't started resuming yet).
  //
  // FRESHNESS GATE (v1.0.35): only links whose session was ACTUALLY RUNNING
  // at last quit are eligible. Tab ids are deterministic per-project counters
  // (`term-<path>-1` is always tab 1), so after a restart a fresh tab matches
  // ANY link ever captured for that slot, up to the map's 30-day retention.
  // Without this gate, 19-28 day old sessions were auto-resumed into Sam's
  // tabs ("random ass shit popped up that I was not just using").
  //   - entry.lastRunningAt must exist (links from before v1.0.35 have none
  //     and are skipped outright), AND
  //   - it must fall within RUNNING_AT_QUIT_SLACK_MS of lastQuitAt. The
  //     Tier-2 capture stamps it every 15s while the session runs, so a
  //     session live at quit reads within ~15s + one save debounce of
  //     lastQuitAt. 20 minutes of slack also covers a crash (no lastQuitAt
  //     write) followed by a quick relaunch.
  //   - the tab id must actually belong to the entry's project
  //     (`term-<projectPath>-<n>`), so a cross-project stale link can never
  //     type a resume into the wrong project's tab.
  const RUNNING_AT_QUIT_SLACK_MS = 20 * 60 * 1000;
  const cfgAll = loadConfig();
  const lastQuitAt = typeof cfgAll.lastQuitAt === 'number' ? cfgAll.lastQuitAt : 0;
  const now = Date.now();
  const tabMap = getSessionTabMap() || {};
  const tabToBest = new Map();
  let skippedStale = 0;
  for (const [sid, entry] of Object.entries(tabMap)) {
    if (!entry?.tabId || !entry?.projectPath) continue;
    // Shape sanity only (term-/abs/path-N). Do NOT require the tab's project
    // to equal entry.projectPath: a supported flow is resuming a project-A
    // session from a tab living in project B's window (store.resumeSession
    // cd's to A first), and that link legitimately has tabId=term-B-N with
    // projectPath=A. The freshness gate below is the real staleness guard.
    // Codex v1.0.35 r2 P2.
    if (!/^term-\/.+-\d+$/.test(entry.tabId)) { skippedStale += 1; continue; }
    const ranAt = typeof entry.lastRunningAt === 'number' ? entry.lastRunningAt : 0;
    // Fresh if the session was running near the last CLEAN quit, OR near
    // "now" (covers a crash: lastQuitAt is stale from an older clean quit,
    // but the Tier-2 stamp kept updating until the crash, so a quick
    // relaunch still sees a recent lastRunningAt). Codex v1.0.35 r1 P2.
    const freshVsQuit = lastQuitAt > 0 && Math.abs(lastQuitAt - ranAt) <= RUNNING_AT_QUIT_SLACK_MS;
    const freshVsNow = (now - ranAt) <= RUNNING_AT_QUIT_SLACK_MS;
    if (!ranAt || (!freshVsQuit && !freshVsNow)) {
      skippedStale += 1;
      continue;
    }
    const prev = tabToBest.get(entry.tabId);
    if (!prev || ranAt > prev.lastRunningAt) {
      tabToBest.set(entry.tabId, {
        sessionId: sid,
        projectPath: entry.projectPath,
        capturedAt: entry.capturedAt || 0,
        lastRunningAt: ranAt,
      });
    }
  }
  if (skippedStale > 0) {
    console.log(`[auto-resume] skipped ${skippedStale} stale/mismatched link(s); ${tabToBest.size} fresh candidate(s)`);
  }
  if (tabToBest.size === 0) {
    console.log('[auto-resume] no sessions were running at last quit, nothing to resume');
    return;
  }

  // Poll for terminals: with many restored project windows / slow PTY init,
  // a single fixed delay can miss late-mounting tabs and permanently skip
  // their resume. Retry until either we see EVERY mapped tab alive, we hit
  // a stable count (no new mounts for one full interval), or we exhaust
  // the total budget. Codex v1.0.33 P2.
  const POLL_INTERVAL_MS = Math.max(500, startupDelayMs);
  const TOTAL_BUDGET_MS = 15_000;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let candidates = [];
  let lastCount = -1;
  let stableTicks = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const live = listTerminals();
    const liveIds = new Set(live.map((t) => t.id));
    candidates = [];
    for (const [tabId, info] of tabToBest) {
      if (liveIds.has(tabId)) candidates.push({ tabId, ...info });
    }
    // Done: every mapped tab is now alive.
    if (candidates.length === tabToBest.size) break;
    // Stable: count hasn't changed for 2 ticks, no more late mounts expected.
    if (candidates.length === lastCount) {
      stableTicks += 1;
      if (stableTicks >= 2 && candidates.length > 0) break;
    } else {
      stableTicks = 0;
      lastCount = candidates.length;
    }
  }

  if (candidates.length === 0) {
    console.log('[auto-resume] no live tabs with mapped sessions after 15s budget, nothing to do');
    return;
  }

  // Validate each: transcript must exist and be under size cap.
  const eligible = [];
  for (const c of candidates) {
    const sizeMB = await getSessionSize(c.sessionId, c.projectPath);
    if (sizeMB == null) {
      console.log(`[auto-resume] skip ${c.tabId}: transcript not found for ${c.sessionId}`);
      continue;
    }
    if (sizeMB > cfg.skipOversizedMB) {
      console.log(`[auto-resume] skip ${c.tabId}: transcript ${sizeMB.toFixed(0)}MB > ${cfg.skipOversizedMB}MB cap`);
      continue;
    }
    eligible.push({ ...c, sizeMB });
  }

  if (eligible.length === 0) {
    console.log('[auto-resume] no eligible sessions after validation');
    return;
  }

  console.log(`[auto-resume] queueing ${eligible.length} session(s) with ${cfg.staggerMs}ms stagger`);

  // Schedule the writes. Each gets a setTimeout with cumulative delay.
  // Mark queued NOW so the user sees the dot immediately, then flip to
  // working when the write fires.
  for (let i = 0; i < eligible.length; i += 1) {
    const e = eligible[i];
    const delayMs = i * cfg.staggerMs;
    broadcastStatus(e.tabId, 'queued');
    const timer = setTimeout(() => {
      queue.delete(e.tabId);
      const cmd = buildResumeCommand(e.projectPath, e.sessionId);
      if (!cmd) {
        console.log(`[auto-resume] ${e.tabId}: command build failed, skipping`);
        broadcastStatus(e.tabId, 'done');
        return;
      }
      try {
        writeTerminal(e.tabId, cmd);
        broadcastStatus(e.tabId, 'working');
      } catch (err) {
        console.warn(`[auto-resume] ${e.tabId}: write failed: ${err.message}`);
        broadcastStatus(e.tabId, 'done');
      }
    }, delayMs);
    queue.set(e.tabId, { sessionId: e.sessionId, projectPath: e.projectPath, timer });
  }
}

/**
 * Cancel a single pending tab. Called by terminal:write IPC when the user
 * types into a tab BEFORE its scheduled resume fires. Clears the queued
 * dot. No-op if the timer already fired or the tab was never queued.
 */
export function cancelTabIfPending(tabId) {
  const entry = queue.get(tabId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  queue.delete(tabId);
  broadcastStatus(tabId, 'done');
  return true;
}

/**
 * Cancel every tab belonging to a given project (called when a project
 * window is closed before its queue has drained).
 */
export function cancelTabsForProject(projectPath) {
  if (!projectPath) return 0;
  let cancelled = 0;
  for (const [tabId, entry] of queue) {
    if (entry.projectPath === projectPath) {
      clearTimeout(entry.timer);
      queue.delete(tabId);
      broadcastStatus(tabId, 'done');
      cancelled += 1;
    }
  }
  return cancelled;
}

/**
 * Cancel the entire queue. Called by Cmd+Shift+R from any window.
 */
export function cancelAll() {
  let cancelled = 0;
  for (const [tabId, entry] of queue) {
    clearTimeout(entry.timer);
    broadcastStatus(tabId, 'done');
    cancelled += 1;
  }
  queue.clear();
  return cancelled;
}

/**
 * Renderer probe: returns true iff the tab currently has a pending
 * scheduled resume. Used by the Settings UI for diagnostic display.
 */
export function isTabPending(tabId) {
  return queue.has(tabId);
}

/**
 * Total pending count, for diagnostics.
 */
export function pendingCount() {
  return queue.size;
}
