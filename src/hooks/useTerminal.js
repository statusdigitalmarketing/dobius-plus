import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { buildTerminalFontFamily } from '../lib/terminal-font';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { useStore } from '../store/store';
import { takePendingScrollback, drawableLine } from '../lib/pending-scrollback';
import { attachPromptEditing } from '../lib/prompt-edit-term';
import { takePendingLaunch } from '../lib/pending-launch';
import { isWindows } from '../../shared/platform.js';
import { rowFacts } from '../../shared/screen-rows.js';

// States carried by the Dobius status marker (OSC 777;dobius;<state>), emitted by
// the managed Claude Notification/Stop hook. Anything else is ignored.
const TAB_STATUS_VALUES = new Set(['working', 'done', 'needs']);

// Terminal IDs that should not be killed on unmount (torn-off tabs).
// Populated by TerminalTabBar before removing the tab, checked by cleanup.
const doNotKillSet = new Set();
export function markDoNotKill(id) { doNotKillSet.add(id); }
export function unmarkDoNotKill(id) { doNotKillSet.delete(id); }

// Tabs docked into this window from a tear-off: their pane claims the running
// PTY instead of spawning a new one. Read once at pane mount (TerminalPane).
const adoptingSet = new Set();
export function markAdopting(id) { adoptingSet.add(id); }
export function takeAdopting(id) { return adoptingSet.delete(id); }

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
 * @returns {{ containerRef: React.RefObject, termRef: React.RefObject, searchAddonRef: React.RefObject, promptEditRef: React.RefObject }}
 */
