import { useState, useEffect, useCallback } from 'react';

/**
 * Hook for loading stats, settings, plans, and skills from the data service.
 */
export function useStats() {
  const [stats, setStats] = useState(null);
  const [settings, setSettings] = useState(null);
  const [bridgeServers, setBridgeServers] = useState({});
  const [plans, setPlans] = useState([]);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const [s, se, bs, p, sk] = await Promise.all([
        window.electronAPI.dataLoadStats(),
        window.electronAPI.dataLoadSettings(),
        window.electronAPI.dataLoadBridgeServers(),
        window.electronAPI.dataLoadPlans(),
        window.electronAPI.dataLoadSkills(),
      ]);
      setStats(s);
      setSettings(se);
      setBridgeServers(bs);
      setPlans(p);
      setSkills(sk);
    } catch (err) {
      console.warn('[useStats] Failed to load:', err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    if (!window.electronAPI) return;
    const remove = window.electronAPI.onDataUpdated(() => {
      loadAll();
    });
    return remove;
  }, [loadAll]);

  return { stats, settings, bridgeServers, plans, skills, loading, refresh: loadAll };
}
