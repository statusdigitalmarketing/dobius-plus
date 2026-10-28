// Resolve the Claude session running in a terminal tab and estimate its context
// usage. Extracted from the data:estimateContextForTab IPC handler (v1.0.40) so
// BOTH that handler and the mobile board (v1.0.43 Phase 3b) share one
// implementation with the same stale-link safeguards. Main-process only.

import { getTerminalClaudeInfo, getTerminalCwd } from './terminal-manager.js';
import { getSessionTabMap } from './config-manager.js';
import { estimateContextForSession } from './data-service.js';
import { snapshot as terminalStatusSnapshot } from './terminal-status.js';

const RECENT_MS = 90 * 1000;
// A stamp from the future (clock moved back) cannot be told apart from a
// current one, so it is not trusted at all.
const FUTURE_SLACK_MS = 60 * 1000;

/**
 * Which Claude session is running in this tab RIGHT NOW.
 * `pid` and `startedAt` name the claude process the answer was read from, so
 * a caller doing other reads in between can tell whether it is still the same run.
 * @returns {Promise<{sessionId:string, sessionProject:string|null, pid:number, startedAt:number|null} | null>}
 */
export async function resolveSessionForTab(tabId) {
  if (!tabId || typeof tabId !== 'string') return null;
  const info = await getTerminalClaudeInfo(tabId);
  if (!info) return null; // no claude running here
  const map = getSessionTabMap() || {};

  // A `--resume` tab names its session in argv (read live). A fresh `claude`
  // has no argv id; fall back to the newest ACTIVELY-RUNNING map link.
  let sessionId = info.sessionId;
  let sessionProject;
  if (sessionId) {
    // The transcript lives under the SESSION's project, not necessarily the
    // tab's live cwd (a same-project resume from a subdir keeps it under the
    // original project). Prefer the mapped project, fall back to cwd. Only
    // a link to THIS tab counts: the same id can exist under two projects,
    // and another tab's link would name the other project's transcript.
    const link = map[sessionId];
    sessionProject = link?.tabId === tabId ? (link.projectPath || null) : null;
  } else {
    // Only trust a link whose session is currently running, and only if it
    // was stamped at/after this process started (a link stamped earlier
    // belongs to a prior claude in the same recycled tab id). Mirrors the
    // v1.0.40 guards exactly.
    const now = Date.now();
    let best = null;
    for (const [sid, entry] of Object.entries(map)) {
      if (entry?.tabId !== tabId) continue;
      const ran = entry.lastRunningAt || 0;
      if (ran <= 0 || (now - ran) > RECENT_MS || ran > now + FUTURE_SLACK_MS) continue;
      // ps reports start times to the whole second, so a stamp from the
      // previous Claude in the same second as this one started is not proof:
      // require a second of margin (the live session is re-stamped soon).
      if (info.startedAt && ran < info.startedAt + 1000) continue;
      if (!best || ran > best.ran) best = { sid, ran, projectPath: entry.projectPath };
    }
    sessionId = best?.sid || null;
    sessionProject = best?.projectPath || null;
  }
  if (!sessionId) return null;
  return { sessionId, sessionProject, pid: info.pid, startedAt: info.startedAt ?? null };
}

/**
 * For the History sidebar: each of `tabIds` that main's own hook status says
 * is 'needs' or 'working', with the session running in it now. Main's status
 * is window-independent, so a just-torn-off window still sees a waiting tab.
 * Returns an ARRAY (never keyed by caller-supplied ids).
 */
export async function liveSessionsForTabs(tabIds) {
  if (!Array.isArray(tabIds)) return [];
  const live = terminalStatusSnapshot().live || {};
  // Filter to tabs that need resolving BEFORE capping, so idle tabs can never
  // crowd out a waiting one. Resolved in parallel: each is a pgrep + ps.
  const eligible = [...new Set(tabIds)]
    .filter((id) => typeof id === 'string')
    .map((tabId) => ({ tabId, status: live[tabId]?.status }))
    .filter(({ status }) => status === 'needs' || status === 'working')
    .slice(0, 64);
  const resolved = await Promise.all(eligible.map(async ({ tabId, status }) => {
    try {
      const r = await resolveSessionForTab(tabId);
      return r?.sessionId ? { tabId, sessionId: r.sessionId, status } : null;
    } catch (err) {
      console.warn('[tab-context] live session lookup skipped', tabId, err?.message);
      return null;
    }
  }));
  return resolved.filter(Boolean);
}

/**
 * @returns {Promise<{tokens:number, maxTokens:number, model:string} | null>}
 * null when no claude is running in the tab, or its transcript is unresolved.
 */
export async function estimateContextForTabId(tabId) {
  try {
    const resolved = await resolveSessionForTab(tabId);
    if (!resolved) return null;
    const { sessionId, sessionProject } = resolved;

    let result = sessionProject
      ? await estimateContextForSession(sessionId, sessionProject)
      : null;
    if (!result) {
      const cwd = await getTerminalCwd(tabId);
      if (cwd && cwd !== sessionProject) result = await estimateContextForSession(sessionId, cwd);
    }
    return result;
  } catch {
    return null;
  }
}
