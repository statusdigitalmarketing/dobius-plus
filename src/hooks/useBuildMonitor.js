import { useState, useEffect, useCallback } from 'react';

/**
 * Hook for monitoring autonomous build progress in a project directory.
 * Loads progress, handoff, supervisor log, and active builds.
 * Auto-refreshes when build files change (via chokidar watcher in main process).
 */
export function useBuildMonitor(projectDir) {
  const [progress, setProgress] = useState(null);
  const [handoff, setHandoff] = useState('');
  const [supervisorLog, setSupervisorLog] = useState([]);
  const [activeBuilds, setActiveBuilds] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    if (!window.electronAPI || !projectDir) {
      setLoading(false);
      return;
    }
    try {
      const [prog, ho, log, active] = await Promise.all([
        window.electronAPI.buildMonitorLoadProgress(projectDir),
        window.electronAPI.buildMonitorLoadHandoff(projectDir),
        window.electronAPI.buildMonitorLoadSupervisorLog(projectDir),
        window.electronAPI.buildMonitorDetectActive(),
      ]);
      setProgress(prog);
      setHandoff(ho);
      setSupervisorLog(log);
      setActiveBuilds(active);
    } catch (err) {
      console.warn('[useBuildMonitor] Failed to load:', err.message);
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  // Initial load + watch/unwatch lifecycle
  useEffect(() => {
    if (!projectDir || !window.electronAPI) return;

    setLoading(true);
    loadAll();

    // Start watching build files
    window.electronAPI.buildMonitorWatch(projectDir);

    // Listen for file change events
    const removeListener = window.electronAPI.onBuildMonitorUpdated((changedDir) => {
      if (changedDir === projectDir) {
        loadAll();
      }
    });

    return () => {
      removeListener();
      window.electronAPI.buildMonitorUnwatch(projectDir);
    };
  }, [projectDir, loadAll]);

  return { progress, handoff, supervisorLog, activeBuilds, loading, refresh: loadAll };
}
