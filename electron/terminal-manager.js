import pty from 'node-pty';
import os from 'os';

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

  const shell = process.env.SHELL || '/bin/zsh';
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
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
