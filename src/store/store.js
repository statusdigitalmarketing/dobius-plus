import { create } from 'zustand';
import { THEMES, applyTheme } from '../lib/themes';

export const useStore = create((set, get) => ({
  // View state
  activeView: 'terminal', // 'terminal' | 'dashboard'
  sidebarVisible: true,
  dashboardTab: 'overview',

  // Theme
  themeIndex: 0,

  // Data
  sessions: [],
  stats: null,
  settings: null,
  activeProcesses: [],

  // Actions
  setActiveView: (view) => set({ activeView: view }),
  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
  setDashboardTab: (tab) => set({ dashboardTab: tab }),

  setThemeIndex: (index) => {
    const theme = THEMES[index % THEMES.length];
    applyTheme(theme);
    set({ themeIndex: index % THEMES.length });
  },

  setSessions: (sessions) => set({ sessions }),
  setStats: (stats) => set({ stats }),
  setSettings: (settings) => set({ settings }),
  setActiveProcesses: (procs) => set({ activeProcesses: procs }),
}));
