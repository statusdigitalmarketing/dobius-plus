import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTerminal, writeTerminal, resizeTerminal, killTerminal, killAll } from './terminal-manager.js';
import {
  loadHistory, loadStats, loadSettings, loadPlans, loadSkills,
  loadTranscript, getActiveProcesses, listProjects, watchFiles, stopWatching,
} from './data-service.js';
import {
  loadConfig, saveConfig, getProjectConfig, setProjectConfig,
  getPinnedSessions, setPinnedSessions,
} from './config-manager.js';
import {
  openProjectWindow, getOpenProjects, closeProjectWindow, closeAllProjectWindows,
} from './window-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

function createWindow() {
  // Restore saved window bounds
  const config = loadConfig();
  const bounds = config.launcherBounds || {};

  mainWindow = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 860,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0D1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Start file watchers for this window
  watchFiles(mainWindow.webContents);

  // Save window bounds on move/resize
  const saveBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const currentConfig = loadConfig();
      currentConfig.launcherBounds = mainWindow.getBounds();
      saveConfig(currentConfig);
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupTerminalHandlers() {
  ipcMain.handle('terminal:create', (event, id, cwd) => {
    return createTerminal(id, cwd, event.sender);
  });

  ipcMain.on('terminal:write', (_event, id, data) => {
    writeTerminal(id, data);
  });

  ipcMain.on('terminal:resize', (_event, id, cols, rows) => {
    resizeTerminal(id, cols, rows);
  });

  ipcMain.on('terminal:kill', (_event, id) => {
    killTerminal(id);
  });
}

function setupDataHandlers() {
  ipcMain.handle('data:loadHistory', () => loadHistory());
  ipcMain.handle('data:loadStats', () => loadStats());
  ipcMain.handle('data:loadSettings', () => loadSettings());
  ipcMain.handle('data:loadPlans', () => loadPlans());
  ipcMain.handle('data:loadSkills', () => loadSkills());
  ipcMain.handle('data:loadTranscript', (_event, sessionId, projectPath) => loadTranscript(sessionId, projectPath));
  ipcMain.handle('data:getActiveProcesses', () => getActiveProcesses());
  ipcMain.handle('data:listProjects', () => listProjects());
}

function setupConfigHandlers() {
  ipcMain.handle('config:load', () => loadConfig());
  ipcMain.handle('config:save', (_event, config) => saveConfig(config));
  ipcMain.handle('config:getProject', (_event, projectPath) => getProjectConfig(projectPath));
  ipcMain.handle('config:setProject', (_event, projectPath, settings) => setProjectConfig(projectPath, settings));
  ipcMain.handle('config:getPinned', () => getPinnedSessions());
  ipcMain.handle('config:setPinned', (_event, sessionIds) => setPinnedSessions(sessionIds));
}

function setupWindowHandlers() {
  ipcMain.handle('window:openProject', (_event, projectPath) => {
    const win = openProjectWindow(projectPath);
    return { ok: true, id: win.id };
  });

  ipcMain.handle('window:getOpen', () => getOpenProjects());

  ipcMain.handle('window:close', (_event, projectPath) => {
    closeProjectWindow(projectPath);
    return { ok: true };
  });
}

app.whenReady().then(() => {
  setupTerminalHandlers();
  setupDataHandlers();
  setupConfigHandlers();
  setupWindowHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  closeAllProjectWindows();
  killAll();
  stopWatching();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
