import { useState, useEffect, useCallback, useMemo } from 'react';
import XtermView from './XtermView';
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
  const m = t.id.match(/^term-(.+)-(\d+)$/);
  if (m && m[1] !== 'mobile') {
    const projectPath = m[1];
    return {
      ...t,
      projectPath,
      projectName: lastSeg(projectPath),
      tabLabel: `Tab ${m[2]}`,
    };
  }
  const projectPath = t.cwd || 'mobile';
  return {
    ...t,
    projectPath,
    projectName: lastSeg(projectPath) || 'mobile',
    tabLabel: 'new',
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

export default function TerminalScreen({ connection, status, onShowHistory }) {
  const [terminals, setTerminals] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

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

  const groups = useMemo(() => groupTerminals(terminals), [terminals]);
  const active = useMemo(
    () => (activeId ? parseTerminal(terminals.find((t) => t.id === activeId) || { id: activeId, cwd: '' }) : null),
    [terminals, activeId]
  );

  const sendKey = useCallback((seq) => {
    if (activeId) connection.send({ type: 'input', id: activeId, data: seq });
  }, [connection, activeId]);

  // New terminal in a specific project (matches the desktop's per-project tabs).
  const newTerminalIn = useCallback((projectPath) => {
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
        <button className="terminal-pick" onClick={() => setSwitcherOpen((v) => !v)}>
          <span className="status-dot" style={{ backgroundColor: statusColor }} />
          <span className="terminal-name">
            {active ? `${active.projectName} / ${active.tabLabel}` : 'No terminal'}
          </span>
          <span className="chevron">{switcherOpen ? '▴' : '▾'}</span>
        </button>
        <button className="icon-btn" onClick={onShowHistory} aria-label="Chat history">☷</button>
        <button className="icon-btn" onClick={newTerminalHere} aria-label="New terminal">+</button>
      </header>

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
        {activeId ? (
          <XtermView connection={connection} activeId={activeId} />
        ) : (
          <div className="empty-state">
            <p className="muted">No terminal selected.</p>
            <p className="muted small">Tap the title bar to pick one.</p>
          </div>
        )}
      </main>

      {activeId && <SpecialKeys onKey={sendKey} />}
    </div>
  );
}
