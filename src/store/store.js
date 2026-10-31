import { create } from 'zustand';
import { THEMES, applyTheme } from '../lib/themes';
import { groupByStage } from '../lib/stages';
import { makeTabId } from '../lib/tab-id';
import { onScreenTabIds, becomesUnread, clearSeen } from '../lib/tab-unread';
import { windowFocused } from '../lib/window-focus';
import { latestSessionForTab } from '../../shared/session-tab.js';
import { applyAutoLabel, lockLabel, unlockLabel } from '../../shared/tab-label.js';
import { NEW_TAB_TOOLS, resumeNeedsNewTab } from '../../shared/new-tab.js';
import { setPendingLaunch, clearPendingLaunches } from '../lib/pending-launch';


// Drop any grid entries whose tab is no longer present. Returns null when the
// grid would be left empty (i.e. grid mode turns off). gridSlots is a dense,
// ordered list of tabIds (1–6) — no gaps — so the layout auto-fits the count.
// The next tab number whose id is not already a tab here. A tab docked back
// from a tear-off keeps its id, which a tear-off numbers from a random offset
// in this same id space.
function nextFreeCounter(state, projectPath) {
  let counter = state.tabCounter + 1;
  while (state.terminalTabs.some((t) => t.id === makeTabId(projectPath, counter, idSpace(state)))) counter += 1;
  return counter;
}

// The id space new tabs are numbered in: an extra window's key, or a
// tear-off's own key (so its tabs never collide with a primary's).
function idSpace(state) {
  return state.tabIdSpace || state.windowKey;
}

// New Tab requests made before this window's tabs were restored (openNewTab).
const queuedNewTabs = [];

function pruneGrid(gridSlots, keptIds) {
  if (!gridSlots) return null;
  const pruned = gridSlots.filter((id) => keptIds.has(id));
  return pruned.length ? pruned : null;
}

// Resolve the tab that terminal writes (inject prompt, resume, restore) should
// target. The active tab may be a BROWSER tab, which has no PTY, so a write to
// it is silently dropped. Return the active tab when it's a terminal, else fall
// back to the most recent terminal tab, else null. Audit Medium.
function resolveActiveTerminalTabId(state) {
  const tabs = state.terminalTabs || [];
  const active = tabs.find((t) => t.id === state.activeTabId);
  if (active && (active.kind || 'terminal') === 'terminal') return active.id;
  const terms = tabs.filter((t) => (t.kind || 'terminal') === 'terminal');
  return terms.length ? terms[terms.length - 1].id : null;
}

