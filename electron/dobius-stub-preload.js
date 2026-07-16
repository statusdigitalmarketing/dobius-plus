// Experiment stub preload — get dobius's shell to PAINT on dobius's shell.
// contextIsolation:false; sets window globals directly.
//
// Key fix (via codex): the fallback stub must NOT resolve to another thenable,
// or `await window.api.settings.get()` never settles (infinite promise
// assimilation) and startup hangs → blank shell. So the fallback `then` resolves
// to a plain [] , and the specific startup methods return real shapes.

function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get(_t, prop) {
      // Resolve to [] (a real, non-thenable, array-safe value) — never another stub.
      if (prop === 'then') return (onFulfilled) => { if (onFulfilled) onFulfilled([]); return Promise.resolve([]); };
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'toString' || prop === 'valueOf') return () => '';
      if (prop === 'length') return 0;
      if (prop === 'map' || prop === 'filter' || prop === 'slice' || prop === 'concat' || prop === 'flat') return () => [];
      if (prop === 'forEach' || prop === 'some' || prop === 'every' || prop === 'find' || prop === 'includes') return () => undefined;
      if (prop === 'join') return () => '';
      if (prop === 'enabled' || prop === 'visible' || prop === 'active') return false;
      return stub();
    },
    apply() { return stub(); },
    has() { return false; },
  });
}

// Real shapes dobius's startup chain needs to progress past the boot gate (codex).
const UI_DEFAULT = {
  lastActiveRepoId: null, lastActiveWorktreeId: null, sidebarWidth: 280,
  rightSidebarOpen: true, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files',
  rightSidebarWidth: 350, markdownTocPanelWidth: 240, groupBy: 'repo', sortBy: 'name',
  projectOrderBy: 'manual', showActiveOnly: false, hideSleepingWorkspaces: false,
  showSleepingWorkspaces: true, hideDefaultBranchWorkspace: false,
  hideAutomationGeneratedWorkspaces: false, filterRepoIds: [], collapsedGroups: [],
  uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
  _worktreeCardModeDefaulted: true, statusBarItems: [], statusBarVisible: true,
  dismissedUpdateVersion: null, lastUpdateCheckAt: null,
};
const SESSION_DEFAULT = {
  activeRepoId: null, activeWorktreeId: null, activeTabId: null, tabsByWorktree: {},
  terminalLayoutsByTabId: {}, openFilesByWorktree: {}, markdownFrontmatterVisible: {},
  browserTabsByWorktree: {}, browserPagesByWorkspace: {}, activeBrowserTabIdByWorktree: {},
  activeFileIdByWorktree: {}, activeTabTypeByWorktree: {}, browserUrlHistory: [],
  defaultTerminalTabsAppliedByWorktreeId: {},
};

const startup = {
  settings: { get: async () => ({}) },
  runtimeEnvironments: { list: async () => [] },
  ui: { get: async () => UI_DEFAULT },
  session: { get: async () => SESSION_DEFAULT },
  onboarding: { get: async () => ({ completed: true }) },
  app: { awaitFirstWindowStartupServices: async () => undefined },
};

function nsProxy(real) {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;          // a namespace object, not a promise
      if (Object.prototype.hasOwnProperty.call(real, prop)) return real[prop];
      return stub();
    },
    apply() { return stub(); },
  });
}

window.api = new Proxy(function () {}, {
  get(_t, prop) {
    if (prop === 'then') return undefined;
    if (Object.prototype.hasOwnProperty.call(startup, prop)) return nsProxy(startup[prop]);
    return stub();
  },
  apply() { return stub(); },
});

window.electron = {
  ipcRenderer: { on: () => () => {}, once: () => {}, send: () => {}, invoke: () => Promise.resolve(undefined), removeListener: () => {}, removeAllListeners: () => {} },
  process: { platform: process.platform, versions: process.versions },
};
