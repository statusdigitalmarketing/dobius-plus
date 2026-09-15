// Reverse lookup: the most recently captured Claude session running in a tab.
//
// sessionTabMap is keyed by sessionId -> { tabId, projectPath, capturedAt }.
// The "continue this tab on the switched account" action needs the other
// direction: given a tabId, which session is live in it. A tab can appear
// under several sessionIds over its life (each resume writes a link), so the
// newest capturedAt wins. Pure and shared so both the store and a test use the
// exact same rule.

/**
 * When `expectedProject` is given, only entries whose projectPath matches are
 * considered. Tab ids (`term-<path>-<counter>`) persist and are REUSED across
 * restarts, so a stale entry from a different project under the same id, with a
 * newer capturedAt, would otherwise win and resume the wrong conversation
 * (the same cross-project bleed the Copy-Last-Response path guards against,
 * Codex v1.0.29 MED). Pass the tab's real projectPath to close it.
 *
 * @param {Record<string, {tabId?: string, projectPath?: string, capturedAt?: number}>} map
 * @param {string} tabId
 * @param {string|null} [expectedProject]
 * @returns {{ sessionId: string, projectPath: string|null, capturedAt: number } | null}
 */
export function latestSessionForTab(map, tabId, expectedProject = null) {
  if (!map || typeof map !== 'object' || !tabId) return null;
  let best = null;
  for (const [sessionId, entry] of Object.entries(map)) {
    if (!entry || entry.tabId !== tabId) continue;
    if (expectedProject && entry.projectPath !== expectedProject) continue;
    const capturedAt = typeof entry.capturedAt === 'number' ? entry.capturedAt : 0;
    if (!best || capturedAt > best.capturedAt) {
      best = { sessionId, projectPath: entry.projectPath || null, capturedAt };
    }
  }
  return best;
}
