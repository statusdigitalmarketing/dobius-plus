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
      ...extraEnv,
    },
  });

  term.onData((data) => {
    if (!webContents.isDestroyed()) {
      webContents.send('terminal:data', id, data);
    }
  });

  term.onExit(({ exitCode, signal }) => {
    terminals.delete(id);
    if (!webContents.isDestroyed()) {
      webContents.send('terminal:exit', id, exitCode, signal);
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
 * Gracefully close all terminals by sending Ctrl+C twice (ends Claude sessions
 * cleanly so they can be resumed), then kill after a delay.
 * @returns {Promise<void>}
 */
export async function gracefulCloseAll() {
  if (terminals.size === 0) return;
  // First Ctrl+C
  for (const [, entry] of terminals) {
    try { entry.pty.write('\x03'); } catch { void 0; }
  }
  await new Promise((r) => setTimeout(r, 300));
  // Second Ctrl+C
  for (const [, entry] of terminals) {
    try { entry.pty.write('\x03'); } catch { void 0; }
  }
  await new Promise((r) => setTimeout(r, 500));
  killAll();
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
 * Get all active terminal IDs.
 */
export function getActiveTerminals() {
  return Array.from(terminals.keys());
}
