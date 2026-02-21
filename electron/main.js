import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTerminal, writeTerminal, resizeTerminal, killTerminal, killAll } from './terminal-manager.js';
import {
  loadHistory, loadStats, loadSettings, loadPlans, loadSkills,
  loadTranscript, getActiveProcesses, listProjects, watchFiles, stopWatching,
} from './data-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
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

app.whenReady().then(() => {
  setupTerminalHandlers();
  setupDataHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  killAll();
  stopWatching();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
