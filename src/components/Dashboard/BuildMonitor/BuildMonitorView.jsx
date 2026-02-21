import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useBuildMonitor } from '../../../hooks/useBuildMonitor';
import { useStore } from '../../../store/store';
import BuildProgressBar from './BuildProgressBar';
import BuildTimeline from './BuildTimeline';
import BuildHealthGauge from './BuildHealthGauge';
import SupervisorStatus from './SupervisorStatus';

export default function BuildMonitorView() {
  const [projectDir, setProjectDir] = useState(null);
  const [configLoaded, setConfigLoaded] = useState(false);

  // Load saved monitored dir from config
  useEffect(() => {
    if (!window.electronAPI) {
      setConfigLoaded(true);
      return;
    }
    window.electronAPI.configLoad().then((config) => {
      if (config?.monitoredBuildDir) {
        setProjectDir(config.monitoredBuildDir);
      }
      setConfigLoaded(true);
    });
  }, []);

  const { progress, handoff, supervisorLog, activeBuilds, loading, buildComplete } = useBuildMonitor(projectDir);
  const setBuildComplete = useStore((s) => s.setBuildComplete);

  // Sync build completion state to store for tab badge
  useEffect(() => {
    setBuildComplete(buildComplete);
  }, [buildComplete, setBuildComplete]);

  const handlePickDirectory = useCallback(async () => {
    if (!window.electronAPI) return;
    const dir = await window.electronAPI.buildMonitorPickDirectory();
    if (dir) {
      setProjectDir(dir);
      // Persist to config
      const config = await window.electronAPI.configLoad();
      config.monitoredBuildDir = dir;
      window.electronAPI.configSave(config);
    }
  }, []);

  const handleClear = useCallback(async () => {
    setProjectDir(null);
    if (window.electronAPI) {
      const config = await window.electronAPI.configLoad();
      delete config.monitoredBuildDir;
      window.electronAPI.configSave(config);
    }
  }, []);

  if (!configLoaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="w-6 h-6 rounded-full animate-pulse" style={{ backgroundColor: 'var(--border)' }} />
      </div>
    );
  }

  // Empty state — no directory selected or no progress data
  if (!projectDir || (!loading && !progress)) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8">
        <div className="text-center max-w-sm">
          {/* Icon */}
          <div
            className="w-12 h-12 rounded-xl mx-auto mb-4 flex items-center justify-center"
            style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>

          <h3 className="text-sm font-medium mb-1" style={{ color: 'var(--fg)' }}>
            No Active Builds
          </h3>
          <p className="text-xs mb-4" style={{ color: 'var(--dim)' }}>
            Monitor an autonomous build by selecting a project directory that contains a{' '}
            <span style={{ fontFamily: "'SF Mono', monospace" }}>claude-progress.json</span> file.
          </p>

          <button
            onClick={handlePickDirectory}
            className="px-4 py-2 text-xs font-medium rounded-lg transition-all duration-150"
            style={{
              backgroundColor: 'var(--accent)',
              color: 'var(--bg)',
            }}
          >
            Monitor Build...
          </button>

          {projectDir && !progress && (
            <p className="text-xs mt-3" style={{ color: 'var(--dim)' }}>
              No build data found in selected directory.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-y-auto">
      {/* Header with directory path + actions */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-xs truncate"
            style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}
          >
            {projectDir}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handlePickDirectory}
            className="px-2 py-1 text-xs rounded transition-colors duration-150"
            style={{
              color: 'var(--dim)',
              border: '1px solid var(--border)',
              backgroundColor: 'transparent',
            }}
          >
            Change
          </button>
          <button
            onClick={handleClear}
            className="px-2 py-1 text-xs rounded transition-colors duration-150"
            style={{
              color: 'var(--dim)',
              border: '1px solid var(--border)',
              backgroundColor: 'transparent',
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {loading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex items-center justify-center"
          >
            <div className="w-6 h-6 rounded-full animate-pulse" style={{ backgroundColor: 'var(--border)' }} />
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex flex-col gap-4"
          >
            {/* Top: Progress Bar */}
            <BuildProgressBar progress={progress} />

            {/* Middle: Gauge + Supervisor */}
            <div className="grid grid-cols-2 gap-4">
              <BuildHealthGauge progress={progress} />
              <SupervisorStatus
                progress={progress}
                supervisorLog={supervisorLog}
                activeBuilds={activeBuilds}
              />
            </div>

            {/* Bottom: Timeline */}
            <BuildTimeline progress={progress} />

            {/* Handoff preview */}
            {handoff && (
              <div
                className="p-4 rounded-lg"
                style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                <h3
                  className="text-xs font-medium uppercase tracking-wider mb-2"
                  style={{ color: 'var(--dim)' }}
                >
                  Handoff
                </h3>
                <pre
                  className="text-xs whitespace-pre-wrap leading-relaxed overflow-y-auto"
                  style={{
                    color: 'var(--dim)',
                    fontFamily: "'SF Mono', monospace",
                    maxHeight: '120px',
                  }}
                >
                  {handoff}
                </pre>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
