import { create } from 'zustand';
import { THEMES, applyTheme } from '../lib/themes';
import { groupByStage } from '../lib/stages';

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
  splitRatio: 0.5,

  // Terminal grid — null when off; otherwise a dense, ordered list of 1–6 tabIds.
  // The tile layout is derived from the count (no empty cells). Split view and
  // grid are mutually exclusive. Drag-to-add is the only way in.
  gridSlots: null,
  gridColumnRatio: 0.5,
  gridRowRatios: [],

  // tabId currently being dragged from the tab bar (drives grid drop zones).
  draggingTabId: null,
  setDraggingTabId: (id) => set({ draggingTabId: id }),

  // Running agents: Map<agentId, tabId>
  runningAgents: {},

  // Agent activity: Map<agentId, { status, lastActivity, linesProcessed, startTime, currentAction }>
  agentActivity: {},

  // Terminal-tab status: Map<tabId, 'working' | 'done' | 'needs'>. Drives the
  // text-message-style status dot on each tab (yellow = working, green = done,
  // red = needs your response). Ephemeral runtime state — intentionally NOT
  // persisted to config or stored on the tab object.
  tabStatus: {},
  // Tabs whose current status came from the OSC hook (PreToolUse/UserPromptSubmit/
  // Stop). useTabActivity's quiet-output settler ignores these — only the hook
  // can clear hook-owned status, so a long quiet tool call no longer flips
  // 'working' → 'done' while Claude is mid-turn.
  hookOwnedTabs: {},
  setTabStatus: (tabId, status) => set((s) => {
    if (!tabId || s.tabStatus[tabId] === status) return {};
    return { tabStatus: { ...s.tabStatus, [tabId]: status } };
  }),
  // OSC handler calls this. Hook-owned 'working' / 'needs' survive quiet
  // output; hook-owned 'done' releases ownership so the next inferred working
  // tracks normally.
  markHookOwned: (tabId, status) => set((s) => {
    if (!tabId) return {};
    const next = { ...s.hookOwnedTabs };
    if (status === 'working' || status === 'needs') next[tabId] = true;
    else delete next[tabId]; // 'done' or anything else releases the claim
    return { hookOwnedTabs: next };
  }),

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
    // kind:'terminal' is the default and (load-bearing) — every existing
    // tab persisted before v1.0.25 has no kind field, so the dispatcher in
    // ProjectView treats undefined as 'terminal' (backwards compatible).
    const tab = { id, label: `Tab ${counter}`, projectPath, kind: 'terminal', createdAt: Date.now() };
    set({
      terminalTabs: [...state.terminalTabs, tab],
      activeTabId: id,
      tabCounter: counter,
    });
    return tab;
  },

  // Add a browser pane (embedded webview). Slots into the same terminalTabs
  // list as terminal tabs — the layout engine in ProjectView treats them
  // uniformly except for which component renders inside the pane.
  addBrowserTab: (projectPath, url) => {
    const state = get();
    const counter = state.tabCounter + 1;
    const id = projectPath ? `term-${projectPath}-${counter}` : `term-main-${counter}`;
    const safeUrl = (typeof url === 'string' && url.trim()) ? url.trim() : 'http://localhost:5173';
    const tab = {
      id,
      label: 'Browser',
      projectPath,
      kind: 'browser',
      url: safeUrl,
      createdAt: Date.now(),
    };
    set({
      terminalTabs: [...state.terminalTabs, tab],
      activeTabId: id,
      tabCounter: counter,
    });
    return tab;
  },

  // Update the URL stored on a browser tab — called when the user navigates
  // inside the webview so the persisted state matches what's on screen.
  updateTabUrl: (tabId, url) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) =>
      t.id === tabId && t.kind === 'browser' ? { ...t, url } : t),
  })),

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
    const ts = { ...state.tabStatus };
    delete ts[tabId];
    // Also prune hookOwnedTabs — otherwise a closed-then-reopened tab id
    // (collision after high tabCounter wrap, or torn-off tab re-attaching)
    // could inherit stale hook ownership and never settle.
    // Codex audit MED (store.js:159).
    const hot = { ...state.hookOwnedTabs };
    delete hot[tabId];
    set({
      terminalTabs: tabs,
      activeTabId: newActive,
      runningAgents: ra,
      agentActivity: aa,
      tabStatus: ts,
      hookOwnedTabs: hot,
      splitTabId: state.splitTabId === tabId ? null : state.splitTabId,
      gridSlots: pruneGrid(state.gridSlots, new Set(tabs.map((t) => t.id))),
      monitoredTabs: state.monitoredTabs.filter((id) => id !== tabId),
    });
  },

  setSplitTab: (tabId) => set({ splitTabId: tabId, gridSlots: null }),
  clearSplitTab: () => set({ splitTabId: null }),
  setSplitRatio: (ratio) => set({ splitRatio: Math.min(0.8, Math.max(0.2, Number(ratio) || 0.5)) }),
  setGridColumnRatio: (ratio) => set({ gridColumnRatio: Math.min(0.8, Math.max(0.2, Number(ratio) || 0.5)) }),
  setGridRowRatios: (ratios) => set({
    gridRowRatios: Array.isArray(ratios)
      ? ratios.map((r) => Math.max(0.12, Number(r) || 0)).filter((r) => r > 0)
      : [],
  }),

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
  // when the last cell is removed. If the removed cell held the active tab,
  // reseat activeTabId onto a surviving grid cell so paneStyleFor doesn't
  // hide it (otherwise input/paste/git polling routes to an invisible tab).
  removeFromGrid: (index) => set((s) => {
    if (!s.gridSlots) return {};
    const removedTabId = s.gridSlots[index];
    const slots = s.gridSlots.filter((_, i) => i !== index);
    const next = { gridSlots: slots.length ? slots : null };
    if (removedTabId === s.activeTabId && slots.length) {
      // Pick the cell that took the removed cell's index, or the last cell.
      next.activeTabId = slots[index] || slots[slots.length - 1];
    }
    return next;
  }),

  clearGrid: () => set({ gridSlots: null }),

  // Restore a persisted layout (already validated against live tabs by caller).
  setGridSlots: (slots) => set({ gridSlots: slots }),

  // Validate against the current tabs list to avoid routing input/git polling
  // to a tab id that doesn't exist (Codex audit MED: store.js:217). Accept
  // null to deliberately clear; reject unknown ids silently to preserve
  // existing state rather than blow up on a stale caller.
  setActiveTab: (tabId) => set((s) => {
    if (tabId === null || tabId === undefined) return { activeTabId: null };
    if (typeof tabId !== 'string') return {};
    if (!s.terminalTabs.some((t) => t.id === tabId)) return {};
    return { activeTabId: tabId };
  }),

  renameTab: (tabId, label) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) => t.id === tabId ? { ...t, label } : t),
  })),

  togglePinTab: (tabId) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) => t.id === tabId ? { ...t, pinned: !t.pinned } : t),
  })),

  // Replacing terminalTabs wholesale (e.g. switching project or restoring a
  // window) MUST also prune every map keyed by tab id. Without this, the
  // store carries split/grid/runningAgents/hookOwnedTabs/etc from the
  // previous project, and the next render references tab ids that don't
  // exist. Codex audit HIGH (store.js:227).
  initTabs: (tabs, counter) => set((s) => {
    const liveIds = new Set(tabs.map((t) => t.id));
    // tabStatus + hookOwnedTabs are keyed by tab id directly.
    const pruneByTabId = (obj) => {
      const next = {};
      for (const [k, v] of Object.entries(obj || {})) if (liveIds.has(k)) next[k] = v;
      return next;
    };
    // runningAgents is { agentId: tabId } — keep entries whose tabId is live.
    const liveAgentIds = new Set();
    const ra = {};
    for (const [agentId, tabId] of Object.entries(s.runningAgents || {})) {
      if (liveIds.has(tabId)) { ra[agentId] = tabId; liveAgentIds.add(agentId); }
    }
    // agentActivity is { agentId: activityObject } — keep entries whose
    // agentId still has a live running tab. Codex round-2 MED on
    // store.js:255 (the old `pruneAgentMap` treated activity OBJECTS as if
    // they were tab ids, dropping all activity on every init).
    const aa = {};
    for (const [agentId, activity] of Object.entries(s.agentActivity || {})) {
      if (liveAgentIds.has(agentId)) aa[agentId] = activity;
    }
    return {
      terminalTabs: tabs,
      activeTabId: tabs.length > 0 ? tabs[0].id : null,
      tabCounter: counter,
      splitTabId: s.splitTabId && liveIds.has(s.splitTabId) ? s.splitTabId : null,
      gridSlots: pruneGrid(s.gridSlots, liveIds),
      runningAgents: ra,
      agentActivity: aa,
      tabStatus: pruneByTabId(s.tabStatus),
      hookOwnedTabs: pruneByTabId(s.hookOwnedTabs),
      monitoredTabs: (s.monitoredTabs || []).filter((id) => liveIds.has(id)),
    };
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
    const ts = { ...state.tabStatus };
    for (const id of removedIds) delete ts[id];
    const hot = { ...state.hookOwnedTabs };
    for (const id of removedIds) delete hot[id];
    // Clear splitTabId if the split pane was killed — otherwise the layout
    // stays stuck in split mode pointing at a dead tab and the surviving
    // active terminal is constrained to half-width with no header to exit.
    const splitTabId = removedIds.has(state.splitTabId) ? null : state.splitTabId;
    set({ terminalTabs: kept, activeTabId: tabId, splitTabId, runningAgents: ra, agentActivity: aa, tabStatus: ts, hookOwnedTabs: hot, gridSlots: pruneGrid(state.gridSlots, new Set(kept.map((t) => t.id))), monitoredTabs: state.monitoredTabs.filter((id) => !removedIds.has(id)) });
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
    const ts = { ...state.tabStatus };
    for (const id of removedIds) delete ts[id];
    const hot = { ...state.hookOwnedTabs };
    for (const id of removedIds) delete hot[id];
    const allKept = [...kept, ...pinnedRight];
    const newActive = allKept.find((t) => t.id === state.activeTabId) ? state.activeTabId : tabId;
    // Same split-cleanup as closeOtherTabs — kill the split pointer if the
    // tab it referenced just got removed.
    const splitTabId = removedIds.has(state.splitTabId) ? null : state.splitTabId;
    set({ terminalTabs: allKept, activeTabId: newActive, splitTabId, runningAgents: ra, agentActivity: aa, tabStatus: ts, hookOwnedTabs: hot, gridSlots: pruneGrid(state.gridSlots, new Set(allKept.map((t) => t.id))), monitoredTabs: state.monitoredTabs.filter((id) => !removedIds.has(id)) });
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

  currentDetached: false,
  setCurrentDetached: (v) => set({ currentDetached: !!v }),

  // Fork checkout (origin + upstream remotes) — labeled distinctly from a plain branch.
  currentIsFork: false,
  setCurrentIsFork: (v) => set({ currentIsFork: !!v }),

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

  // Pipeline tasks (Epic 7 — Kanban board). The stage mutations go through the
  // main process, which enforces the transition table and broadcasts
  // `tasks:updated`; the UI subscribes to that and calls loadTasks to refresh.
  // The mutators RETURN the service result ({ ok, task } | { ok:false, error })
  // so the UI can snap an illegal drop back instead of crashing.
  tasks: [],
  loadTasks: async (projectPath) => {
    const r = await window.electronAPI.tasksList(projectPath);
    set({ tasks: Array.isArray(r) ? r : [] });
  },
  setTaskStage: async (projectPath, taskId, toStage, opts) => {
    return window.electronAPI.tasksAdvance(projectPath, taskId, toStage, opts || { actor: 'human' });
  },
  blockTask: async (projectPath, taskId, reason) => {
    return window.electronAPI.tasksBlock(projectPath, taskId, reason, { actor: 'human' });
  },
  unblockTask: async (projectPath, taskId, opts) => {
    return window.electronAPI.tasksUnblock(projectPath, taskId, opts || { actor: 'human' });
  },
  tasksByStage: () => groupByStage(get().tasks),

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
