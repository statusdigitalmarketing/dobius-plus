import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

/**
 * xterm.js display bound to one attached terminal. Switching `activeId`
 * detaches the old terminal, clears the screen, and attaches the new one
 * (the server replays its rolling buffer so the screen isn't blank).
 */
export default function XtermView({ connection, activeId }) {
  const hostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const prevIdRef = useRef(null);

  // Create the xterm instance once.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      theme: { background: '#1F1E1D', foreground: '#F4F3EE', cursor: '#C15F3C' },
      cursorBlink: true,
      scrollback: 12000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Keyboard input -> server.
    const dataSub = term.onData((data) => {
      if (prevIdRef.current) {
        connection.send({ type: 'input', id: prevIdRef.current, data });
      }
    });

    // Refit on container resize, push the new size to the PTY.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        // Force a repaint: a refit onto the same geometry does not re-render, so
        // a view that went stale stays blank until something reflows it.
        if (term.rows > 0) term.refresh(0, term.rows - 1);
        if (prevIdRef.current) {
          connection.send({ type: 'resize', id: prevIdRef.current, cols: term.cols, rows: term.rows });
        }
      } catch { /* noop */ }
    });
    ro.observe(hostRef.current);

    // Coming back to the foreground: iOS tears down the rendered view while the
    // PWA is backgrounded and xterm does not repaint itself on return, which is
    // the "grey screen with just the cursor until I reflow it" case. Repaint
    // from the buffer we already hold; no server round trip needed.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      try {
        fit.fit();
        if (term.rows > 0) term.refresh(0, term.rows - 1);
      } catch { /* noop */ }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      dataSub.dispose();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisible);
      term.dispose();
    };
  }, [connection]);

  // Re-subscribe to the active terminal (attach + a repaint resize). Shared by
  // the activeId-change effect and the reconnect handler.
  const reattach = () => {
    if (!activeId) return;
    connection.send({ type: 'attach', id: activeId });
    const fit = fitRef.current;
    const term = termRef.current;
    if (fit && term) {
      try {
        fit.fit();
        // Repaint what we already have straight away, so the view is correct
        // even before the server's replay and the two-resize redraw land.
        if (term.rows > 0) term.refresh(0, term.rows - 1);
        const { cols, rows } = term;
        connection.send({ type: 'resize', id: activeId, cols, rows: Math.max(1, rows - 1) });
        setTimeout(() => connection.send({ type: 'resize', id: activeId, cols, rows }), 80);
      } catch { /* noop */ }
    }
  };

  // Stream server output for the active terminal.
  useEffect(() => {
    const off = connection.onMessage((msg) => {
      if (msg.type === 'output' && msg.id === activeId) {
        // A replay carries the server's FULL rolling buffer. On reconnect the
        // activeId is unchanged, so the switch effect's reset() doesn't run, and
        // writing the replay verbatim appended a second copy of the whole screen
        // every reconnect. Honor the flag: reset before repainting. Audit MED-11.
        if (msg.replay) termRef.current?.reset();
        termRef.current?.write(msg.data);
      } else if (msg.type === 'exit' && msg.id === activeId) {
        termRef.current?.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
      } else if (msg.type === 'authed') {
        // Reconnected: the server dropped our subscription on close, and
        // activeId is unchanged so the attach effect below won't re-run. Re-
        // attach here so output resumes (and, per connection.js, this runs
        // before queued input is flushed). Codex v1.0.43 Phase 3c P2.
        reattach();
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, activeId]);

  // Attach/detach when the active terminal changes. The two-resize repaint
  // that forces a TUI (Claude Code) to redraw on attach lives in reattach().
  useEffect(() => {
    const prev = prevIdRef.current;
    if (prev && prev !== activeId) {
      connection.send({ type: 'detach', id: prev });
    }
    if (activeId && activeId !== prev) {
      termRef.current?.reset();
      reattach();
      termRef.current?.focus();
    }
    prevIdRef.current = activeId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, activeId]);

  return <div className="xterm-host" ref={hostRef} />;
}
