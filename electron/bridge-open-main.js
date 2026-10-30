// The electron side of /openTab (logic and docs: bridge-open-tab.js,
// docs/bridge-open-tab.md). Builds the deps createOpenTabService needs from
// the real windows, PTYs and screen emulator.
//
// The tab is created by the project WINDOW, exactly like Cmd+T: main asks the
// renderer to add a tab, the renderer answers with the id it made, and that
// tab's pane spawns the PTY through terminal:create, so the shell gets the
// same account environment as every other tab.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app, ipcMain } from 'electron';
import { openProjectWindow, primaryDockTarget, getWindowEntryByWcId, getOpenProjects } from './window-manager.js';
import { terminalInstance, terminalRawOutputSeq, getTerminalBuffer, getTerminalProcess, getTerminalWebContentsId } from './terminal-manager.js';
import { writeRawInput } from './chat-service.js';
import { renderScreenLines } from './screen-render.js';
import { listProjects } from './data-service.js';
import { parseTabId } from './tab-id-util.js';

const TERMINAL_ID_RE = /^term-.+-\d+$/;
const WINDOW_READY_MS = 15_000;
const TAB_ADD_MS = 10_000;
const PTY_START_MS = 15_000;
// Longest escape sequence a screen tail is backed up over (see activityForTab).
const SCREEN_TAIL_CHARS = 262_144;
const ESC_BACKUP_CHARS = 512;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

// The click on the board is the user asking for this window, so it comes
// forward even when Dobius+ is in the background. An isolated ship-test
// instance does not steal focus from whatever Sam is typing in.
function bringToFront(win) {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  if (process.platform === 'darwin' && !process.env.DOBIUS_USERDATA_DIR) app.focus({ steal: true });
  win.focus();
}

/**
 * The project the board named, as Dobius+ knows it. Only a folder Dobius+
 * already lists (an open window, the launcher's projects folder, a manually
 * added project, or one with Claude sessions) is accepted: a typo or a bad
 * card must not open Claude in ~ or / or create window state for an arbitrary
 * folder. Matched by realpath, and the KNOWN spelling is returned so an open
 * window for that project is reused rather than a second one opened.
 */
async function resolveProject(input) {
  let real;
  try { real = await fs.promises.realpath(input); }
  catch { return { status: 404, error: `projectPath does not exist: ${input}` }; }
  try {
    if (!(await fs.promises.stat(real)).isDirectory()) return { status: 400, error: 'projectPath is not a directory' };
  } catch (err) { return { status: 404, error: `projectPath is not readable: ${err.message}` }; }
  const open = getOpenProjects() || [];
  let listed;
  try { listed = ((await listProjects()) || []).map((p) => p.decodedPath); } catch { listed = []; }
  const seen = new Set();
  const candidates = [...open, input, ...listed].filter((p) => {
    if (typeof p !== 'string' || !p.startsWith('/') || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  const known = new Set([...open, ...listed]);
  for (const c of candidates) {
    if (!known.has(c)) continue;
    let cReal;
    try { cReal = await fs.promises.realpath(c); } catch { continue; }
    if (cReal === real) return { path: c };
  }
  return { status: 403, error: 'projectPath is not a project Dobius+ knows; open it once from the launcher (or keep it in the projects folder) first' };
}

/**
 * @param {{ windowReady: (wc) => boolean, ownerOf: (tabId) => number|undefined }} main
 *   windowReady: the window restored its tabs and listens for bridge:openTab
 *   (the same window:tabsReady signal a dock waits for). ownerOf: the
 *   webContents id terminal:create recorded for a tab.
 */
export function createBridgeOpenDeps({ windowReady, ownerOf }) {
  const pending = new Map(); // nonce -> { wcId, projectPath, done }

  ipcMain.on('bridge:tabOpened', (event, nonce, tabId) => {
    const p = typeof nonce === 'string' ? pending.get(nonce) : null;
    if (!p || p.wcId !== event.sender.id) return;
    if (typeof tabId !== 'string' || !TERMINAL_ID_RE.test(tabId) || parseTabId(tabId)?.projectPath !== p.projectPath) {
      p.done(null);
      return;
    }
    p.done(tabId);
  });

  async function openTab(projectPath) {
    let target = primaryDockTarget(projectPath, null);
    if (!target) {
      openProjectWindow(projectPath);
      target = primaryDockTarget(projectPath, null);
    }
    if (!target) return { error: 'could not open the project window' };
    const { win } = target;
    const wc = win.webContents;
    bringToFront(win);
    if (!(await waitFor(() => wc.isDestroyed() || windowReady(wc), WINDOW_READY_MS)) || wc.isDestroyed()) {
      return { error: 'the project window did not finish loading' };
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const tabId = await new Promise((resolve) => {
      const done = (id) => { clearTimeout(timer); pending.delete(nonce); resolve(id); };
      const timer = setTimeout(() => done(null), TAB_ADD_MS);
      pending.set(nonce, { wcId: wc.id, projectPath, done });
      wc.send('bridge:openTab', { nonce });
    });
    if (!tabId) return { error: 'the project window did not add the tab' };
    // The tab's pane spawns the PTY via terminal:create; wait until it is
    // this window's.
    if (!(await waitFor(() => !!terminalInstance(tabId) && ownerOf(tabId) === wc.id, PTY_START_MS))) {
      return { error: 'the new tab\'s terminal did not start' };
    }
    return { tabId };
  }

  function focusTab(tabId) {
    const entry = getWindowEntryByWcId(getTerminalWebContentsId(tabId));
    if (!entry) return false;
    bringToFront(entry.win);
    entry.win.webContents.send('bridge:focusTab', tabId);
    return true;
  }

  async function readScreen(tabId) {
    const raw = getTerminalBuffer(tabId) || '';
    let start = Math.max(0, raw.length - SCREEN_TAIL_CHARS);
    if (start > 0) {
      const esc = raw.lastIndexOf('\x1b', start);
      if (esc !== -1 && start - esc <= ESC_BACKUP_CHARS) start = esc;
    }
    const lines = await renderScreenLines(raw.slice(start));
    return lines ? { lines, modes: lines.modes } : null;
  }

  return {
    resolveProject,
    openTab,
    focusTab,
    readScreen,
    tabAlive: (tabId) => !!terminalInstance(tabId) && getTerminalWebContentsId(tabId) !== null,
    ptyOf: (tabId) => terminalInstance(tabId),
    outputSeq: (tabId) => terminalRawOutputSeq(tabId),
    cliRunning: async (tabId) => /^(claude|codex|node)$/i.test(path.basename((await getTerminalProcess(tabId)) || '')),
    // Typed at the shell prompt, as a person would: plain `claude`, the
    // account env and PATH come from the tab's shell, and no permission
    // flag is ever added.
    typeLaunch: (tabId) => writeRawInput(tabId, 'claude\r'),
    // One bracketed paste and no Enter: the person presses Enter.
    paste: (tabId, text) => writeRawInput(tabId, `\x1b[200~${text}\x1b[201~`),
    sleep,
    now: () => Date.now(),
  };
}
