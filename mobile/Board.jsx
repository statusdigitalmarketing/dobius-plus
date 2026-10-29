import { useState, useEffect, useMemo, useRef } from 'react';
import SessionCard from './SessionCard';
import LooseEnds from './LooseEnds';
import { sortTermsByAttention, groupSummary, summaryLabel, isGroupCollapsed } from './board-order.js';
import VoiceButton from './VoiceButton';
import { pushSupported, pushActive, enablePush } from './push-client';
import { timeAgo } from './format';
import { pairingKey } from './pairings';

// Group terminals by project PATH, preserving first-seen order. Keyed on path,
// not name, so two projects that share a folder name (Sam runs several
// `blueatlasbiologics.com` / `blueatlasusa.com` checkouts) stay separate
// sections instead of merging with duplicate tab labels. Codex Phase 2 P2.
function groupByProject(list) {
  const groups = [];
  const byPath = new Map();
  for (const t of list) {
    const key = t.projectPath || t.projectName || 'other';
    let g = byPath.get(key);
    if (!g) { g = { projectPath: key, projectName: t.projectName || key, terms: [] }; byPath.set(key, g); groups.push(g); }
    g.terms.push(t);
  }
  return groups;
}

// Order projects so anything needing attention floats up: a project with a
// 'needs' tab first, then one with 'working', then the rest.
function rank(g) {
  if (g.terms.some((t) => t.status === 'needs')) return 0;
  if (g.terms.some((t) => t.status === 'working')) return 1;
  return 2;
}

/**
 * The session board: the phone's home. A live, status-rich overview of every
 * terminal on the Mac, one tap into any of them. Consumes the status-rich
 * `terminals` payload the server pushes on change (v1.0.43 Phase 1b).
 */
// Device-local board preferences (v1.0.53): pinned tab ids + collapsed project
// paths. localStorage so they survive PWA restarts without a server round-trip.
const PINS_KEY = 'dobius-mobile-pins';
const EXPANDED_KEY = 'dobius-mobile-expanded';
const COLLAPSED_KEY = 'dobius-mobile-collapsed';
const loadList = (key) => {
  try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
};
const saveList = (key, list) => { try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* private mode */ } };

