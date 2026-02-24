import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../store/store';
import { THEMES, applyTheme } from '../../lib/themes';
import TopBar from '../shared/TopBar';
import StatusBar from '../shared/StatusBar';
import TerminalPane from './TerminalPane';
import TerminalTabBar from './TerminalTabBar';
import Sidebar from './Sidebar';
import DashboardView from '../Dashboard/DashboardView';
import GitSidePanel from '../shared/GitSidePanel';
import QuitOverlay from '../shared/QuitOverlay';
import ResumeBanner from './ResumeBanner';

export default function ProjectView({ projectPath }) {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const themeIndex = useStore((s) => s.themeIndex);
  const setThemeIndex = useStore((s) => s.setThemeIndex);
  const toggleGitPanel = useStore((s) => s.toggleGitPanel);
  const setCurrentProjectPath = useStore((s) => s.setCurrentProjectPath);
  const theme = THEMES[themeIndex];
  const setSessions = useStore((s) => s.setSessions);
  const setActiveProcesses = useStore((s) => s.setActiveProcesses);

  // Tab state
  const tabs = useStore((s) => s.terminalTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const addTab = useStore((s) => s.addTab);
  const removeTab = useStore((s) => s.removeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const initTabs = useStore((s) => s.initTabs);

  const [pinnedIds, setPinnedIds] = useState([]);
  const [tabsInitialized, setTabsInitialized] = useState(false);

  // Extract project name from path
  const projectName = projectPath
    ? projectPath.split('/').filter(Boolean).pop()
    : 'Dobius+';

  // Store current project path for other components (e.g. GitView)
  useEffect(() => {
    setCurrentProjectPath(projectPath || null);
  }, [projectPath, setCurrentProjectPath]);

  // Apply theme on mount and change
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Load config on mount (pinned sessions + theme + tabs)
  useEffect(() => {
    if (!window.electronAPI?.configGetPinned) return;
    window.electronAPI.configGetPinned().then(setPinnedIds);
    if (projectPath) {
      window.electronAPI.configGetProject(projectPath).then((config) => {
        if (config && typeof config.themeIndex === 'number') {
          setThemeIndex(config.themeIndex);
        }
        // Restore saved tabs
        if (config?.tabs?.length > 0 && config.tabCounter > 0) {
          initTabs(config.tabs, config.tabCounter);
        } else {
          // First open: create initial tab
          addTab(projectPath);
        }
        setTabsInitialized(true);
      });
    } else {
      // No project path (launcher) — create a default tab
      if (tabs.length === 0) {
        addTab(null);
      }
      setTabsInitialized(true);
    }
  }, [projectPath, setThemeIndex]);

  // Save theme to config when it changes
  useEffect(() => {
    if (!window.electronAPI?.configSetProject || !projectPath) return;
    window.electronAPI.configSetProject(projectPath, { themeIndex });
  }, [themeIndex, projectPath]);

  // Save tabs to config whenever they change
  useEffect(() => {
    if (!tabsInitialized || !projectPath || !window.electronAPI?.terminalSaveTabs) return;
    if (tabs.length > 0) {
      window.electronAPI.terminalSaveTabs(projectPath, tabs, useStore.getState().tabCounter);
    }
  }, [tabs, tabsInitialized, projectPath]);

  // Clean up running agents when a terminal PTY exits + auto-capture journal
  useEffect(() => {
    if (!window.electronAPI?.onTerminalExit) return;
    const removeExitListener = window.electronAPI.onTerminalExit((termId, exitCode) => {
      const state = useStore.getState();
      // Find which agent (if any) was running in this tab
      const agentId = Object.keys(state.runningAgents).find(
        (key) => state.runningAgents[key] === termId
      );
      // Unregister first to prevent duplicate processing if event fires twice
      state.unregisterAgentsByTabId(termId);
      if (agentId) {
        // Auto-capture journal entry
        const tab = state.terminalTabs.find((t) => t.id === termId);
        const duration = tab?.createdAt ? Math.round((Date.now() - tab.createdAt) / 1000) : 0;
        const entry = {
          id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: tab?.createdAt || Date.now(),
          duration,
          projectPath: projectPath || '',
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          summary: '',
          linesOutput: 0,
        };
        window.electronAPI.agentMemoryAppendJournal?.(agentId, entry);
      }
    });
    return () => removeExitListener?.();
  }, [projectPath]);

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
      if (window.electronAPI?.configSetPinned) {
        window.electronAPI.configSetPinned(next);
      }
      return next;
    });
  }, []);

  const handleResumeSession = useCallback((session) => {
    if (!session.sessionId || !/^[\w-]+$/.test(session.sessionId)) return;
    setActiveView('terminal');
    const cmd = `claude --resume ${session.sessionId}\r`;
    const termId = useStore.getState().activeTabId;
    if (window.electronAPI && termId) {
      window.electronAPI.terminalWrite(termId, cmd);
    }
  }, [setActiveView]);

  const handleCdToProject = useCallback((sessionProject) => {
    if (!sessionProject || !sessionProject.startsWith('/') || /[;&|`$\x00-\x1F\x7F]/.test(sessionProject)) return;
    setActiveView('terminal');
    const safePath = sessionProject.replace(/'/g, "'\\''");
    const cmd = `cd '${safePath}'\r`;
    const termId = useStore.getState().activeTabId;
    if (window.electronAPI && termId) {
      window.electronAPI.terminalWrite(termId, cmd);
    }
  }, [setActiveView]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === 't' && !e.shiftKey) {
        // Cmd+T = new tab
        e.preventDefault();
        if (useStore.getState().activeView === 'terminal') {
          addTab(projectPath);
        } else {
          // In dashboard, switch to terminal
          setActiveView('terminal');
        }
      } else if (e.key === 'T' && e.shiftKey) {
        // Cmd+Shift+T = toggle terminal/dashboard
        e.preventDefault();
        const current = useStore.getState().activeView;
        setActiveView(current === 'terminal' ? 'dashboard' : 'terminal');
      } else if (e.key === 'w' && !e.shiftKey) {
        // Cmd+W = close tab (don't close window if last tab)
        e.preventDefault();
        const state = useStore.getState();
        if (state.activeView === 'terminal' && state.terminalTabs.length > 1) {
          const tabId = state.activeTabId;
          if (tabId && window.electronAPI) {
            window.electronAPI.terminalKill(tabId);
          }
          removeTab(state.activeTabId);
        }
      } else if (e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === 'g') {
        e.preventDefault();
        toggleGitPanel();
      } else if (e.key === 'k') {
        e.preventDefault();
        const termId = useStore.getState().activeTabId;
        if (window.electronAPI && termId) {
          window.electronAPI.terminalWrite(termId, 'clear\r');
        }
      } else if (e.key === 'r' && !e.shiftKey) {
        // Cmd+R = resume last Claude session
        e.preventDefault();
        if (projectPath && window.electronAPI?.dataGetLatestSession) {
          window.electronAPI.dataGetLatestSession(projectPath).then((session) => {
            if (session?.sessionId) {
              useStore.getState().resumeSession(session.sessionId);
            }
          });
        }
      } else if (e.key === '[' && e.shiftKey) {
        // Cmd+Shift+[ = prev tab
        e.preventDefault();
        const state = useStore.getState();
        const idx = state.terminalTabs.findIndex((t) => t.id === state.activeTabId);
        if (idx > 0) setActiveTab(state.terminalTabs[idx - 1].id);
      } else if (e.key === ']' && e.shiftKey) {
        // Cmd+Shift+] = next tab
        e.preventDefault();
        const state = useStore.getState();
        const idx = state.terminalTabs.findIndex((t) => t.id === state.activeTabId);
        if (idx < state.terminalTabs.length - 1) setActiveTab(state.terminalTabs[idx + 1].id);
      } else if (e.key >= '1' && e.key <= '9') {
        // Cmd+1-9 = switch to tab N
        e.preventDefault();
        const state = useStore.getState();
        const tabIdx = parseInt(e.key, 10) - 1;
        if (tabIdx < state.terminalTabs.length) {
          setActiveTab(state.terminalTabs[tabIdx].id);
          if (state.activeView !== 'terminal') setActiveView('terminal');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projectPath, addTab, removeTab, setActiveTab, setActiveView, toggleSidebar, toggleGitPanel]);

  // Menu bar events
  useEffect(() => {
    if (!window.electronAPI) return;
    const cleanups = [
      window.electronAPI.onMenuToggleView?.(() => {
        const current = useStore.getState().activeView;
        setActiveView(current === 'terminal' ? 'dashboard' : 'terminal');
      }),
      window.electronAPI.onMenuToggleSidebar?.(() => toggleSidebar()),
      window.electronAPI.onMenuToggleGitPanel?.(() => toggleGitPanel()),
      window.electronAPI.onMenuNewTab?.(() => {
        addTab(projectPath);
        setActiveView('terminal');
      }),
      window.electronAPI.onMenuCloseTab?.(() => {
        const state = useStore.getState();
        if (state.terminalTabs.length > 1) {
          const tabId = state.activeTabId;
          if (tabId && window.electronAPI) {
            window.electronAPI.terminalKill(tabId);
          }
          removeTab(state.activeTabId);
        }
      }),
    ];
    return () => cleanups.forEach((fn) => fn?.());
  }, [setActiveView, toggleSidebar, toggleGitPanel, addTab, removeTab, projectPath]);

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
              onCdToProject={handleCdToProject}
            />
          </div>
        )}

        <div className="flex-1 min-w-0 relative flex flex-col">
          {/* Terminal view with tab bar */}
          <div
            className="flex-1 flex flex-col min-h-0"
            style={{ display: activeView === 'terminal' ? 'flex' : 'none' }}
          >
            <TerminalTabBar />
            <ResumeBanner projectPath={projectPath} />
            <div className="flex-1 relative min-h-0">
              {tabsInitialized && tabs.map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}
                >
                  <TerminalPane
                    id={tab.id}
                    cwd={tab.projectPath}
                    theme={theme.xtermTheme}
                  />
                </div>
              ))}
            </div>
          </div>
          {activeView !== 'terminal' && <DashboardView />}
        </div>

        {activeView === 'terminal' && (
          <GitSidePanel projectDir={projectPath} />
        )}
      </div>

      <StatusBar />
      <QuitOverlay />
    </div>
  );
}
