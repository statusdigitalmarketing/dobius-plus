const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  terminalGetProcess: (id) => ipcRenderer.invoke('terminal:getProcess', id),
  terminalGetCwd: (id) => ipcRenderer.invoke('terminal:getCwd', id),
  onTerminalData: (callback) => {
    const handler = (_event, id, data) => callback(id, data);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },
  terminalSaveState: (id, state, forceFlush) => ipcRenderer.invoke('terminal:saveState', id, state, !!forceFlush),
  terminalLoadState: (id) => ipcRenderer.invoke('terminal:loadState', id),
  terminalSaveTabs: (projectPath, tabs, counter) => ipcRenderer.invoke('terminal:saveTabs', projectPath, tabs, counter),
  terminalLoadTabs: (projectPath) => ipcRenderer.invoke('terminal:loadTabs', projectPath),
  terminalSaveClosedTabs: (projectPath, closedTabs) => ipcRenderer.invoke('terminal:saveClosedTabs', projectPath, closedTabs),
  terminalLoadClosedTabs: (projectPath) => ipcRenderer.invoke('terminal:loadClosedTabs', projectPath),
  terminalRequestSaveNow: () => ipcRenderer.invoke('terminal:requestSaveNow'),
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

  // Agents
  agentsGetBuiltins: () => ipcRenderer.invoke('agents:getBuiltins'),
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsSave: (agent) => ipcRenderer.invoke('agents:save', agent),
  agentsDelete: (agentId) => ipcRenderer.invoke('agents:delete', agentId),
  agentsWriteTempPrompt: (text) => ipcRenderer.invoke('agents:writeTempPrompt', text),

  // Agent Memory
  agentMemoryGet: (agentId) => ipcRenderer.invoke('agentMemory:get', agentId),
  agentMemorySetContext: (agentId, context) => ipcRenderer.invoke('agentMemory:setContext', agentId, context),
  agentMemoryAppendJournal: (agentId, entry) => ipcRenderer.invoke('agentMemory:appendJournal', agentId, entry),
  agentMemoryAddExperience: (agentId, text) => ipcRenderer.invoke('agentMemory:addExperience', agentId, text),
  agentMemoryRemoveExperience: (agentId, index) => ipcRenderer.invoke('agentMemory:removeExperience', agentId, index),
  agentMemoryClear: (agentId) => ipcRenderer.invoke('agentMemory:clear', agentId),

  // Orchestration
  orchestrationDecompose: (args) => ipcRenderer.invoke('orchestration:decompose', args),
  orchestrationList: () => ipcRenderer.invoke('orchestration:list'),
  orchestrationGet: (runId) => ipcRenderer.invoke('orchestration:get', runId),
  orchestrationSave: (run) => ipcRenderer.invoke('orchestration:save', run),
  orchestrationDelete: (runId) => ipcRenderer.invoke('orchestration:delete', runId),

  // File (CLAUDE.md editor)
  fileRead: (filePath) => ipcRenderer.invoke('file:read', filePath),
  fileWrite: (filePath, content) => ipcRenderer.invoke('file:write', filePath, content),
  fileListClaudeMd: (projectPath) => ipcRenderer.invoke('file:listClaudeMd', projectPath),

  // Per-project notes / memory (<project>/.dobius/NOTES.md)
  notesRead: (projectPath) => ipcRenderer.invoke('notes:read', projectPath),
  notesWrite: (projectPath, content) => ipcRenderer.invoke('notes:write', projectPath, content),

  // Skill files (read/write).
  skillReadFile: (skillPath, filename) => ipcRenderer.invoke('skill:readFile', skillPath, filename),
  skillWriteFile: (skillPath, filename, content) => ipcRenderer.invoke('skill:writeFile', skillPath, filename, content),

  // Claude status hooks: manage an opt-in Notification/Stop hook block in
  // ~/.claude/settings.json that drives the terminal-tab status dots. The
  // duplicate block here previously shadowed itself (last-wins), only by
  // luck did claudeHooksEnable still get its opts arg. De-duped.
  claudeHooksGetStatus: () => ipcRenderer.invoke('claudeHooks:getStatus'),
  claudeHooksEnable: (opts) => ipcRenderer.invoke('claudeHooks:enable', opts),
  claudeHooksDisable: () => ipcRenderer.invoke('claudeHooks:disable'),

  // Checkpoints
  checkpointSave: (projectPath, checkpoint) => ipcRenderer.invoke('checkpoint:save', projectPath, checkpoint),
  checkpointList: (projectPath) => ipcRenderer.invoke('checkpoint:list', projectPath),
  checkpointDelete: (projectPath, checkpointId) => ipcRenderer.invoke('checkpoint:delete', projectPath, checkpointId),
  checkpointRename: (projectPath, checkpointId, newLabel) => ipcRenderer.invoke('checkpoint:rename', projectPath, checkpointId, newLabel),

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
  dataLoadAllSessions: (projectFilter) => ipcRenderer.invoke('data:loadAllSessions', projectFilter),
  dataGetLatestSession: (projectPath) => ipcRenderer.invoke('data:getLatestSession', projectPath),
  dataDeleteSession: (sessionId, projectPath) => ipcRenderer.invoke('data:deleteSession', sessionId, projectPath),
  dataKillProcess: (pid) => ipcRenderer.invoke('data:killProcess', pid),
  dataLoadProjectTokens: () => ipcRenderer.invoke('data:loadProjectTokens'),
  dataSearchTranscripts: (query) => ipcRenderer.invoke('data:searchTranscripts', query),
  dataEstimateContextSize: (projectPath) => ipcRenderer.invoke('data:estimateContextSize', projectPath),
  onDataUpdated: (callback) => {
    const handler = (_event, changedPath) => callback(changedPath);
    ipcRenderer.on('data:updated', handler);
    return () => ipcRenderer.removeListener('data:updated', handler);
  },

  // File change watcher
  filewatcherWatch: (projectPath) => ipcRenderer.invoke('filewatcher:watch', projectPath),
  filewatcherUnwatch: (projectPath) => ipcRenderer.invoke('filewatcher:unwatch', projectPath),
  filewatcherGetEvents: (projectPath) => ipcRenderer.invoke('filewatcher:getEvents', projectPath),
  onFilewatcherChange: (callback) => {
    const handler = (_event, projectPath, entry) => callback(projectPath, entry);
    ipcRenderer.on('filewatcher:change', handler);
    return () => ipcRenderer.removeListener('filewatcher:change', handler);
  },

  // Config (persisted to ~/Library/Application Support/Dobius/)
  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (config) => ipcRenderer.invoke('config:save', config),
  configGetProject: (projectPath) => ipcRenderer.invoke('config:getProject', projectPath),
  configSetProject: (projectPath, settings) => ipcRenderer.invoke('config:setProject', projectPath, settings),
  configGetPinned: () => ipcRenderer.invoke('config:getPinned'),
  configSetPinned: (sessionIds) => ipcRenderer.invoke('config:setPinned', sessionIds),
  configGetPinnedProjects: () => ipcRenderer.invoke('config:getPinnedProjects'),
  configSetPinnedProjects: (paths) => ipcRenderer.invoke('config:setPinnedProjects', paths),
  configGetSettings: () => ipcRenderer.invoke('config:getSettings'),
  configUpdateSettings: (updates) => ipcRenderer.invoke('config:updateSettings', updates),
  configGetSessionTags: () => ipcRenderer.invoke('config:getSessionTags'),
  configSetSessionTag: (sessionId, label, color) => ipcRenderer.invoke('config:setSessionTag', sessionId, label, color),
  configRemoveSessionTag: (sessionId) => ipcRenderer.invoke('config:removeSessionTag', sessionId),
  configGetSessionTabMap: () => ipcRenderer.invoke('config:getSessionTabMap'),
  configSetSessionTabLink: (sessionId, tabId, projectPath) => ipcRenderer.invoke('config:setSessionTabLink', sessionId, tabId, projectPath),

  // Account management
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsSave: (account) => ipcRenderer.invoke('accounts:save', account),
  accountsDelete: (accountId) => ipcRenderer.invoke('accounts:delete', accountId),
  accountsGetForProject: (projectPath) => ipcRenderer.invoke('accounts:getForProject', projectPath),
  accountsSetForProject: (projectPath, accountId) => ipcRenderer.invoke('accounts:setForProject', projectPath, accountId),
  accountsCaptureClaudeJson: (destPath) => ipcRenderer.invoke('accounts:captureClaudeJson', destPath),
  accountsActivateClaude: (accountId) => ipcRenderer.invoke('accounts:activateClaude', accountId),
  accountsGetActiveClaude: () => ipcRenderer.invoke('accounts:getActiveClaude'),

  getHomeDirPath: () => ipcRenderer.invoke('utils:getHomeDirPath'),

  // Window management
  windowOpenProject: (projectPath) => ipcRenderer.invoke('window:openProject', projectPath),
  windowGetOpen: () => ipcRenderer.invoke('window:getOpen'),
  windowClose: (projectPath) => ipcRenderer.invoke('window:close', projectPath),
  windowSetTitle: (title) => ipcRenderer.invoke('window:setTitle', title),
  windowShowLauncher: () => ipcRenderer.invoke('window:showLauncher'),
  windowPickAndOpenProject: () => ipcRenderer.invoke('window:pickAndOpenProject'),

  // Mobile server
  mobileServerStart: () => ipcRenderer.invoke('mobileServer:start'),
  mobileServerStop: () => ipcRenderer.invoke('mobileServer:stop'),
  mobileServerStatus: () => ipcRenderer.invoke('mobileServer:status'),
  mobileServerRegenerateCode: () => ipcRenderer.invoke('mobileServer:regenerateCode'),
  mobileServerListDevices: () => ipcRenderer.invoke('mobileServer:listDevices'),
  mobileServerRemoveDevice: (token) => ipcRenderer.invoke('mobileServer:removeDevice', token),
  mobileServerSetBindMode: (mode) => ipcRenderer.invoke('mobileServer:setBindMode', mode),

  // iMessage bridge — drive Dobius+ by texting yourself
  imessageBridgeGetConfig: () => ipcRenderer.invoke('imessageBridge:getConfig'),
  imessageBridgeUpdateConfig: (updates) => ipcRenderer.invoke('imessageBridge:updateConfig', updates),
  imessageBridgeStatus: () => ipcRenderer.invoke('imessageBridge:status'),
  imessageBridgeOpenFullDiskAccess: () => ipcRenderer.invoke('imessageBridge:openFullDiskAccess'),
  imessageBridgeTestSend: () => ipcRenderer.invoke('imessageBridge:testSend'),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  updaterGetPending: () => ipcRenderer.invoke('updater:getPending'),
  updaterGetStatus: () => ipcRenderer.invoke('updater:getStatus'),
  updaterGetCurrentVersion: () => ipcRenderer.invoke('updater:getCurrentVersion'),
  updaterDismiss: (version) => ipcRenderer.invoke('updater:dismiss', version),
  onUpdaterStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
  windowTearOffTab: (projectPath, tabId, tabLabel, screenX, screenY) =>
    ipcRenderer.invoke('window:tearOffTab', projectPath, tabId, tabLabel, screenX, screenY),
  terminalClaimPty: (tabId) => ipcRenderer.invoke('terminal:claimPty', tabId),

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
  onLauncherFocusSearch: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('launcher:focusSearch', handler);
    return () => ipcRenderer.removeListener('launcher:focusSearch', handler);
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
  onMenuNewTab: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:new-tab', handler);
    return () => ipcRenderer.removeListener('menu:new-tab', handler);
  },
  onMenuCloseTab: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:close-tab', handler);
    return () => ipcRenderer.removeListener('menu:close-tab', handler);
  },
  onMenuResumeSession: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('menu:resume-session', handler);
    return () => ipcRenderer.removeListener('menu:resume-session', handler);
  },

  // File path from drag-drop (File.path removed in Electron 32+)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Save clipboard image to temp file, return path
  saveClipboardImage: (base64Data, mimeType) => ipcRenderer.invoke('terminal:saveClipboardImage', base64Data, mimeType),

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

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  shellShowInFinder: (filePath) => ipcRenderer.invoke('shell:showInFinder', filePath),

  // Project management
  projectSetDisplayName: (projectPath, name) => ipcRenderer.invoke('project:setDisplayName', projectPath, name),
  projectRemoveFromList: (projectPath) => ipcRenderer.invoke('project:removeFromList', projectPath),

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
  improvePrompt: (rawPrompt) => ipcRenderer.invoke('prompt:improve', rawPrompt),

  // Project tasks (to-do list dropdown)
  tasksList: (projectPath) => ipcRenderer.invoke('tasks:list', projectPath),
  tasksAdd: (projectPath, taskData) => ipcRenderer.invoke('tasks:add', projectPath, taskData),
  tasksUpdate: (projectPath, taskId, patch) => ipcRenderer.invoke('tasks:update', projectPath, taskId, patch),
  tasksDelete: (projectPath, taskId) => ipcRenderer.invoke('tasks:delete', projectPath, taskId),
  tasksComplete: (projectPath, taskId) => ipcRenderer.invoke('tasks:complete', projectPath, taskId),
  tasksSyncAsana: (projectPath) => ipcRenderer.invoke('tasks:syncAsana', projectPath),
  tasksAdvance: (p, id, stage, opts) => ipcRenderer.invoke('tasks:advance', p, id, stage, opts),
  tasksReopen: (p, id, opts) => ipcRenderer.invoke('tasks:reopen', p, id, opts),
  tasksBlock: (p, id, reason, opts) => ipcRenderer.invoke('tasks:block', p, id, reason, opts),
  tasksUnblock: (p, id, opts) => ipcRenderer.invoke('tasks:unblock', p, id, opts),
  // Fires when a task is completed from a terminal via dobius-task-done, so an
  // open Tasks panel can re-check the box live. Callback receives projectPath.
  onTasksUpdated: (cb) => {
    const handler = (_e, projectPath) => cb(projectPath);
    ipcRenderer.on('tasks:updated', handler);
    return () => ipcRenderer.removeListener('tasks:updated', handler);
  },
  asanaGetConfig: () => ipcRenderer.invoke('asana:getConfig'),
  asanaUpdateConfig: (updates) => ipcRenderer.invoke('asana:updateConfig', updates),
  autoModeGet: () => ipcRenderer.invoke('automode:get'),
  autoModeSetEnabled: (on) => ipcRenderer.invoke('automode:setEnabled', on),
  visualOpenWindow: (projectPath) => ipcRenderer.invoke('visual:openWindow', projectPath),
  visualStart: (projectPath) => ipcRenderer.invoke('visual:start', projectPath),
  visualStop: () => ipcRenderer.invoke('visual:stop'),
  visualGetPort: () => ipcRenderer.invoke('visual:getPort'),
  visualScreenshot: (webContentsId) => ipcRenderer.invoke('visual:screenshot', webContentsId),
  visualListPages: () => ipcRenderer.invoke('visual:listPages'),
  visualDeployStatus: (projectPath, opts) => ipcRenderer.invoke('visual:deployStatus', projectPath, opts),
  visualDeployPreview: (projectPath, opts) => ipcRenderer.invoke('visual:deployPreview', projectPath, opts),
  visualPromote: (projectPath, opts) => ipcRenderer.invoke('visual:promote', projectPath, opts),
});
