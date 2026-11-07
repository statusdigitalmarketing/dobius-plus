// The electron side of /openTab (logic and docs: bridge-open-tab.js,
// docs/bridge-open-tab.md). Builds the deps createOpenTabService needs from
// the real windows, PTYs and screen emulator.
//
// The tab is created by the project WINDOW through the New Tab path
// (store.openNewTab with tool 'claude'): main asks the renderer for it, the
// renderer answers with the id it made, and that tab's pane spawns the PTY
// through terminal:create with launch 'claude', so the shell gets the same
// account environment as every other tab and starts Claude itself (no typing).

import crypto from 'crypto';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app, ipcMain } from 'electron';
import { openProjectWindow, primaryDockTarget, getWindowEntryByWcId, getOpenProjects } from './window-manager.js';
import { terminalInstance, getTerminalBuffer, terminalCols, subscribeTerminal, trimToEscapeBoundary, getTerminalWebContentsId, writeTerminal, listTerminals, getProcessCwd, addInputObserver, terminalClosing } from './terminal-manager.js';
import { classifyClaudeProcess, isClaudeEntrypoint, JS_RUNTIMES, CLAUDE_SCRIPT_RE } from './claude-argv.js';
import { isKeyboardInput, isUserInput } from './bridge-open-tab.js';
import { submitPending } from './chat-service.js';
import { renderScreenLines } from './screen-render.js';
import { listProjects } from './data-service.js';
import { parseTabId } from './tab-id-util.js';

const WINDOW_READY_MS = 15_000;
const TAB_ADD_MS = 10_000;
const PTY_START_MS = 15_000;
// Output kept for the readiness render. A Claude startup is a few KB.
const WATCH_CAP_CHARS = 262_144;
const execFileP = promisify(execFile);

// `term-<project>-<n>`, or `term-<project>~w-<8>-<n>` from an extra window,
// parsed by the one tab-id parser. A whole-path match, so `/a/b`'s request
// never takes `/a/b-1`'s tab. (A folder whose own name ends in `~w-` plus 8
// characters parses as an extra window of its parent and is refused: safe.)
const isTabOfProject = (tabId, projectPath) => parseTabId(tabId)?.projectPath === projectPath;

// Writes made by /openTab itself, so they are not counted as a person's.
let ownWrite = false;
/** True while Dobius itself is typing into a tab (a /openTab or team delivery paste or Enter), not a person. */
export const isOwnWrite = () => ownWrite;
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

