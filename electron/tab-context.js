// Resolve the Claude session running in a terminal tab and estimate its context
// usage. Extracted from the data:estimateContextForTab IPC handler (v1.0.40) so
// BOTH that handler and the mobile board (v1.0.43 Phase 3b) share one
// implementation with the same stale-link safeguards. Main-process only.

import { getTerminalClaudeInfo, getTerminalCwd, listTerminals } from './terminal-manager.js';
import { getSessionTabMap } from './config-manager.js';
import { estimateContextForSession, sessionTranscriptBirth } from './data-service.js';
import { presenceOf } from './claude-presence.js';
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
// opts.strict: a failed process check throws (the board must not read it as "that session runs nowhere").
export async function resolveSessionForTab(tabId, opts = {}) {
  if (!tabId || typeof tabId !== 'string') return null;
  const info = await getTerminalClaudeInfo(tabId, { strict: opts.strict === true, thorough: opts.thorough === true });
  if (!info) return null; // no claude running here
  const map = getSessionTabMap() || {};

  // A `--resume` tab names its session in argv (read live). A fresh `claude`
  // has no argv id; fall back to the newest ACTIVELY-RUNNING map link.
  let sessionId = info.sessionId;
  let sessionProject;
  let sessionFromRecord = null;
  // Two children in the shell and none named by argv: which claude is in use
  // cannot be told, so no session is named at all (neither the record nor a
  // saved link may speak for it).
  // strict (the board): that is not known, which is not the same as "no session here".
  if (!sessionId && info.soleChild === false) {
    if (opts.strict === true) throw new Error('two programs in that shell: which Claude is in use cannot be told');
    return null;
  }
  // After a /clear the argv still names the session it resumed, but Claude's own record for this process has moved on:
  // the record wins when it names another session (same rule as Tasks > Commands).
  if (sessionId) {
    const moved = await recordSession(tabId, info, { evenEmpty: true });
    // Moved to a session with nothing said yet: no conversation to name (never the cleared one).
    if (moved?.empty && moved.sessionId !== sessionId) return null;
    if (moved && moved.sessionId !== sessionId) return { sessionId: moved.sessionId, sessionProject: moved.sessionProject, pid: info.pid, startedAt: info.startedAt ?? null, startFt: info.startFt ?? null };
  }
  if (sessionId) {
    // The transcript lives under the SESSION's project, not necessarily the
    // tab's live cwd (a same-project resume from a subdir keeps it under the
    // original project). Prefer the mapped project, fall back to cwd. Only
    // a link to THIS tab counts: the same id can exist under two projects,
    // and another tab's link would name the other project's transcript.
    const link = map[sessionId];
    sessionProject = link?.tabId === tabId ? (link.projectPath || null) : null;
  } else if ((sessionFromRecord = await recordSession(tabId, info, { evenEmpty: true }))) {
    // Its record names a session with nothing said yet (a /clear just now): no session, never an older saved link to
    // another one. A link to that same session is kept (its transcript may just have been unreadable for a moment).
    if (sessionFromRecord.empty) {
      const link = map[sessionFromRecord.sessionId];
      const ran = link?.lastRunningAt || 0;
      const now = Date.now();
      const linked = link?.tabId === tabId && ran > 0 && now - ran <= RECENT_MS && ran <= now + FUTURE_SLACK_MS
        && !(info.startedAt && ran < info.startedAt + 1000);
      return linked ? { sessionId: sessionFromRecord.sessionId, sessionProject: link.projectPath || null, pid: info.pid, startedAt: info.startedAt ?? null, startFt: info.startFt ?? null } : null;
    }
    // Claude's own record for THIS process names the session exactly (and
    // follows /clear), and its transcript was found where the record says.
    ({ sessionId, sessionProject } = sessionFromRecord);
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
  return { sessionId, sessionProject, pid: info.pid, startedAt: info.startedAt ?? null, startFt: info.startFt ?? null };
}

/**
 * The session a tab's fresh `claude` is on, from Claude's own record
 * (<configDir>/sessions/<pid>.json, claude-presence.js), when that session's
 * transcript exists under the directory the record names (or the tab's). The
 * 15s link scan used to be the only way a bare `claude` got linked, so a
 * session it could not place (Claude's cwd differing from the shell's) left
 * the Chat view on "starting up" for good (Bryan, Asana 1220098108555131).
 * @returns {Promise<{sessionId:string, sessionProject:string}|null>}
 */
async function recordSession(tabId, info, { evenEmpty = false } = {}) {
  // With other children in the shell the record may not be the claude in use
  // (one of two, one suspended): the scan's rule, so a name only, never here.
  if (info.soleChild === false) return null;
  const terminals = listTerminals();
  const configDir = terminals.find((t) => t.id === tabId)?.claudeConfigDir ?? null;
  const rec = await presenceOf(info, configDir);
  if (!rec?.sessionId) return null;
  // One session, one tab: a session another LIVE tab is linked to stays its.
  const link = (getSessionTabMap() || {})[rec.sessionId];
  if (link?.tabId && link.tabId !== tabId && terminals.some((t) => t.id === link.tabId)) return null;
  for (const dir of [rec.cwd, await getTerminalCwd(tabId)]) {
    if (dir && await sessionTranscriptBirth(dir, rec.sessionId)) return { sessionId: rec.sessionId, sessionProject: dir };
  }
  // No transcript yet: nothing said in this session.
  return evenEmpty ? { sessionId: rec.sessionId, sessionProject: null, empty: true } : null;
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
