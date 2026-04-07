import { BrowserWindow, app, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { killTerminal, getActiveTerminals, gracefulCloseTerminals, getTerminalsForProject } from './terminal-manager.js';
import { watchFiles } from './watcher-service.js';
import { getProjectConfig, setProjectConfig } from './config-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Map of windowId (number) → { projectPath, win } */
const projectWindows = new Map();

/**
 * Find the first open window for a project path.
 * @param {string} projectPath
 * @returns {BrowserWindow|null}
 */
function getWindowForProject(projectPath) {
  for (const [, entry] of projectWindows) {
    if (entry.projectPath === projectPath && !entry.win.isDestroyed()) {
      return entry.win;
    }
  }
  return null;
}

/**
 * Get all window IDs associated with a project path.
 * @param {string} projectPath
 * @returns {number[]}
 */
function getWindowIdsForProject(projectPath) {
  const ids = [];
  for (const [winId, entry] of projectWindows) {
    if (entry.projectPath === projectPath && !entry.win.isDestroyed()) {
      ids.push(winId);
    }
  }
  return ids;
}

/**
 * Set up common window event handlers (bounds saving, close cleanup, etc.)
 * @param {BrowserWindow} win
 * @param {string} projectPath
 * @param {{ isTearOff?: boolean, tearOffTabId?: string }} options
 */
function setupWindowEvents(win, projectPath, { isTearOff = false, tearOffTabId = null } = {}) {
  // Keep window title after page sets <title>
  win.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  // Start file watchers for this window
  watchFiles(win.webContents);

  // Save window bounds on move/resize (debounced)
  if (!isTearOff) {
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
  }

  // Graceful close: send Ctrl+C twice to Claude sessions so they print resume IDs,
  // save scrollback, then kill terminals. Prevents immediate PTY death on window X.
  let closingGracefully = false;
  win.on('close', (e) => {
    if (closingGracefully) return; // Phase 2 — let it close

    // Phase 1 — intercept, do graceful shutdown
    e.preventDefault();
    closingGracefully = true;

    // Request scrollback save from renderer
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:requestSave');
    }

    // Determine which terminals this window owns
    const termIds = isTearOff && tearOffTabId
      ? [tearOffTabId]
      : getTerminalsForProject(projectPath);

    // Send Ctrl+C twice, wait for Claude to print resume ID, save scrollback, then close
    gracefulCloseTerminals(termIds).then(() => {
      // Request another save to capture the resume ID that Claude just printed
      if (!win.isDestroyed()) {
        win.webContents.send('terminal:requestSave');
      }
      // Brief delay for the save IPC to complete, then actually close
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.close(); // closingGracefully=true so this time it goes through
        }
      }, 500);
    });
  });

  // Clean up on close (runs after graceful close completes)
  win.on('closed', () => {
    projectWindows.delete(win.id);

    // If this is a tear-off window, only kill the specific torn-off terminal
    if (isTearOff && tearOffTabId) {
      killTerminal(tearOffTabId);
      return;
    }

    // For primary windows: check if another window for this project exists.
    // If so, don't kill any terminals (the other window owns them).
    const otherWindowIds = getWindowIdsForProject(projectPath);
    if (otherWindowIds.length > 0) return;

    // No other windows — kill all terminals for this project
    const termIds = getTerminalsForProject(projectPath);
    for (const id of termIds) {
      killTerminal(id);
    }
  });

  projectWindows.set(win.id, { projectPath, win });
}

/**
 * Open a window for a project. If one already exists, focus it.
 * @param {string} projectPath
 * @returns {BrowserWindow}
 */
export function openProjectWindow(projectPath) {
  // If window already open for this project, focus it
  const existing = getWindowForProject(projectPath);
  if (existing) {
    existing.focus();
    return existing;
  }

  const projectConfig = getProjectConfig(projectPath) || {};
  const bounds = projectConfig.windowBounds || {};
  const folderName = path.basename(projectPath);

  const win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 860,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    title: `${folderName} — Dobius+`,
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
  const encodedProject = encodeURIComponent(projectPath);
  if (isDev) {
    win.loadURL(`http://localhost:5173?project=${encodedProject}`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      query: { project: projectPath },
    });
  }

  setupWindowEvents(win, projectPath);
  return win;
}

/**
 * Open a torn-off tab in its own window.
 * @param {string} projectPath
 * @param {string} tabId — the terminal tab ID being torn off
 * @param {string} tabLabel — display label for the tab
 * @param {number} screenX — cursor X position (screen coords)
 * @param {number} screenY — cursor Y position (screen coords)
 * @returns {BrowserWindow}
 */
export function openTornOffWindow(projectPath, tabId, tabLabel, screenX, screenY) {
  const folderName = path.basename(projectPath);

  // Count existing windows for this project to generate "folder (2)" style title
  const existingCount = getWindowIdsForProject(projectPath).length;
  const windowNumber = existingCount + 1;
  const title = windowNumber > 1
    ? `${folderName} (${windowNumber}) — Dobius+`
    : `${folderName} — Dobius+`;

  // Position window near the cursor, offset so title bar is under cursor
  const display = screen.getDisplayNearestPoint({ x: screenX, y: screenY });
  const x = Math.max(display.bounds.x, screenX - 200);
  const y = Math.max(display.bounds.y, screenY - 30);

  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    x,
    y,
    minWidth: 600,
    minHeight: 400,
    title,
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
  const encodedProject = encodeURIComponent(projectPath);
  const encodedTabId = encodeURIComponent(tabId);
  const encodedLabel = encodeURIComponent(tabLabel);
  const query = `project=${encodedProject}&tearOffTab=${encodedTabId}&tearOffLabel=${encodedLabel}`;

  if (isDev) {
    win.loadURL(`http://localhost:5173?${query}`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      query: { project: projectPath, tearOffTab: tabId, tearOffLabel: tabLabel },
    });
  }

  setupWindowEvents(win, projectPath, { isTearOff: true, tearOffTabId: tabId });
  return win;
}

/**
 * Get list of open project paths (deduplicated).
 * @returns {string[]}
 */
export function getOpenProjects() {
  const paths = new Set();
  for (const [, entry] of projectWindows) {
    if (!entry.win.isDestroyed()) {
      paths.add(entry.projectPath);
    }
  }
  return Array.from(paths);
}

/**
 * Close the primary window for a specific project.
 * @param {string} projectPath
 */
export function closeProjectWindow(projectPath) {
  const win = getWindowForProject(projectPath);
  if (win && !win.isDestroyed()) {
    win.close();
  }
}

/**
 * Close all project windows — called on app quit.
 * Uses destroy() to skip per-window graceful close (app quit already ran gracefulCloseAll).
 */
export function closeAllProjectWindows() {
  for (const [, entry] of projectWindows) {
    if (!entry.win.isDestroyed()) {
      entry.win.destroy(); // Skips 'close' event — prevents per-window graceful close
    }
  }
  projectWindows.clear();
}
