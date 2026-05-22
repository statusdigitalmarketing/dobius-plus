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
      theme: { background: '#0D1117', foreground: '#E6EDF3', cursor: '#58A6FF' },
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
        if (prevIdRef.current) {
          connection.send({ type: 'resize', id: prevIdRef.current, cols: term.cols, rows: term.rows });
        }
      } catch { /* noop */ }
    });
    ro.observe(hostRef.current);

    return () => {
      dataSub.dispose();
      ro.disconnect();
      term.dispose();
    };
  }, [connection]);

  // Stream server output for the active terminal.
  useEffect(() => {
    const off = connection.onMessage((msg) => {
      if (msg.type === 'output' && msg.id === activeId) {
        termRef.current?.write(msg.data);
      } else if (msg.type === 'exit' && msg.id === activeId) {
        termRef.current?.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n');
      }
    });
    return off;
  }, [connection, activeId]);

  // Attach/detach when the active terminal changes.
  useEffect(() => {
    const prev = prevIdRef.current;
    if (prev && prev !== activeId) {
      connection.send({ type: 'detach', id: prev });
    }
    if (activeId && activeId !== prev) {
      termRef.current?.reset();
      connection.send({ type: 'attach', id: activeId });
      const fit = fitRef.current;
      const term = termRef.current;
      if (fit && term) {
        try {
          fit.fit();
          const { cols, rows } = term;
          // Two resizes (rows-1 then rows) force a SIGWINCH so a TUI like
          // Claude Code repaints its whole screen on attach. The server's
          // replay buffer is empty for an idle or freshly-restored terminal,
          // so without this the pane looks blank until the next keystroke.
          connection.send({ type: 'resize', id: activeId, cols, rows: Math.max(1, rows - 1) });
          setTimeout(() => {
            connection.send({ type: 'resize', id: activeId, cols, rows });
          }, 80);
        } catch { /* noop */ }
      }
      termRef.current?.focus();
    }
    prevIdRef.current = activeId;
  }, [connection, activeId]);

  return <div className="xterm-host" ref={hostRef} />;
}
