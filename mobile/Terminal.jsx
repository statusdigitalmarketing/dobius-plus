import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import XtermView from './XtermView';
import ChatView from './ChatView';
import SpecialKeys from './SpecialKeys';

/** Last path segment, for a short folder label. */
function lastSeg(p) {
  if (!p) return '';
  const parts = String(p).split('/').filter(Boolean);
  return parts[parts.length - 1] || String(p);
}

/**
 * Parse a terminal into { projectPath, projectName, tabLabel }.
 * Desktop terminal IDs are `term-<projectPath>-<counter>`; the counter is the
 * desktop tab number. Phone-spawned terminals are `term-mobile-<ts>` and are
 * grouped by their cwd instead.
 */
function parseTerminal(t) {
  // Prefer the SERVER's parsed projectPath/projectName: it already splits the
  // extra-window `~<wk>` marker so all windows of a project group under the
  // real folder (v1.0.66). Only fall back to id parsing for old servers.
  if (t.projectPath && t.projectPath !== 'mobile') {
    return {
      ...t,
      projectName: t.projectName || lastSeg(t.projectPath),
      tabLabel: t.label || 'Tab',
    };
  }
  const m = t.id.match(/^term-(.+)-(\d+)$/);
  if (m && m[1] !== 'mobile') {
    // Legacy fallback: right-anchor on the fixed `~w-<8>` window marker so a
    // `~` inside a real folder name stays part of the project path.
    const extra = t.id.match(/^term-(.+)~w-[a-z0-9]{8}-(\d+)$/);
    const projectPath = extra ? extra[1] : m[1];
    return {
      ...t,
      projectPath,
      projectName: lastSeg(projectPath),
      tabLabel: t.label || `Tab ${extra ? extra[2] : m[2]}`,
    };
  }
  const projectPath = t.cwd || 'mobile';
  return {
    ...t,
    projectPath,
    projectName: lastSeg(projectPath) || 'mobile',
    tabLabel: t.label || 'new',
  };
}

/** Group parsed terminals by project, preserving first-seen order. */
function groupTerminals(terminals) {
  const groups = [];
  const byPath = new Map();
  for (const raw of terminals) {
    const t = parseTerminal(raw);
    let g = byPath.get(t.projectPath);
    if (!g) {
      g = { projectPath: t.projectPath, projectName: t.projectName, terms: [] };
      byPath.set(t.projectPath, g);
      groups.push(g);
    }
    g.terms.push(t);
  }
  return groups;
}

