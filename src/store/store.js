import { create } from 'zustand';
import { THEMES, applyTheme } from '../lib/themes';

// Drop any grid entries whose tab is no longer present. Returns null when the
// grid would be left empty (i.e. grid mode turns off). gridSlots is a dense,
// ordered list of tabIds (1–6) — no gaps — so the layout auto-fits the count.
function pruneGrid(gridSlots, keptIds) {
  if (!gridSlots) return null;
  const pruned = gridSlots.filter((id) => keptIds.has(id));
  return pruned.length ? pruned : null;
}

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

  // Monitors — tab IDs the user is watching ("monitor this terminal").
  // Active/idle is derived from the tab's running process, not stored here.
  monitoredTabs: [],
  toggleMonitor: (tabId) => set((s) => ({
    monitoredTabs: s.monitoredTabs.includes(tabId)
      ? s.monitoredTabs.filter((id) => id !== tabId)
      : [...s.monitoredTabs, tabId],
  })),

  // Terminal tabs
  terminalTabs: [],
  activeTabId: null,
  tabCounter: 0,
  splitTabId: null,

  // Terminal grid — null when off; otherwise a dense, ordered list of 1–6 tabIds.
  // The tile layout is derived from the count (no empty cells). Split view and
  // grid are mutually exclusive. Drag-to-add is the only way in.
  gridSlots: null,

  // tabId currently being dragged from the tab bar (drives grid drop zones).
  draggingTabId: null,
  setDraggingTabId: (id) => set({ draggingTabId: id }),

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
    // Clean up any running agents associated with this tab — prune BOTH
    // runningAgents and agentActivity (otherwise stale activity entries leak
    // and the activity UI keeps rendering agents for a closed tab).
    const ra = { ...state.runningAgents };
    const aa = { ...state.agentActivity };
    for (const key of Object.keys(ra)) {
      if (ra[key] === tabId) { delete ra[key]; delete aa[key]; }
    }
    set({
      terminalTabs: tabs,
      activeTabId: newActive,
      runningAgents: ra,
      agentActivity: aa,
      splitTabId: state.splitTabId === tabId ? null : state.splitTabId,
      gridSlots: pruneGrid(state.gridSlots, new Set(tabs.map((t) => t.id))),
      monitoredTabs: state.monitoredTabs.filter((id) => id !== tabId),
    });
  },

  setSplitTab: (tabId) => set({ splitTabId: tabId, gridSlots: null }),
  clearSplitTab: () => set({ splitTabId: null }),

  // Grid actions ----------------------------------------------------------
  // Append a tab to the grid (max 6), starting grid mode if needed. A tab can
  // only appear once. Clears split view (mutually exclusive).
  addToGrid: (tabId) => set((s) => {
    if (!tabId) return {};
    const cur = s.gridSlots || [];
    if (cur.includes(tabId)) return { splitTabId: null, activeTabId: tabId };
    if (cur.length >= 6) return {};
    return { gridSlots: [...cur, tabId], splitTabId: null, activeTabId: tabId };
  }),

  // Swap two cells by index (dragging one cell's header onto another).
  swapGrid: (a, b) => set((s) => {
    if (!s.gridSlots || a === b) return {};
    if (a < 0 || b < 0 || a >= s.gridSlots.length || b >= s.gridSlots.length) return {};
    const slots = [...s.gridSlots];
    [slots[a], slots[b]] = [slots[b], slots[a]];
    return { gridSlots: slots };
  }),

  // Remove a cell by index; the grid compacts and reflows. Exits grid mode
  // when the last cell is removed.
  removeFromGrid: (index) => set((s) => {
    if (!s.gridSlots) return {};
    const slots = s.gridSlots.filter((_, i) => i !== index);
    return { gridSlots: slots.length ? slots : null };
  }),

  clearGrid: () => set({ gridSlots: null }),

  // Restore a persisted layout (already validated against live tabs by caller).
  setGridSlots: (slots) => set({ gridSlots: slots }),

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
    const aa = { ...state.agentActivity };
    for (const key of Object.keys(ra)) {
      if (removedIds.has(ra[key])) { delete ra[key]; delete aa[key]; }
    }
    set({ terminalTabs: kept, activeTabId: tabId, runningAgents: ra, agentActivity: aa, gridSlots: pruneGrid(state.gridSlots, new Set(kept.map((t) => t.id))), monitoredTabs: state.monitoredTabs.filter((id) => !removedIds.has(id)) });
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
    const aa = { ...state.agentActivity };
    for (const key of Object.keys(ra)) {
      if (removedIds.has(ra[key])) { delete ra[key]; delete aa[key]; }
    }
    const allKept = [...kept, ...pinnedRight];
    const newActive = allKept.find((t) => t.id === state.activeTabId) ? state.activeTabId : tabId;
    set({ terminalTabs: allKept, activeTabId: newActive, runningAgents: ra, agentActivity: aa, gridSlots: pruneGrid(state.gridSlots, new Set(allKept.map((t) => t.id))), monitoredTabs: state.monitoredTabs.filter((id) => !removedIds.has(id)) });
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

  currentIsWorktree: false,
  setCurrentIsWorktree: (v) => set({ currentIsWorktree: !!v }),

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
    // Tier 1 capture: link this session to the tab it is being resumed into,
    // so the Cmd+B sidebar can show which tab the session belongs to.
    window.electronAPI.configSetSessionTabLink?.(sessionId, termId, get().currentProjectPath);
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
