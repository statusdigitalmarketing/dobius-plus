import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

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

export function useSessions({ projectFilter = null } = {}) {
  const [sessions, setSessions] = useState([]);
  const [sessionTabMap, setSessionTabMap] = useState({});
  const [sessionTags, setSessionTags] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Ref tracks the latest sessionTags so optimistic-update callbacks don't
  // close over a stale snapshot — otherwise rapid setLabel calls could
  // overwrite a color a sibling render had just set.
  const tagsRef = useRef({});

  const loadSessions = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      // Use dataLoadAllSessions (reads transcript files directly from
      // ~/.claude/projects/) instead of dataLoadHistory (reads
      // ~/.claude/history.jsonl, which on this Mac is 95% incomplete
      // and 92% full of ghost entries for deleted transcripts). The
      // sidebar was effectively only able to surface the ~83 sessions
      // that happened to be in BOTH lists, out of 4,367 real ones on
      // disk. Switching to the disk source shows everything that
      // actually exists, capped at 500 most-recent.
      const [raw, tabMap, tags] = await Promise.all([
        window.electronAPI.dataLoadAllSessions(),
        window.electronAPI.configGetSessionTabMap?.() ?? {},
        window.electronAPI.configGetSessionTags?.() ?? {},
      ]);
      // dataLoadAllSessions returns { sessionId, projectPath, projectName,
      // preview, timestamp, age, status }. The sidebar consumes the older
      // { sessionId, project, display, timestamp } shape that dataLoadHistory
      // used, so alias the new field names without changing the consumers.
      const data = (raw || []).map((s) => ({
        ...s,
        project: s.projectPath || s.project,
        // Prefer preview (session-specific first message) over projectName.
        // Using projectName as primary made every session card in a single
        // project's sidebar identical, which is the opposite of useful.
        // Codex PR#3 r4 P2.
        display: s.preview || s.projectName || 'Untitled',
      }));
      setSessions(data);
      setSessionTabMap(tabMap || {});
      const safeTags = tags || {};
      tagsRef.current = safeTags;
      setSessionTags(safeTags);
    } catch (err) {
      console.warn('[useSessions] Failed to load:', err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
    if (!window.electronAPI) return;
    const remove = window.electronAPI.onDataUpdated(() => {
      loadSessions();
    });
    return remove;
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
    return scoped.filter((s) =>
      s.displayName?.toLowerCase().includes(q) || s.project?.toLowerCase().includes(q));
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