export const useStore = create((set, get) => ({
  // View state
  activeView: 'terminal', // 'terminal' | 'dashboard'
  sidebarVisible: false,
  gitPanelVisible: false,
  // Right-side tool panel opened from the TopBar Terminal dropdown (v1.0.52):
  // null | 'files' | 'gittree'. One at a time; independent of the Cmd+G panel.
  toolPanel: null,
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
  // windowKey (v1.0.66): identifies an EXTRA primary window so its tab ids are
  // globally unique across windows of the same project. 'main'/null = the first
  // window, which keeps the legacy `term-<path>-<n>` id (zero migration). Set
  // once by ProjectView from the URL. See tabId() below.
  windowKey: null,
  setWindowKey: (windowKey) => set({ windowKey: windowKey || null }),
  // Tear-off windows only: numbers their new tabs apart from every primary
  // window. Ids only, never a persistence key (that stays windowKey).
  tabIdSpace: null,
  setTabIdSpace: (key) => set({ tabIdSpace: key || null }),
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
  // tabId -> epoch ms the OSC hook last set 'done'. useTabActivity uses this to
  // avoid clobbering a just-finished managed turn's green dot back to yellow:
  // the 'done' marker's own trailing bytes also hit the output listener, and
  // without this guard the quiet settler would then turn the tab gray. Genuine
  // plain-shell activity after the window still flows yellow -> gray.
  recentHookDone: {},
  // tabId -> true: Claude finished a turn there while it was off screen or the
  // window was unfocused. Cleared by markTabsSeen (ProjectView) once the tab is
  // on screen in a focused window. Ephemeral, like tabStatus.
  unreadTabs: {},
  // opts.fromHook: the status came from the Claude hook's OSC marker
  // (useTerminal), the only source whose 'done' means a turn finished.
  setTabStatus: (tabId, status, opts) => set((s) => {
    if (!tabId) return {};
    // Decided BEFORE the unchanged-status early return: another writer may
    // already show 'done'. hookOwnedTabs is still set here for a real turn:
    // the OSC handler calls setTabStatus('done') BEFORE markHookOwned('done')
    // releases it.
    const seen = windowFocused() && onScreenTabIds(s).has(tabId);
    const unread = !s.unreadTabs[tabId] && becomesUnread(status, seen, s.hookOwnedTabs[tabId], opts?.fromHook);
    const out = {};
    if (s.tabStatus[tabId] !== status) out.tabStatus = { ...s.tabStatus, [tabId]: status };
    if (unread) out.unreadTabs = { ...s.unreadTabs, [tabId]: true };
    return out;
  }),
  markTabsSeen: (seenIds) => set((s) => {
    const next = clearSeen(s.unreadTabs, seenIds);
    return next === s.unreadTabs ? {} : { unreadTabs: next };
  }),
  // OSC handler calls this. Hook-owned 'working' / 'needs' survive quiet
  // output; hook-owned 'done' releases ownership so the next inferred working
  // tracks normally.
  markHookOwned: (tabId, status) => set((s) => {
    if (!tabId) return {};
    const next = { ...s.hookOwnedTabs };
    const done = { ...s.recentHookDone };
    if (status === 'working' || status === 'needs') { next[tabId] = true; delete done[tabId]; }
    else { delete next[tabId]; if (status === 'done') done[tabId] = Date.now(); } // release + stamp
    return { hookOwnedTabs: next, recentHookDone: done };
  }),

  // Activity timeline: chronological feed of agent actions (max 100)
  activityTimeline: [],

  // Recently closed tabs (stack, max 10) for Cmd+Shift+T reopen
  recentlyClosedTabs: [],

  // Active orchestration run (or null)
  activeOrchestration: null,

  // Board notification
  boardNotification: null,

  // The New Tab project picker, opened by the tab bar's + button.
  newTabPickerOpen: false,
  setNewTabPickerOpen: (open) => set({ newTabPickerOpen: !!open }),

  // Tab actions
  addTab: (projectPath) => {
    const state = get();
    const counter = nextFreeCounter(state, projectPath);
    const id = makeTabId(projectPath, counter, idSpace(state));
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

  // New Tab (the + picker, Cmd+T, the menu, the palette): a terminal tab that
  // starts the tool chosen in Settings (Claude Code by default) in its project.
  // `tool` ('claude' | 'codex' | 'shell') overrides the setting. Every other
  // addTab caller (reopen, agents, checkpoints, orchestrator, restored tabs)
  // types its own command or none, so it must not come through here.
  // Before the window's saved tabs are restored the request waits (a tab made
  // then could share an id with a restored one) and opens once they are;
  // it returns null in that case.
  openNewTab: (projectPath, tool) => {
    if (!get().tabsReady) { queuedNewTabs.push([projectPath, tool]); return null; }
    const tab = get().addTab(projectPath);
    // main reads the setting at spawn ('default'); an unknown tool starts nothing.
    const launch = tool === undefined ? 'default' : (NEW_TAB_TOOLS.includes(tool) ? tool : 'shell');
    setPendingLaunch(tab.id, launch);
    // Its shell is about to start a tool: nothing may be typed at it for now
    // (resumeNeedsNewTab). 'default' may turn out to be a plain shell: harmless.
    if (launch !== 'shell') {
      set((s) => ({ terminalTabs: s.terminalTabs.map((t) => (t.id === tab.id ? { ...t, startsTool: true } : t)) }));
    }
    return tab;
  },

  // Set once this window's tabs are restored (or it starts fresh).
  tabsReady: false,
  markTabsReady: () => {
    if (get().tabsReady) return;
    set({ tabsReady: true });
    for (const [projectPath, tool] of queuedNewTabs.splice(0)) get().openNewTab(projectPath, tool);
  },

  // Add a browser pane (embedded webview). Slots into the same terminalTabs
  // list as terminal tabs — the layout engine in ProjectView treats them
  // uniformly except for which component renders inside the pane.
  addBrowserTab: (projectPath, url) => {
    const state = get();
    const counter = nextFreeCounter(state, projectPath);
    const id = makeTabId(projectPath, counter, idSpace(state));
    // Scheme guard: only http/https survive. javascript:/file:/data: would
    // otherwise be passed straight to <webview src>. PR#3 r1 LOW.
    const candidate = (typeof url === 'string' && url.trim()) ? url.trim() : '';
    const safeUrl = /^https?:\/\//i.test(candidate) ? candidate : 'http://localhost:5173';
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

  // A tab docked back from a tear-off window, keeping its id (its PTY, session
  // links and scrollback are keyed by it). Returns false for a duplicate.
  adoptTab: (tab, status, hookOwned) => {
    const state = get();
    if (!tab?.id || state.terminalTabs.some((t) => t.id === tab.id)) return false;
    // Its id is in this window's id space only if it was born here (so below
    // the counter), else in a tear-off's own space: never handed out here.
    set({
      terminalTabs: [...state.terminalTabs, tab],
      tabStatus: status ? { ...state.tabStatus, [tab.id]: status } : state.tabStatus,
      hookOwnedTabs: hookOwned ? { ...state.hookOwnedTabs, [tab.id]: true } : state.hookOwnedTabs,
    });
    get().showTab(tab.id);
    return true;
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
    const ts = { ...state.tabStatus };
    delete ts[tabId];
    // Also prune hookOwnedTabs — otherwise a closed-then-reopened tab id
    // (collision after high tabCounter wrap, or torn-off tab re-attaching)
    // could inherit stale hook ownership and never settle.
    // Codex audit MED (store.js:159).
    const hot = { ...state.hookOwnedTabs };
    delete hot[tabId];
    const rhd = { ...state.recentHookDone };
    delete rhd[tabId];
    const unread = clearSeen(state.unreadTabs, new Set([tabId]));
    set({
      terminalTabs: tabs,
      activeTabId: newActive,
      runningAgents: ra,
      agentActivity: aa,
      tabStatus: ts,
      hookOwnedTabs: hot,
      recentHookDone: rhd,
      unreadTabs: unread,
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

  // "I want to see this tab": leave split if it is the split's right pane and
  // leave grid if it is not a grid cell, otherwise the split guard reverts the
  // selection or the tab activates while display:none.
  showTab: (tabId) => {
    const s = get();
    if (tabId === s.splitTabId) s.clearSplitTab();
    if (s.gridSlots && !s.gridSlots.includes(tabId)) s.setGridSlots(null);
    get().setActiveTab(tabId);
  },

  // A deliberate rename (tab bar edit, agent launch) locks the label so the
  // automatic sources below never overwrite it.
  renameTab: (tabId, label) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) => t.id === tabId ? lockLabel(t, label) : t),
  })),

  // Terminal or Chat (the readable transcript view over the same PTY). Stored
  // on the tab so it survives a restart, tear-off, dock and reopen.
  setTabViewMode: (tabId, mode) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) => {
      if (t.id !== tabId) return t;
      if (mode === 'chat') return { ...t, viewMode: 'chat' };
      const { viewMode: _drop, ...rest } = t;
      return rest;
    }),
  })),

  // The user cleared the name: hand the label back to the automatic sources.
  unlockTabLabel: (tabId) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) => t.id === tabId ? unlockLabel(t) : t),
  })),

  // Automatic label from the terminal title ('title') or `dobius-tab`
  // ('agent'). No-op (no store change, so no config write) when the label is
  // unchanged or the user has locked it. See shared/tab-label.js.
  setAutoTabLabel: (tabId, rawLabel, source) => set((s) => {
    let changed = false;
    const tabs = s.terminalTabs.map((t) => {
      if (t.id !== tabId) return t;
      const next = applyAutoLabel(t, rawLabel, source);
      if (next !== t) changed = true;
      return next;
    });
    // Returning the state itself makes zustand skip the update entirely.
    return changed ? { terminalTabs: tabs } : s;
  }),

  togglePinTab: (tabId) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) => t.id === tabId ? { ...t, pinned: !t.pinned } : t),
  })),

  // Replacing terminalTabs wholesale (e.g. switching project or restoring a
  // window) MUST also prune every map keyed by tab id. Without this, the
  // store carries split/grid/runningAgents/hookOwnedTabs/etc from the
  // previous project, and the next render references tab ids that don't
  // exist. Codex audit HIGH (store.js:227).
  initTabs: (tabs, counter) => set((s) => {
    clearPendingLaunches();
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
      // Reset layout ratios on project switch. Otherwise the previous project's
      // splitRatio / gridColumnRatio / gridRowRatios carry into the new project
      // as initial UI state, flashing the wrong layout until the new project's
      // config-load effect overwrites them, AND if the new project's config has
      // no saved ratios they stick. The per-project load effect (ProjectView
      // useEffect that reads configGetProject) will overwrite these defaults
      // with persisted values when they exist.
      splitRatio: 0.5,
      gridColumnRatio: 0.5,
      gridRowRatios: [],
      runningAgents: ra,
      agentActivity: aa,
      tabStatus: pruneByTabId(s.tabStatus),
      hookOwnedTabs: pruneByTabId(s.hookOwnedTabs),
      unreadTabs: pruneByTabId(s.unreadTabs),
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
    set({ terminalTabs: kept, activeTabId: tabId, splitTabId, runningAgents: ra, agentActivity: aa, tabStatus: ts, hookOwnedTabs: hot, unreadTabs: clearSeen(state.unreadTabs, removedIds), gridSlots: pruneGrid(state.gridSlots, new Set(kept.map((t) => t.id))), monitoredTabs: state.monitoredTabs.filter((id) => !removedIds.has(id)) });
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
    set({ terminalTabs: allKept, activeTabId: newActive, splitTabId, runningAgents: ra, agentActivity: aa, tabStatus: ts, hookOwnedTabs: hot, unreadTabs: clearSeen(state.unreadTabs, removedIds), gridSlots: pruneGrid(state.gridSlots, new Set(allKept.map((t) => t.id))), monitoredTabs: state.monitoredTabs.filter((id) => !removedIds.has(id)) });
  },

  // Actions
  setActiveView: (view) => set({ activeView: view }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setSidebarVisible: (v) => set({ sidebarVisible: !!v }),
  toggleGitPanel: () => set((s) => ({ gitPanelVisible: !s.gitPanelVisible })),
  toggleToolPanel: (panel) => set((s) => ({ toolPanel: s.toolPanel === panel ? null : panel })),
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
      window.electronAPI.terminalSaveClosedTabs(projectPath, stack, s.windowKey || undefined);
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
    const counter = nextFreeCounter(state, closed.projectPath);
    const id = makeTabId(closed.projectPath, counter, idSpace(state));
    // Restore kind/url too. If the closed tab was a browser, reopening as a
    // terminal (which is what dropping these fields did) would be a clear
    // regression. Default to terminal when kind is missing (legacy pre-v1.0.25
    // closed entries had no kind field).
    const tab = {
      id,
      label: closed.label,
      // A reopened tab keeps the user's lock. A legacy entry saved without the
      // flag gets no flag, so isLabelLocked's legacy rule protects a custom name.
      ...(typeof closed.labelLocked === 'boolean' ? { labelLockedByUser: closed.labelLocked } : {}),
      projectPath: closed.projectPath,
      kind: closed.kind || 'terminal',
      ...(closed.url ? { url: closed.url } : {}),
      ...(closed.viewMode === 'chat' ? { viewMode: 'chat' } : {}),
      createdAt: Date.now(),
    };
    set({
      recentlyClosedTabs: rest,
      terminalTabs: [...state.terminalTabs, tab],
      activeTabId: id,
      tabCounter: counter,
    });
    // Persist updated closed tabs list
    const projectPath = state.currentProjectPath;
    if (projectPath && window.electronAPI?.terminalSaveClosedTabs) {
      window.electronAPI.terminalSaveClosedTabs(projectPath, rest, state.windowKey || undefined);
    }
    // Return the new tab + saved scrollback so the caller can restore it
    return { tab, scrollback: closed.scrollback };
  },

  // Resume a Claude session by sending the resume command to the active terminal
  // Accepts EITHER a bare sessionId (legacy callers, treated as current
  // project's cwd, NOT recommended) or a { sessionId, project, sizeMB? }
  // object. v1.0.28's cwd fix lives here so EVERY caller benefits, not just
  // the in-Project resume path. ResumeBanner + Sessions dashboard both call
  // this and previously dropped the project, putting Claude in the wrong cwd
  // for the session. Fix: cd to project first, then run --resume.
  // The tab a terminal write should target (active tab if a terminal, else the
  // nearest terminal tab, else null). Used by resume/inject/restore so they
  // don't silently no-op when a browser tab is active. Audit Medium.
  getActiveTerminalTabId: () => resolveActiveTerminalTabId(get()),

  // Continue the running conversation in THIS tab on the currently ACTIVE
  // account. The reason this exists: switching accounts (Settings > Accounts)
  // only changes NEW terminals, so hitting a session limit and switching left
  // the current tab still bound to the maxed-out account (Sam: "stays on
  // original account and says i still dont have credits left"). This respawns
  // the tab's PTY, which re-reads the active account at the spawn choke point
  // (CLAUDE_CONFIG_DIR), then resumes the same session from the shared
  // transcript store, so the conversation continues on fresh quota.
  continueTabOnActiveAccount: async (tabId) => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null;
    if (!api || !tabId) return;
    // The tab's REAL project, read from the live tab list (not the persisted
    // map), so the lookup is project-guarded and the respawn's cwd is right for
    // a worktree/subdir tab rather than the active project (reviewer MED-HIGH).
    const tab = (get().terminalTabs || []).find((t) => t.id === tabId);
    const tabProject = tab?.projectPath || get().currentProjectPath || null;
    let sessionId = null;
    try {
      const map = (await api.configGetSessionTabMap?.()) || {};
      sessionId = latestSessionForTab(map, tabId, tabProject)?.sessionId || null;
    } catch { /* no map: still respawn to switch the account for a fresh session */ }
    // Respawn HARD-kills whatever runs in this tab (build, editor, claude), so
    // confirm first (reviewer MED). Non-interactive callers (tests) proceed.
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const ok = window.confirm(
        sessionId
          ? 'Restart this tab on the switched account and resume the conversation? Whatever is running in this tab now will be stopped.'
          : 'Restart this tab on the switched account? Whatever is running in this tab now will be stopped, and no linked session was found to resume.'
      );
      if (!ok) return;
    }
    set({ activeView: 'terminal', activeTabId: tabId });
    // Respawn: main kills the old PTY and creates a new one, reading the live
    // active account (CLAUDE_CONFIG_DIR) at the spawn choke point.
    try { await api.terminalCreate?.(tabId, tabProject || undefined); } catch { return; }
    if (!sessionId) return; // account switched; user continues fresh
    // Delegate the actual resume to resumeSession, which owns the claim gate
    // (refuses if the session runs on the phone/another window: reviewer HIGH),
    // the worktree/cross-project cwd rules, and char-by-char typing. Wait first
    // so the old claude has exited (claimSessionResume refuses while its process
    // is still visible) and the new shell is ready.
    setTimeout(() => {
      if (!(get().terminalTabs || []).some((t) => t.id === tabId)) return; // tab closed (reviewer LOW)
      set({ activeTabId: tabId }); // re-assert in case focus moved during the wait
      get().resumeSession({ sessionId, project: tabProject || undefined });
    }, 900);
  },


  // Resume a Codex session in the active terminal tab. Separate from
  // resumeSession because Codex owns its own session lifecycle (no Claude
  // reservation map applies) and the command is `codex resume <id>`. Same tab
  // targeting and cross-project cd rules as the Claude path.
  resumeCodexSession: (arg) => {
    const session = typeof arg === 'string' ? { sessionId: arg } : (arg || {});
    const { sessionId } = session;
    if (!sessionId || sessionId.length > 100 || !/^[a-zA-Z0-9][\w-]*$/.test(sessionId)) return;
    set({ activeView: 'terminal' });
    const termId = resolveActiveTerminalTabId(get());
    if (typeof window === 'undefined' || !window.electronAPI || !termId) return;
    if (termId !== get().activeTabId) set({ activeTabId: termId });
    const projectPath = session.project || '';
    const sameProject = projectPath && projectPath === get().currentProjectPath;
    let cmd;
    if (sameProject || !projectPath) {
      cmd = `codex resume ${sessionId}`;
    } else if (projectPath.startsWith('/') && !/[\x00-\x1F\x7F]/.test(projectPath)) {
      cmd = `cd '${projectPath.replace(/'/g, "'\\''")}' && codex resume ${sessionId}`;
    } else {
      return;
    }
    get().resumeTargetTab(termId).then((target) => {
      if (!target) return;
      const chars = `${cmd}\r`.split('');
      let i = 0;
      const sendNext = () => {
        if (i >= chars.length) return;
        window.electronAPI.terminalWrite(target.id, chars[i]); i += 1;
        if (i < chars.length) setTimeout(sendNext, 8);
      };
      setTimeout(sendNext, target.delayMs);
    });
  },

  // The tab a resume types into: the given one if it is at a shell prompt,
  // otherwise a new plain-shell tab (resumeNeedsNewTab). { id, delayMs, fresh }
  // or null. delayMs: a new tab's pane needs a moment to spawn its PTY (writes
  // before that are dropped), the same wait the agent launch uses.
  resumeTargetTab: async (termId) => {
    let proc = null;
    try { proc = await window.electronAPI.terminalGetProcess?.(termId); } catch { proc = null; }
    const tab = (get().terminalTabs || []).find((t) => t.id === termId);
    if (!resumeNeedsNewTab(proc, tab)) return { id: termId, delayMs: 15, fresh: false };
    const fresh = get().openNewTab(tab?.projectPath || get().currentProjectPath, 'shell');
    if (!fresh) return null;
    get().showTab?.(fresh.id);
    return { id: fresh.id, delayMs: 500, fresh: true };
  },

  resumeSession: (arg) => {
    const session = typeof arg === 'string' ? { sessionId: arg } : (arg || {});
    const { sessionId, sizeMB } = session;
    if (!sessionId || sessionId.length > 100 || !/^[a-zA-Z0-9][\w-]*$/.test(sessionId)) return;
    // Large-transcript heads-up, NOT a hard block. Sam: "we should always be
    // able to resume a session." Big transcripts can be slow to load and may
    // trigger compaction, so warn once, but always let the user proceed rather
    // than refusing outright the way v1.0.28's dead-session guard did. A
    // non-interactive caller (no window, e.g. tests) proceeds without asking.
    if (sizeMB && sizeMB > 80 && typeof window !== 'undefined') {
      const proceed = window.confirm(`This session's transcript is ${sizeMB.toFixed(0)}MB. Large transcripts can take a while for Claude to load and may get compacted.\n\nResume anyway?`);
      if (!proceed) return;
    }
    set({ activeView: 'terminal' });
    // Target a terminal tab, not a browser tab (which would drop the command).
    // Focus it too so the resume is visible. Audit Medium.
    const termId = resolveActiveTerminalTabId(get());
    if (!window.electronAPI || !termId) return;
    if (termId !== get().activeTabId) set({ activeTabId: termId });
    // cd BEFORE resume only for CROSS-project resumes (Sessions dashboard /
    // Search into a tab belonging to a different project), where wrong-cwd
    // is guaranteed. For SAME-project resumes (Cmd+R, ResumeBanner, sidebar
    // double-click in this window) issue a bare `claude --resume`: the tab's
    // shell is already where the user wants it, often a WORKTREE or subdir,
    // and force-cd'ing to the project root was yanking them out of it
    // (Sam-reported v1.0.35: "branches and worktree mess things up").
    const projectPath = session.project || '';
    const sameProject = projectPath && projectPath === get().currentProjectPath;
    let cmd;
    if (sameProject) {
      cmd = `claude --resume ${sessionId}`;
    } else if (projectPath && projectPath.startsWith('/') && !/[\x00-\x1F\x7F]/.test(projectPath)) {
      const safeProject = projectPath.replace(/'/g, "'\\''");
      cmd = `cd '${safeProject}' && claude --resume ${sessionId}`;
    } else if (!projectPath) {
      // Legacy bare-sessionId path: stay in current tab's cwd. Not ideal but
      // preserves backward compat for callers that haven't been updated.
      cmd = `claude --resume ${sessionId}`;
    } else {
      console.warn(`[resume] aborting, invalid project path for session ${sessionId}`);
      if (typeof window !== 'undefined') {
        window.alert(`Can't resume this session, its project path is missing or invalid.\n\nOpen the session's project window directly first.`);
      }
      return;
    }
    const projectForLink = projectPath || get().currentProjectPath;

    const startResume = (target) => {
      const typeIt = () => {
        // Tier 1 capture: link the session to the tab only once the resume is
        // actually GOING to happen, so neither an aborted nor a refused resume
        // persists a bad link (Codex v1.0.35 P2, extended in round 8). A link
        // written for a refused resume is not inert: if that tab is running some
        // other fresh claude, liveClaudeSessionIds would believe the link and
        // suppress this session from loose ends entirely.
        window.electronAPI.configSetSessionTabLink?.(sessionId, target.id, projectForLink);
        const chars = cmd.split('');
        chars.push('\r');
        let i = 0;
        const sendNext = () => {
          if (i < chars.length) {
            window.electronAPI.terminalWrite(target.id, chars[i]);
            i++;
            if (i < chars.length) setTimeout(sendNext, 8);
          }
        };
        setTimeout(sendNext, target.delayMs);
      };

      // CLAIM the session before typing. `claude --resume` is not visible as a
      // process for a second or two, and inside that window a second surface
      // (the phone, another window, another tab) would be told the session is
      // free and resume it too, leaving two processes appending to one
      // transcript. Every desktop resume path (Cmd+R, ResumeBanner, Sessions,
      // Search, sidebar, Loose Ends) funnels through here, so this one call
      // covers all of them. An earlier version merely RESERVED, which cannot
      // refuse: a second tab silently took ownership and both ran. Codex
      // Critical, round 7.
      //
      // The claim is bound to this tab, so retrying here after a failed resume
      // is granted, and killing the tab frees the session at once.
      const claim = window.electronAPI.dataClaimSessionResume?.(sessionId, target.id);
      if (!claim?.then) { typeIt(); return; } // older preload: behave as before
      claim.then((okToRun) => {
        if (okToRun === false) {
          // A tab opened just for this resume has no other purpose.
          if (target.fresh) get().removeTab(target.id);
          if (typeof window !== 'undefined') {
            window.alert('That session is already running somewhere else.\n\nSwitch to the tab (or the phone) that has it rather than starting a second copy.');
          }
          return;
        }
        typeIt();
      }).catch(() => typeIt()); // if we cannot tell, do what the user asked
    };
    get().resumeTargetTab(termId).then((target) => { if (target) startResume(target); });
  },
}));
