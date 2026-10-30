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
import { terminalInstance, terminalRawOutputSeq, subscribeTerminal, trimToEscapeBoundary, getTerminalWebContentsId, writeTerminal, listTerminals, getTerminalCwd, getProcessCwd, addInputObserver, terminalClosing } from './terminal-manager.js';
import { classifyClaudeProcess, isClaudeEntrypoint } from './claude-argv.js';
import { isKeyboardInput, CLAUDE_SCRIPT_RE } from './bridge-open-tab.js';
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

// Writes made by /openTab itself, so they are not counted as a person's.
let ownWrite = false;
function writeOwn(tabId, data) {
  ownWrite = true;
  try { writeTerminal(tabId, data); } finally { ownWrite = false; }
}

// -ww: never truncate a command line.
const psField = async (pid, field) => (await execFileP('/bin/ps', ['-ww', '-o', `${field}=`, '-p', String(pid)], { timeout: 1000, encoding: 'utf8' })).stdout.trim();

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
  if (kind !== 'claude' || typeof token !== 'string' || !token.startsWith('/')) return false;
  // The command line splits at spaces (`node "/tmp/claude tools/x.js"` reads
  // as `/tmp/claude`), so the token must RESOLVE to Claude's own script.
  try { return CLAUDE_SCRIPT_RE.test(fs.realpathSync(token)) && fs.statSync(token).isFile(); } catch { return false; }
}

