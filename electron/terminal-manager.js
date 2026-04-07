import pty from 'node-pty';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';

const terminals = new Map();

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
    if (entry && !entry.webContents.isDestroyed()) {
      entry.webContents.send('terminal:data', id, data);
    }
  });

  term.onExit(({ exitCode, signal }) => {
    const entry = terminals.get(id);
    terminals.delete(id);
    if (entry && !entry.webContents.isDestroyed()) {
      entry.webContents.send('terminal:exit', id, exitCode, signal);
    }
  });

  terminals.set(id, { pty: term, webContents });
  return { pid: term.pid };
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
 * Check if a terminal has a busy child process (not just the shell).
 * Returns the process name if busy, or null if idle.
 */
export function getTerminalProcess(id) {
  const entry = terminals.get(id);
  if (!entry) return null;
  try {
    const pid = entry.pty.pid;
    if (typeof pid !== 'number' || pid <= 0) return null;
    const { execFileSync } = require('child_process');
    const result = execFileSync('pgrep', ['-lP', String(pid)], {
      timeout: 1000,
      encoding: 'utf8',
    }).trim();
    if (!result) return null;
    // pgrep -lP returns lines like "12345 claude" — extract process names
    const lines = result.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    // Return the first non-shell child process name
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
 * Get terminal IDs matching a project path prefix.
 * @param {string} projectPath
 * @returns {string[]}
 */
export function getTerminalsForProject(projectPath) {
  const prefix = `term-${projectPath}`;
  const matching = [];
  for (const id of terminals.keys()) {
    if (id === prefix || id.startsWith(`${prefix}-`)) {
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
