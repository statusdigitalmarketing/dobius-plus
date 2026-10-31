// Buckets the History sidebar's sessions into sections. Pure, so it is tested
// under plain node (electron/__tests__/session-shelves.test.mjs).
//
// Precedence: needs > pinned > working > recent > earlier.
//
// liveSessions comes from main (tabs:liveSessions): for each of this window's
// tabs that main's hook status says is 'needs' or 'working', the session that
// tab is running NOW (argv --resume id, else the freshest running link stamped
// after the process started). Main decides because only it can see process
// start times; a renderer guess credited the PREVIOUS session in a reused tab.
//
// Without a live answer, the on-disk heuristic is trusted only for 'working'
// (Claude spoke in the last 120s). Its 'needs' just means the user spoke
// last, which on an old session is an interrupted turn, not a waiting prompt.

export const RECENT_LIMIT = 15;
export const EARLIER_PAGE = 25;
// Mirrors data-service.js: disk 'working' means Claude wrote within 120s.
// Re-checked here because the cached list is only refreshed on file activity,
// so a finished chat would otherwise stay "working" forever.
export const DISK_WORKING_MS = 120 * 1000;
const FUTURE_SLACK_MS = 60 * 1000;

/**
 * The automatic name a History row shows (a user's own label still wins, in
 * useSessions). The tab the session ran in comes first, as the user named it
 * (Brett: "it should be whatever you actually name the tab"); then Claude's
 * own title, the newest prompt, the project. A bare "Tab N" never reaches
 * tabName (main drops it), so an unnamed tab falls through to the summary.
 */
export function sessionAutoName(s) {
  return s?.tabName || s?.title || s?.preview || s?.projectName || 'Untitled';
}

export function liveStatusBySession(liveSessions) {
  const out = new Map();
  for (const l of liveSessions || []) {
    if (!l?.sessionId || (l.status !== 'needs' && l.status !== 'working')) continue;
    // Two tabs running one session (should not happen): needs wins.
    if (out.get(l.sessionId) !== 'needs') out.set(l.sessionId, l.status);
  }
  return out;
}

export function bucketSessions({
  sessions, pinnedIds = [], liveSessions = [], recentLimit = RECENT_LIMIT, now = Date.now(),
}) {
  const live = liveStatusBySession(liveSessions);
  const pinnedSet = new Set(pinnedIds);
  const out = { needs: [], pinned: [], working: [], recent: [], earlier: [] };
  for (const s of sessions) {
    // A timestamp from the future (clock moved back) is not evidence of work.
    // activityAt is the newest write of any kind (what main judged 'working'
    // by); timestamp is the last MESSAGE, which a long tool call leaves behind.
    const age = now - (Number(s.activityAt ?? s.timestamp) || 0);
    const diskWorking = s.status === 'working' && age >= -FUTURE_SLACK_MS && age < DISK_WORKING_MS;
    const status = live.get(s.sessionId) || (diskWorking ? 'working' : null);
    if (status === 'needs') out.needs.push(s);
    else if (pinnedSet.has(s.sessionId)) out.pinned.push(s);
    else if (status === 'working') out.working.push(s);
    else if (out.recent.length < recentLimit) out.recent.push(s);
    else out.earlier.push(s);
  }
  return out;
}
