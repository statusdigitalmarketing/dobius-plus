import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

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
 * @returns {{ scrollback: string[], cols: number, rows: number }}
 */
function getScrollback(term) {
  const buffer = term.buffer.active;
  const lines = [];
  const totalRows = buffer.length;
  // Start from beginning, cap at MAX_SCROLLBACK_LINES
  const start = Math.max(0, totalRows - MAX_SCROLLBACK_LINES);
  for (let i = start; i < totalRows; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  // Trim trailing empty lines
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
 * @returns {{ containerRef: React.RefObject, termRef: React.RefObject }}
 */
export function useTerminal({ id, cwd, theme }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);

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

  // Save current scrollback state to config
  const saveState = useCallback(() => {
    if (!termRef.current || !window.electronAPI?.terminalSaveState) return;
    const state = getScrollback(termRef.current);
    if (state.scrollback.length > 0) {
      state.savedAt = Date.now();
      window.electronAPI.terminalSaveState(id, state);
    }
  }, [id]);

  // Main effect: create terminal + pty (only depends on id and cwd)
  useEffect(() => {
    if (!containerRef.current || !window.electronAPI) return;

    const term = new Terminal({
      theme: theme || DEFAULT_THEME,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.open(containerRef.current);

    // Initial fit after a brief delay to allow layout
    requestAnimationFrame(() => {
      fit();
    });

    // Restore saved scrollback before creating pty
    let restorePromise = Promise.resolve();
    if (window.electronAPI.terminalLoadState) {
      restorePromise = window.electronAPI.terminalLoadState(id).then((state) => {
        if (state?.scrollback?.length > 0 && termRef.current) {
          // Write previous session lines as dim text
          for (const line of state.scrollback) {
            termRef.current.write(`\x1b[2m${line}\x1b[0m\r\n`);
          }
          // Separator
          termRef.current.write('\x1b[2m\x1b[38;5;240m── previous session ──\x1b[0m\r\n\r\n');
        }
      }).catch(() => {
        // Ignore restore errors
      });
    }

    // Forward user input to pty
    const inputDisposable = term.onData((data) => {
      window.electronAPI.terminalWrite(id, data);
    });

    // Receive data from pty
    const removeDataListener = window.electronAPI.onTerminalData((termId, data) => {
      if (termId === id && termRef.current) {
        termRef.current.write(data);
      }
    });

    // Handle terminal exit
    const removeExitListener = window.electronAPI.onTerminalExit((termId, exitCode) => {
      if (termId === id && termRef.current) {
        termRef.current.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
      }
    });

    // Create pty after restore completes
    restorePromise.then(() => {
      window.electronAPI.terminalCreate(id, cwd);
    });

    // Listen for save requests from main process (window close)
    const removeRequestSave = window.electronAPI.onTerminalRequestSave?.(() => {
      saveState();
    });

    // ResizeObserver for auto-fitting
    let resizeTimer;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fit, 50);
    });
    observer.observe(containerRef.current);

    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      // Save state before cleanup
      saveState();
      inputDisposable.dispose();
      removeDataListener();
      removeExitListener();
      removeRequestSave?.();
      window.electronAPI.terminalKill(id);
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd, fit, saveState]);

  // Separate effect: update theme without recreating terminal
  useEffect(() => {
    if (termRef.current && theme) {
      termRef.current.options.theme = theme;
    }
  }, [theme]);

  return { containerRef, termRef };
}
