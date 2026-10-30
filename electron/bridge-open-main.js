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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app, ipcMain } from 'electron';
import { openProjectWindow, primaryDockTarget, getWindowEntryByWcId, getOpenProjects } from './window-manager.js';
import { terminalInstance, terminalRawOutputSeq, subscribeTerminal, trimToEscapeBoundary, getTerminalClaudeInfo, getTerminalWebContentsId, writeTerminal, listTerminals, getTerminalCwd, terminalInputAgeMs } from './terminal-manager.js';
import { classifyClaudeProcess, isClaudeEntrypoint } from './claude-argv.js';
import { submitPending } from './chat-service.js';
import { renderScreenLines } from './screen-render.js';
import { listProjects } from './data-service.js';

const TERMINAL_ID_RE = /^term-.+-\d+$/;
const WINDOW_READY_MS = 15_000;
const TAB_ADD_MS = 10_000;
const PTY_START_MS = 15_000;
// Output kept for the readiness render. A Claude startup is a few KB.
const WATCH_CAP_CHARS = 262_144;
const execFileP = promisify(execFile);

// `term-<project>-<n>`, or `term-<project>~w-<8>-<n>` from an extra window.
// Matched against the KNOWN project rather than parsed, so a folder whose
// own name contains `~w-` is not misread as a window key.
function isTabOfProject(tabId, projectPath) {
  if (typeof tabId !== 'string' || !TERMINAL_ID_RE.test(tabId)) return false;
  const head = `term-${projectPath}`;
  return tabId.startsWith(head) && /^(?:~w-[a-z0-9]{8})?-\d+$/.test(tabId.slice(head.length));
}

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh']);
const INTERPRETERS = new Set(['node', 'bun', 'deno']);

const psField = async (pid, field) => (await execFileP('/bin/ps', ['-o', `${field}=`, '-p', String(pid)], { timeout: 1000, encoding: 'utf8' })).stdout.trim();