export default function TerminalScreen({ connection, status, initialId, onBack, onShowHistory }) {
  const [terminals, setTerminals] = useState([]);
  const [activeId, setActiveId] = useState(initialId || null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // The specific session being confirmed for stop, captured at tap time, so a
  // later activeId change (exit / reordered payload) can't make Stop kill the
  // wrong terminal. { id, label } or null. Codex Phase 3a P2.
  const [confirmStop, setConfirmStop] = useState(null);
  // Guards a createTerminal round-trip so a double-tap over Tailscale latency
  // can't spawn two orphan PTYs. Reset on the reply. Audit MED-10.
  const creatingRef = useRef(false);
  // 'chat' (responsive transcript, default) vs 'terminal' (raw PTY mirror). The
  // raw mirror is width-locked to the desktop and unreadable for wide TUIs, so
  // Chat is the default; the toggle is persisted.
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem('dobius-mobile-view') === 'terminal' ? 'terminal' : 'chat'; } catch { return 'chat'; }
  });
  const toggleMode = useCallback(() => {
    setMode((m) => {
      const next = m === 'chat' ? 'terminal' : 'chat';
      try { localStorage.setItem('dobius-mobile-view', next); } catch { /* noop */ }
      return next;
    });
  }, []);
  // Force the raw terminal (used by the Chat view's selector "answer manually"
  // escape hatch when a selection prompt can't be tapped through).
  const openTerminal = useCallback(() => {
    setMode('terminal');
    try { localStorage.setItem('dobius-mobile-view', 'terminal'); } catch { /* noop */ }
  }, []);

  const refreshList = useCallback(() => {
    connection.send({ type: 'listTerminals' });
  }, [connection]);

  useEffect(() => {
    const off = connection.onMessage((msg) => {
      if (msg.type === 'authed') {
        refreshList();
      } else if (msg.type === 'terminals') {
        setTerminals(msg.list || []);
        setActiveId((cur) => {
          if (cur && (msg.list || []).some((t) => t.id === cur)) return cur;
          return (msg.list || [])[0]?.id || null;
        });
      } else if (msg.type === 'terminalCreated') {
        creatingRef.current = false;
        refreshList();
        setActiveId(msg.id);
        setSwitcherOpen(false);
      } else if (msg.type === 'terminalMissing') {
        // Attach was rejected: the terminal exited between the listing and the
        // tap. Drop off it and refresh so we don't show a live-looking blank
        // that swallows keystrokes. Audit MED-9.
        refreshList();
        setActiveId((cur) => (cur === msg.id ? null : cur));
      } else if (msg.type === 'exit') {
        refreshList();
      } else if (msg.type === 'error') {
        creatingRef.current = false; // let the user retry a failed create
      }
    });
    if (connection.status === 'authed') refreshList();
    return off;
  }, [connection, refreshList]);

  // Switch to a deep-linked session even when already mounted on the terminal
  // screen: a push tapped while here updates initialId (the openTabId prop) but
  // the useState initializer above only read it once, so without this the screen
  // stayed on the old terminal. Audit MED-12 (Codex follow-up).
  useEffect(() => {
    if (initialId) setActiveId(initialId);
  }, [initialId]);

  // Close the stop-confirm if the session it named has since exited/vanished.
  useEffect(() => {
    if (confirmStop && !terminals.some((t) => t.id === confirmStop.id)) setConfirmStop(null);
  }, [terminals, confirmStop]);

  const groups = useMemo(() => groupTerminals(terminals), [terminals]);
  const active = useMemo(
    () => (activeId ? parseTerminal(terminals.find((t) => t.id === activeId) || { id: activeId, cwd: '' }) : null),
    [terminals, activeId]
  );

  const sendKey = useCallback((seq) => {
    if (activeId) connection.send({ type: 'input', id: activeId, data: seq });
  }, [connection, activeId]);

  // Authorize the tab the user is actively viewing so input/resize/kill work in
  // BOTH modes, including the Stop button on a sessionless terminal in Chat mode
  // (the Chat view otherwise never sends loadTranscript to authorize it). The
  // server gate still blocks a socket that never references a tab. Audit Medium.
  // Gate on status==='authed' and depend on it so a WS reconnect (fresh server
  // socket with an empty _authedTabs) re-authorizes the active tab; without this,
  // Stop silently no-ops after any reconnect. Codex follow-up.
  useEffect(() => {
    if (activeId && status === 'authed') connection.send({ type: 'authorizeTab', id: activeId });
  }, [connection, activeId, status]);

  // New terminal in a specific project (matches the desktop's per-project tabs).
  const newTerminalIn = useCallback((projectPath) => {
    if (creatingRef.current) return; // guard double-tap over latency (MED-10)
    creatingRef.current = true;
    setSwitcherOpen(false);
    connection.send({ type: 'createTerminal', cwd: projectPath });
  }, [connection]);

  // Top-bar "+": add a tab in the active terminal's project.
  const newTerminalHere = useCallback(() => {
    if (active?.projectPath && active.projectPath !== 'mobile') {
      newTerminalIn(active.projectPath);
    } else {
      setSwitcherOpen(true); // no project context, let the user pick one
    }
  }, [active, newTerminalIn]);

  const statusColor = status === 'authed' ? '#3FB950' : status === 'connecting' ? '#D29922' : '#F85149';

  return (
    <div className="screen terminal-screen">
      <header className="top-bar">
        {onBack && (
          <button className="icon-btn back-btn" onClick={onBack} aria-label="Back to sessions">‹</button>
        )}
        <button className="terminal-pick" onClick={() => setSwitcherOpen((v) => !v)}>
          <span className="status-dot" style={{ backgroundColor: statusColor }} />
          <span className="terminal-name">
            {active ? `${active.projectName} / ${active.tabLabel}` : 'No terminal'}
          </span>
          <span className="chevron">{switcherOpen ? '▴' : '▾'}</span>
        </button>
        {activeId && (
          <button
            className="icon-btn stop-btn"
            onClick={() => setConfirmStop({ id: activeId, label: active ? `${active.projectName} / ${active.tabLabel}` : 'this session' })}
            aria-label="Stop session"
          >■</button>
        )}
        {activeId && (
          <button
            className="icon-btn view-toggle"
            onClick={toggleMode}
            title={mode === 'chat' ? 'Switch to raw Terminal view' : 'Switch to Chat view'}
            aria-label="Toggle chat/terminal view"
          >
            {mode === 'chat' ? 'Term' : 'Chat'}
          </button>
        )}
        <button className="icon-btn" onClick={onShowHistory} aria-label="Chat history">☷</button>
        <button className="icon-btn" onClick={newTerminalHere} aria-label="New terminal">+</button>
      </header>

      {confirmStop && (
        <div className="confirm-bar">
          <span>Stop {confirmStop.label}?</span>
          <div className="confirm-actions">
            <button className="confirm-cancel" onClick={() => setConfirmStop(null)}>Cancel</button>
            <button
              className="confirm-stop"
              onClick={() => {
                connection.send({ type: 'kill', id: confirmStop.id });
                setConfirmStop(null);
              }}
            >Stop</button>
          </div>
        </div>
      )}

      {switcherOpen && (
        <div className="switcher">
          {groups.length === 0 && <div className="switcher-empty">No terminals open</div>}
          {groups.map((g) => (
            <div key={g.projectPath} className="switcher-group">
              <div className="switcher-group-head">{g.projectName}</div>
              {g.terms.map((t) => (
                <button
                  key={t.id}
                  className={`switcher-item ${t.id === activeId ? 'active' : ''}`}
                  onClick={() => { setActiveId(t.id); setSwitcherOpen(false); }}
                >
                  <span className="terminal-name">{t.tabLabel}</span>
                </button>
              ))}
              <button
                className="switcher-subnew"
                onClick={() => newTerminalIn(g.projectPath)}
              >
                + tab in {g.projectName}
              </button>
            </div>
          ))}
        </div>
      )}

      <main className="terminal-body">
        {!activeId ? (
          <div className="empty-state">
            <p className="muted">No terminal selected.</p>
            <p className="muted small">Tap the title bar to pick one.</p>
          </div>
        ) : mode === 'chat' ? (
          <ChatView key={activeId} connection={connection} tab={active} onOpenTerminal={openTerminal} />
        ) : (
          <XtermView connection={connection} activeId={activeId} />
        )}
      </main>

      {/* Raw-terminal helper keys only apply to the terminal mirror; the chat
          view has its own input. */}
      {activeId && mode === 'terminal' && <SpecialKeys onKey={sendKey} />}
    </div>
  );
}
