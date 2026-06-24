import pty from 'node-pty';
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

const terminals = new Map();

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

/**
 * Create a new terminal session.
 * @param {string} id — unique terminal ID
 * @param {string} cwd — working directory
 * @param {Electron.WebContents} webContents — renderer to send data to
 * @returns {{ pid: number }}
 */
export function createTerminal(id, cwd, webContents) {
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
  const extraPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
  const fullPath = [...extraPaths, process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':');

  const shell = process.env.SHELL || '/bin/zsh';
  const term = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: safeCwd,
    env: {
      ...process.env,
      PATH: fullPath,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      DOBIUS_CWD: safeCwd,
      ...extraEnv,
    },
  });

  term.onData((data) => {
    const entry = terminals.get(id);
    if (!entry) return;
    // Desktop window (unchanged path).
    if (entry.webContents && !entry.webContents.isDestroyed()) {
      entry.webContents.send('terminal:data', id, data);
    }
    // Rolling buffer for late mobile subscribers, only maintained when a
    // subscriber is actually attached. With no mobile client connected (the
    // common case), the per-event string concat + slice is skipped entirely,
    // which removes ~1MB-per-event allocation pressure from the hot path.
    if (entry.subscribers.size > 0) {
      entry.outputBuffer = (entry.outputBuffer + data).slice(-OUTPUT_BUFFER_BYTES);
      for (const sub of entry.subscribers) {
        try { sub.onData?.(id, data); } catch { /* drop bad subscriber silently */ }
      }
    }
  });

  term.onExit(({ exitCode, signal }) => {
    const entry = terminals.get(id);
    terminals.delete(id);
    if (!entry) return;
    if (entry.webContents && !entry.webContents.isDestroyed()) {
      entry.webContents.send('terminal:exit', id, exitCode, signal);
    }
    for (const sub of entry.subscribers) {
      try { sub.onExit?.(id, exitCode, signal); } catch { /* noop */ }
    }
  });

  terminals.set(id, {
    pty: term,
    webContents,
    subscribers: new Set(),
    outputBuffer: '',
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
 * Returns { unsubscribe, buffer }. The buffer is recent output for replay so
 * a freshly-attached client (e.g. a phone) doesn't see a blank screen.
 */
export function subscribeTerminal(id, sink) {
  const entry = terminals.get(id);
  if (!entry || !sink) return { unsubscribe: () => {}, buffer: '' };
  entry.subscribers.add(sink);
  return {
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
      const { stdout: psOut } = await execFileP('/bin/ps', ['-o', 'command=', '-p', childPid], {
        timeout: 1000,
        encoding: 'utf8',
      });
      const m = psOut.trim().match(/\bclaude\b.*?\s(?:--resume|-r)\s+([a-zA-Z0-9][\w-]{1,99})/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
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
export function killAll() {
  for (const [id, entry] of terminals) {
    try {
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
  return true;
}


/**
 * Get all active terminal IDs.
 */
export function getActiveTerminals() {
  return Array.from(terminals.keys());
}
