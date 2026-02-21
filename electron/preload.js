const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
  },

  // Terminal
  terminalCreate: (id, cwd) => ipcRenderer.invoke('terminal:create', id, cwd),
  terminalWrite: (id, data) => ipcRenderer.send('terminal:write', id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
  terminalKill: (id) => ipcRenderer.send('terminal:kill', id),
  onTerminalData: (callback) => {
    const handler = (_event, id, data) => callback(id, data);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },
  terminalSaveState: (id, state) => ipcRenderer.invoke('terminal:saveState', id, state),
  terminalLoadState: (id) => ipcRenderer.invoke('terminal:loadState', id),
  onTerminalRequestSave: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('terminal:requestSave', handler);
    return () => ipcRenderer.removeListener('terminal:requestSave', handler);
  },
  onTerminalExit: (callback) => {
    const handler = (_event, id, exitCode, signal) => callback(id, exitCode, signal);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },

  // Data (read-only ~/.claude/ access)
  dataLoadHistory: () => ipcRenderer.invoke('data:loadHistory'),
  dataLoadStats: () => ipcRenderer.invoke('data:loadStats'),
  dataLoadSettings: () => ipcRenderer.invoke('data:loadSettings'),
  dataLoadBridgeServers: () => ipcRenderer.invoke('data:loadBridgeServers'),
  dataLoadPlans: () => ipcRenderer.invoke('data:loadPlans'),
  dataReadPlanFile: (planName) => ipcRenderer.invoke('data:readPlanFile', planName),
  dataLoadSkills: () => ipcRenderer.invoke('data:loadSkills'),
  dataLoadTranscript: (sessionId, projectPath) => ipcRenderer.invoke('data:loadTranscript', sessionId, projectPath),
  dataGetActiveProcesses: () => ipcRenderer.invoke('data:getActiveProcesses'),
  dataListProjects: () => ipcRenderer.invoke('data:listProjects'),
  onDataUpdated: (callback) => {
    const handler = (_event, changedPath) => callback(changedPath);
    ipcRenderer.on('data:updated', handler);
    return () => ipcRenderer.removeListener('data:updated', handler);
  },

  // Config (persisted to ~/Library/Application Support/Dobius/)
  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (config) => ipcRenderer.invoke('config:save', config),
  configGetProject: (projectPath) => ipcRenderer.invoke('config:getProject', projectPath),
  configSetProject: (projectPath, settings) => ipcRenderer.invoke('config:setProject', projectPath, settings),
  configGetPinned: () => ipcRenderer.invoke('config:getPinned'),
  configSetPinned: (sessionIds) => ipcRenderer.invoke('config:setPinned', sessionIds),

  // Window management
  windowOpenProject: (projectPath) => ipcRenderer.invoke('window:openProject', projectPath),
  windowGetOpen: () => ipcRenderer.invoke('window:getOpen'),
  windowClose: (projectPath) => ipcRenderer.invoke('window:close', projectPath),

  // Build Monitor
  buildMonitorLoadProgress: (projectDir) => ipcRenderer.invoke('buildMonitor:loadProgress', projectDir),
  buildMonitorLoadSupervisorLog: (projectDir) => ipcRenderer.invoke('buildMonitor:loadSupervisorLog', projectDir),
  buildMonitorLoadHandoff: (projectDir) => ipcRenderer.invoke('buildMonitor:loadHandoff', projectDir),
  buildMonitorDetectActive: () => ipcRenderer.invoke('buildMonitor:detectActive'),
  buildMonitorPickDirectory: () => ipcRenderer.invoke('buildMonitor:pickDirectory'),
  buildMonitorNotify: (opts) => ipcRenderer.invoke('buildMonitor:notify', opts),
  buildMonitorWatch: (projectDir) => ipcRenderer.invoke('buildMonitor:watch', projectDir),
  buildMonitorUnwatch: (projectDir) => ipcRenderer.invoke('buildMonitor:unwatch', projectDir),
  onBuildMonitorUpdated: (callback) => {
    const handler = (_event, projectDir) => callback(projectDir);
    ipcRenderer.on('buildMonitor:updated', handler);
    return () => ipcRenderer.removeListener('buildMonitor:updated', handler);
  },

  // Menu events
  onMenuToggleView: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:toggle-view', handler);
    return () => ipcRenderer.removeListener('menu:toggle-view', handler);
  },
  onMenuToggleSidebar: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:toggle-sidebar', handler);
    return () => ipcRenderer.removeListener('menu:toggle-sidebar', handler);
  },
  onMenuToggleGitPanel: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:toggle-git-panel', handler);
    return () => ipcRenderer.removeListener('menu:toggle-git-panel', handler);
  },

  // Quit gate
  onQuitPrompt: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('app:quit-prompt', handler);
    return () => ipcRenderer.removeListener('app:quit-prompt', handler);
  },
  onQuitCancel: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('app:quit-cancel', handler);
    return () => ipcRenderer.removeListener('app:quit-cancel', handler);
  },

  // Git
  gitStatus: (projectDir) => ipcRenderer.invoke('git:status', projectDir),
  gitLog: (projectDir, count) => ipcRenderer.invoke('git:log', projectDir, count),
  gitBranches: (projectDir) => ipcRenderer.invoke('git:branches', projectDir),
  gitDiff: (projectDir, hash) => ipcRenderer.invoke('git:diff', projectDir, hash),
  gitGhAvailable: () => ipcRenderer.invoke('git:ghAvailable'),
  gitPullRequests: (projectDir) => ipcRenderer.invoke('git:pullRequests', projectDir),
  gitIssues: (projectDir) => ipcRenderer.invoke('git:issues', projectDir),
  gitPrDetails: (projectDir, prNumber) => ipcRenderer.invoke('git:prDetails', projectDir, prNumber),
  gitIssueDetails: (projectDir, issueNumber) => ipcRenderer.invoke('git:issueDetails', projectDir, issueNumber),
});
