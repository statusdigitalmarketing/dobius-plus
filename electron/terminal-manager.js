import pty from 'node-pty';
import { isClaudeCommand } from './claude-argv.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Promise-based subprocess execution. Replaces the previous execFileSync
// callers because the sync version blocks the main thread on every call,
// which under load became a noticeable typing-latency contributor (the
// 3s-per-tab process-detection poll in TerminalTabBar was firing ~12-30 sync
// pgrep calls per second across many tabs).
const execFileP = promisify(execFile);
import { app } from 'electron';
import { getSessionTabMap } from './config-manager.js';

const terminals = new Map();

// Global terminal observers (v1.0.43): sinks that see EVERY terminal's data +
// exit, independent of window/mobile attachment. Used by the main-process
// status authority. Each observer is { onData(id, data, cwd), onExit(id,
// {exitCode, signal, cwd}) }.
const terminalObservers = new Set();
export function addTerminalObserver(observer) {
  if (observer) terminalObservers.add(observer);
  return () => terminalObservers.delete(observer);
}

/**
 * Defensive startup check: node-pty's `spawn-helper` MUST be executable or
 * every PTY opens blank (the helper is exec'd to launch the shell, and without
 * +x that exec fails with EACCES). electron-builder's asar-unpack step has been
 * seen to drop the bit, and an external file copy (scp/rsync) or a recursive
 * chmod can do the same. Re-assert 0755 on launch so neither a bad build nor an
 * accidental permission change can leave the user with dead terminals again.
 * Safe to call every launch (chmod on an already-correct file is a no-op) and
 * only touches a file inside our own app bundle. Returns true if the helper is
 * executable afterward.
 */
export function ensureSpawnHelperExecutable() {
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper')
      : null,
    path.join(process.cwd(), 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
  ].filter(Boolean);

  let ok = false;
  for (const helper of candidates) {
    try {
      if (!fs.existsSync(helper)) continue;
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helper, 0o755);
        console.warn(`[terminal-manager] spawn-helper was not executable; restored 0755: ${helper}`);
      }
      ok = true;
    } catch (err) {
      console.error(`[terminal-manager] spawn-helper check failed for ${helper}:`, err.message);
    }
  }
  if (!ok) {
    console.error('[terminal-manager] WARNING: node-pty spawn-helper not found or not fixable; terminals may open blank.');
  }
  return ok;
}

// Per-terminal rolling output buffer cap (bytes). Replayed to a freshly-
// attached mobile client so it has real scrollback, not just the last screen.
// 1MB is roughly 10-15k lines of terminal text.
const OUTPUT_BUFFER_BYTES = 1024 * 1024;
// Cap kept even when NO mobile client is subscribed, so the FIRST phone attach
// to a desktop-only or idle tab replays a real screen, not a blank one (audit
// HIGH-3). Raised 64KB -> 512KB (v1.0.72): Claude Code repaints its live region
// with cursor-up + column-positioning in the MAIN buffer (no alt-screen, no
// clear-screen), so the phone can only reconstruct the screen if the replayed
// tail contains a COMPLETE frame. During heavy reasoning a single frame can
// exceed 64KB, so the 64KB tail started mid-frame and the phone painted a
// partial grid: the "grey screen with only the cursor and a fragment" Sam
// reported. 512KB holds several large frames. Still far under the 1MB
// subscribed cap, and only idle tabs pay it.
const IDLE_BUFFER_BYTES = 512 * 1024;

/**
 * Create a new terminal session.
 * @param {string} id — unique terminal ID
 * @param {string} cwd — working directory
 * @param {Electron.WebContents} webContents — renderer to send data to
 * @returns {{ pid: number }}
 */