function isExecutableFile(f) {
  try {
    const st = fs.statSync(f);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// Is this process REALLY claude? Judged on the executable the kernel ran
// (`comm`, the full path when it is the only column), not only on the
// command line, which splits at spaces: `/tmp/claude tools/zsh` reads as
// `/tmp/claude` to every argv parser. Either the executable itself is a
// claude entrypoint that exists, or it is node/bun/deno running a claude
// entrypoint (the npm install, and the ship-test stand-in) that exists.
async function isClaudeProcess(pid) {
  const comm = await psField(pid, 'comm');
  if (comm.startsWith('/') && isClaudeEntrypoint(comm)) return isExecutableFile(comm);
  if (!INTERPRETERS.has(comm.split('/').pop())) return false;
  const { kind, token } = classifyClaudeProcess(await psField(pid, 'command'));
  return kind === 'claude' && typeof token === 'string' && token.startsWith('/') && fs.statSync(token, { throwIfNoEntry: false })?.isFile() === true;
}

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
    // A NEW tab has no PTY yet when the window answers (its pane spawns one
    // after this), so an id that already has a shell is an existing tab and
    // is refused: the message must never land in a tab already in use.
    if (!isTabOfProject(tabId, p.projectPath) || terminalInstance(tabId)) {
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
    // A reload while we wait restarts the page's tab counter, so a tab the
    // person opens next could reuse the id we were given. Any reload from
    // here until the PTY exists fails the open.
    let reloaded = false;
    const onReload = () => { reloaded = true; };
    wc.on('did-start-loading', onReload);
    try {
      return await addTabAndWait(wc, projectPath, () => reloaded);
    } finally {
      if (!wc.isDestroyed()) wc.removeListener('did-start-loading', onReload);
    }
  }

  async function addTabAndWait(wc, projectPath, reloaded) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const tabId = await new Promise((resolve) => {
      const done = (id) => { clearTimeout(timer); pending.delete(nonce); resolve(id); };
      const timer = setTimeout(() => done(null), TAB_ADD_MS);
      pending.set(nonce, { wcId: wc.id, projectPath, done });
      // The window drops a request it receives after main stopped waiting
      // (a stalled renderer), so a late one cannot leave an orphan tab.
      // (2s margin: an answer sent right at the deadline would still be
      // in flight when main gives up.)
      wc.send('bridge:openTab', { nonce, expiresAt: Date.now() + TAB_ADD_MS - 2000 });
    });
    if (!tabId) return { error: 'the project window did not add the tab' };
    // The tab's pane spawns the PTY via terminal:create; wait until it is
    // this window's.
    const started = await waitFor(() => reloaded() || (!!terminalInstance(tabId) && ownerOf(tabId) === wc.id), PTY_START_MS);
    if (reloaded()) return { error: 'the project window reloaded while the tab was opening' };
    if (!started) return { error: 'the new tab\'s terminal did not start', tabId };
    // The shell must have started IN the project (createTerminal falls back
    // to home for a folder that vanished).
    if (listTerminals().find((t) => t.id === tabId)?.cwd !== projectPath) {
      return { error: 'the new tab did not start in the project folder', tabId };
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

  // The tab's output from now on, for the readiness render. Collected from
  // a subscription rather than read from the shared rolling buffer, so
  // mark() can drop everything up to the launch: only what Claude draws
  // after `claude` is typed can make the tab ready.
  function watchOutput(tabId) {
    let buf = '';
    let seq = 0;
    const sub = subscribeTerminal(tabId, {
      onData: (_id, data) => { seq += 1; buf = trimToEscapeBoundary(buf + data, WATCH_CAP_CHARS); },
    });
    return {
      mark: () => { buf = ''; },
      seq: () => seq,
      screen: async () => {
        const lines = await renderScreenLines(buf);
        return lines ? { lines, modes: lines.modes } : null;
      },
      stop: () => sub.unsubscribe(),
    };
  }

  // Claude is the tab's FOREGROUND process: a child of the shell whose
  // command line is claude by the STRICT test (classifyClaudeProcess: the
  // executed program itself, so `node other.js /path/claude` is not; the
  // native binary's process name is its version, so names are useless) and
  // whose process group owns the terminal. A suspended or background claude,
  // a shell back at its prompt, or any error fails.
  async function claudeRunning(tabId) {
    const info = await getTerminalClaudeInfo(tabId);
    if (!info?.pid) return false;
    try {
      const { stdout } = await execFileP('/bin/ps', ['-o', 'pgid=,tpgid=,stat=', '-p', String(info.pid)], { timeout: 1000, encoding: 'utf8' });
      const m = stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      if (!m) return false;
      const [, pgid, tpgid, stat] = m;
      return pgid === tpgid && !stat.startsWith('T') && (await isClaudeProcess(info.pid));
    } catch {
      return false;
    }
  }

  // The shell itself owns the terminal: the PTY's process is still a shell
  // (a login script's `exec claude` replaces it in place, same pid) and no
  // job (Codex started by a login script, a pager) is in the foreground, so
  // a typed `claude` reaches the shell and nothing else.
  async function shellForeground(tabId) {
    const pid = terminalInstance(tabId)?.pid;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      const { stdout } = await execFileP('/bin/ps', ['-o', 'pgid=,tpgid=,comm=', '-p', String(pid)], { timeout: 1000, encoding: 'utf8' });
      const m = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) return false;
      const name = m[3].split('/').pop().replace(/^-/, '');
      return m[1] === m[2] && SHELLS.has(name);
    } catch {
      return false;
    }
  }

  // The shell is in the project folder NOW (a login script can `cd`
  // elsewhere after the spawn), so Claude starts in the project.
  async function shellInProject(tabId, projectPath) {
    try {
      const cwd = await getTerminalCwd(tabId);
      return !!cwd && (await fs.promises.realpath(cwd)) === (await fs.promises.realpath(projectPath));
    } catch {
      return false;
    }
  }

  return {
    resolveProject,
    shellForeground,
    shellInProject,
    inputQuietMs: (tabId) => terminalInputAgeMs(tabId),
    openTab,
    focusTab,
    watchOutput,
    claudeRunning,
    tabAlive: (tabId) => !!terminalInstance(tabId) && getTerminalWebContentsId(tabId) !== null,
    ptyOf: (tabId) => terminalInstance(tabId),
    outputSeq: (tabId) => terminalRawOutputSeq(tabId),
    // Typed at the shell prompt, as a person would: plain `claude`, the
    // account env and PATH come from the tab's shell, and no permission
    // flag is ever added.
    // Written straight to the PTY, never queued behind a Chat submit: a
    // queued write would go out LATER, after the checks that cleared it (a
    // queued /exit could put Claude's shell in front of it).
    typeLaunch: (tabId) => writeTerminal(tabId, 'claude\r'),
    // One bracketed paste and no Enter: the person presses Enter.
    paste: (tabId, text) => writeTerminal(tabId, `\x1b[200~${text}\x1b[201~`),
    // Someone is sending a Chat message into the tab right now: its Enter is
    // still to come, so the prompt is not ours to type into.
    inputBusy: (tabId) => submitPending(tabId),
    sleep,
    now: () => Date.now(),
  };
}
