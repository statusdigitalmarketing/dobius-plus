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

  // Load initial data
  useEffect(() => {
    if (!window.electronAPI) return;

    window.electronAPI.dataLoadHistory().then(setSessions);
    window.electronAPI.dataGetActiveProcesses().then(setActiveProcesses);

    const removeWatcher = window.electronAPI.onDataUpdated(() => {
      window.electronAPI.dataLoadHistory().then(setSessions);
      window.electronAPI.dataGetActiveProcesses().then(setActiveProcesses);
    });

    // Refresh active processes periodically
    const interval = setInterval(() => {
      window.electronAPI.dataGetActiveProcesses().then(setActiveProcesses);
    }, 10000);

    return () => {
      removeWatcher();
      clearInterval(interval);
    };
  }, [setSessions, setActiveProcesses]);

  const handleTogglePin = useCallback((sessionId) => {
    setPinnedIds((prev) =>
      prev.includes(sessionId)
        ? prev.filter((id) => id !== sessionId)
        : [...prev, sessionId]
    );
  }, []);

  const handleResumeSession = useCallback((session) => {
    setActiveView('terminal');
    // Write the resume command to the terminal
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
        {/* Sidebar */}
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

        {/* Main content */}
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
