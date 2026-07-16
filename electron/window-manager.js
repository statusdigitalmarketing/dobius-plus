import { BrowserWindow, app, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { killTerminal, getActiveTerminals, gracefulCloseTerminals, getTerminalsForProject } from './terminal-manager.js';
import { watchFiles } from './watcher-service.js';
import { getProjectConfig, setProjectConfig, loadConfig, saveConfig } from './config-manager.js';
import { getQuittingForUpdate, getQuitting } from './quit-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Map of windowId (number) → { projectPath, win } */
const projectWindows = new Map();

/**
 * Persist the CURRENT set of open project paths to config.lastOpenProjects.
 *
 * v1.0.38 (Brett-reported): lastOpenProjects used to be written in exactly
 * ONE place, the Phase-3 branch of a normal two-press Cmd+Q quit. Any other
 * exit (the auto-update Restart button, force quit, OS shutdown, crash) never
 * recorded the window list, so on relaunch the list was stale or empty and
 * the app came up with just a fresh launcher instead of restoring the
 * session. Brett hit Restart and lost all his windows exactly this way.
 *
 * Keeping the list live on every open/close means the truth is already on
 * disk before any exit path runs, so restore works no matter HOW the app
 * went down. Guarded by getQuitting(): once a quit is committed the windows
 * all close in a cascade, which would otherwise rewrite this to [] and wipe
 * the state we're trying to restore. saveConfig is debounced so the churn is
 * cheap. Tear-off windows are excluded (they're ephemeral, not a project's
 * primary window).
 */
function persistOpenProjects() {
  if (getQuitting()) return; // snapshot frozen: quit in progress
  try {
    const config = loadConfig();
    config.lastOpenProjects = getOpenProjectsForRestore();
    saveConfig(config);
  } catch { /* best-effort */ }
}

/**
 * The project paths that SHOULD be reopened on next launch: live primary
 * windows only. Tear-off windows are excluded because they are ephemeral,
 * so a project whose primary window the user deliberately closed does not
 * come back just because a torn-off tab of it is still floating.
 *
 * Distinct from getOpenProjects(), which includes tear-offs and is used for
 * "is this project open right now" checks (isKnownProject, focus routing).
 * Every writer of lastOpenProjects MUST use this one so the live snapshot
 * and the quit-path snapshots cannot disagree. Codex v1.0.38 r1 P2.
 */
export function getOpenProjectsForRestore() {
  const paths = new Set();
  for (const [, entry] of projectWindows) {
    if (!entry.isTearOff && !entry.win.isDestroyed()) paths.add(entry.projectPath);
  }
  return Array.from(paths);
}

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
    if (closingGracefully) return; // Phase 2, let it close

    // Updater-bypass: when the Restart button is firing app.quit() through
    // squirrel.mac, the bundle replace expects the app to exit FAST. Let
    // every window close immediately; will-quit + the updater branch of
    // before-quit handle PTY/server teardown. Without this bypass, the
    // graceful Ctrl+C+save dance can race the bundle replacement.
    if (getQuittingForUpdate && getQuittingForUpdate()) return;

    // Phase 1, intercept and do graceful shutdown
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
    // Deliberately closed windows should NOT come back next launch. No-ops
    // during a quit (getQuitting), so the teardown cascade can't wipe the
    // restore list. v1.0.38.
    persistOpenProjects();

    // Auto-resume cancel: drop any pending queue entries for this project
    // since the tabs are about to die. Dynamic import avoids a hard
    // circular dep on the orchestrator module.
    try {
      // eslint-disable-next-line global-require, import/no-extraneous-dependencies
      import('./auto-resume.js').then((m) => {
        if (m?.cancelTabsForProject) m.cancelTabsForProject(projectPath);
      }).catch(() => {});
    } catch { /* noop */ }

    // If this is a tear-off window, only kill the specific torn-off terminal
    if (isTearOff && tearOffTabId) {
      killTerminal(tearOffTabId);
      return;
    }

    // For primary windows: check if another window for this project exists.
    // If so, don't kill any terminals (the other window owns them).
    const otherWindowIds = getWindowIdsForProject(projectPath);
    if (otherWindowIds.length > 0) return;

    // No other windows, kill all terminals for this project
    const termIds = getTerminalsForProject(projectPath);
    for (const id of termIds) {
      killTerminal(id);
    }
  });

  projectWindows.set(win.id, { projectPath, win, isTearOff });
  // Record the new window immediately so any exit path can restore it.
  persistOpenProjects();
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
    title: `${folderName} | Dobius+`,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0D1117',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // BrowserPane (v1.0.25+) embeds <webview> for the dev-server preview.
      // Tag is sandboxed + isolated via partition string in BrowserPane.jsx.
      webviewTag: true,
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
    ? `${folderName} (${windowNumber}) | Dobius+`
    : `${folderName} | Dobius+`;

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
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // BrowserPane (v1.0.25+) embeds <webview> for the dev-server preview.
      // Tag is sandboxed + isolated via partition string in BrowserPane.jsx.
      webviewTag: true,
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

/** Single Visual preview window (phone-shaped, its own window so it never covers the terminal). */
let visualWindow = null;
let visualWindowProject = null;

function visualUrl(win, projectPath) {
  const isDev = !app.isPackaged;
  const encodedProject = encodeURIComponent(projectPath);
  if (isDev) {
    win.loadURL(`http://localhost:5173?project=${encodedProject}&visual=1`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      query: { project: projectPath, visual: '1' },
    });
  }
}

/**
 * Open (or focus) the Visual preview window for a project. If a window is
 * already open for a DIFFERENT project, reload it to the requested project
 * (instead of silently showing the previous project).
 * @param {string} projectPath
 * @returns {BrowserWindow}
 */
export function openVisualWindow(projectPath) {
  if (visualWindow && !visualWindow.isDestroyed()) {
    if (visualWindowProject !== projectPath) {
      visualWindowProject = projectPath;
      visualUrl(visualWindow, projectPath);
      visualWindow.setTitle(`Visual — ${path.basename(projectPath)}`);
    }
    visualWindow.focus();
    return visualWindow;
  }

  const folderName = path.basename(projectPath);

  // Phone-shaped: 375 viewport + 8px bezel each side + panel padding, plus header/footer chrome.
  const win = new BrowserWindow({
    width: 431,
    height: 880,
    minWidth: 431,
    minHeight: 560,
    title: `Visual — ${folderName}`,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0D1117',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  visualUrl(win, projectPath);

  win.on('closed', () => {
    visualWindow = null;
    visualWindowProject = null;
    // Stop the express server + chokidar watcher when the Visual window
    // closes. The renderer's visualStop IPC is not reliable once the
    // BrowserWindow is being destroyed (channel can die mid-flight), so
    // tear down from the main side too. Dynamic import to avoid a top-of-
    // file circular risk. Codex r28 P2.
    import('./visual-server.js').then((m) => {
      if (m?.stopVisualServer) m.stopVisualServer().catch(() => {});
    }).catch(() => {});
  });
  visualWindow = win;
  visualWindowProject = projectPath;
  return win;
}

export function getVisualWindow() {
  return (visualWindow && !visualWindow.isDestroyed()) ? visualWindow : null;
}

/** Destroy the Visual window if open (used on quit so its server can be torn down). */
export function closeVisualWindow() {
  if (visualWindow && !visualWindow.isDestroyed()) visualWindow.destroy();
  visualWindow = null;
  visualWindowProject = null;
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
