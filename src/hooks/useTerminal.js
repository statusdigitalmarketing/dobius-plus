import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { useStore } from '../store/store';

// States carried by the Dobius status marker (OSC 777;dobius;<state>), emitted by
// the managed Claude Notification/Stop hook. Anything else is ignored.
const TAB_STATUS_VALUES = new Set(['working', 'done', 'needs']);

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

    // Cancellation flag for any async work that resolves after this effect
    // unmounts (Codex audit HIGH: useTerminal.js:189 — restorePromise was
    // calling terminalCreate / terminalClaimPty against a disposed term).
    // Same flag also gates the rAF below and any future async resolves.
    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      fit();
    });

    // Restore saved scrollback before creating pty
    let restorePromise = Promise.resolve();
    if (window.electronAPI.terminalLoadState) {
      restorePromise = window.electronAPI.terminalLoadState(id).then((state) => {
        if (cancelled) return;
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

    // Deterministic tab status: the managed Claude hook emits OSC 777;dobius;<state>
    // into this PTY. xterm reassembles chunk-split OSC sequences for us; we map the
    // marker to this tab's status and swallow it (return true) so it never renders.
    const oscDisposable = term.parser.registerOscHandler(777, (payload) => {
      const parts = String(payload).split(';');
      if (parts[0] === 'dobius' && TAB_STATUS_VALUES.has(parts[1])) {
        const store = useStore.getState();
        store.setTabStatus(id, parts[1]);
        // Claim hook-ownership so useTabActivity's silence settler doesn't
        // flip this tab to 'done' during a long quiet tool call. 'done' or
        // unknown payload releases the claim back to output-flow inference.
        store.markHookOwned(id, parts[1]);
        return true; // handled — do not pass through to other handlers / the screen
      }
      return false; // not ours (e.g. a real `notify` payload) — let xterm handle it
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
      // Guard against the effect having unmounted between the restore and
      // this callback. terminalCreate/terminalClaimPty would otherwise spawn
      // a PTY for a disposed terminal component, leaking the PTY + producing
      // ghost output that nothing renders.
      if (cancelled) return;
      if (claimExisting) {
        window.electronAPI.terminalClaimPty(id);
      } else {
        window.electronAPI.terminalCreate(id, cwd);
      }
    });

    const removeRequestSave = window.electronAPI.onTerminalRequestSave?.(() => {
      saveState(true); // force flush — called before window close
    });

    // Periodic auto-save every 60s with forceFlush=false (per-file debounce
    // coalesces). The previous 30s + forceFlush=true did one atomic disk
    // write per tab every 30s, regardless of whether scrollback actually
    // changed. With 10 tabs that was ~28,800 forced atomic writes per day
    // fighting SSD power management on battery. Apple-grade audit P2.
    // The unmount path (Cmd+W close) still does saveState(true) below so
    // an intentional close is fully durable.
    const autoSaveInterval = setInterval(() => {
      saveState(false);
    }, 60000);

    let resizeTimer;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fit, 50);
    });
    observer.observe(containerRef.current);

    // v1.0.28 copy-on-select: when the user finishes a selection (mouseup),
    // auto-copy it to clipboard. xterm doesn't have a built-in copyOnSelect
    // flag — onSelectionChange fires per-frame during drag which would spam
    // the clipboard. mouseup fires once at the end which is the right time.
    // Capture the container node in a local — containerRef.current can
    // change between this effect and cleanup if the host element remounts,
    // leaving a stale listener attached. Codex v1.0.28 round-1 LOW.
    const mouseUpNode = containerRef.current;
    const onMouseUp = () => {
      const sel = term.getSelection();
      if (sel && sel.trim()) {
        navigator.clipboard?.writeText(sel).catch(() => { /* clipboard denied or unavailable */ });
      }
    };
    mouseUpNode.addEventListener('mouseup', onMouseUp);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      clearInterval(autoSaveInterval);
      clearTimeout(resizeTimer);
      observer.disconnect();
      mouseUpNode?.removeEventListener('mouseup', onMouseUp);
      saveState();
      inputDisposable.dispose();
      oscDisposable.dispose();
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