async function childPids(pid) {
  try {
    const { stdout } = await execFileP('/usr/bin/pgrep', ['-P', String(pid)], { timeout: 1000, encoding: 'utf8' });
    return stdout.split('\n').map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch (err) {
    if (err?.code === 1) return []; // pgrep: no children
    throw err;
  }
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
  // A PERSON's keyboard writes into each tab we opened, counted from the
  // moment the window names the tab (before its PTY exists), so keys typed
  // while it starts are never missed. tabId -> { n, off }
  // One counter PER REQUEST (a reused tab id after a crash must not share or
  // cancel another request's counter). tabId -> Set of { n }
  const keyCounters = new Map();
  function countKeys(tabId) {
    const c = { n: 0, tabId };
    if (!keyCounters.has(tabId)) keyCounters.set(tabId, new Set());
    keyCounters.get(tabId).add(c);
    return c;
  }
  function stopCounting(c) {
    const set = c && keyCounters.get(c.tabId);
    if (!set) return;
    set.delete(c);
    if (!set.size) keyCounters.delete(c.tabId);
  }
  const bump = (id, data) => {
    const set = typeof id === 'string' ? keyCounters.get(id) : null;
    if (set && isKeyboardInput(data)) for (const c of set) c.n += 1;
  };
  addInputObserver((id, data) => { if (!ownWrite) bump(id, data); });
  // Keys a window sends for a tab whose PTY does not exist yet are dropped by
  // terminal:write, so the observer above never sees them; a person typed
  // all the same, and their Enter may follow once the shell is up. Count
  // them here too.
  ipcMain.on('terminal:write', (_event, id, data) => bump(id, data));

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
    p.counter = countKeys(tabId);
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
    const entry = { wcId: wc.id, projectPath, done: null, counter: null };
    const tabId = await new Promise((resolve) => {
      const done = (id) => { clearTimeout(timer); pending.delete(nonce); resolve(id); };
      const timer = setTimeout(() => done(null), TAB_ADD_MS);
      entry.done = done;
      pending.set(nonce, entry);
      // The window drops a request it receives after main stopped waiting
      // (a stalled renderer), so a late one cannot leave an orphan tab.
      // (2s margin: an answer sent right at the deadline would still be
      // in flight when main gives up.)
      wc.send('bridge:openTab', { nonce, expiresAt: Date.now() + TAB_ADD_MS - 2000 });
    });
    if (!tabId) return { error: 'the project window did not add the tab' };
    // The tab's pane spawns the PTY via terminal:create; wait until it is
    // this window's.
    const { counter } = entry;
    const started = await waitFor(() => reloaded() || wc.isDestroyed() || (!!terminalInstance(tabId) && ownerOf(tabId) === wc.id), PTY_START_MS);
    if (reloaded() || wc.isDestroyed()) { stopCounting(counter); return { error: 'the project window reloaded or closed while the tab was opening' }; }
    if (!started) { stopCounting(counter); return { error: 'the new tab\'s terminal did not start', tabId }; }
    // The shell must have started IN the project (createTerminal falls back
    // to home for a folder that vanished).
    if (listTerminals().find((t) => t.id === tabId)?.cwd !== projectPath) {
      stopCounting(counter);
      return { error: 'the new tab did not start in the project folder', tabId };
    }
    return { tabId, keyCounter: counter };
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
  function watchOutput(tabId, counter) {
    let buf = '';
    let seq = 0;
    const keys = counter || countKeys(tabId);
    const sub = subscribeTerminal(tabId, {
      onData: (_id, data) => { seq += 1; buf = trimToEscapeBoundary(buf + data, WATCH_CAP_CHARS); },
    });
    return {
      mark: () => { buf = ''; },
      seq: () => seq,
      keys: () => keys.n,
      screen: async () => {
        const lines = await renderScreenLines(buf);
        return lines ? { lines, modes: lines.modes } : null;
      },
      stop: () => { sub.unsubscribe(); stopCounting(keys); },
    };
  }

  // Claude is the tab's FOREGROUND process: a child of the shell whose
  // command line is claude by the STRICT test (classifyClaudeProcess: the
  // executed program itself, so `node other.js /path/claude` is not; the
  // native binary's process name is its version, so names are useless) and
  // whose process group owns the terminal. A suspended or background claude,
  // a shell back at its prompt, or any error fails.
  // Candidates: a claude child of the shell, or the PTY's own process when
  // a login script `exec`'d claude in place of the shell. It must LEAD the
  // terminal's foreground process group (a background claude in the shell's
  // own group, job control off, does not), and work in the project (a login
  // script's `cd /q; claude` does not).
  async function claudeRunning(tabId, projectPath) {
    const shellPid = terminalInstance(tabId)?.pid;
    if (!Number.isInteger(shellPid) || shellPid <= 0) return false;
    // EVERY child, not the first claude one: a background `claude -p` listed
    // first must not hide the interactive one.
    let pids;
    try { pids = [...(await childPids(shellPid)), shellPid]; } catch { return false; }
    for (const pid of pids) {
      try {
        const { stdout } = await execFileP('/bin/ps', ['-o', 'pgid=,tpgid=,stat=', '-p', String(pid)], { timeout: 1000, encoding: 'utf8' });
        const m = stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
        if (!m) continue;
        const [, pgid, tpgid, stat] = m;
        // The permission mode is NOT checked (Sam: "bypass permissions should
        // act just like auto mode"); only that this really is claude.
        if (pgid !== tpgid || pgid !== String(pid) || stat.startsWith('T') || !(await isClaudeProcess(pid))) continue;
        const cwd = await getProcessCwd(pid);
        if (cwd && (await fs.promises.realpath(cwd)) === (await fs.promises.realpath(projectPath))) return true;
      } catch { /* this candidate is unreadable: not claude */ }
    }
    return false;
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
      if (m[1] !== m[2] || !SHELLS.has(name)) return false;
      // With job control off, a running child shares the shell's group, so
      // the group owning the terminal does not prove the SHELL is reading
      // it: no child may be in the foreground group.
      for (const child of await childPids(pid)) {
        const { stdout: o } = await execFileP('/bin/ps', ['-o', 'pgid=', '-p', String(child)], { timeout: 1000, encoding: 'utf8' });
        if (o.trim() === m[2]) return false;
      }
      return true;
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
    openTab,
    focusTab,
    watchOutput,
    claudeRunning,
    // A tab being closed (its window shutting down sends Ctrl+C straight to
    // the PTY) is not alive: nothing more is typed into it.
    tabAlive: (tabId) => !!terminalInstance(tabId) && getTerminalWebContentsId(tabId) !== null && !terminalClosing(tabId),
    ptyOf: (tabId) => terminalInstance(tabId),
    outputSeq: (tabId) => terminalRawOutputSeq(tabId),
    // Typed at the shell prompt, as a person would: plain `claude`, the
    // account env and PATH come from the tab's shell, and no permission
    // flag is ever added.
    // Written straight to the PTY, never queued behind a Chat submit: a
    // queued write would go out LATER, after the checks that cleared it (a
    // queued /exit could put Claude's shell in front of it).
    // Ctrl+E then Ctrl+U first: anything already on the shell's input line
    // (end of line, then kill to its start, so a cursor moved to the start
    // cannot leave a tail) is erased, never run along with the launch.
    typeLaunch: (tabId) => writeOwn(tabId, '\x05\x15claude\r'),
    // One bracketed paste, no Enter in it.
    paste: (tabId, text) => writeOwn(tabId, `\x1b[200~${text}\x1b[201~`),
    // The single Enter, written on its own once the paste has settled.
    submit: (tabId) => writeOwn(tabId, '\r'),
    // Someone is sending a Chat message into the tab right now: its Enter is
    // still to come, so the prompt is not ours to type into.
    inputBusy: (tabId) => submitPending(tabId),
    sleep,
    now: () => Date.now(),
  };
}
