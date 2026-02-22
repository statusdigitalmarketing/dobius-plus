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
    set({ terminalTabs: tabs, activeTabId: newActive });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  renameTab: (tabId, label) => set((s) => ({
    terminalTabs: s.terminalTabs.map((t) => t.id === tabId ? { ...t, label } : t),
  })),

  initTabs: (tabs, counter) => set({
    terminalTabs: tabs,
    activeTabId: tabs.length > 0 ? tabs[0].id : null,
    tabCounter: counter,
  }),

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
  setSessions: (sessions) => set({ sessions }),
  setActiveProcesses: (procs) => set({ activeProcesses: procs }),
  setBuildComplete: (val) => set({ buildComplete: val }),
}));
