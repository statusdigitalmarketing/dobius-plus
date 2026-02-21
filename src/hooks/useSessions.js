import { useState, useEffect, useCallback } from 'react';

/**
 * Hook for loading and filtering session history.
 */
export function useSessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const loadSessions = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const data = await window.electronAPI.dataLoadHistory();
      setSessions(data);
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

  const filtered = search
    ? sessions.filter((s) =>
        s.display?.toLowerCase().includes(search.toLowerCase()) ||
        s.project?.toLowerCase().includes(search.toLowerCase())
      )
    : sessions;

  return { sessions: filtered, allSessions: sessions, loading, search, setSearch };
}