export function createTerminal(id, cwd, webContents, accountEnv = {}) {
  // A respawn under an existing id (e.g. "Continue on switched account") must
  // NOT strand what was attached to the old PTY. Carry over the live subscriber
  // set so an attached phone keeps streaming (killing the old PTY would orphan
  // it: its onExit is suppressed by the identity guard, so the mobile socket
  // still thinks it is subscribed and receives nothing). Carry over the last
  // known geometry so the resumed shell renders at the tab's real size instead
  // of collapsing to 80x24 (reviewer P2 x2).
  const prev = terminals.get(id);
  const prevSubs = prev?.subscribers;
  const prevCols = prev?.cols;
  const prevRows = prev?.rows;
  // Kill existing terminal with this ID if any
  if (terminals.has(id)) {
    killTerminal(id);
  }

  // Validate cwd is an existing directory; fall back to home
  let safeCwd = os.homedir();
  if (cwd && typeof cwd === 'string') {
    try {
      const stat = fs.statSync(cwd);
      if (stat.isDirectory()) {
        safeCwd = cwd;
      }
    } catch {
      // Invalid path — use home directory
    }
  }

  // Per-project shell history file
  const extraEnv = {};
  if (id.startsWith('term-')) {
    const encodedProject = Buffer.from(safeCwd).toString('base64url');
    const histDir = path.join(app.getPath('userData'), 'terminal-history', encodedProject);
    try {
      fs.mkdirSync(histDir, { recursive: true });
    } catch {
      // Ignore — directory may already exist
    }
    extraEnv.HISTFILE = path.join(histDir, '.zsh_history');
  }

  // Electron's process.env.PATH is minimal when launched from Finder/Dock.
  // Prepend Homebrew paths so tools like zoxide, fzf, brew etc. are available.
  // If the account has a specific CLI path, prepend its directory first so
  // typing `claude` in the shell resolves to the account's binary.
  const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
  if (accountEnv.DOBIUS_CLI_DIR) {
    extraPaths.unshift(accountEnv.DOBIUS_CLI_DIR);
  }
  // gws shim dir goes FIRST so `gws` resolves to the shim (v1.0.41). It sits
  // ahead of the account CLI dir too; they never collide (different binaries).
  if (accountEnv.DOBIUS_GWS_SHIM_DIR) {
    extraPaths.unshift(accountEnv.DOBIUS_GWS_SHIM_DIR);
  }
  const fullPath = [...extraPaths, process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');

  // These two are consumed here (into PATH), not passed as literal env vars.
  const { DOBIUS_CLI_DIR: _ignored, DOBIUS_GWS_SHIM_DIR: _ignored2, ...termEnv } = accountEnv;

  const shell = process.env.SHELL || '/bin/zsh';
  const spawnEnv = {
    ...process.env,
    PATH: fullPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    DOBIUS_CWD: safeCwd,
    ...extraEnv,
    ...termEnv,
  };
  // A termEnv key set to undefined is a DELETION signal: e.g. a ChatGPT Codex
  // account must not inherit an OPENAI_API_KEY from Dobius's environment, which
  // would override its stored login. (A key re-exported by the login shell
  // profile is outside our reach; this clears the inherited case.)
  for (const [k, v] of Object.entries(termEnv)) { if (v === undefined) delete spawnEnv[k]; }
  const spawnCols = (Number.isInteger(prevCols) && prevCols > 0) ? prevCols : 80;
  const spawnRows = (Number.isInteger(prevRows) && prevRows > 0) ? prevRows : 24;
  const term = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color', cols: spawnCols, rows: spawnRows, cwd: safeCwd, env: spawnEnv,
  });

  const dataSub = term.onData((data) => {
    const entry = terminals.get(id);
    // Identity guard: if this id was re-created (createTerminal killed the old
    // PTY and spawned a new one under the same id), the OLD pty's late onData
    // must not be routed as the replacement's output. Audit High.
    if (!entry || entry.pty !== term) return;
    // Global observers (main-process status authority, v1.0.43): see EVERY
    // terminal's output regardless of whether a window or mobile client is
    // attached, so tab status is tracked centrally. Cheap: observers do a
    // bounded string scan, no per-chunk allocation like the mobile buffer.
    for (const obs of terminalObservers) {
      try { obs.onData?.(id, data, entry.cwd); } catch { /* never let an observer break the PTY */ }
    }
    // Desktop window (unchanged path).
    if (entry.webContents && !entry.webContents.isDestroyed()) {
      entry.webContents.send('terminal:data', id, data);
    }
    // Rolling buffer for late mobile subscribers. Always maintained so the
    // FIRST phone attach to a desktop-only/idle tab replays a real screen, not a
    // blank one (audit HIGH-3). Keep only a screenful (64KB) when no phone is
    // subscribed; grow to full 1MB scrollback once one is. The slice bounds the
    // allocation either way, and the idle 64KB case is cheaper than the 1MB case
    // that was already accepted for subscribed tabs.
    const cap = entry.subscribers.size > 0 ? OUTPUT_BUFFER_BYTES : IDLE_BUFFER_BYTES;
    entry.outputBuffer = (entry.outputBuffer + data).slice(-cap);
    for (const sub of entry.subscribers) {
      try { sub.onData?.(id, data); } catch { /* drop bad subscriber silently */ }
    }
  });

  const exitSub = term.onExit(({ exitCode, signal }) => {
    const entry = terminals.get(id);
    // Identity guard: a killed PTY's onExit fires asynchronously. If the id was
    // already re-created (createTerminal kills old -> spawns new under same id),
    // entry.pty is the NEW live pty; deleting it here would kill the live
    // replacement and emit a bogus exit. Only act when this IS the current pty.
    // Audit High.
    if (!entry || entry.pty !== term) return;
    terminals.delete(id);
    // Global observers get the exit + the cwd BEFORE the entry is gone, so the
    // status authority can cache exit code/project for the mobile board.
    for (const obs of terminalObservers) {
      try { obs.onExit?.(id, { exitCode, signal, cwd: entry.cwd }); } catch { /* noop */ }
    }
    if (entry.webContents && !entry.webContents.isDestroyed()) {
      entry.webContents.send('terminal:exit', id, exitCode, signal);
    }
    for (const sub of entry.subscribers) {
      try { sub.onExit?.(id, exitCode, signal); } catch { /* noop */ }
    }
  });

  terminals.set(id, {
    pty: term,
    // node-pty routes onData/onExit through a NAPI ThreadSafeFunction. If a
    // callback lands while Node is freeing its environment at quit, the throw
    // has no handler and the process dies with SIGABRT ("Dobius+ quit
    // unexpectedly"), which is exactly what the Restart button produced with
    // several windows open (crash reports 2026-08-10: pty.node ->
    // ThrowAsJavaScriptException inside node::Environment::CleanupHandles).
    // Keeping the disposables lets shutdown UNREGISTER the JS callbacks before
    // killing the PTYs, so the late callbacks have nothing to call into.
    disposables: [dataSub, exitSub],
    webContents,
    // True once this PTY has ever been bound to a desktop window (created with a
    // webContents, or later claimed by one). Headless PTYs (voice-conductor
    // background agents, phone-spawned terminals) are created with webContents
    // null and never claimed, so this stays false. A project window's close/kill
    // only reaps WINDOW-owned PTYs, so closing a window never terminates a
    // deliberately-headless background agent. Audit High.
    everWindowOwned: !!webContents,
    // Reuse the SAME Set object so subscribe/unsubscribe closures captured
    // against the old entry still target the live set after a respawn.
    subscribers: prevSubs || new Set(),
    outputBuffer: '',
    // Last known PTY geometry, seeded from the spawn size and updated on every
    // resize, so a respawn can restore the tab's real dimensions.
    cols: spawnCols,
    rows: spawnRows,
    cwd: safeCwd,
    // Track the requested project path (pre-fallback) for exact-match lookup
    // in getTerminalsForProject. Carson's audit #2 (CRITICAL): the old
    // id-string-prefix lookup collided on sibling projects whose paths
    // shared a prefix (e.g. /x/app vs /x/app-v2 — closing one's window
    // would kill the other's live PTYs).
    projectPath: (cwd && typeof cwd === 'string') ? cwd : null,
  });
  return { pid: term.pid };
}