export function useTerminal({ id, cwd, theme, fontSize = 13, fontFamily = '', maxScrollbackLines = MAX_SCROLLBACK_LINES, claimExisting = false }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  // True while the pane has no layout box (its tab is hidden). Used so the
  // repaint below runs once on becoming visible instead of on every fit.
  const wasHiddenRef = useRef(true);
  const searchAddonRef = useRef(null);
  const promptEditRef = useRef(null);

  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current && containerRef.current) {
      // A HIDDEN pane must never fit. Every tab stays mounted with
      // display:none, so its container has no layout box, and the fit addon
      // clamps that to cols=2 rows=1 rather than failing; the `> 0` guard
      // below happily forwarded that, squeezing the hidden tab's PTY to 2x1
      // and rewrapping whatever ran in it (Codex High, latent for every
      // font-SIZE change too; surfaced by the font-family effect). The tab
      // refits on becoming visible, so skipping here loses nothing.
      if (!containerRef.current.offsetWidth || !containerRef.current.offsetHeight) {
        // Remember we were hidden, so the next successful fit knows it is the
        // hidden -> visible transition and repaints once.
        wasHiddenRef.current = true;
        return;
      }
      try {
        fitAddonRef.current.fit();
        const { cols, rows } = termRef.current;
        if (cols > 0 && rows > 0) {
          window.electronAPI.terminalResize(id, cols, rows);
        }
        // Repaint ONLY on the hidden -> visible transition, never on an ordinary
        // resize. A fit landing on the SAME cols/rows does not re-render, so a
        // pane written to while hidden (every tab stays mounted with
        // display:none) can show a stale or blank grid until something reflows
        // it; this is that reflow.
        //
        // It must NOT run on every fit. refresh() re-renders every visible row
        // into the DOM, and that write can change the container's measured size,
        // which re-fires the ResizeObserver, which fits, which refreshes again:
        // a debounced feedback loop that repaints ~20 times a second and makes
        // the terminal visibly thrash (Sam, right after v1.0.73).
        if (wasHiddenRef.current && rows > 0) {
          termRef.current.refresh(0, rows - 1);
        }
        wasHiddenRef.current = false;
      } catch (err) {
        console.warn('[useTerminal] fit error:', err.message);
      }
    }
  }, [id]);

  // Read through a ref: the setting arrives after mount, and a new saveState
  // identity would rerun the terminal effect below, re-creating or
  // re-claiming the PTY.
  const maxLinesRef = useRef(maxScrollbackLines);
  maxLinesRef.current = maxScrollbackLines;
  const saveState = useCallback((forceFlush = false) => {
    if (!termRef.current || !window.electronAPI?.terminalSaveState) return;
    const state = getScrollback(termRef.current, maxLinesRef.current);
    if (state.scrollback.length > 0) {
      state.savedAt = Date.now();
      window.electronAPI.terminalSaveState(id, state, forceFlush);
    }
  }, [id]);

  useEffect(() => {
    if (!containerRef.current || !window.electronAPI) return;

    const term = new Terminal({
      theme: theme || DEFAULT_THEME,
      fontFamily: buildTerminalFontFamily(fontFamily),
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

    // Restore saved scrollback before creating pty. A checkpoint fork hands
    // its scrollback over in memory, so it never races the disk save.
    let restorePromise = Promise.resolve();
    // Whether this tab came back with its saved scrollback (a restored tab,
    // not a new or moved one): main may resume its Claude session then.
    let restoredFromDisk = false;
    const forked = takePendingScrollback(id);
    // A New Tab asks main to start its tool (Claude Code, Codex) in the PTY it
    // creates. A claimed (moved) tab is never new.
    const launchTool = claimExisting ? undefined : takePendingLaunch(id);
    if (forked || window.electronAPI.terminalLoadState) {
      restorePromise = (forked ? Promise.resolve(forked) : window.electronAPI.terminalLoadState(id)).then((state) => {
        if (cancelled) return;
        if (state?.scrollback?.length > 0 && termRef.current) {
          for (const line of state.scrollback) {
            const safeLine = drawableLine(line);
            termRef.current.write('\x1b[2m' + safeLine + '\x1b[0m\r\n');
          }
          // A moved tab (tear-off or dock) keeps its live session: no divider.
          if (!claimExisting) termRef.current.write('\x1b[2m\x1b[38;5;240m── previous session ──\x1b[0m\r\n\r\n');
          // Windows: ConPTY clears the screen (ED2) as the new shell starts, and xterm's ED2 erases the viewport
          // without keeping it, so restored lines still on screen were wiped (Max, 2.2.19: a snoozed tab came back
          // empty). Scroll them all into scrollback first: the new prompt starts on a clean screen with the old
          // output one scroll up. Swallowing ConPTY's clear instead would not work: it draws by absolute position
          // and would paint over them. A moved tab keeps its live PTY and is left alone.
          // Fit first so the padding is the pane's real height: padding the default 24 rows and growing afterwards
          // makes xterm pull the restored lines back down onto the screen ConPTY then clears (review, 2.2.20). A
          // hidden pane cannot be measured and keeps 24; its ConPTY clear runs at that size, so nothing comes back.
          if (!claimExisting && isWindows()) {
            fit();
            termRef.current.write('\r\n'.repeat(termRef.current.rows));
          }
          if (!forked && !claimExisting) restoredFromDisk = true;
        }
      }).catch(() => {});
    }

    // Claude's prompt edits like a text field (click, select + delete/type/
    // paste); everything else passes straight through to the PTY. Input it
    // holds back is reported to main as it arrives (/openTab must see it).
    const promptEdit = attachPromptEditing(
      term,
      (data) => window.electronAPI.terminalWrite(id, data),
      (data) => window.electronAPI.terminalInputHeld?.(id, data),
    );
    promptEditRef.current = promptEdit;
    const inputDisposable = term.onData((data) => promptEdit.handleData(data));

    // Deterministic tab status: the managed Claude hook emits OSC 777;dobius;<state>
    // into this PTY. xterm reassembles chunk-split OSC sequences for us; we map the
    // marker to this tab's status and swallow it (return true) so it never renders.
    const oscDisposable = term.parser.registerOscHandler(777, (payload) => {
      const parts = String(payload).split(';');
      if (parts[0] === 'dobius' && TAB_STATUS_VALUES.has(parts[1])) {
        const store = useStore.getState();
        // done;idle is Claude idle for a minute: a red tab (an open prompt, or
        // a `! command` handed back) still waits on the person.
        // Nor a tab whose turn ended with background work still running.
        if (parts[1] === 'done' && parts[2] === 'idle' && (store.tabStatus[id] === 'needs' || store.backgroundTabs[id])) return true;
        store.setTabStatus(id, parts[1], { fromHook: true, handoff: parts[2] === 'handoff', background: parts[2] === 'background' });
        // Claim hook-ownership so useTabActivity's silence settler doesn't
        // flip this tab to 'done' during a long quiet tool call. 'done' or
        // unknown payload releases the claim back to output-flow inference.
        store.markHookOwned(id, parts[1]);
        return true; // handled — do not pass through to other handlers / the screen
      }
      return false; // not ours (e.g. a real `notify` payload) — let xterm handle it
    });

    // Automatic tab labels. Claude Code sets the terminal title (OSC 0/2) to
    // the topic it is working on; `dobius-tab "<summary>"` run inside this tab
    // arrives from main as an explicit agent label. The store applies both
    // only when the user has not renamed the tab by hand (shared/tab-label.js).
    const titleDisposable = term.onTitleChange((title) => {
      useStore.getState().setAutoTabLabel(id, title, 'title');
    });
    const removeAutoLabelListener = window.electronAPI.onTerminalAutoLabel?.((termId, label) => {
      if (termId === id) useStore.getState().setAutoTabLabel(id, label, 'agent');
    });

    const removeDataListener = window.electronAPI.onTerminalData((termId, data) => {
      if (termId === id && termRef.current) {
        termRef.current.write(data);
      }
    });

    // main asks what this tab's screen shows (electron/window-screen.js): its rebuilt copy is cut from a bounded tail,
    // and this xterm was written every byte. Answered once xterm has parsed everything already written.
    const removeScreenRequest = window.electronAPI.onTerminalScreenRequest?.((nonce, termId) => {
      if (termId !== id || !termRef.current) return;
      termRef.current.write('', () => {
        const t = termRef.current;
        if (!t) return;
        const b = t.buffer.active;
        const lines = [];
        for (let r = 0; r < t.rows; r += 1) lines.push(b.getLine(b.baseY + r)?.translateToString(true) ?? '');
        // The same per-row facts main reads off its own render (dim ghost suggestions, coloured rules).
        const facts = rowFacts((r) => b.getLine(b.baseY + r), t.rows, t.cols);
        window.electronAPI.terminalScreenReply?.(nonce, id, { lines, cursor: { x: b.cursorX, y: b.cursorY }, ...facts });
      });
    });

    const removeExitListener = window.electronAPI.onTerminalExit((termId, exitCode) => {
      if (termId === id && termRef.current) {
        termRef.current.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
      }
    });

    // main saw this tab's permission prompt answered (desktop keys, Chat, the
    // phone): red goes back to working, as a hook marker would set it. Only a
    // tab still red changes, so a newer marker always wins.
    const removeStatusHint = window.electronAPI.onTerminalStatusHint?.((termId, status) => {
      // Enter typed into a tab a hook left green: output drives it again.
      // After xterm has parsed what is queued, so a 'done' still waiting
      // there cannot land after the release and hold green again.
      // The tab moved into this window: main's live status for it wins over
      // whatever came along with the move (main.js terminal:claimPty).
      if (termId === id && typeof status === 'string' && status.startsWith('sync;')) {
        const [, st, owned, bg, handoff] = status.split(';');
        if (!['working', 'needs', 'done', 'idle'].includes(st)) return;
        const s = useStore.getState();
        // A 'working' that only output flow decided is this window's to infer
        // from the output it now receives: taking it here would hold yellow,
        // since nothing starts this window's quiet timer (Codex, round 7).
        // Nor does it keep hook ownership the move carried along: main says no
        // hook owns this tab now, so quiet output must be able to settle it.
        // So the tab starts idle here: the next output it receives makes it
        // working again, and the quiet after that settles it (Codex, round 9).
        if (st === 'working' && owned !== '1') { s.releaseBackground(id); s.markHookOwned(id, 'idle'); s.setTabStatus(id, 'idle'); return; }
        s.setTabStatus(id, st, { syncBackground: bg === '1', handoff: handoff === '1' });
        s.markHookOwned(id, owned === '1' ? st : (st === 'done' ? 'done' : 'idle'));
        return;
      }
      if (termId === id && status === 'release') {
        termRef.current?.write('', () => {
          const s = useStore.getState();
          s.releaseHookDone(id);
          s.releaseBackground(id);
          // Enter is activity: yellow now, the settler takes it to idle, so the
          // dot moves even if the command's output already went by.
          if (s.tabStatus[id] === 'done') s.setTabStatus(id, 'working');
        });
        return;
      }
      // 'working-free': a handed-back `! command` was run. The turn had ended,
      // so no hook may follow: yellow, but output flow settles it.
      const free = status === 'working-free';
      if (termId !== id || (status !== 'working' && !free) || !termRef.current) return;
      // After xterm has parsed everything already written: the red marker for
      // this very prompt may still be queued (an answer from the phone can
      // beat the desktop's own parsing).
      termRef.current.write('', () => {
        const s = useStore.getState();
        if (s.tabStatus[id] !== 'needs') return;
        s.setTabStatus(id, 'working', { fromHook: true });
        // Not hook-owned when free: the settler takes it to idle if nothing follows.
        s.markHookOwned(id, free ? 'free' : 'working');
      });
    });

    // A Codex hook's state for this tab, applied exactly like the OSC 777
    // marker above. After xterm has parsed what is already written, so output
    // queued before the hook cannot be counted after it.
    const removeHookStatus = window.electronAPI.onTerminalHookStatus?.((termId, status, tag) => {
      if (termId !== id || !TAB_STATUS_VALUES.has(status) || !termRef.current) return;
      termRef.current.write('', () => {
        const s = useStore.getState();
        s.setTabStatus(id, status, { fromHook: true, handoff: tag === 'handoff' });
        s.markHookOwned(id, status);
      });
    });

    restorePromise.then(() => {
      // Guard against the effect having unmounted between the restore and
      // this callback. terminalCreate/terminalClaimPty would otherwise spawn
      // a PTY for a disposed terminal component, leaking the PTY + producing
      // ghost output that nothing renders.
      if (cancelled) return;
      if (claimExisting) {
        // Size the PTY to this pane once it is ours: resizes sent before the
        // claim lands are refused by main's owner check.
        Promise.resolve(window.electronAPI.terminalClaimPty(id))
          .then((res) => {
            if (cancelled) return;
            if (res?.ok) fit();
            // A refused claim leaves this pane with no terminal behind it;
            // the window holding it decides what to do (ProjectView).
            else window.dispatchEvent(new CustomEvent('dobius:claim-refused', { detail: id }));
          })
          .catch((err) => console.warn('[useTerminal] claim failed:', err?.message));
      } else {
        // A tab moved to another account keeps it across relaunches: its pin
        // rides on the tab and main resolves it (spawn-account-env.js).
        const pin = useStore.getState().terminalTabs.find((t) => t.id === id)?.claudeAccountPin;
        const opts = {
          ...(launchTool !== undefined ? { launch: launchTool } : {}),
          ...(pin && typeof pin === 'object' ? { claudeAccountPin: pin } : {}),
          ...(restoredFromDisk && launchTool === undefined ? { restored: true } : {}),
        };
        window.electronAPI.terminalCreate(id, cwd, Object.keys(opts).length ? opts : undefined);
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
    // flag; onSelectionChange fires per-frame during drag which would spam
    // the clipboard. mouseup fires once at the end which is the right time.
    // Capture the container node in a local; containerRef.current can
    // change between this effect and cleanup if the host element remounts,
    // leaving a stale listener attached. Codex v1.0.28 round-1 LOW.
    //
    // v1.0.36 fix (Brett's "Issue with Copying"): the original handler wrote
    // the clipboard on ANY mouseup with a non-empty selection, so a bare
    // click in a terminal that still had a stale selection re-copied that old
    // terminal text over whatever the user had just copied in another app
    // (symptom 1), and a lingering Claude TUI border (a run of U+2500) got
    // pasted into Adobe as "a long horizontal line" (symptom 2). Fix: only
    // copy when THIS mouse cycle was an actual SELECTION GESTURE (a drag, or
    // a double/triple-click), skip pure box-drawing/whitespace selections,
    // and require window focus.
    //
    // We detect the gesture rather than compare selection strings (Codex
    // v1.0.36 r1): a string compare wrongly suppressed deliberately
    // re-selecting the same text. `dragged` = the mouse moved past a small
    // threshold while the button was down; e.detail >= 2 on mouseup means a
    // double/triple-click. A bare single click that happens to leave a stale
    // selection intact is neither, so it no-ops.
    const mouseUpNode = containerRef.current;
    let dragged = false;
    let downX = 0;
    let downY = 0;
    const DRAG_THRESHOLD_PX = 3;
    const onMouseDown = (e) => { dragged = false; downX = e.clientX; downY = e.clientY; };
    const onMouseMove = (e) => {
      if (dragged) return;
      if (Math.abs(e.clientX - downX) > DRAG_THRESHOLD_PX || Math.abs(e.clientY - downY) > DRAG_THRESHOLD_PX) {
        dragged = true;
      }
    };
    // A selection made entirely of box-drawing glyphs (U+2500..U+257F) and
    // whitespace is a TUI border, never something a user means to copy.
    const isBorderOnly = (s) => !/[^─-╿\s]/.test(s);
    const onMouseUp = (e) => {
      const gesture = dragged || e.detail >= 2; // real drag OR double/triple-click
      dragged = false;
      if (!gesture) { promptEdit.click(e); return; } // bare click: caret, never a copy
      // A selection in Claude's prompt is for editing (select, then type or
      // Cmd+V over it); copying it would overwrite the clipboard being pasted.
      if (promptEdit.selectionInInput()) return;
      const sel = term.getSelection();
      if (!sel || !sel.trim()) return;               // empty / cleared: skip
      if (isBorderOnly(sel)) return;                 // pure TUI border: skip
      if (typeof document !== 'undefined' && !document.hasFocus()) return; // background window click-through: skip
      navigator.clipboard?.writeText(sel).catch((err) => {
        console.debug('[copy-on-select] clipboard write failed:', err?.message || err);
      });
    };
    mouseUpNode.addEventListener('mousedown', onMouseDown);
    mouseUpNode.addEventListener('mousemove', onMouseMove);
    mouseUpNode.addEventListener('mouseup', onMouseUp);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      clearInterval(autoSaveInterval);
      clearTimeout(resizeTimer);
      observer.disconnect();
      mouseUpNode?.removeEventListener('mousedown', onMouseDown);
      mouseUpNode?.removeEventListener('mousemove', onMouseMove);
      mouseUpNode?.removeEventListener('mouseup', onMouseUp);
      saveState();
      inputDisposable.dispose();
      promptEdit.dispose();
      promptEditRef.current = null;
      oscDisposable.dispose();
      titleDisposable.dispose();
      removeAutoLabelListener?.();
      removeDataListener();
      removeExitListener();
      removeScreenRequest?.();
      removeStatusHint?.();
      removeHookStatus?.();
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

  // Separate effect: update font family without recreating terminal. Cell
  // metrics change with the face, so re-fit exactly like a size change.
  // buildTerminalFontFamily always ends the stack in `monospace`, so a font
  // that does not exist on this machine degrades to the default look rather
  // than a broken grid.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontFamily = buildTerminalFontFamily(fontFamily);
      requestAnimationFrame(() => fit());
    }
  }, [fontFamily, fit]);

  return { containerRef, termRef, searchAddonRef, promptEditRef };
}
