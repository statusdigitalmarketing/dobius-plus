import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../store/store';
import { THEMES, applyTheme } from '../../lib/themes';
import TopBar from '../shared/TopBar';
import StatusBar from '../shared/StatusBar';
import TerminalPane from './TerminalPane';
import Sidebar from './Sidebar';

export default function ProjectView({ projectPath }) {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const themeIndex = useStore((s) => s.themeIndex);
  const setThemeIndex = useStore((s) => s.setThemeIndex);
  const theme = THEMES[themeIndex];
  const setSessions = useStore((s) => s.setSessions);
  const setActiveProcesses = useStore((s) => s.setActiveProcesses);

  const [pinnedIds, setPinnedIds] = useState([]);

  // Extract project name from path
  const projectName = projectPath
    ? projectPath.split('/').filter(Boolean).pop()
    : 'Dobius+';

  // Apply theme on mount and change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Load config on mount (pinned sessions + theme)
  useEffect(() => {
    if (!window.electronAPI?.configGetPinned) return;
    window.electronAPI.configGetPinned().then(setPinnedIds);
    if (projectPath) {
      window.electronAPI.configGetProject(projectPath).then((config) => {
        if (config && typeof config.themeIndex === 'number') {
          setThemeIndex(config.themeIndex);
        }
      });
    }
  }, [projectPath, setThemeIndex]);

  // Save theme to config when it changes
  useEffect(() => {
    if (!window.electronAPI?.configSetProject || !projectPath) return;
    window.electronAPI.configSetProject(projectPath, { themeIndex });
  }, [themeIndex, projectPath]);

  // Load initial data
  useEffect(() => {
    if (!window.electronAPI) return;

    window.electronAPI.dataLoadHistory().then(setSessions);
    window.electronAPI.dataGetActiveProcesses().then(setActiveProcesses);

    const removeWatcher = window.electronAPI.onDataUpdated(() => {
      window.electronAPI.dataLoadHistory().then(setSessions);
      window.electronAPI.dataGetActiveProcesses().then(setActiveProcesses);
    });

    const interval = setInterval(() => {
      window.electronAPI.dataGetActiveProcesses().then(setActiveProcesses);
    }, 10000);

    return () => {
      removeWatcher();
      clearInterval(interval);
    };
  }, [setSessions, setActiveProcesses]);

  const handleTogglePin = useCallback((sessionId) => {
    setPinnedIds((prev) => {
      const next = prev.includes(sessionId)
        ? prev.filter((id) => id !== sessionId)
        : [...prev, sessionId];
      // Persist to config
      if (window.electronAPI?.configSetPinned) {
        window.electronAPI.configSetPinned(next);
      }
      return next;
    });
  }, []);

  const handleResumeSession = useCallback((session) => {
    setActiveView('terminal');
    const cmd = `claude --resume ${session.sessionId}\n`;
    const termId = projectPath ? `term-${projectPath}` : 'main';
    if (window.electronAPI) {
      window.electronAPI.terminalWrite(termId, cmd);
    }
  }, [projectPath, setActiveView]);

  return (
    <div className="h-full w-full flex flex-col" style={{ backgroundColor: 'var(--bg)' }}>
      <TopBar projectName={projectName} />

      <div className="flex-1 flex min-h-0">
        {sidebarVisible && (
          <div
            className="w-70 shrink-0 overflow-hidden"
            style={{
              backgroundColor: 'var(--surface)',
              borderRight: '1px solid var(--border)',
            }}
          >
            <Sidebar
              pinnedIds={pinnedIds}
              onTogglePin={handleTogglePin}
              onResumeSession={handleResumeSession}
            />
          </div>
        )}

        <div className="flex-1 min-w-0">
          {activeView === 'terminal' ? (
            <TerminalPane
              id={projectPath ? `term-${projectPath}` : 'main'}
              cwd={projectPath}
              theme={theme.xtermTheme}
            />
          ) : (
            <div
              className="h-full flex items-center justify-center"
              style={{ color: 'var(--dim)' }}
            >
              Dashboard (coming in Task 4.1)
            </div>
          )}
        </div>
      </div>

      <StatusBar />
    </div>
  );
}
