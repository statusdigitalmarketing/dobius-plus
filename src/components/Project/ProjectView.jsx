import { useEffect, useState, useCallback, useRef } from 'react';
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
  const splitTabId = useStore((s) => s.splitTabId);
  const clearSplitTab = useStore((s) => s.clearSplitTab);

  // Terminal grid state + actions
  const gridSlots = useStore((s) => s.gridSlots);
  const draggingTabId = useStore((s) => s.draggingTabId);
  const setDraggingTabId = useStore((s) => s.setDraggingTabId);
  const addToGrid = useStore((s) => s.addToGrid);
  const removeFromGrid = useStore((s) => s.removeFromGrid);
  const swapGrid = useStore((s) => s.swapGrid);
  const clearGrid = useStore((s) => s.clearGrid);
  const setGridSlots = useStore((s) => s.setGridSlots);

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

  // Track active tab's git branch + worktree status. Each tab has its own
  // shell with its own cwd — the user might `cd` into a worktree in one tab
  // and stay on main in another. Fetches the active tab's shell cwd via lsof,
  // then runs git status against that cwd. Re-runs on tab switch + every 20s.
  const currentBranch = useStore((s) => s.currentBranch);
  const setCurrentBranch = useStore((s) => s.setCurrentBranch);
  const currentIsWorktree = useStore((s) => s.currentIsWorktree);
  const setCurrentIsWorktree = useStore((s) => s.setCurrentIsWorktree);
  useEffect(() => {
    if (!projectPath || !window.electronAPI?.gitStatus) {
      setCurrentBranch('');
      setCurrentIsWorktree(false);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        let cwd = null;
        if (activeTabId && window.electronAPI?.terminalGetCwd) {
          cwd = await window.electronAPI.terminalGetCwd(activeTabId);
        }
        const dir = cwd || projectPath;
        const s = await window.electronAPI.gitStatus(dir);
        if (cancelled) return;
        setCurrentBranch(s?.isRepo ? (s.branch || '') : '');
        setCurrentIsWorktree(!!s?.isWorktree);
      } catch {
        // Swallow — leave previous values in place
      }
    };
    refresh();
    const id = setInterval(refresh, 20000);
    return () => { cancelled = true; clearInterval(id); };
  }, [projectPath, activeTabId, setCurrentBranch, setCurrentIsWorktree]);

  // Push window title (shown in Mission Control / window switcher).
  // Includes branch and a "(worktree)" suffix when the active tab is in one.
  useEffect(() => {
    if (!window.electronAPI?.windowSetTitle) return;
    const wtTag = currentIsWorktree ? ' (worktree)' : '';
    const branchPart = currentBranch ? ` - ${currentBranch}${wtTag}` : '';
    window.electronAPI.windowSetTitle(`${projectName}${branchPart} | Dobius+`);
  }, [projectName, currentBranch, currentIsWorktree]);

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
        // Offset tabCounter for tear-off windows to avoid ID collisions with
        // the primary window (which shares the same project config counter).
        // Using timestamp-based offset ensures uniqueness across windows.
        const counter = (config?.tabCounter || 1) + Math.floor(Date.now() / 1000) % 10000;
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
          // Restore a persisted grid layout, dropping any entry whose tab is gone.
          if (Array.isArray(config.gridSlots)) {
            const validIds = new Set(config.tabs.map((t) => t.id));
            const restored = config.gridSlots.filter((id) => id && validIds.has(id));
            if (restored.length) setGridSlots(restored);
          }
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

  // Persist grid layout per project (merged into project config; skip tear-offs).
  // Gate on hydration so the mount-time default (gridSlots: null) can't clobber a
  // saved layout before the load effect has had a chance to restore it.
  const gridHydratedRef = useRef(false);
  useEffect(() => {
    if (tabsInitialized) gridHydratedRef.current = true;
  }, [tabsInitialized]);
  useEffect(() => {
    if (tearOffTabId || !gridHydratedRef.current) return;
    if (!tabsInitialized || !projectPath || !window.electronAPI?.configSetProject) return;
    window.electronAPI.configSetProject(projectPath, { gridSlots });
  }, [gridSlots, tabsInitialized, projectPath, tearOffTabId]);

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

  // Cmd+R / menu "Resume Last Session" — resume the latest session that ran in
  // the ACTIVE tab (via the session↔tab link), falling back to the project's
  // most recent session only if this tab has no linked session yet.
  // Guarded so the keydown path and the menu accelerator can't double-fire.
  const resumeGuardRef = useRef(0);
  const doResumeLatest = useCallback(() => {
    const now = Date.now();
    if (now - resumeGuardRef.current < 1500) return;
    resumeGuardRef.current = now;
    if (!projectPath || !window.electronAPI) return;
    const api = window.electronAPI;
    const termId = useStore.getState().activeTabId;

    const resolve = async () => {
      // 1. Latest session linked to THIS tab.
      if (termId && api.configGetSessionTabMap) {
        try {
          const map = await api.configGetSessionTabMap();
          let best = null;
          for (const [sid, entry] of Object.entries(map || {})) {
            if (entry?.tabId === termId && (!best || (entry.capturedAt || 0) > best.capturedAt)) {
              best = { sessionId: sid, capturedAt: entry.capturedAt || 0 };
            }
          }
          if (best?.sessionId) return best.sessionId;
        } catch { /* fall through */ }
      }
      // 2. Fallback: project's most recent session.
      if (api.dataGetLatestSession) {
        const s = await api.dataGetLatestSession(projectPath);
        return s?.sessionId || null;
      }
      return null;
    };

    resolve().then((sessionId) => {
      if (sessionId) handleResumeSession({ sessionId });
    });
  }, [projectPath, handleResumeSession]);

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
    // Check pin protection
    if (tab?.pinned) {
      const confirmed = window.confirm(`"${tab.label}" is pinned. Close anyway?`);
      if (!confirmed) return;
    }
    // Save scrollback before closing so Cmd+Shift+T can restore it
    let scrollback = null;
    let saved = null;
    if (window.electronAPI?.terminalLoadState) {
      await window.electronAPI.terminalRequestSaveNow?.();
      await new Promise((r) => setTimeout(r, 200));
      saved = await window.electronAPI.terminalLoadState(tabId);
      scrollback = saved?.scrollback || null;
    }
    if (tab) {
      state.pushClosedTab({ label: tab.label, projectPath: tab.projectPath, scrollback });
    }
    // Auto-checkpoint on close, matching the tab-bar X / middle-click / context-menu
    // paths (Cmd+W previously skipped this, so the same close produced no checkpoint).
    // Reuse the scrollback already loaded above — no second save round-trip.
    if (scrollback?.length > 0 && projectPath && window.electronAPI?.checkpointSave) {
      try {
        await window.electronAPI.checkpointSave(projectPath, {
          label: `Auto: ${tab?.label || 'closed tab'}`,
          terminalId: tabId,
          scrollback,
          cols: saved?.cols || 80,
          rows: saved?.rows || 24,
        });
      } catch (err) {
        console.error('[ProjectView] auto-checkpoint on close failed:', err);
      }
    }
    if (window.electronAPI) {
      window.electronAPI.terminalKill(tabId);
    }
    removeTab(tabId);
  }, [removeTab, projectPath]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // When focus is in one of the app's OWN text fields (the command bar or a
      // tab-rename input) — but NOT the xterm terminal, which uses a hidden
      // textarea — don't let disruptive shortcuts hijack the keystroke (e.g.
      // Cmd+K wiping the terminal mid-compose, Cmd+W closing during a rename).
      const ae = document.activeElement;
      const inXterm = ae?.classList?.contains?.('xterm-helper-textarea');
      const inAppField = !inXterm && !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);

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
        if (inAppField) return;
        e.preventDefault();
        closeActiveTab();
      } else if (e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === 'g') {
        e.preventDefault();
        toggleGitPanel();
      } else if (e.key === 'k') {
        if (inAppField) return;
        e.preventDefault();
        const termId = useStore.getState().activeTabId;
        if (window.electronAPI && termId) {
          window.electronAPI.terminalWrite(termId, 'clear\r');
        }
      } else if (e.key === 'r' && !e.shiftKey) {
        // Cmd+R = resume last Claude session. Keydown is the reliable path
        // (fires even when the xterm terminal has focus); the menu item shares
        // doResumeLatest's debounce so the two can't double-fire.
        e.preventDefault();
        doResumeLatest();
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
  }, [projectPath, addTab, removeTab, setActiveTab, setActiveView, toggleSidebar, toggleGitPanel, closeActiveTab, doResumeLatest]);

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
      window.electronAPI.onMenuResumeSession?.(() => {
        // Menu "Resume Last Session" — shares the keydown's guarded path.
        doResumeLatest();
      }),
    ];
    return () => cleanups.forEach((fn) => fn?.());
  }, [setActiveView, toggleSidebar, toggleGitPanel, addTab, removeTab, projectPath, closeActiveTab, doResumeLatest]);

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
            {(() => {
              // Single layout engine for all modes. Every TerminalPane mounts ONCE
              // in this container and is positioned purely by CSS — never moved
              // between containers — so neither split nor grid ever unmounts a pane
              // or kills its PTY. The grid is a DENSE list of 1–6 terminals whose
              // tile layout is derived from the count, so there are never empty cells:
              //   1 → full · 2 → side-by-side · 3 → 2 over 1(span) · 4 → 2×2
              //   5 → 2,2,1(span) · 6 → 2×3
              const gridActive = !!gridSlots;
              const n = gridActive ? gridSlots.length : 0;
              const cols = n === 1 ? 1 : 2;
              const rows = Math.max(1, Math.ceil(n / cols));

              // CSS placement for the i-th terminal. An odd final terminal spans
              // the full row so the grid stays gap-free.
              const placement = (i) => {
                if (n === 1) return { gridColumn: '1 / -1', gridRow: 1 };
                if (n > 1 && n % 2 === 1 && i === n - 1) return { gridColumn: '1 / -1', gridRow: rows };
                return { gridColumn: (i % 2) + 1, gridRow: Math.floor(i / 2) + 1 };
              };

              const containerStyle = gridActive
                ? {
                    position: 'relative',
                    display: 'grid',
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
                    gap: 1,
                    backgroundColor: 'var(--border)',
                  }
                : { position: 'relative' };

              const paneStyleFor = (tab) => {
                const isActive = tab.id === activeTabId;
                if (gridActive) {
                  const idx = gridSlots.indexOf(tab.id);
                  if (idx === -1) return { display: 'none' };
                  return {
                    ...placement(idx),
                    position: 'relative',
                    display: 'flex',
                    minWidth: 0,
                    minHeight: 0,
                    paddingTop: 24, // room for the cell header overlay
                    backgroundColor: 'var(--bg)',
                    outline: isActive ? '2px solid var(--accent)' : 'none',
                    outlineOffset: '-2px',
                  };
                }
                if (splitTabId) {
                  if (tab.id === splitTabId) return { position: 'absolute', top: 0, bottom: 0, right: 0, width: '50%', paddingTop: 28, display: 'flex' };
                  if (isActive) return { position: 'absolute', top: 0, bottom: 0, left: 0, width: '50%', display: 'flex' };
                  return { position: 'absolute', inset: 0, display: 'none' };
                }
                return { position: 'absolute', inset: 0, display: isActive ? 'flex' : 'none' };
              };

              // True while dragging a tab that isn't already a grid cell — i.e. one
              // that can be added. (Dragging an existing cell drives reorder instead.)
              const draggingNewTab = !!draggingTabId && (!gridSlots || !gridSlots.includes(draggingTabId));

              return (
                <div className="flex-1 min-h-0 min-w-0" style={containerStyle}>
                  {tabsInitialized && tabs.map((tab) => (
                    <div key={tab.id} style={paneStyleFor(tab)}>
                      <TerminalPane
                        id={tab.id}
                        cwd={tab.projectPath}
                        theme={theme.xtermTheme}
                        claimExisting={tab.id === tearOffTabId}
                      />
                    </div>
                  ))}

                  {/* Split chrome (divider + header) as overlays — pane children
                      never change, so every pane stays mounted. */}
                  {splitTabId && !gridActive && (() => {
                    const splitTab = tabs.find((t) => t.id === splitTabId);
                    if (!splitTab) return null;
                    return (
                      <>
                        <div style={{ position: 'absolute', top: 0, bottom: 0, left: 'calc(50% - 0.5px)', width: 1, backgroundColor: 'var(--border)', zIndex: 5 }} />
                        <div style={{
                          position: 'absolute', top: 0, right: 0, width: '50%', height: 28,
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '0 10px', borderBottom: '1px solid var(--border)',
                          backgroundColor: 'var(--surface)', zIndex: 6,
                        }}>
                          <span style={{ fontSize: 11, fontFamily: "'SF Mono', monospace", color: 'var(--dim)' }}>
                            {splitTab.label}
                          </span>
                          <button
                            onClick={clearSplitTab}
                            title="Exit split view"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--dim)', fontSize: 13, lineHeight: 1, padding: '2px 4px' }}
                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; }}
                          >
                            ✕
                          </button>
                        </div>
                      </>
                    );
                  })()}

                  {/* Grid chrome — one header per terminal (drag to reorder · click to
                      focus · ✕ to remove). Placed at the same cell as its pane and keyed
                      by tabId so it travels with the terminal on reorder. */}
                  {gridActive && gridSlots.map((slotTabId, idx) => {
                    const slotTab = tabs.find((t) => t.id === slotTabId);
                    if (!slotTab) return null;
                    return (
                      <div
                        key={`gh-${slotTabId}`}
                        style={{
                          ...placement(idx), alignSelf: 'start', position: 'relative', zIndex: 6,
                          height: 24, width: '100%', display: 'flex', alignItems: 'center',
                          justifyContent: 'space-between', padding: '0 8px',
                          backgroundColor: 'var(--surface)', borderBottom: '1px solid var(--border)',
                          cursor: 'grab', boxSizing: 'border-box',
                        }}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', slotTabId); setDraggingTabId(slotTabId); }}
                        onDragEnd={() => setDraggingTabId(null)}
                        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const dragged = e.dataTransfer.getData('text/plain') || draggingTabId;
                          if (dragged) {
                            const from = gridSlots.indexOf(dragged);
                            if (from !== -1) swapGrid(from, idx);
                            else addToGrid(dragged);
                          }
                          setDraggingTabId(null);
                        }}
                        onClick={() => setActiveTab(slotTabId)}
                        title="Drag to reorder · click to focus"
                      >
                        <span style={{ fontSize: 11, fontFamily: "'SF Mono', monospace", color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {slotTab.label}
                        </span>
                        <span
                          onClick={(e) => { e.stopPropagation(); removeFromGrid(idx); }}
                          title="Remove from grid"
                          style={{ cursor: 'pointer', color: 'var(--dim)', fontSize: 13, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; }}
                        >
                          ✕
                        </span>
                      </div>
                    );
                  })}

                  {gridActive && (
                    <button
                      onClick={clearGrid}
                      title="Exit grid"
                      style={{
                        position: 'absolute', top: 4, right: 8, zIndex: 20,
                        padding: '2px 8px', fontSize: 11, fontFamily: "'SF Mono', monospace",
                        color: 'var(--dim)', backgroundColor: 'var(--surface)',
                        border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; }}
                    >
                      Exit grid ✕
                    </button>
                  )}

                  {/* Drop affordance — dragging a not-yet-gridded tab reveals one zone
                      covering the area; dropping adds it (opening the grid if needed).
                      This drag-drop is the only way to build the grid. */}
                  {draggingNewTab && (
                    <div
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const dragged = e.dataTransfer.getData('text/plain') || draggingTabId;
                        if (dragged) addToGrid(dragged);
                        setDraggingTabId(null);
                      }}
                      style={{
                        position: 'absolute', inset: 0, zIndex: 30, padding: 12,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        backgroundColor: 'rgba(0,0,0,0.4)',
                      }}
                    >
                      <div style={{
                        width: '60%', height: '60%', maxWidth: 420, maxHeight: 260,
                        border: '2px dashed rgba(255,255,255,0.55)', borderRadius: 10,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'rgba(255,255,255,0.92)', fontSize: 13, fontFamily: "'SF Mono', monospace",
                        textAlign: 'center', padding: 16,
                      }}>
                        {gridActive
                          ? (n >= 6 ? 'Grid is full (6 max)' : 'Drop to add to the grid')
                          : 'Drop to open this terminal in a grid'}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
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