/**
 * Subscribe a sink to a terminal's output. The sink is { onData, onExit }.
 * Returns { ok, unsubscribe, buffer }. `ok` is false when the terminal does not
 * exist (already exited), so the caller can tell the client instead of
 * pretending the attach succeeded. The buffer is recent output for replay so a
 * freshly-attached client (e.g. a phone) doesn't see a blank screen.
 */
export function subscribeTerminal(id, sink) {
  const entry = terminals.get(id);
  if (!entry || !sink) return { ok: false, unsubscribe: () => {}, buffer: '' };
  entry.subscribers.add(sink);
  return {
    ok: true,
    unsubscribe: () => { entry.subscribers.delete(sink); },
    buffer: entry.outputBuffer,
  };
}

/**
 * List live terminals with their id, shell pid, and starting cwd.
 */
export function listTerminals() {
  return Array.from(terminals.entries()).map(([id, entry]) => ({
    id,
    pid: entry.pty.pid,
    cwd: entry.cwd,
  }));
}

/**
 * Write data to a terminal's stdin.
 */
export function writeTerminal(id, data) {
  const entry = terminals.get(id);
  if (entry) {
    entry.pty.write(data);
  }
}

/**
 * Resize a terminal.
 */
export function resizeTerminal(id, cols, rows) {
  const entry = terminals.get(id);
  if (entry) {
    try {
      entry.pty.resize(cols, rows);
      // Remember the geometry so a later respawn restores it (reviewer P2).
      if (Number.isInteger(cols) && cols > 0) entry.cols = cols;
      if (Number.isInteger(rows) && rows > 0) entry.rows = rows;
    } catch (err) {
      console.error(`[terminal-manager] resize error for ${id}:`, err.message);
    }
  }
}

