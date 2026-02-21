import { useEffect } from 'react';
import { useStore } from '../../store/store';
import { THEMES, applyTheme } from '../../lib/themes';
import TopBar from '../shared/TopBar';
import StatusBar from '../shared/StatusBar';
import TerminalPane from './TerminalPane';

export default function ProjectView({ projectPath }) {
  const activeView = useStore((s) => s.activeView);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const themeIndex = useStore((s) => s.themeIndex);
  const theme = THEMES[themeIndex];
  const setSessions = useStore((s) => s.setSessions);
  const setActiveProcesses = useStore((s) => s.setActiveProcesses);

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

  return (
    <div className="h-full w-full flex flex-col" style={{ backgroundColor: 'var(--bg)' }}>
      <TopBar projectName={projectName} />

      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        {sidebarVisible && (
          <div
            className="w-70 shrink-0 overflow-y-auto"
            style={{
              backgroundColor: 'var(--surface)',
              borderRight: '1px solid var(--border)',
            }}
          >
            <div className="p-3 text-xs" style={{ color: 'var(--dim)' }}>
              Conversations
            </div>
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
