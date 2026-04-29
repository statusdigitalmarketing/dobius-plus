import { create } from 'zustand';
import { THEMES, applyTheme } from '../lib/themes';

export const useStore = create((set, get) => ({
  // View state
  activeView: 'terminal', // 'terminal' | 'dashboard'
  sidebarVisible: false,
  gitPanelVisible: false,
  dashboardTab: 'overview',

  // Theme
  themeIndex: 0,

  // Data
  currentProjectPath: null,
  sessions: [],
  activeProcesses: [],
  buildComplete: false,

  // Terminal tabs
  terminalTabs: [],
  activeTabId: null,
  tabCounter: 0,

  // Running agents: Map<agentId, tabId>
  runningAgents: {},

  // Agent activity: Map<agentId, { status, lastActivity, linesProcessed, startTime, currentAction }>
  agentActivity: {},

  // Activity timeline: chronological feed of agent actions (max 100)
  activityTimeline: [],

  // Recently closed tabs (stack, max 10) for Cmd+Shift+T reopen
  recentlyClosedTabs: [],

  // Active orchestration run (or null)
  activeOrchestration: null,

  // Board notification
  boardNotification: null,

  // Tab actions
  addTab: (projectPath) => {
    const state = get();
    const counter = state.tabCounter + 1;
    const id = projectPath ? `term-${projectPath}-${counter}` : `term-main-${counter}`;
    const tab = { id, label: `Tab ${counter}`, projectPath, createdAt: Date.now() };
    set({
      terminalTabs: [...state.terminalTabs, tab],
      activeTabId: id,
      tabCounter: counter,
    });
    return tab;
  },

  removeTab: (tabId) => {
    const state = get();
    const tabs = state.terminalTabs.filter((t) => t.id !== tabId);
    if (tabs.length === 0) return; // don't remove last tab
    const newActive = state.activeTabId === tabId
      ? tabs[Math.max(0, state.terminalTabs.findIndex((t) => t.id === tabId) - 1)]?.id || tabs[0]?.id
      : state.activeTabId;
    // Clean up any running agents associated with this tab
    const ra = { ...state.runningAgents };
    for (const key of Object.keys(ra)) {
      if (ra[key] === tabId) delete ra[key];
    }
    set({ terminalTabs: tabs, activeTabId: newActive, runningAgents: ra });
  },


  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  renameTab: (tabId, label) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) => t.id === tabId ? { ...t, label } : t),
  })),

  togglePinTab: (tabId) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) => t.id === tabId ? { ...t, pinned: !t.pinned } : t),
  })),

  initTabs: (tabs, counter) => set({
    terminalTabs: tabs,
    activeTabId: tabs.length > 0 ? tabs[0].id : null,
    tabCounter: counter,
  }),

  reorderTabs: (fromIndex, toIndex) => set((s) => {
    const tabs = [...s.terminalTabs];
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(toIndex, 0, moved);
    return { terminalTabs: tabs };
  }),

  closeOtherTabs: (tabId) => {
    const state = get();
    // Keep the target tab AND any pinned tabs
    const kept = state.terminalTabs.filter((t) => t.id === tabId || t.pinned);
    if (kept.length === 0) return;
    const removed = state.terminalTabs.filter((t) => t.id !== tabId && !t.pinned);
    removed.forEach((t) => window.electronAPI?.terminalKill(t.id));
    const removedIds = new Set(removed.map((t) => t.id));
    const ra = { ...state.runningAgents };
    for (const key of Object.keys(ra)) {
      if (removedIds.has(ra[key])) delete ra[key];
    }
    set({ terminalTabs: kept, activeTabId: tabId, runningAgents: ra });
  },

  closeTabsToRight: (tabId) => {
    const state = get();
    const idx = state.terminalTabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const kept = state.terminalTabs.slice(0, idx + 1);
    // Preserve pinned tabs that are to the right
    const rightTabs = state.terminalTabs.slice(idx + 1);
    const pinnedRight = rightTabs.filter((t) => t.pinned);
    const removed = rightTabs.filter((t) => !t.pinned);
    removed.forEach((t) => window.electronAPI?.terminalKill(t.id));
    const removedIds = new Set(removed.map((t) => t.id));
    const ra = { ...state.runningAgents };
    for (const key of Object.keys(ra)) {
      if (removedIds.has(ra[key])) delete ra[key];
    }
    const allKept = [...kept, ...pinnedRight];
    const newActive = allKept.find((t) => t.id === state.activeTabId) ? state.activeTabId : tabId;
    set({ terminalTabs: allKept, activeTabId: newActive, runningAgents: ra });
  },

  // Actions
  setActiveView: (view) => set({ activeView: view }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  toggleGitPanel: () => set((s) => ({ gitPanelVisible: !s.gitPanelVisible })),
  setDashboardTab: (tab) => set({ dashboardTab: tab }),

  setThemeIndex: (index) => {
    const theme = THEMES[index % THEMES.length];
    applyTheme(theme);
    set({ themeIndex: index % THEMES.length });
  },

  setCurrentProjectPath: (p) => set({ currentProjectPath: p }),

  currentBranch: '',
  setCurrentBranch: (b) => set({ currentBranch: b || '' }),

  setSessions: (sessions) => set({ sessions }),
  setActiveProcesses: (procs) => set({ activeProcesses: procs }),
  setBuildComplete: (val) => set({ buildComplete: val }),

  // Running agent tracking
  registerRunningAgent: (agentId, tabId) => set((s) => ({
    runningAgents: { ...s.runningAgents, [agentId]: tabId },
  })),

  unregisterAgentsByTabId: (tabId) => set((s) => {
    const ra = { ...s.runningAgents };
    const aa = { ...s.agentActivity };
    for (const key of Object.keys(ra)) {
      if (ra[key] === tabId) {
        delete ra[key];
        delete aa[key];
      }
    }
    return { runningAgents: ra, agentActivity: aa };
  }),

  // Agent activity tracking
  updateAgentActivity: (agentId, activity) => set((s) => ({
    agentActivity: {
      ...s.agentActivity,
      [agentId]: { ...s.agentActivity[agentId], ...activity },
    },
  })),

  clearAgentActivity: (agentId) => set((s) => {
    const aa = { ...s.agentActivity };
    delete aa[agentId];
    return { agentActivity: aa };
  }),

  // Activity timeline (max 100 entries, FIFO)
  appendActivityTimeline: (entry) => set((s) => {
    const timeline = [...s.activityTimeline, entry];
    if (timeline.length > 100) timeline.shift();
    return { activityTimeline: timeline };
  }),

  // Orchestration
  setActiveOrchestration: (run) => set({ activeOrchestration: run }),
  updateSubtaskStatus: (subtaskId, updates) => set((s) => {
    if (!s.activeOrchestration) return {};
    const subtasks = s.activeOrchestration.subtasks.map((st) =>
      st.id === subtaskId ? { ...st, ...updates } : st
    );
    return { activeOrchestration: { ...s.activeOrchestration, subtasks } };
  }),
  clearOrchestration: () => set({ activeOrchestration: null }),

  // Board notifications
  setBoardNotification: (notification) => set({ boardNotification: notification }),
  clearBoardNotification: () => set({ boardNotification: null }),

  // Recently closed tabs (persisted to config for cross-session recovery)
  pushClosedTab: (closedTab) => set((s) => {
    const entry = { ...closedTab, closedAt: Date.now() };
    const stack = [entry, ...s.recentlyClosedTabs].slice(0, 20);
    // Persist to config
    const projectPath = s.currentProjectPath;
    if (projectPath && window.electronAPI?.terminalSaveClosedTabs) {
      window.electronAPI.terminalSaveClosedTabs(projectPath, stack);
    }
    return { recentlyClosedTabs: stack };
  }),

  initClosedTabs: (closedTabs) => set({ recentlyClosedTabs: closedTabs || [] }),

  reopenClosedTab: (index = 0) => {
    const state = get();
    if (state.recentlyClosedTabs.length === 0) return null;
    const idx = Math.min(index, state.recentlyClosedTabs.length - 1);
    const closed = state.recentlyClosedTabs[idx];
    const rest = state.recentlyClosedTabs.filter((_, i) => i !== idx);
    const counter = state.tabCounter + 1;
    const id = closed.projectPath ? `term-${closed.projectPath}-${counter}` : `term-main-${counter}`;
    const tab = { id, label: closed.label, projectPath: closed.projectPath, createdAt: Date.now() };
    set({
      recentlyClosedTabs: rest,
      terminalTabs: [...state.terminalTabs, tab],
      activeTabId: id,
      tabCounter: counter,
    });
    // Persist updated closed tabs list
    const projectPath = state.currentProjectPath;
    if (projectPath && window.electronAPI?.terminalSaveClosedTabs) {
      window.electronAPI.terminalSaveClosedTabs(projectPath, rest);
    }
    // Return the new tab + saved scrollback so the caller can restore it
    return { tab, scrollback: closed.scrollback };
  },

  // Resume a Claude session by sending the resume command to the active terminal
  resumeSession: (sessionId) => {
    if (!sessionId || sessionId.length > 100 || !/^[a-zA-Z0-9][\w-]*$/.test(sessionId)) return;
    set({ activeView: 'terminal' });
    const termId = get().activeTabId;
    if (!window.electronAPI || !termId) return;
    const cmd = `claude --resume ${sessionId}`;
    const chars = cmd.split('');
    chars.push('\r');
    let i = 0;
    const sendNext = () => {
      if (i < chars.length) {
        window.electronAPI.terminalWrite(termId, chars[i]);
        i++;
        if (i < chars.length) {
          setTimeout(sendNext, 8);
        }
      }
    };
    setTimeout(sendNext, 15);
  },
}));
