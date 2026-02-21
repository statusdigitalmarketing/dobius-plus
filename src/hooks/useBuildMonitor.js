import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Hook for monitoring autonomous build progress in a project directory.
 * Loads progress, handoff, supervisor log, and active builds.
 * Auto-refreshes when build files change (via chokidar watcher in main process).
 * Fires macOS notification on build completion (once per build).
 */
export function useBuildMonitor(projectDir) {
  const [progress, setProgress] = useState(null);
  const [handoff, setHandoff] = useState('');
  const [supervisorLog, setSupervisorLog] = useState([]);
  const [activeBuilds, setActiveBuilds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [buildComplete, setBuildComplete] = useState(false);

  // Track which builds we've already notified about (by build_start + dir)
  const notifiedRef = useRef(new Set());

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

      // Check for completion and fire notification once
      if (prog && prog.status === 'complete' && prog.tasks_remaining?.length === 0) {
        const buildKey = `${projectDir}:${prog.build_start}`;
        if (!notifiedRef.current.has(buildKey)) {
          notifiedRef.current.add(buildKey);
          setBuildComplete(true);
          const completed = prog.tasks_completed?.length || 0;
          const total = completed;
          window.electronAPI.buildMonitorNotify({
            title: 'Dobius+ \u2014 Build Complete',
            body: `${completed}/${total} tasks completed`,
          });
        }
      } else {
        setBuildComplete(false);
      }
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

    // Poll active builds every 10s (detects process start/stop without file changes)
    const pollInterval = setInterval(() => {
      window.electronAPI.buildMonitorDetectActive().then(setActiveBuilds);
    }, 10_000);

    return () => {
      removeListener();
      clearInterval(pollInterval);
      window.electronAPI.buildMonitorUnwatch(projectDir);
    };
  }, [projectDir, loadAll]);

  return { progress, handoff, supervisorLog, activeBuilds, loading, buildComplete, refresh: loadAll };
}