// The file the kernel is actually running for pid: lsof's first text (txt)
// entry is the program image, symlinks already resolved. '' when unknown.
async function executablePath(pid) {
  try {
    // UTF-8 locale: under C, lsof escapes every non-ASCII byte (/Users/rené).
    const env = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' };
    const { stdout } = await execFileP('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], { timeout: 1500, encoding: 'utf8', env });
    const line = stdout.split('\n').find((l) => l.startsWith('n/'));
    // lsof escapes odd characters (a tab becomes the two characters \t), so a
    // name with a backslash is not a usable path: refuse it, never guess.
    return line && !line.includes('\\') ? line.slice(1) : '';
  } catch (err) {
    console.warn(`[bridge-open] could not read the executable of pid ${pid}:`, err?.message || err);
    return '';
  }
}

// Is this process REALLY claude? Judged on the executable the kernel ran,
// not only on the command line, which splits at spaces: `/tmp/claude
// tools/zsh` reads as `/tmp/claude` to every argv parser. Either the
// executable itself is a claude entrypoint that exists, or it is
// node/bun/deno running a claude entrypoint (the npm install, and the
// ship-test stand-in) that exists.
//
// `ps -o comm=` is the path the process was STARTED with, so a tab that runs
// plain `claude` (how a new tab starts it) reports just "claude" (Brett,
// 2026-11-02: /openTab never saw Claude). Only for that bare name, the real
// file decides, by WHO SIGNED IT rather than where it sits: Anthropic's
// Developer ID signature on com.anthropic.claude-code. Location patterns
// were tried and lost both ways in review (look-alike folders passed;
// Homebrew @latest, npm's claude.exe, XDG_DATA_HOME and symlinked install
// folders failed). Every other name keeps the old path, so a runtime alias
// (`node` -> node-v22) is never renamed out of JS_RUNTIMES.
// Accepted residuals: lsof's first txt entry is assumed to be the image (a
// helper named `claude` that maps Claude's binary below its own would pass),
// a genuine Claude of 2.1.34 or older started with BUN_BE_BUN=1 runs an
// arbitrary script under the real binary, and a same-user attacker swapping
// folders during the ~2s codesign run could cache a pass for the wrong file.
// All need deliberate local action as this user, who could type into the
// terminal directly anyway, and must still show Claude's prompt on screen.
const CLAUDE_SIGNATURE = 'anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"';
const signedCache = new Map(); // path|ino|size|mtime|ctime -> { ok, at }
const UNSIGNED_RECHECK_MS = 30_000;

// Verifying a 300MB binary takes about 2s, so a pass is kept for that exact
// file (a replaced or updated binary has a new inode, size or mtime); a fail
// is re-checked after 30s in case it was a timeout.
export async function isSignedClaude(file, { verify } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return false; } // gone: not a running Claude we can vouch for
  if (!st.isFile() || (st.mode & 0o111) === 0) return false;
  // ctime too: an owner can restore mtime after rewriting the same inode, but
  // not ctime.
  const key = `${file}|${st.ino}|${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
  const hit = signedCache.get(key);
  if (hit && (hit.ok || Date.now() - hit.at < UNSIGNED_RECHECK_MS)) return hit.ok;
  const check = verify || ((f) => execFileP('/usr/bin/codesign', ['--verify', '--strict', `-R=${CLAUDE_SIGNATURE}`, f], { timeout: 20_000 }).then(() => true, () => false));
  const ok = await check(file);
  if (signedCache.size > 50) signedCache.clear();
  signedCache.set(key, { ok, at: Date.now() });
  return ok;
}

export async function isClaudeProcess(pid, { ps = psField, exe = executablePath, signed = isSignedClaude } = {}) {
  const comm = await ps(pid, 'comm');
  if (comm === 'claude') {
    const real = await exe(pid);
    return real.startsWith('/') && await signed(real);
  }
  if (comm.startsWith('/') && isClaudeEntrypoint(comm)) return isExecutableFile(comm);
  if (!JS_RUNTIMES.has(comm.split('/').pop())) return false;
  const { kind, token } = classifyClaudeProcess(await ps(pid, 'command'));
  if (kind !== 'claude' || typeof token !== 'string' || !token.startsWith('/')) return false;
  // The command line splits at spaces (`node "/tmp/claude tools/x.js"` reads
  // as `/tmp/claude`), so the token must RESOLVE to Claude's own script.
  try { return CLAUDE_SCRIPT_RE.test(fs.realpathSync(token)) && fs.statSync(token).isFile(); } catch { return false; }
}

// Does anything Claude started hold THIS terminal open, on any descriptor,
// directly or through /dev/tty (an external editor from Ctrl+G, a `!` shell
// command, a helper reading fd 3)? Then the screen may not be Claude's prompt,
// whatever it looks like, and nothing may be pasted (Codex team review r4/r5,
// Critical). MCP servers and tool commands run on pipes and hold no descriptor
// on the terminal (checked on a live Claude 2.1.317 session: none of its
// descendants did). Only descriptors open for READING count (a write-only
// stderr on the terminal steals no keys). Any doubt counts as yes: ps or lsof
// failing, Claude gone from the process table, a tree too large to walk, or a
// descendant owned by another user (sudo vim): macOS does not let lsof see
// another user's descriptors, and it skips such a process silently.
// Residual: a LOCAL process built to race this check (forking a reader between
// the process snapshot and the paste) is outside the threat model, which is a
// remote teammate's text.
export async function ttyReaderUnder(pid, tty, { exec = execFileP } = {}) {
  try {
    const { stdout } = await exec('/bin/ps', ['-A', '-o', 'pid=,ppid=,uid=,tty='], { timeout: 1500, encoding: 'utf8' });
    const kids = new Map();
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
      if (!m) continue;
      if (!kids.has(m[2])) kids.set(m[2], []);
      kids.get(m[2]).push({ pid: m[1], uid: Number(m[3]), tty: m[4] });
    }
    const me = typeof process.getuid === 'function' ? process.getuid() : null;
    // Claude itself must still be there: gone means its shell may have started
    // something else on the terminal.
    if (![...kids.values()].some((list) => list.some((k) => k.pid === String(pid)))) return true;
    const desc = [];
    const queue = [String(pid)];
    while (queue.length) {
      if (desc.length > 5000) return true;
      for (const k of kids.get(queue.shift()) || []) {
        if (me !== null && k.uid !== me) return true;
        queue.push(k.pid);
        desc.push(k.pid);
      }
    }
    if (!desc.length) return false;
    // Every descriptor of every descendant: a process without this terminal as
    // its controlling tty can still have opened it.
    // -n -P: no host or port name lookups (a slow resolver must not time this
    // out on an MCP server's socket). -Fan: access mode, then name, per fd.
    const r = await exec('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', desc.join(','), '-Fan'], { timeout: 3000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .catch((err) => (err?.code === 1 && !err.stdout ? { stdout: '' } : Promise.reject(err)));
    const names = new Set([`/dev/${tty}`, '/dev/tty']);
    let mode = '';
    for (const l of r.stdout.split('\n')) {
      if (l.startsWith('f') || l.startsWith('p')) mode = '';
      else if (l.startsWith('a')) mode = l.slice(1);
      else if (l.startsWith('n') && names.has(l.slice(1)) && mode !== 'w') return true;
    }
    return false;
  } catch (err) {
    console.warn('[bridge-open] could not check what reads the terminal:', err?.message || err);
    return true;
  }
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
  function countKeys(tabId, wcId = null) {
    // n: keyboard writes; any: every write a person made, mouse included.
    const c = { n: 0, any: 0, tabId, wcId };
    if (!keyCounters.has(tabId)) keyCounters.set(tabId, new Set());
    keyCounters.get(tabId).add(c);
    return c;
  }
  function stopCounting(c) {
    c?.cleanup?.();
    const set = c && keyCounters.get(c.tabId);
    if (!set) return;
    set.delete(c);
    if (!set.size) keyCounters.delete(c.tabId);
  }
  // senderId: a window's terminal:write counts only for the request that
  // window is opening (another window cannot write into this tab, so its
  // writes must not be able to cancel the request either).
  const bump = (id, data, senderId = null) => {
    const set = typeof id === 'string' ? keyCounters.get(id) : null;
    if (!set || !isUserInput(data)) return;
    const key = isKeyboardInput(data);
    for (const c of set) {
      if (senderId !== null && c.wcId !== senderId) continue;
      c.any += 1;
      if (key) c.n += 1;
    }
  };
  addInputObserver((id, data) => { if (!ownWrite) bump(id, data); });
  // Keys a window sends for a tab whose PTY does not exist yet are dropped by
  // terminal:write, so the observer above never sees them; a person typed
  // all the same, and their Enter may follow once the shell is up. Count
  // them here too. A key that does reach the PTY is so counted twice (and a
  // held one, below, three times): harmless, every reader only asks whether
  // a count moved (!== 0, or !== an earlier reading), never by how much.
  ipcMain.on('terminal:write', (event, id, data) => bump(id, data, event.sender.id));
  // Prompt editing (src/lib/prompt-edit-term.js) holds a person's input in
  // its own queue while an edit or an image paste is pending, so it reaches
  // terminal:write late, maybe after our Enter. The window owning the tab
  // reports each held input as it accepts it (a key, counted now) and null
  // once its queue drains; until then the tab is busy. After a tear-off the
  // old and the new window can both hold. /openTab is the only reader: Chat
  // and the command bar are not ordered around a hold (accepted residual,
  // src/lib/prompt-edit-term.js). tabId -> Set of wcIds
  const heldInput = new Map();
  const dropHold = (t, w) => {
    const set = heldInput.get(t);
    if (!set?.delete(w)) return;
    if (!set.size) heldInput.delete(t);
  };
  const heldHooked = new WeakSet();
  ipcMain.on('terminal:inputHeld', (event, id, data) => {
    const wc = event.sender;
    if (typeof id !== 'string') return;
    // The release comes from the window that holds, even once the tab has
    // moved to another window (a tear-off claims the PTY before the old pane
    // is gone); only a new hold needs the tab's current owner.
    if (data === null) {
      dropHold(id, wc.id);
      return;
    }
    if (getTerminalWebContentsId(id) !== wc.id || typeof data !== 'string' || !data) return;
    if (!heldHooked.has(wc)) {
      heldHooked.add(wc);
      // A reloaded, crashed or closed page never reports its drain.
      const forget = () => { for (const t of [...heldInput.keys()]) dropHold(t, wc.id); };
      wc.on('did-start-loading', forget);
      wc.on('render-process-gone', forget);
      wc.once('destroyed', forget);
    }
    if (!heldInput.has(id)) heldInput.set(id, new Set());
    heldInput.get(id).add(wc.id);
    // Counted for every request on the tab: the sender was just checked as
    // the tab's owner, which may be a tear-off and not the opening window.
    bump(id, data);
  });

  // Windows /openTab opened (webContents ids). Such a window, starting with no
  // saved tabs, makes no first tab of its own: the request's tab (tool
  // claude) is its first, so one request never starts two tools (ProjectView
  // asks while it restores its tabs). Kept until the request ends, so a page
  // reloaded meanwhile asks again and still makes no tab of its own, and
  // counted: a second request into that window keeps it until IT ends too.
  // wcId -> requests in flight
  const openedForBridge = new Map();
  ipcMain.handle('window:openedForBridge', (event) => openedForBridge.has(event.sender.id));

  // Requests main stopped waiting for: a window that answers one anyway
  // (it added the tab after main gave up) is told to drop that tab, so a
  // retry of the same request cannot leave two. nonce -> { wcId, projectPath }
  const expired = new Map();
  ipcMain.on('bridge:tabOpened', (event, nonce, tabId) => {
    const late = typeof nonce === 'string' ? expired.get(nonce) : null;
    if (late) {
      expired.delete(nonce);
      if (late.wcId === event.sender.id && isTabOfProject(tabId, late.projectPath)) event.sender.send('bridge:dropTab', tabId);
      return;
    }
    const p = typeof nonce === 'string' ? pending.get(nonce) : null;
    if (!p || p.wcId !== event.sender.id) return;
    // A NEW tab has no PTY yet when the window answers (its pane spawns one
    // after this), so an id that already has a shell is an existing tab and
    // is refused: the message must never land in a tab already in use.
    // And an id another live request already holds is refused: one tab per
    // request, never two requests typing into one tab.
    if (!isTabOfProject(tabId, p.projectPath) || terminalInstance(tabId) || keyCounters.get(tabId)?.size) {
      p.done(null);
      return;
    }
    p.counter = countKeys(tabId, p.wcId);
    p.done(tabId);
  });

  async function openTab(projectPath) {
    let target = primaryDockTarget(projectPath, null);
    let opened = null;
    if (!target) {
      const win = openProjectWindow(projectPath);
      target = primaryDockTarget(projectPath, null);
      // A window opened FOR this request: our tab is its first, so a fresh
      // window (no saved tabs) must not also start the New Tab default.
      if (target?.win === win) opened = win.webContents.id;
    } else if (openedForBridge.has(target.win.webContents.id)) {
      // Another request opened it and its page may still be starting.
      opened = target.win.webContents.id;
    }
    if (opened !== null) openedForBridge.set(opened, (openedForBridge.get(opened) || 0) + 1);
    try {
      return await openTabIn(target, projectPath);
    } finally {
      // The request's tab exists now (or never will): once no request is
      // left, the window decides its own first tab again.
      if (opened !== null) {
        const n = openedForBridge.get(opened) - 1;
        if (n > 0) openedForBridge.set(opened, n); else openedForBridge.delete(opened);
      }
    }
  }

  async function openTabIn(target, projectPath) {
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
      const timer = setTimeout(() => {
        expired.set(nonce, { wcId: wc.id, projectPath });
        setTimeout(() => expired.delete(nonce), 60_000).unref?.();
        done(null);
      }, TAB_ADD_MS);
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
    // From here until the request ends, a reload of this window ends it: the
    // reloaded page replaces the tab's PTY, so nothing may be typed into the
    // old one (tabAlive reads this flag).
    const onReload = () => { counter.reloaded = true; };
    wc.on('did-start-loading', onReload);
    counter.cleanup = () => { if (!wc.isDestroyed()) wc.removeListener('did-start-loading', onReload); };
    const closing = () => !!getWindowEntryByWcId(wc.id)?.closing;
    const started = await waitFor(() => reloaded() || wc.isDestroyed() || closing() || (!!terminalInstance(tabId) && ownerOf(tabId) === wc.id), PTY_START_MS);
    if (reloaded() || wc.isDestroyed() || closing()) { stopCounting(counter); return { error: 'the project window reloaded or closed while the tab was opening' }; }
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

  // The tab's output since its PTY started (it is brand new: its shell's
  // first command is claude), kept current from a subscription. Seeded from
  // the PTY's own buffer in the same tick it subscribes, so nothing drawn
  // before the watch began is missed.
  function watchOutput(tabId, counter) {
    let buf = trimToEscapeBoundary(getTerminalBuffer(tabId) || '', WATCH_CAP_CHARS);
    let seq = 0;
    const keys = counter || countKeys(tabId);
    const sub = subscribeTerminal(tabId, {
      onData: (_id, data) => { seq += 1; buf = trimToEscapeBoundary(buf + data, WATCH_CAP_CHARS); },
    });
    return {
      seq: () => seq,
      keys: () => keys.n,
      input: () => keys.any,
      screen: async () => {
        // At the PTY's own width: a wider window's rules must not wrap.
        const lines = await renderScreenLines(buf, { cols: terminalCols(tabId) });
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
    let tty;
    try {
      pids = [...(await childPids(shellPid)), shellPid];
      tty = await psField(shellPid, 'tty');
    } catch { return false; }
    // It must be on THIS tab's terminal (a child can hold another pty).
    if (!tty || tty === '??') return false;
    for (const pid of pids) {
      try {
        const { stdout } = await execFileP('/bin/ps', ['-o', 'pgid=,tpgid=,stat=', '-p', String(pid)], { timeout: 1000, encoding: 'utf8' });
        const m = stdout.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
        if (!m) continue;
        const [, pgid, tpgid, stat] = m;
        // The permission mode is NOT checked (Sam: "bypass permissions should
        // act just like auto mode"); only that this really is claude.
        if (pgid !== tpgid || pgid !== String(pid) || stat.startsWith('T') || (await psField(pid, 'tty')) !== tty || !(await isClaudeProcess(pid))) continue;
        // No project (team delivery into the pinned orchestrator tab, which
        // can work in any folder): no working-folder check.
        if (projectPath !== null) {
          const cwd = await getProcessCwd(pid);
          if (!cwd || (await fs.promises.realpath(cwd)) !== (await fs.promises.realpath(projectPath))) continue;
        }
        // Team delivery only (no project): Claude leads the foreground group,
        // but an editor or shell command it started may be the one reading the
        // keyboard. /openTab types into a tab it just opened, where nothing can
        // be open yet, and keeps main's behaviour (an MCP wrapper holding the
        // terminal, e.g. `zsh -lc`, must not stop Brett's board sending).
        if (projectPath === null && (await ttyReaderUnder(pid, tty))) continue;
        return true;
      } catch { /* this candidate is unreadable: not claude */ }
    }
    return false;
  }

  return {
    resolveProject,
    openTab,
    focusTab,
    watchOutput,
    claudeRunning,
    // A tab being closed (its window shutting down sends Ctrl+C straight to
    // the PTY) is not alive: nothing more is typed into it.
    // Nor is a tab whose window is closing (its shutdown snapshot can miss a
    // PTY that started after it began).
    tabAlive: (tabId) => {
      if (!terminalInstance(tabId) || terminalClosing(tabId)) return false;
      const win = getWindowEntryByWcId(getTerminalWebContentsId(tabId));
      return !!win && !win.closing && ![...(keyCounters.get(tabId) || [])].some((c) => c.reloaded);
    },
    ptyOf: (tabId) => terminalInstance(tabId),
    // Written straight to the PTY, never queued behind a Chat submit: a
    // queued write would go out LATER, after the checks that cleared it (a
    // queued /exit could put Claude's shell in front of it).
    // One bracketed paste, no Enter in it.
    paste: (tabId, text) => writeOwn(tabId, `\x1b[200~${text}\x1b[201~`),
    // The single Enter, written on its own once the paste has settled.
    submit: (tabId) => writeOwn(tabId, '\r'),
    // Someone is sending a Chat message into the tab right now, or prompt
    // editing holds their input: their Enter may still be to come, so the
    // prompt is not ours to type into.
    inputBusy: (tabId) => submitPending(tabId) || heldInput.has(tabId),
    sleep,
    now: () => Date.now(),
  };
}
