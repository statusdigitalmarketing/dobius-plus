import { BrowserWindow, app } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { killTerminal, getActiveTerminals } from './terminal-manager.js';
import { watchFiles } from './watcher-service.js';
import { getProjectConfig, setProjectConfig } from './config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Map of projectPath → BrowserWindow */
const projectWindows = new Map();

/**
 * Open a window for a project. If one already exists, focus it.
 * @param {string} projectPath
 * @returns {BrowserWindow}
 */
export function openProjectWindow(projectPath) {
  // If window already open for this project, focus it
  const existing = projectWindows.get(projectPath);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  // Get saved bounds for this project
  const projectConfig = getProjectConfig(projectPath) || {};
  const bounds = projectConfig.windowBounds || {};

  const win = new BrowserWindow({
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

  // Load with project query param
  const isDev = !app.isPackaged;
  const encodedProject = encodeURIComponent(projectPath);
  if (isDev) {
    win.loadURL(`http://localhost:5173?project=${encodedProject}`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      query: { project: projectPath },
    });
  }

  // Start file watchers for this window
  watchFiles(win.webContents);

  // Save window bounds on move/resize (debounced to reduce I/O)
  let boundsTimer;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const config = getProjectConfig(projectPath) || {};
        config.windowBounds = win.getBounds();
        setProjectConfig(projectPath, config);
      }
    }, 300);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Clean up on close
  win.on('closed', () => {
    projectWindows.delete(projectPath);

    // Kill all terminals associated with this project
    const termId = `term-${projectPath}`;
    const activeTerminals = getActiveTerminals();
    for (const id of activeTerminals) {
      if (id === termId || id.startsWith(`${termId}-`)) {
        killTerminal(id);
      }
    }
  });

  projectWindows.set(projectPath, win);
  return win;
}

/**
 * Get list of open project paths.
 * @returns {string[]}
 */
export function getOpenProjects() {
  const open = [];
  for (const [projectPath, win] of projectWindows) {
    if (!win.isDestroyed()) {
      open.push(projectPath);
    }
  }
  return open;
}

/**
 * Close a specific project window.
 * @param {string} projectPath
 */
export function closeProjectWindow(projectPath) {
  const win = projectWindows.get(projectPath);
  if (win && !win.isDestroyed()) {
    win.close();
  }
}

/**
 * Close all project windows — called on app quit.
 */
export function closeAllProjectWindows() {
  for (const [, win] of projectWindows) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  projectWindows.clear();
}
