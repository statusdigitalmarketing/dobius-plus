import { useState, useEffect, useCallback } from 'react';
import XtermView from './XtermView';
import SpecialKeys from './SpecialKeys';

/** basename of a path, for a short terminal label. */
function basename(p) {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

export default function TerminalScreen({ connection, status }) {
  const [terminals, setTerminals] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const refreshList = useCallback(() => {
    connection.send({ type: 'listTerminals' });
  }, [connection]);

  // Request the terminal list once authed, and handle list/create messages.
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
        refreshList();
        setActiveId(msg.id);
        setSwitcherOpen(false);
      } else if (msg.type === 'exit') {
        refreshList();
      }
    });
    if (connection.status === 'authed') refreshList();
    return off;
  }, [connection, refreshList]);

  const sendKey = useCallback((seq) => {
    if (activeId) connection.send({ type: 'input', id: activeId, data: seq });
  }, [connection, activeId]);

  const newTerminal = useCallback(() => {
    connection.send({ type: 'createTerminal' });
  }, [connection]);

  const activeTerm = terminals.find((t) => t.id === activeId);
  const statusColor = status === 'authed' ? '#3FB950' : status === 'connecting' ? '#D29922' : '#F85149';

  return (
    <div className="screen terminal-screen">
      <header className="top-bar">
        <button className="terminal-pick" onClick={() => setSwitcherOpen((v) => !v)}>
          <span className="status-dot" style={{ backgroundColor: statusColor }} />
          <span className="terminal-name">
            {activeTerm ? basename(activeTerm.cwd) : 'No terminal'}
          </span>
          <span className="chevron">{switcherOpen ? '▴' : '▾'}</span>
        </button>
        <button className="icon-btn" onClick={newTerminal} aria-label="New terminal">+</button>
      </header>

      {switcherOpen && (
        <div className="switcher">
          {terminals.length === 0 && (
            <div className="switcher-empty">No terminals open</div>
          )}
          {terminals.map((t) => (
            <button
              key={t.id}
              className={`switcher-item ${t.id === activeId ? 'active' : ''}`}
              onClick={() => { setActiveId(t.id); setSwitcherOpen(false); }}
            >
              <span className="terminal-name">{basename(t.cwd)}</span>
              <span className="muted small">{t.cwd}</span>
            </button>
          ))}
          <button className="switcher-item new" onClick={newTerminal}>
            + New terminal
          </button>
        </div>
      )}

      <main className="terminal-body">
        {activeId ? (
          <XtermView connection={connection} activeId={activeId} />
        ) : (
          <div className="empty-state">
            <p className="muted">No terminal selected.</p>
            <button className="primary" onClick={newTerminal}>New terminal</button>
          </div>
        )}
      </main>

      {activeId && <SpecialKeys onKey={sendKey} />}
    </div>
  );
}
