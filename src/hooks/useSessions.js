import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { sessionAutoName } from '../lib/session-shelves';

/**
 * Hook for loading and filtering session history.
 *
 * v1.0.26 additions:
 *   - sessionTags fetched + applied: each session gets `displayName` =
 *     user's custom label OR the auto-generated display.
 *   - setLabel / clearLabel actions exposed for inline rename UX.
 *   - projectFilter option: when a `projectPath` is passed in, only sessions
 *     in that project show. Driven by the new sidebar toggle.
 */
// Keep in sync with electron/config-manager.js setSessionTag's label slice.
// Codex flagged the mismatch (renderer 100, main 50) as a UX divergence —
// optimistic UI would show a longer label than the persisted truth.
const MAX_LABEL_LEN = 50;

// Same-window broadcast so the History sidebar, the Sessions page and its tab
// badge agree on settings.showAutomatedSessions. detail: boolean.
export const SHOW_AUTOMATED_EVENT = 'dobius:show-automated-changed';

export function useSessions({ projectFilter = null, excludeAutomated = false } = {}) {
  const [sessions, setSessions] = useState([]);
  const [sessionTabMap, setSessionTabMap] = useState({});
  const [sessionTags, setSessionTags] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Ref tracks the latest sessionTags so optimistic-update callbacks don't
  // close over a stale snapshot — otherwise rapid setLabel calls could
  // overwrite a color a sibling render had just set.
  const tagsRef = useRef({});
  // Apply a reply only if it was asked with the CURRENT options and is not
  // older than the last one applied. A slow reply from before a toggle must
  // not overwrite the toggled list (the Sessions.jsx ordering race).
  const paramsKey = `${projectFilter || ''}|${excludeAutomated ? 1 : 0}`;
  const paramsRef = useRef(paramsKey);
  paramsRef.current = paramsKey;
  const reqIdRef = useRef(0);
  const appliedIdRef = useRef(0);
  const appliedKeyRef = useRef(null);

  const loadSessions = useCallback(async () => {
    if (!window.electronAPI) return;
    const reqId = ++reqIdRef.current;
    const key = `${projectFilter || ''}|${excludeAutomated ? 1 : 0}`;
    const isCurrent = () => key === paramsRef.current && reqId >= appliedIdRef.current;
    // New options: show loading rather than the previous options' rows.
    if (key !== appliedKeyRef.current) setLoading(true);
    try {
      // Use dataLoadAllSessions (reads transcript files directly from
      // ~/.claude/projects/) instead of dataLoadHistory (reads
      // ~/.claude/history.jsonl, which on this Mac is 95% incomplete
      // and 92% full of ghost entries for deleted transcripts).
      // Pass projectFilter to the IPC so the global 500-cap applies AFTER
      // the project filter. Without this, an older project's sidebar on a
      // machine with more than 500 newer sessions in other projects would
      // appear empty. Codex PR#3 r8 P2.
      const [raw, tabMap, tags] = await Promise.all([
        window.electronAPI.dataLoadAllSessions(projectFilter || undefined, { excludeAutomated }),
        window.electronAPI.configGetSessionTabMap?.() ?? {},
        window.electronAPI.configGetSessionTags?.() ?? {},
      ]);
      if (!isCurrent()) return;
      appliedIdRef.current = reqId;
      appliedKeyRef.current = key;
      // dataLoadAllSessions returns { sessionId, projectPath, projectName,
      // preview, timestamp, age, status }. The sidebar consumes the older
      // { sessionId, project, display, timestamp } shape that dataLoadHistory
      // used, so alias the new field names without changing the consumers.
      const data = (raw || []).map((s) => ({
        ...s,
        project: s.projectPath || s.project,
        // The tab's name first, then Claude Code's own title, the newest
        // prompt, the project (sessionAutoName). The prompt alone left most
        // rows reading "No preview available" or a pasted tool echo. Using
        // projectName as primary made every card in one project identical
        // (Codex PR#3 r4 P2).
        display: sessionAutoName(s),
      }));
      setSessions(data);
      setSessionTabMap(tabMap || {});
      const safeTags = tags || {};
      tagsRef.current = safeTags;
      setSessionTags(safeTags);
    } catch (err) {
      console.warn('[useSessions] Failed to load:', err.message);
    } finally {
      // A discarded stale reply must not end the loading state of a newer one.
      if (isCurrent()) setLoading(false);
    }
  }, [projectFilter, excludeAutomated]);

  useEffect(() => {
    loadSessions();
    if (!window.electronAPI) return;
    const remove = window.electronAPI.onDataUpdated(() => {
      loadSessions();
    });
    // Main renamed a running session after its tab: no transcript write
    // announces that, so it has its own event.
    const removeNames = window.electronAPI.onSessionNamesChanged?.(() => {
      loadSessions();
    });
    return () => { remove(); removeNames?.(); };
  }, [loadSessions]);

  // Apply tags + project filter without re-fetching. displayName is what the
  // sidebar should render: user-set label wins, falls back to auto display.
  const decorated = useMemo(() => {
    return sessions.map((s) => {
      const tag = sessionTags[s.sessionId];
      const customLabel = tag?.label;
      return { ...s, displayName: customLabel || s.display || 'Untitled', customLabel };
    });
  }, [sessions, sessionTags]);

  const scoped = useMemo(() => {
    if (!projectFilter) return decorated;
    return decorated.filter((s) => s.project === projectFilter);
  }, [decorated, projectFilter]);

  const filtered = useMemo(() => {
    if (!search) return scoped;
    const q = search.toLowerCase();
    // The prompt and Claude's title stay searchable when the row shows
    // something else (the tab's name, a custom label).
    return scoped.filter((s) =>
      s.displayName?.toLowerCase().includes(q) || s.project?.toLowerCase().includes(q)
      || s.preview?.toLowerCase().includes(q) || s.title?.toLowerCase().includes(q));
  }, [scoped, search]);

  // Optimistic local update + persist. On persist failure, ROLL BACK to the
  // previous state — otherwise the sidebar would show labels that aren't
  // saved to disk, and the user would think their rename worked when it
  // didn't. The pre-snapshot is captured via tagsRef (always points at the
  // latest committed state), the optimistic mutation derives color from
  // that same snapshot so a sibling render can't overwrite an existing color.
  // Targeted rollback helper. Restoring the WHOLE snapshot would erase any
  // sibling rename/reset that succeeded while this one was in flight (Codex
  // round-2 MED on useSessions.js:93). Only undo our own sessionId, against
  // the latest committed state at rollback time.
  const rollbackSession = useCallback((sessionId, previousTag) => {
    const current = tagsRef.current;
    const next = { ...current };
    if (previousTag) next[sessionId] = previousTag;
    else delete next[sessionId];
    tagsRef.current = next;
    setSessionTags(next);
  }, []);

  const setLabel = useCallback(async (sessionId, label) => {
    const safe = (label || '').trim().slice(0, MAX_LABEL_LEN);
    if (!safe) return;
    if (typeof window.electronAPI?.configSetSessionTag !== 'function') {
      console.warn('[useSessions] configSetSessionTag IPC missing — rename not persisted');
      return;
    }
    const previousTag = tagsRef.current[sessionId]; // for targeted rollback
    const color = previousTag?.color || 'blue';
    const optimistic = { ...tagsRef.current, [sessionId]: { ...(previousTag || {}), label: safe, color } };
    tagsRef.current = optimistic;
    setSessionTags(optimistic);
    try {
      await window.electronAPI.configSetSessionTag(sessionId, safe, color);
    } catch (err) {
      console.warn('[useSessions] setLabel persist failed, rolling back:', err.message);
      rollbackSession(sessionId, previousTag);
    }
  }, [rollbackSession]);

  const clearLabel = useCallback(async (sessionId) => {
    if (typeof window.electronAPI?.configRemoveSessionTag !== 'function') {
      console.warn('[useSessions] configRemoveSessionTag IPC missing — reset not persisted');
      return;
    }
    const previousTag = tagsRef.current[sessionId];
    if (!previousTag) return;
    const next = { ...tagsRef.current };
    delete next[sessionId];
    tagsRef.current = next;
    setSessionTags(next);
    try {
      await window.electronAPI.configRemoveSessionTag(sessionId);
    } catch (err) {
      console.warn('[useSessions] clearLabel persist failed, rolling back:', err.message);
      rollbackSession(sessionId, previousTag);
    }
  }, [rollbackSession]);

  return {
    sessions: filtered,
    allSessions: sessions,
    sessionTabMap,
    sessionTags,
    loading,
    search,
    setSearch,
    setLabel,
    clearLabel,
  };
}
