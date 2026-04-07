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
import { useAgentActivity } from '../../hooks/useAgentActivity';

export default function ProjectView({ projectPath, tearOffTabId, tearOffLabel }) {
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
  const initClosedTabs = useStore((s) => s.initClosedTabs);

  const [pinnedIds, setPinnedIds] = useState([]);
  const [tabsInitialized, setTabsInitialized] = useState(false);

  // Start agent activity monitoring for all running agents
  useAgentActivity();

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

    // Tear-off window: initialize with the single torn-off tab
    if (tearOffTabId && projectPath) {
      window.electronAPI.configGetProject(projectPath).then((config) => {
        if (config && typeof config.themeIndex === 'number') {
          setThemeIndex(config.themeIndex);
        }
        const tab = {
          id: tearOffTabId,
          label: tearOffLabel || 'Tab',
          projectPath,
          createdAt: Date.now(),
        };
        // Use the existing tabCounter from the project config to avoid ID collisions
        const counter = config?.tabCounter || 1;
        initTabs([tab], counter);
        setTabsInitialized(true);
      });
      return;
    }

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
      // Load persisted closed tabs for Cmd+Shift+T recovery across sessions
      window.electronAPI.terminalLoadClosedTabs?.(projectPath).then((closed) => {
        if (closed?.length > 0) initClosedTabs(closed);
      });
    } else {
      // No project path (launcher) — create a default tab
      if (tabs.length === 0) {
        addTab(null);
      }
      setTabsInitialized(true);
    }
  }, [projectPath, setThemeIndex, tearOffTabId, tearOffLabel]);

  // Save theme to config when it changes
  useEffect(() => {
    if (!window.electronAPI?.configSetProject || !projectPath) return;
    window.electronAPI.configSetProject(projectPath, { themeIndex });
  }, [themeIndex, projectPath]);

  // Save tabs to config whenever they change (skip for tear-off windows to avoid conflicts)
  useEffect(() => {
    if (tearOffTabId) return; // Tear-off windows don't persist tabs
    if (!tabsInitialized || !projectPath || !window.electronAPI?.terminalSaveTabs) return;
    if (tabs.length > 0) {
      window.electronAPI.terminalSaveTabs(projectPath, tabs, useStore.getState().tabCounter);
    }
  }, [tabs, tabsInitialized, projectPath, tearOffTabId]);

  // Clean up running agents when a terminal PTY exits + auto-capture journal + orchestration tracking
  useEffect(() => {
    if (!window.electronAPI?.onTerminalExit) return;
    const removeExitListener = window.electronAPI.onTerminalExit((termId, exitCode) => {
      const state = useStore.getState();
      // Find which agent (if any) was running in this tab
      const agentId = Object.keys(state.runningAgents).find(
        (key) => state.runningAgents[key] === termId
      );
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
        window.electronAPI.agentMemoryAppendJournal?.(agentId, entry)
          .catch((err) => console.error('[ProjectView] Failed to save agent journal:', err));

        // Board notification for agent completion
        const agentName = tab?.label || agentId;
        state.setBoardNotification({
          agentId,
          agentName,
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          timestamp: Date.now(),
        });
      }

      // Orchestration: check if this tab belongs to an active orchestration
      const orch = state.activeOrchestration;
      if (orch && orch.status === 'running') {
        const subtask = orch.subtasks.find((st) => st.tabId === termId && st.status === 'running');
        if (subtask) {
          const doUpdate = (outputSummary) => {
            const current = useStore.getState().activeOrchestration;
            if (!current || current.id !== orch.id) return;

            // Build updated run locally to avoid stale reads after partial updates
            const updatedSubtasks = current.subtasks.map((st) =>
              st.id === subtask.id
                ? {
                    ...st,
                    status: (exitCode === 0 || exitCode === null) ? 'completed' : 'failed',
                    completedAt: Date.now(),
                    exitCode: typeof exitCode === 'number' ? exitCode : null,
                    outputSummary,
                  }
                : st
            );

            const allDone = updatedSubtasks.every((st) => st.status === 'completed' || st.status === 'failed');
            const failedCount = updatedSubtasks.filter((st) => st.status === 'failed').length;

            const finalRun = {
              ...current,
              subtasks: updatedSubtasks,
              ...(allDone ? {
                status: failedCount === 0 ? 'completed' : 'failed',
                completedAt: Date.now(),
              } : {}),
            };

            useStore.getState().setActiveOrchestration(finalRun);
            window.electronAPI?.orchestrationSave(finalRun)
              .catch((err) => console.error('[Orchestrator] Failed to save run:', err));
          };

          // Try to extract output summary from terminal scrollback
          if (window.electronAPI?.terminalLoadState) {
            window.electronAPI.terminalLoadState(termId).then((saved) => {
              let summary = null;
              if (saved?.scrollback) {
                const stripped = saved.scrollback.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
                summary = stripped.slice(-500).trim();
              }
              doUpdate(summary);
            }).catch(() => doUpdate(null));
          } else {
            doUpdate(null);
          }
        }
      }

      // Unregister AFTER all state-dependent operations complete
      state.unregisterAgentsByTabId(termId);
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

  // Close active tab with process confirmation
  const closeActiveTab = useCallback(async () => {
    const state = useStore.getState();
    if (state.activeView !== 'terminal' || state.terminalTabs.length <= 1) return;

    const tabId = state.activeTabId;
    if (!tabId) return;

    // Check for active child process (claude, node, etc.)
    if (window.electronAPI?.terminalGetProcess) {
      try {
        const processName = await window.electronAPI.terminalGetProcess(tabId);
        if (processName) {
          const confirmed = window.confirm(
            `"${processName}" is still running in this tab.\n\nClose anyway?`
          );
          if (!confirmed) return;
        }
      } catch {
        // If check fails, proceed with close
      }
    }

    const tab = state.terminalTabs.find((t) => t.id === tabId);
    if (tab) {
      state.pushClosedTab({ label: tab.label, projectPath: tab.projectPath, scrollback: null });
    }
    if (window.electronAPI) {
      window.electronAPI.terminalKill(tabId);
    }
    removeTab(tabId);
  }, [removeTab]);

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
        // Cmd+Shift+T = reopen last closed tab (in terminal view) or toggle to terminal (in dashboard)
        e.preventDefault();
        const state = useStore.getState();
        if (state.activeView === 'terminal' && state.recentlyClosedTabs.length > 0) {
          const result = state.reopenClosedTab();
          if (result?.tab && result?.scrollback?.length > 0) {
            // Restore scrollback as dimmed text after terminal initializes
            setTimeout(() => {
              if (window.electronAPI?.terminalSaveState) {
                window.electronAPI.terminalSaveState(result.tab.id, {
                  scrollback: result.scrollback,
                  cols: 80,
                  rows: 24,
                  savedAt: Date.now(),
                });
              }
            }, 100);
          }
        } else {
          const current = state.activeView;
          setActiveView(current === 'terminal' ? 'dashboard' : 'terminal');
        }
      } else if (e.key === 'w' && !e.shiftKey) {
        // Cmd+W = close tab (with process confirmation)
        e.preventDefault();
        closeActiveTab();
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
  }, [projectPath, addTab, removeTab, setActiveTab, setActiveView, toggleSidebar, toggleGitPanel, closeActiveTab]);

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
      window.electronAPI.onMenuCloseTab?.(() => closeActiveTab()),
    ];
    return () => cleanups.forEach((fn) => fn?.());
  }, [setActiveView, toggleSidebar, toggleGitPanel, addTab, removeTab, projectPath, closeActiveTab]);

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
                    claimExisting={tab.id === tearOffTabId}
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
