import { create } from 'zustand';
import { THEMES, applyTheme } from '../lib/themes';

export const useStore = create((set) => ({
  // View state
  activeView: 'terminal', // 'terminal' | 'dashboard'
  sidebarVisible: true,
  dashboardTab: 'overview',

  // Theme
  themeIndex: 0,

  // Data
  sessions: [],
  activeProcesses: [],
  buildComplete: false,

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
  setActiveProcesses: (procs) => set({ activeProcesses: procs }),
  setBuildComplete: (val) => set({ buildComplete: val }),
}));
