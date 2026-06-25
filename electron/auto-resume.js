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

import { getAutoResume, getSessionTabMap } from './config-manager.js';
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

  // Wait for windows + terminals to fully mount. ProjectView's initTabs
  // dispatches createTerminal calls during this window.
  await new Promise((r) => setTimeout(r, startupDelayMs));

  const tabMap = getSessionTabMap() || {};
  // Invert: tabId -> { sessionId, projectPath, capturedAt }
  // If a tab has multiple historical sessions (the captured map can stack
  // over time), prefer the most recently captured one.
  const tabToBest = new Map();
  for (const [sid, entry] of Object.entries(tabMap)) {
    if (!entry?.tabId || !entry?.projectPath) continue;
    const prev = tabToBest.get(entry.tabId);
    if (!prev || (entry.capturedAt || 0) > (prev.capturedAt || 0)) {
      tabToBest.set(entry.tabId, {
        sessionId: sid,
        projectPath: entry.projectPath,
        capturedAt: entry.capturedAt || 0,
      });
    }
  }

  // Filter to tabs that are actually alive in the new launch.
  const live = listTerminals();
  const liveIds = new Set(live.map((t) => t.id));
  const candidates = [];
  for (const [tabId, info] of tabToBest) {
    if (!liveIds.has(tabId)) continue;
    candidates.push({ tabId, ...info });
  }

  if (candidates.length === 0) {
    console.log('[auto-resume] no live tabs with mapped sessions, nothing to do');
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