/**
 * Whether a desktop window is currently driving this terminal (vs phone-only).
 * Used by the mobile bridge to avoid resizing a PTY out from under a desktop
 * xterm — when a phone at 60x24 reshapes a PTY that the desktop has at 200x50,
 * TUI apps re-render to the phone's geometry and the desktop display turns to
 * garbage. Lets the mobile path treat its resize as advisory in that case.
 */
export function terminalHasDesktopAttached(id) {
  const entry = terminals.get(id);
  if (!entry) return false;
  return !!(entry.webContents && !entry.webContents.isDestroyed());
}

/**
 * Check if a terminal has a busy child process (not just the shell).
 * Returns the process name if busy, or null if idle.
 */
export async function getTerminalProcess(id) {
  const entry = terminals.get(id);
  if (!entry) return null;
  try {
    const pid = entry.pty.pid;
    if (typeof pid !== 'number' || pid <= 0) return null;
    const { stdout } = await execFileP('/usr/bin/pgrep', ['-lP', String(pid)], {
      timeout: 1000,
      encoding: 'utf8',
    });
    const result = stdout.trim();
    if (!result) return null;
    // pgrep -lP returns lines like "12345 claude"
    const lines = result.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    for (const line of lines) {
      const name = line.trim().split(/\s+/).slice(1).join(' ');
      if (name && name !== 'zsh' && name !== 'bash' && name !== 'sh') return name;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * If a terminal is running `claude --resume <id>` (or `-r <id>`), return that
 * session id. Used to link a session to its tab even when the resume was
 * typed manually rather than launched through the app. Returns null otherwise.
 */
export async function getTerminalProcessArgv(id) {
  const info = await getTerminalClaudeInfo(id);
  return info?.sessionId || null;
}

/**
 * Inspect the claude process (if any) running inside a terminal.
 * Returns { sessionId, startedAt } where:
 *   - sessionId: the id from `--resume <id>` / `-r <id>`, else null
 *   - startedAt: epoch ms the claude child process started, else null
 *
 * v1.0.39 (Brett-reported: "each tab isn't saying its name in the session
 * history"): a FRESH `claude` generates its session id at runtime, so the
 * argv contains no id and the old regex-only linker never linked it. Those
 * tabs got no name badge in the sidebar, and auto-resume could never restore
 * them either. startedAt lets the caller correlate the process to the
 * transcript it created (see resolveFreshSessionId in main.js).
 */
export async function getTerminalClaudeInfo(id) {
  const entry = terminals.get(id);
  if (!entry) return null;
  try {
    const pid = entry.pty.pid;
    if (typeof pid !== 'number' || pid <= 0) return null;
    const { stdout: pgrepOut } = await execFileP('/usr/bin/pgrep', ['-P', String(pid)], {
      timeout: 1000,
      encoding: 'utf8',
    });
    const children = pgrepOut.trim().split('\n').filter(Boolean);
    for (const childPid of children) {
      // `lstart` is the process start time; `command` is the argv. One ps
      // call gets both so the fresh-session correlation costs nothing extra.
      const { stdout: psOut } = await execFileP('/bin/ps', ['-o', 'lstart=,command=', '-p', childPid], {
        timeout: 1000,
        encoding: 'utf8',
      });
      const line = psOut.trim();
      if (!line) continue;
      // `lstart` is a fixed 24-char date ("Wed Jul 15 21:49:26 2026"), the
      // rest is the command.
      const lstart = line.slice(0, 24);
      const command = line.slice(24).trim();
      if (!isClaudeCommand(command)) continue;
      const parsed = Date.parse(lstart);
      const startedAt = Number.isFinite(parsed) ? parsed : null;
      const m = command.match(/(?:--resume|-r)\s+([a-zA-Z0-9][\w-]{1,99})/);
      return { sessionId: m ? m[1] : null, startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Session ids that a LIVE terminal is running Claude on right now.
 *
 * Callers that reason about "abandoned" or "resumable" work need this, and
 * data-service cannot see the terminal manager. Being wrong costs real work in
 * both directions: name a session that is not running and offering Resume
 * double-runs one transcript under two processes; miss one that is, and
 * genuinely abandoned work is suppressed and never resurfaces.
 *
 * The truth is the PROCESS, in two parts:
 *   - argv `--resume <id>` names the session directly. Authoritative.
 *   - a FRESH claude generates its id at runtime, so its argv has no id at
 *     all. Only the saved sessionId -> tabId map can name that one.
 *
 * The map is a cache and it lies in ways that matter (Codex, High):
 *   - the tab may be gone entirely, so require it to be live
 *   - claude may have EXITED inside a tab that is still open, which is exactly
 *     the abandoned case the feature exists to surface, so require a running
 *     claude in that tab
 *   - the tab may have moved on to a different session, and the link stays
 *     stale until the 15s reconcile tick. If argv names an id, argv wins and
 *     the map has nothing to add for that tab
 *   - several old links can point at one tab, and at most one can be current,
 *     so take only the most recently captured
 * Best effort: never throws.
 */
async function processSessionIds() {
  const ids = new Set();
  try {
    const terms = listTerminals();
    const infoByTab = new Map();
    await Promise.all(terms.map(async (t) => {
      try { infoByTab.set(t.id, await getTerminalClaudeInfo(t.id)); }
      catch { infoByTab.set(t.id, null); }
    }));

    // Tabs running a claude whose session id we CANNOT read from argv. These
    // are the only tabs the saved map can tell us anything useful about, and
    // the process start time is what decides whether a link is current.
    const freshTabs = new Map(); // tabId -> claude startedAt (may be null)
    for (const [tabId, info] of infoByTab) {
      if (info && !info.sessionId) freshTabs.set(tabId, info.startedAt);
      if (info?.sessionId) ids.add(info.sessionId);
    }

    if (freshTabs.size > 0) {
      const newestPerTab = new Map(); // tabId -> { sid, capturedAt }
      for (const [sid, link] of Object.entries(getSessionTabMap() || {})) {
        if (!link?.tabId || !freshTabs.has(link.tabId)) continue;
        const at = typeof link.capturedAt === 'number' ? link.capturedAt : 0;
        // The link must postdate the claude process it claims to describe.
        // Stop `old`, start a bare `claude` in the SAME tab, and for up to 15s
        // (until the next capture tick) the link still names `old` while the
        // tab is running something else entirely, which hid `old` from loose
        // ends even though it was genuinely abandoned. Codex High, round 3.
        //
        // STRICTLY after, plus a second. `ps lstart` truncates DOWN to the
        // second, so startedAt is already up to 999ms EARLIER than the real
        // start; slack in that direction lets the stale link back through
        // (Codex High, round 4). Being strict costs nothing real: the capture
        // tick is 15s, so a genuine link is never written within a second of
        // the process starting, and the worst case is a live fresh session not
        // being excluded, which findLooseEnds drops anyway on its 45-minute
        // idle rule.
        const startedAt = freshTabs.get(link.tabId);
        if (Number.isFinite(startedAt) && at < startedAt + 1000) continue;
        const best = newestPerTab.get(link.tabId);
        if (!best || at > best.capturedAt) newestPerTab.set(link.tabId, { sid, capturedAt: at });
      }
      for (const { sid } of newestPerTab.values()) ids.add(sid);
    }
  } catch { /* best effort */ }
  return ids;
}

/**
 * Everything that must not be resumed again right now: sessions a real process
 * is on, PLUS sessions somebody has claimed and is about to start.
 */
export async function liveClaudeSessionIds() {
  const ids = await processSessionIds();
  for (const sid of activeReservations()) ids.add(sid);
  return [...ids];
}

// A resume is not visible in the process table for a second or two: the shell
// has to print a prompt, the command has to be typed in, and claude has to
// start. Two surfaces checking "is it live" inside that window both got `no`
// and both resumed, which is the double-run this is all meant to prevent
// (Codex Critical, round 3). A claim reserves the id for that window.
const resumeReservations = new Map(); // sessionId -> { tabId, expiry }
// Un-tabbed reservations are placeholders held for the moment between "the
// user clicked resume" and "we know which tab it landed in", so they expire
// fast. A tab-bound one has to outlive the whole startup path: shell profile,
// then claude itself. A fixed 30s was NOT enough (a slow .zshrc alone can eat
// it), and letting it lapse early re-opens the double-run. Codex Critical,
// round 4. The tab check below is what actually ends these; the timeout is
// only a backstop for a tab that lives forever after a failed resume.
const RESERVATION_MS = 30_000;
const TAB_RESERVATION_MS = 600_000;
/**
 * Should this reservation be forgotten? Pure, so every branch is testable
 * without waiting out real timeouts.
 *
 * Deliberately does NOT try to detect a FAILED resume by looking for a claude
 * process after a grace period. That was tried and it re-opened the very
 * double-run this exists to prevent (Codex Critical, round 6): a shell profile
 * slower than the grace looks identical to a resume that failed, so the
 * reservation was dropped while the resume was still legitimately on its way,
 * and a second surface was cleared to run the same transcript. No timeout can
 * separate "slow" from "failed"; only the process appearing can, and waiting
 * for that IS the window. So the rule stays on facts: the tab is alive, or it
 * is not. Retrying a failed resume is handled by ownership in
 * claimSessionResume instead, which needs no timing guess at all.
 *
 * @param r {{tabId: string|null, reservedAt: number, expiry: number}}
 * @param ctx {{now: number, tabLive: boolean}}
 */
export function shouldDropReservation(r, { now, tabLive }) {
  if (!r || r.expiry <= now) return true;
  if (!r.tabId) return false;   // placeholder, rides its short expiry
  return !tabLive;              // the resume died with its tab
}

function activeReservations() {
  const now = Date.now();
  let live = null;
  for (const [sid, r] of resumeReservations) {
    if (r.tabId && !live) live = new Set(listTerminals().map((t) => t.id));
    if (shouldDropReservation(r, { now, tabLive: !r.tabId || live.has(r.tabId) })) {
      resumeReservations.delete(sid);
    }
  }
  return resumeReservations.keys();
}

/**
 * Take the slot. INTERNAL: an unconditional reserve is a footgun, because it
 * silently overwrites somebody else's legitimate claim (auto-resume did
 * exactly that to a resume the phone had already started, and both ran.
 * Codex Critical, round 9). Everything outside this module goes through
 * claimSessionResume, which can refuse.
 */
function reserve(sessionId, tabId = null) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  const bound = typeof tabId === 'string' && tabId ? tabId : null;
  const now = Date.now();
  resumeReservations.set(sessionId, {
    tabId: bound,
    reservedAt: now,
    expiry: now + (bound ? TAB_RESERVATION_MS : RESERVATION_MS),
  });
}

/**
 * Give back a reservation YOU hold, for a resume that was claimed and then
 * abandoned (a spawn that threw, a queued auto-resume that got cancelled).
 *
 * Ownership-checked, exactly like the claim. Releasing by session id alone was
 * a footgun in the same shape as the unconditional reserve: a stale
 * auto-resume timer, giving up on a session the PHONE had since claimed,
 * deleted the phone's reservation and re-opened the double-run window while
 * the phone's own `claude --resume` was still on its way (Codex Critical,
 * round 10). Pass the tab you claimed with; pass nothing only to release a
 * placeholder that never got a tab.
 *
 * @returns true if a reservation was actually released.
 */
export function releaseSessionResume(sessionId, tabId = null) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const held = resumeReservations.get(sessionId);
  if (!held) return false;
  if ((held.tabId || null) !== (tabId || null)) return false; // not yours
  resumeReservations.delete(sessionId);
  return true;
}

/**
 * Ask permission to resume, and take the slot in the same step.
 * Check-then-act split across two calls is exactly what let two surfaces
 * through, so this is one call: it returns false when the session is already
 * running or already claimed, and otherwise reserves it before returning true.
 * Single-threaded main process, so this is atomic by construction.
 */
export async function claimSessionResume(sessionId, tabId = null) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  // A real process on this session beats everything, including ownership: if
  // claude is genuinely running it, nobody may start a second one, not even
  // the tab that reserved it.
  if ((await processSessionIds()).has(sessionId)) return false;
  // Prune FIRST, then read: everything from here down is synchronous, so a
  // concurrent claim that is still inside the await above cannot interleave,
  // and whichever caller reaches this line first takes the slot.
  activeReservations();
  const held = resumeReservations.get(sessionId);
  if (held) {
    // Retrying in the tab that already owns this session is always allowed.
    // Without this, a resume that failed outright (claude not on PATH, the CLI
    // exiting at once) would hold the session until its tab closed, refusing
    // the obvious retry. Ownership answers that without any timing guess, and
    // it still refuses a DIFFERENT tab, which is the case that corrupts a
    // transcript. Codex round 5 Medium, round 6 Critical.
    if (!tabId || held?.tabId !== tabId) return false;
  }
  reserve(sessionId, tabId);
  return true;
}

/**
 * Attach a tab to a reservation you ALREADY hold, once you know which tab the
 * resume landed in. A no-op when no reservation exists, so it can never take a
 * session, and it refuses to move one that belongs to a different tab.
 */
export function bindReservationTab(sessionId, tabId) {
  const held = resumeReservations.get(sessionId);
  if (!held || !tabId) return false;
  if (held.tabId && held.tabId !== tabId) return false;
  reserve(sessionId, tabId);
  return true;
}

/**
 * Get the current working directory of a terminal's shell process.
 * Uses `lsof` to query the shell PID's cwd descriptor. Returns null if the
 * terminal doesn't exist or lsof can't determine the cwd.
 */
export async function getTerminalCwd(id) {
  const entry = terminals.get(id);
  if (!entry) return null;
  try {
    const pid = entry.pty.pid;
    if (typeof pid !== 'number' || pid <= 0) return null;
    // -Fn prints a "p<pid>" line then an "n<cwd>" line. Parse the n-prefixed one.
    const { stdout } = await execFileP('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
      timeout: 1500,
      encoding: 'utf8',
    });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n') && line.length > 1) return line.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Kill a specific terminal.
 */
export function killTerminal(id) {
  const entry = terminals.get(id);
  if (entry) {
    try {
      // Behaviour-neutral (the onExit handler's identity guard already no-ops
      // once the entry is gone) but it frees the ThreadSafeFunction now instead
      // of leaving a late callback that could land during a quit.
      disposeListeners(entry);
      entry.pty.kill();
    } catch (err) {
      console.error(`[terminal-manager] kill error for ${id}:`, err.message);
    }
    terminals.delete(id);
  }
}

/**
 * Gracefully close specific terminals by sending Ctrl+C twice (ends Claude
 * sessions cleanly so they can be resumed), then wait for output.
 * @param {string[]} [ids] — terminal IDs to close. If omitted, closes all.
 * @returns {Promise<void>}
 */
export async function gracefulCloseTerminals(ids) {
  const entries = ids
    ? ids.map((id) => terminals.get(id)).filter(Boolean)
    : Array.from(terminals.values());
  if (entries.length === 0) return;
  // First Ctrl+C — interrupts any running command
  for (const entry of entries) {
    try { entry.pty.write('\x03'); } catch { void 0; }
  }
  await new Promise((r) => setTimeout(r, 500));
  // Second Ctrl+C — triggers Claude to print resume session ID
  for (const entry of entries) {
    try { entry.pty.write('\x03'); } catch { void 0; }
  }
  // Give Claude time to print the resume ID before terminals get killed
  await new Promise((r) => setTimeout(r, 1500));
}

/**
 * Gracefully close all terminals — called on app quit.
 * @returns {Promise<void>}
 */
export async function gracefulCloseAll() {
  return gracefulCloseTerminals();
}

/**
 * Get terminal IDs belonging to a project, matched on the stored projectPath
 * by exact equality (not an id string-prefix, which collides for sibling
 * projects whose paths share a prefix — e.g. /x/app vs /x/app-v2).
 * Carson's audit #2 (CRITICAL).
 * @param {string} projectPath
 * @returns {string[]}
 */
export function getTerminalsForProject(projectPath) {
  const target = (projectPath && typeof projectPath === 'string') ? projectPath : null;
  const matching = [];
  for (const [id, entry] of terminals) {
    if (entry.projectPath === target) {
      matching.push(id);
    }
  }
  return matching;
}

/**
 * Kill all terminals — called on app quit.
 */
/**
 * Detach a PTY's JS callbacks. MUST run before kill() on any shutdown path:
 * kill() is asynchronous, so node-pty's final data/exit callbacks arrive later,
 * and if that is after Node starts tearing down its environment the NAPI throw
 * aborts the process. Safe to call twice.
 */
function disposeListeners(entry) {
  for (const d of (entry?.disposables || [])) {
    try { d?.dispose?.(); } catch { /* already disposed */ }
  }
  if (entry) entry.disposables = [];
}

export function killAll() {
  for (const [id, entry] of terminals) {
    try {
      // Unregister FIRST, then kill: the reverse order is what crashed the
      // app on the update-Restart path (SIGABRT in CleanupHandles).
      disposeListeners(entry);
      entry.pty.kill();
    } catch (err) {
      console.error(`[terminal-manager] killAll error for ${id}:`, err.message);
    }
  }
  terminals.clear();
}

/**
 * Reassign a terminal's output to a different BrowserWindow's webContents.
 * Used for tab tear-off: the PTY stays alive but sends data to the new window.
 * @param {string} id — terminal ID
 * @param {Electron.WebContents} newWebContents — the new window's webContents
 * @returns {boolean} true if reassigned, false if terminal not found
 */
export function reassignTerminal(id, newWebContents) {
  const entry = terminals.get(id);
  if (!entry) return false;
  entry.webContents = newWebContents;
  if (newWebContents) entry.everWindowOwned = true; // a window claim binds it. Audit High.
  return true;
}

/**
 * True if this terminal was ever bound to a desktop window. False for headless
 * (voice-conductor background agents) and phone-spawned PTYs, which a window's
 * close must never Ctrl+C or kill. Audit High.
 */
export function wasWindowOwned(id) {
  return !!terminals.get(id)?.everWindowOwned;
}

/**
 * The webContents.id that currently owns a terminal's output (the last window to
 * create or claim it), or null if the terminal or its owner is gone. Lets a
 * closing window kill a PTY ONLY when it is the real owner, so an aborted /
 * never-claimed tear-off window closing can't kill a PTY still bound to the
 * source window. Codex.
 */
export function getTerminalWebContentsId(id) {
  const entry = terminals.get(id);
  const wc = entry?.webContents;
  if (!wc || wc.isDestroyed?.()) return null;
  return wc.id;
}


/**
 * Get all active terminal IDs.
 */
export function getActiveTerminals() {
  return Array.from(terminals.keys());
}

/**
 * Recent RAW output (ANSI included) for a terminal, or '' if unknown. Used by
 * the mobile selector probe to detect an interactive selection prompt in the
 * live screen. The buffer is a rolling tail (64KB idle / 1MB when subscribed),
 * which is more than a screenful, so a current selector is always within it.
 */
export function getTerminalBuffer(id) {
  const entry = terminals.get(id);
  return entry ? entry.outputBuffer : '';
}