export default function Board({ connection, status, onOpen, onShowHistory, macName, onMacs }) {
  const pinsKey = pairingKey(connection.pairing, PINS_KEY);
  const collapsedKey = pairingKey(connection.pairing, COLLAPSED_KEY);
  const expandedKey = pairingKey(connection.pairing, EXPANDED_KEY);
  const [terminals, setTerminals] = useState([]);
  const [recentExits, setRecentExits] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [pins, setPins] = useState(() => loadList(pinsKey));
  const [collapsed, setCollapsed] = useState(() => loadList(collapsedKey));
  // Explicit EXPANSIONS are tracked separately from collapses. Dormant
  // projects hide themselves by default (32 of 39 tabs on this account are
  // idle shells), and without this a group the user just opened would be
  // re-hidden on the next render. isGroupCollapsed resolves the three-way.
  const [expanded, setExpanded] = useState(() => loadList(expandedKey));

  const togglePin = (id) => {
    setPins((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      saveList(pinsKey, next);
      return next;
    });
  };
  const toggleCollapsed = (projectPath, terms) => {
    // Toggle against what is ACTUALLY showing, not against the collapsed list:
    // a dormant group is hidden by default while absent from that list, so the
    // old logic made the first tap "collapse" an already-hidden group and the
    // user had to tap twice to open it.
    const showingNow = !isGroupCollapsed(projectPath, terms, { collapsed, expanded });
    const nextCollapsed = showingNow
      ? [...collapsed.filter((x) => x !== projectPath), projectPath]
      : collapsed.filter((x) => x !== projectPath);
    const nextExpanded = showingNow
      ? expanded.filter((x) => x !== projectPath)
      : [...expanded.filter((x) => x !== projectPath), projectPath];
    setCollapsed(nextCollapsed); saveList(collapsedKey, nextCollapsed);
    setExpanded(nextExpanded); saveList(expandedKey, nextExpanded);
  };
  const [alerts, setAlerts] = useState('off'); // off | on | error
  const [alertMsg, setAlertMsg] = useState('');
  // Guards a createTerminal round-trip so a double-tap in the picker (Tailscale
  // latency) can't spawn two orphan PTYs. Reset on the reply. Audit MED-10.
  const creatingRef = useRef(null); // { at, nonce } while a create is in flight

  // Reflect an ACTUAL subscription, not just permission (Codex Phase 5b P2), so
  // the bell keeps showing if the subscription was cleared/pruned server-side.
  // When one exists, re-register in the background so the server entry is bound
  // to the current device token (migrates any pre-token subscription so device
  // removal can revoke it). enablePush is idempotent and won't re-prompt.
  useEffect(() => {
    let cancelled = false;
    pushActive(connection).then((active) => {
      if (cancelled || !active) return;
      enablePush(connection).then((result) => {
        if (!cancelled) { setAlerts(result.ok ? 'on' : 'error'); setAlertMsg(result.error || ''); }
      });
    });
    return () => { cancelled = true; };
  }, [connection]);
  // Tick so relative times ("3m") refresh on quiet sessions: the server omits
  // lastActivityAt from its change signature, so without this the board only
  // re-renders on a status change and a time could stay "just now". Codex P3.
  const [, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    const off = connection.onMessage((msg) => {
      if (msg.type === 'authed') {
        connection.send({ type: 'listTerminals' });
      } else if (msg.type === 'terminals') {
        setTerminals(msg.list || []);
        setRecentExits(msg.recentExits || []);
      } else if (msg.type === 'projects') {
        setProjects(msg.list || []);
      } else if (msg.type === 'terminalCreated') {
        // Navigate for ANY terminalCreated (a Loose Ends resume emits it too
        // and wants the same jump), but release the create guard only for the
        // Board's own create (echoed nonce): an unrelated resume completing
        // mid-create must not unblock a second tap (Codex round 2).
        if (creatingRef.current && msg.nonce === creatingRef.current.nonce) {
          creatingRef.current = null;
        }
        setPickerOpen(false);
        onOpen(msg.id); // jump straight into the new session
      } else if (msg.type === 'error') {
        // A rejected create (e.g. Unknown project) must release the guard and
        // surface, else the picker looks frozen (Audit MED-10). But ONLY the
        // create's own error (matched by echoed nonce) releases it: an
        // unrelated error on the shared socket (a failed Loose Ends resume,
        // for example) used to clear the guard mid-create and a second tap
        // spawned a second PTY (Codex Medium). A lost reply is bounded by
        // the 15s timestamp on the guard itself.
        if (creatingRef.current && msg.nonce === creatingRef.current.nonce) {
          creatingRef.current = null;
        }
        setAlertMsg(msg.message || 'Could not create session');
        setTimeout(() => setAlertMsg(''), 5000);
      }
    });
    if (connection.status === 'authed') connection.send({ type: 'listTerminals' });
    return off;
  }, [connection, onOpen]);

  const groups = useMemo(() => {
    const g = groupByProject(terminals);
    return g
      .map((grp, i) => ({ ...grp, terms: sortTermsByAttention(grp.terms), _i: i }))
      .sort((a, b) => rank(a) - rank(b) || a._i - b._i);
  }, [terminals]);

  // Pinned rows in PIN order (the order Sam pinned them), only for tabs that
  // are currently alive; a dead pin silently waits (same tab id comes back on
  // app restart, since tab ids persist in the desktop config).
  const pinnedTerms = useMemo(() => {
    const byId = new Map(terminals.map((t) => [t.id, t]));
    return pins.map((id) => byId.get(id)).filter(Boolean);
  }, [terminals, pins]);

  const totals = groupSummary(terminals);
  const needsCount = terminals.filter((t) => t.status === 'needs').length;
  const workingCount = terminals.filter((t) => t.status === 'working').length;

  const dotColor = status === 'authed' ? 'var(--status-done)'
    : status === 'connecting' ? 'var(--status-working)' : 'var(--status-needs)';

  return (
    <div className="screen board-screen">
      {/* The Claude app's home header: a round button (your Macs), the Mac's
          name over a quiet status line, and a pill of actions. */}
      <header className="board-header elevated">
        <div className="board-title-row">
          <button className="tb-round" onClick={onMacs} aria-label={`Switch Mac, current Mac: ${macName}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2.5 19h19" /></svg>
          </button>
          <button className="board-title-mid" onClick={onMacs} aria-label={`Switch Mac, current Mac: ${macName}`}>
            <span className="board-title-main">{macName}</span>
            <span className="board-title-sub">
              {status !== 'authed' && <span className="status-dot" style={{ backgroundColor: dotColor }} />}
              {[
                status === 'authed' ? 'connected' : status === 'connecting' ? 'connecting' : 'offline',
                needsCount > 0 ? `${needsCount} needs you` : '',
                workingCount > 0 ? `${workingCount} working` : '',
                terminals.length > 0 && totals.active === 0 ? 'all quiet' : '',
                totals.done > 0 && totals.needs === 0 && totals.working === 0 ? `${totals.done} just finished` : '',
              ].filter(Boolean).join(' · ')}
            </span>
          </button>
          <div className="tb-pill">
            {pushSupported() && alerts !== 'on' && (
              <button
                onClick={async () => {
                  const r = await enablePush(connection);
                  setAlerts(r.ok ? 'on' : 'error');
                  setAlertMsg(r.ok ? '' : (r.error || 'Could not enable alerts'));
                  if (!r.ok) setTimeout(() => setAlertMsg(''), 5000);
                }}
                aria-label="Enable notifications"
                title="Get notified when a session needs you"
              ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg></button>
            )}
            <button onClick={onShowHistory} aria-label="Chat history">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
            </button>
            <button
              onClick={() => { setPickerOpen(true); connection.send({ type: 'listProjects' }); }}
              aria-label="New session"
            ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
          </div>
        </div>
        {alertMsg && <div className="board-alert">{alertMsg}</div>}
      </header>

      <main className="board-body">
        {terminals.length === 0 ? (
          <div className="board-empty">
            <div className="board-empty-glyph">◍</div>
            <p className="board-empty-title">No sessions running</p>
            <p className="muted small">
              {status === 'authed'
                ? 'Open a terminal on your Mac and it will appear here.'
                : 'Waiting for the connection to your Mac…'}
            </p>
          </div>
        ) : (
          <>
            {pinnedTerms.length > 0 && (
              <section className="board-group board-pinned">
                <div className="board-group-head">
                  <span className="board-group-name">★ Pinned</span>
                </div>
                {pinnedTerms.map((t) => (
                  <SessionCard
                    key={`pin-${t.id}`}
                    term={t}
                    onOpen={onOpen}
                    pinned
                    onTogglePin={togglePin}
                    titlePrefix={t.projectName || ''}
                  />
                ))}
              </section>
            )}
            {groups.map((g) => {
              const isCollapsed = isGroupCollapsed(g.projectPath, g.terms, { collapsed, expanded });
              const sum = groupSummary(g.terms);
              return (
                <section key={g.projectPath} className="board-group">
                  {/* Tap the project name to collapse/expand its tabs (v1.0.53). */}
                  <button className="board-group-head board-group-toggle" onClick={() => toggleCollapsed(g.projectPath, g.terms)}>
                    <span className="board-group-caret">{isCollapsed ? '▸' : '▾'}</span>
                    <span className="board-group-name">{g.projectName}</span>
                    {/* Counts show whether the group is open or shut, so a
                        collapsed project still tells you what is inside. */}
                    <span className={`board-group-count${sum.needs > 0 ? ' board-count-needs' : ''}`}>
                      {summaryLabel(sum)}
                    </span>
                  </button>
                  {!isCollapsed && g.terms.map((t) => (
                    <SessionCard
                      key={t.id}
                      term={t}
                      onOpen={onOpen}
                      pinned={pins.includes(t.id)}
                      onTogglePin={togglePin}
                    />
                  ))}
                </section>
              );
            })}
          </>
        )}

        {/* Outside the live-sessions branch above: with nothing running, the
            work you abandoned is the ONLY thing left worth showing. */}
        <LooseEnds connection={connection} />

        {recentExits.length > 0 && (
          <section className="board-group board-exits">
            <div className="board-group-head">Recently finished</div>
            {recentExits.slice(-5).reverse().map((e) => (
              <div key={`${e.id}-${e.at}`} className="exit-row">
                <span className={`exit-dot ${e.exitCode === 0 ? 'ok' : 'bad'}`} aria-hidden="true" />
                <span className="exit-main">
                  <span className="card-title">{e.projectName || 'terminal'}</span>
                  <span className="card-sub">
                    {e.exitCode === 0 ? 'finished' : `exited ${e.exitCode ?? ''}`}
                    {e.at ? ` · ${timeAgo(e.at)}` : ''}
                  </span>
                </span>
              </div>
            ))}
          </section>
        )}
      </main>

      <VoiceButton connection={connection} />

      {pickerOpen && (
        <div className="sheet-backdrop" onClick={() => setPickerOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-heading">
              <button className="tb-round" onClick={() => setPickerOpen(false)} aria-label="Close">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
              <div className="sheet-title">New session in…</div>
            </div>
            <div className="sheet-list">
              {projects.length === 0 && <div className="sheet-empty">Loading projects…</div>}
              {projects.map((p) => (
                <button
                  key={p.path}
                  className="sheet-item"
                  onClick={() => {
                    // Guard double-tap (MED-10). Time-stamped: a guard older
                    // than 15s means the reply was lost, not in flight.
                    if (creatingRef.current && Date.now() - creatingRef.current.at < 15000) return;
                    const nonce = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    creatingRef.current = { at: Date.now(), nonce };
                    setPickerOpen(false); // close optimistically so a second tap can't fire
                    connection.send({ type: 'createTerminal', cwd: p.path, nonce });
                  }}
                >
                  <span className="card-title">{p.name}</span>
                  <span className="card-sub">{p.path}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
