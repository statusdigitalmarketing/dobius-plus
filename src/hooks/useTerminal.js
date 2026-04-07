import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';

// Terminal IDs that should not be killed on unmount (torn-off tabs).
// Populated by TerminalTabBar before removing the tab, checked by cleanup.
const doNotKillSet = new Set();
export function markDoNotKill(id) { doNotKillSet.add(id); }
export function unmarkDoNotKill(id) { doNotKillSet.delete(id); }

const DEFAULT_THEME = {
  background: '#0D1117',
  foreground: '#E6EDF3',
  cursor: '#58A6FF',
  cursorAccent: '#0D1117',
  selectionBackground: '#264F78',
  selectionForeground: '#E6EDF3',
  black: '#0D1117',
  red: '#F85149',
  green: '#3FB950',
  yellow: '#D29922',
  blue: '#58A6FF',
  magenta: '#BC8CFF',
  cyan: '#39D353',
  white: '#E6EDF3',
  brightBlack: '#484F58',
  brightRed: '#FF7B72',
  brightGreen: '#56D364',
  brightYellow: '#E3B341',
  brightBlue: '#79C0FF',
  brightMagenta: '#D2A8FF',
  brightCyan: '#56D364',
  brightWhite: '#F0F6FC',
};

const MAX_SCROLLBACK_LINES = 1000;

/**
 * Extract scrollback text from xterm.js buffer.
 * @param {Terminal} term
 * @param {number} maxLines
 * @returns {{ scrollback: string[], cols: number, rows: number }}
 */
function getScrollback(term, maxLines = MAX_SCROLLBACK_LINES) {
  const buffer = term.buffer.active;
  const lines = [];
  const totalRows = buffer.length;
  const start = Math.max(0, totalRows - maxLines);
  for (let i = start; i < totalRows; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return { scrollback: lines, cols: term.cols, rows: term.rows };
}

/**
 * Hook to manage an xterm.js terminal connected to node-pty via IPC.
 * @param {Object} options
 * @param {string} options.id — unique terminal ID
 * @param {string} options.cwd — working directory for the pty
 * @param {Object} [options.theme] — xterm theme object
 * @param {boolean} [options.claimExisting] — if true, claim an existing PTY (for tab tear-off)
 * @returns {{ containerRef: React.RefObject, termRef: React.RefObject, searchAddonRef: React.RefObject }}
 */
export function useTerminal({ id, cwd, theme, fontSize = 13, maxScrollbackLines = MAX_SCROLLBACK_LINES, claimExisting = false }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const searchAddonRef = useRef(null);

  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current && containerRef.current) {
      try {
        fitAddonRef.current.fit();
        const { cols, rows } = termRef.current;
        if (cols > 0 && rows > 0) {
          window.electronAPI.terminalResize(id, cols, rows);
        }
      } catch (err) {
        console.warn('[useTerminal] fit error:', err.message);
      }
    }
  }, [id]);

  const saveState = useCallback((forceFlush = false) => {
    if (!termRef.current || !window.electronAPI?.terminalSaveState) return;
    const state = getScrollback(termRef.current, maxScrollbackLines);
    if (state.scrollback.length > 0) {
      state.savedAt = Date.now();
      window.electronAPI.terminalSaveState(id, state, forceFlush);
    }
  }, [id, maxScrollbackLines]);

  useEffect(() => {
    if (!containerRef.current || !window.electronAPI) return;

    const term = new Terminal({
      theme: theme || DEFAULT_THEME,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, url) => {
      if (window.electronAPI?.openExternal) {
        window.electronAPI.openExternal(url);
      }
    });
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    term.open(containerRef.current);

    requestAnimationFrame(() => {
      fit();
    });

    // Restore saved scrollback before creating pty
    let restorePromise = Promise.resolve();
    if (window.electronAPI.terminalLoadState) {
      restorePromise = window.electronAPI.terminalLoadState(id).then((state) => {
        if (state?.scrollback?.length > 0 && termRef.current) {
          for (const line of state.scrollback) {
            const safeLine = String(line).replace(/\x1b/g, '');
            termRef.current.write('\x1b[2m' + safeLine + '\x1b[0m\r\n');
          }
          termRef.current.write('\x1b[2m\x1b[38;5;240m── previous session ──\x1b[0m\r\n\r\n');
        }
      }).catch(() => {});
    }

    const inputDisposable = term.onData((data) => {
      window.electronAPI.terminalWrite(id, data);
    });

    const removeDataListener = window.electronAPI.onTerminalData((termId, data) => {
      if (termId === id && termRef.current) {
        termRef.current.write(data);
      }
    });

    const removeExitListener = window.electronAPI.onTerminalExit((termId, exitCode) => {
      if (termId === id && termRef.current) {
        termRef.current.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
      }
    });

    restorePromise.then(() => {
      if (claimExisting) {
        // Tear-off: claim the existing PTY from the old window
        window.electronAPI.terminalClaimPty(id);
      } else {
        window.electronAPI.terminalCreate(id, cwd);
      }
    });

    const removeRequestSave = window.electronAPI.onTerminalRequestSave?.(() => {
      saveState();
    });

    // Periodic auto-save every 30s — Chrome-style crash recovery.
    // forceFlush=true ensures an atomic write to disk, not just the debounce cache.
    const autoSaveInterval = setInterval(() => {
      saveState(true);
    }, 30000);

    let resizeTimer;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fit, 50);
    });
    observer.observe(containerRef.current);

    return () => {
      clearInterval(autoSaveInterval);
      clearTimeout(resizeTimer);
      observer.disconnect();
      saveState();
      inputDisposable.dispose();
      removeDataListener();
      removeExitListener();
      removeRequestSave?.();
      // Don't kill PTY if: (a) this is a claimed terminal, or (b) it was marked
      // as do-not-kill by the tear-off handler (old window unmounting torn-off tab)
      if (!claimExisting && !doNotKillSet.has(id)) {
        window.electronAPI.terminalKill(id);
      }
      doNotKillSet.delete(id);
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [id, cwd, fit, saveState, claimExisting]);

  // Separate effect: update theme without recreating terminal
  useEffect(() => {
    if (termRef.current && theme) {
      termRef.current.options.theme = theme;
    }
  }, [theme]);

  // Separate effect: update font size without recreating terminal
  useEffect(() => {
    if (termRef.current && fontSize) {
      termRef.current.options.fontSize = fontSize;
      // Re-fit after font change and notify PTY of new dimensions
      requestAnimationFrame(() => fit());
    }
  }, [fontSize, fit]);

  return { containerRef, termRef, searchAddonRef };
}
