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
  onTerminalExit: (callback) => {
    const handler = (_event, id, exitCode, signal) => callback(id, exitCode, signal);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },

  // Data (read-only ~/.claude/ access)
  dataLoadHistory: () => ipcRenderer.invoke('data:loadHistory'),
  dataLoadStats: () => ipcRenderer.invoke('data:loadStats'),
  dataLoadSettings: () => ipcRenderer.invoke('data:loadSettings'),
  dataLoadPlans: () => ipcRenderer.invoke('data:loadPlans'),
  dataLoadSkills: () => ipcRenderer.invoke('data:loadSkills'),
  dataLoadTranscript: (sessionId, projectPath) => ipcRenderer.invoke('data:loadTranscript', sessionId, projectPath),
  dataGetActiveProcesses: () => ipcRenderer.invoke('data:getActiveProcesses'),
  dataListProjects: () => ipcRenderer.invoke('data:listProjects'),
  onDataUpdated: (callback) => {
    const handler = (_event, changedPath) => callback(changedPath);
    ipcRenderer.on('data:updated', handler);
    return () => ipcRenderer.removeListener('data:updated', handler);
  },
});
