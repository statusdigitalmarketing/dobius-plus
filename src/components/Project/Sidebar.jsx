import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSessions, SHOW_AUTOMATED_EVENT } from '../../hooks/useSessions';
import { useStore } from '../../store/store';
import { STATUS_COLORS } from '../../lib/status-colors';
import { bucketSessions, EARLIER_PAGE } from '../../lib/session-shelves';
import ConversationCard from './ConversationCard';
import ProjectTabsView from './ProjectTabsView';
import Preview from './Preview';

const SHELF_DEFAULTS = { working: false, earlier: true };

function SectionLabel({ children, color }) {
  return (
    <div
      className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wider flex items-center gap-1.5"
      style={{ color: color || 'var(--dim)', fontSize: '10px' }}
    >
      {children}
    </div>
  );
}

// Collapsible bottom shelf. The count stays in the header so a collapsed
// shelf still says how much is inside.
function Shelf({ label, count, dot, collapsed, onToggle, children }) {
  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-1.5 px-3 py-1.5"
        style={{
          background: 'transparent', border: 'none', cursor: onToggle ? 'pointer' : 'default',
          color: 'var(--dim)', fontSize: 10, fontFamily: "'SF Mono', monospace",
          textTransform: 'uppercase', letterSpacing: '0.1em',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--surface-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        <span style={{ fontSize: 8, width: 8 }}>{collapsed ? '▶' : '▼'}</span>
        {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: dot }} />}
        <span>{label}</span>
        <span style={{ marginLeft: 'auto' }}>{count}</span>
      </button>
      {!collapsed && children}
    </div>
  );
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function Sidebar({ pinnedIds = [], onTogglePin, onResumeSession }) {
  // v1.0.26: sidebar can scope to the current project via a toggle in the
  // header. Persisted in config.settings.sidebarFilterToProject so it sticks
  // across reloads. Fetched once on mount; updated whenever the toggle fires.
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const [projectScoped, setProjectScoped] = useState(false);
  // View mode: 'tabs' = all tabs grouped by project across every window (Brett's
  // request, the default); 'history' = the existing session feed (unchanged).
  const [viewMode, setViewMode] = useState('tabs');
  const [shelfCollapsed, setShelfCollapsed] = useState(SHELF_DEFAULTS);
  const [earlierShown, setEarlierShown] = useState(EARLIER_PAGE);
  // Agent SDK runs (review hooks, worktree agents) are hidden from History
  // unless asked for: they outnumbered real chats ~75 to 1.
  const [showAutomated, setShowAutomated] = useState(false);
  // A click before the initial settings read lands must win over that read.
  const touchedRef = useRef({ automated: false, shelves: false });

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.configGetSettings?.().then((s) => {
      if (cancelled) return;
      if (s?.sidebarFilterToProject !== undefined) setProjectScoped(!!s.sidebarFilterToProject);
      if (s?.sidebarViewMode === 'tabs' || s?.sidebarViewMode === 'history') setViewMode(s.sidebarViewMode);
      if (typeof s?.showAutomatedSessions === 'boolean' && !touchedRef.current.automated) {
        setShowAutomated(s.showAutomatedSessions);
        // Same-window peers may hold a value read before another window changed it.
        window.dispatchEvent(new CustomEvent(SHOW_AUTOMATED_EVENT, { detail: s.showAutomatedSessions }));
      }
      const saved = s?.sidebarShelvesCollapsed;
      if (saved && typeof saved === 'object' && !touchedRef.current.shelves) {
        setShelfCollapsed({
          working: typeof saved.working === 'boolean' ? saved.working : SHELF_DEFAULTS.working,
          earlier: typeof saved.earlier === 'boolean' ? saved.earlier : SHELF_DEFAULTS.earlier,
        });
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onChange = (e) => {
      if (typeof e.detail !== 'boolean') return;
      touchedRef.current.automated = true;
      setShowAutomated(e.detail);
    };
    window.addEventListener(SHOW_AUTOMATED_EVENT, onChange);
    return () => window.removeEventListener(SHOW_AUTOMATED_EVENT, onChange);
  }, []);

  const toggleShelf = useCallback((id) => {
    touchedRef.current.shelves = true;
    setShelfCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      window.electronAPI?.configUpdateSettings?.({ sidebarShelvesCollapsed: next })
        ?.catch?.((err) => console.warn('[Sidebar] persist shelves failed:', err.message));
      return next;
    });
  }, []);

  const setMode = useCallback(async (mode) => {
    setViewMode(mode);
    try { await window.electronAPI?.configUpdateSettings?.({ sidebarViewMode: mode }); }
    catch (err) { console.warn('[Sidebar] persist view mode failed:', err.message); }
  }, []);

  const toggleProjectScope = useCallback(async () => {
    const next = !projectScoped;
    setProjectScoped(next);
    try { await window.electronAPI?.configUpdateSettings?.({ sidebarFilterToProject: next }); }
    catch (err) { console.warn('[Sidebar] persist filter toggle failed:', err.message); }
  }, [projectScoped]);

  const toggleShowAutomated = useCallback(async () => {
    const next = !showAutomated;
    touchedRef.current.automated = true;
    setShowAutomated(next);
    window.dispatchEvent(new CustomEvent(SHOW_AUTOMATED_EVENT, { detail: next }));
    try { await window.electronAPI?.configUpdateSettings?.({ showAutomatedSessions: next }); }
    catch (err) { console.warn('[Sidebar] persist automated toggle failed:', err.message); }
  }, [showAutomated]);

  const {
    sessions, sessionTabMap, loading, search, setSearch, setLabel, clearLabel,
  } = useSessions({
    projectFilter: projectScoped && currentProjectPath ? currentProjectPath : null,
    excludeAutomated: !showAutomated,
  });

  const [selectedId, setSelectedId] = useState(null);
  const [previewSession, setPreviewSession] = useState(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [closedTabsExpanded, setClosedTabsExpanded] = useState(false);
  const recentlyClosedTabs = useStore((s) => s.recentlyClosedTabs);
  const reopenClosedTab = useStore((s) => s.reopenClosedTab);
  const terminalTabs = useStore((s) => s.terminalTabs);
  const tabStatus = useStore((s) => s.tabStatus);
  const searchInputRef = useRef(null);

  // Resolve a session to its terminal tab's live label (Cmd+B tab badge).
  // Stores the tabId, so a renamed tab shows its new name automatically.
  const tabLabelFor = (sessionId) => {
    const link = sessionTabMap?.[sessionId];
    if (!link?.tabId) return null;
    // Live tab in THIS window: badge is legit regardless of the session's
    // home project (cross-project resumes park a project-A session in a
    // project-B tab, link.projectPath = A while the tab lives here).
    const open = terminalTabs.find((t) => t.id === link.tabId);
    if (open) return open.label;
    // Fallback to recently-closed only when the link's project matches this
    // window. Tab ids recycle across restarts (per-project counters), so a
    // stale cross-project link must not badge a closed tab here with an old
    // session. Codex v1.0.35 r5 P3.
    if (link.projectPath && currentProjectPath && link.projectPath !== currentProjectPath) return null;
    const closed = recentlyClosedTabs.find((c) => c.id === link.tabId);
    return closed ? `${closed.label} (closed)` : null;
  };

  // Auto-focus search on open (Sidebar mounts/unmounts with sidebarVisible).
  // setTimeout(50) rather than rAF so xterm can't steal focus on the reflow.
  useEffect(() => {
    const t = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleClick = (session, e) => {
    if (e.detail === 2) {
      // Double-click → resume session
      onResumeSession?.(session);
    } else {
      // Single click → just select
      setSelectedId(session.sessionId);
    }
  };

  const handleResume = () => {
    if (previewSession) {
      onResumeSession?.(previewSession);
    }
  };

  // Ask MAIN which session each of this window's tabs is running and whether
  // its hook status is needs/working: only main sees process start times (a
  // renderer guess credited the previous session in a reused tab) and its
  // status survives a tear-off. Re-asked on any local status change and every
  // 15s, matching main's link refresh tick. Only the newest answer lands.
  const [liveSessions, setLiveSessions] = useState([]);
  const liveSeqRef = useRef(0);
  const liveAppliedRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // Keys, not arrays: a tab's title changing must not re-ask main.
  const tabIdsKey = useMemo(() => terminalTabs.map((t) => t.id).join('\n'), [terminalTabs]);
  const statusKey = useMemo(
    () => terminalTabs.map((t) => tabStatus[t.id] || '').join('|'),
    [terminalTabs, tabStatus],
  );
  useEffect(() => {
    if (viewMode !== 'history' || !window.electronAPI?.tabsLiveSessions) {
      setLiveSessions([]);
      return undefined;
    }
    let inFlight = false;
    const ids = tabIdsKey ? tabIdsKey.split('\n') : [];
    // The immediate ask (a status just changed) always goes out; interval
    // ticks are skipped while one is still running. A reply is dropped only
    // on unmount, never because a newer ask started: any reply newer than the
    // last APPLIED one lands, so rapid status churn cannot starve every reply.
    const fetchLive = async (fromTick) => {
      if (fromTick && inFlight) return;
      inFlight = true;
      const seq = ++liveSeqRef.current;
      try {
        const r = await window.electronAPI.tabsLiveSessions(ids);
        if (mountedRef.current && seq > liveAppliedRef.current) {
          liveAppliedRef.current = seq;
          setLiveSessions(Array.isArray(r) ? r : []);
        }
      } catch (err) {
        console.warn('[Sidebar] live sessions lookup failed:', err?.message);
      } finally {
        inFlight = false;
      }
    };
    fetchLive(false);
    const t = setInterval(() => fetchLive(true), 15000);
    return () => clearInterval(t);
  }, [viewMode, tabIdsKey, statusKey]);

  // liveSessions is replaced on every 15s poll, which also re-judges the disk
  // "working" fallback against the current time.
  const buckets = useMemo(
    () => bucketSessions({ sessions, pinnedIds, liveSessions, now: Date.now() }),
    [sessions, pinnedIds, liveSessions],
  );

  // While searching, matches must never hide inside a collapsed shelf.
  const searching = !!search;
  const workingOpen = searching || !shelfCollapsed.working;
  const earlierOpen = searching || !shelfCollapsed.earlier;
  const earlierVisible = searching ? buckets.earlier : buckets.earlier.slice(0, earlierShown);

  const renderCards = (list) => (
    <AnimatePresence>
      {list.map((session, i) => (
        <motion.div
          key={session.sessionId}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: Math.min(i, 10) * 0.03 }}
        >
          <ConversationCard
            session={session}
            selected={selectedId === session.sessionId}
            pinned={pinnedIds.includes(session.sessionId)}
            tabLabel={tabLabelFor(session.sessionId)}
            hasCustomLabel={!!session.customLabel}
            onSelect={(e) => handleClick(session, e)}
            onTogglePin={() => onTogglePin?.(session.sessionId)}
            onRename={setLabel}
            onClearRename={clearLabel}
          />
        </motion.div>
      ))}
    </AnimatePresence>
  );

  if (previewSession) {
    return (
      <Preview
        session={previewSession}
        onClose={() => setPreviewSession(null)}
        onResume={handleResume}
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header: Tabs|History view toggle + (History-only) project-scope toggle */}
      <div className="px-3 pt-3 pb-1 shrink-0 flex items-center justify-between gap-2">
        <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {[['tabs', 'Tabs'], ['history', 'History']].map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setMode(mode)}
              title={mode === 'tabs' ? 'All tabs, grouped by project, across every window' : 'Session history'}
              style={{
                padding: '2px 10px', fontSize: 10, fontFamily: "'SF Mono', monospace",
                color: viewMode === mode ? 'var(--bg)' : 'var(--dim)',
                backgroundColor: viewMode === mode ? 'var(--accent)' : 'transparent',
                border: 'none', cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {viewMode === 'history' && currentProjectPath && (
            <button
              onClick={toggleProjectScope}
              title={projectScoped
                ? 'Showing only sessions from this project, click to show all'
                : 'Showing all sessions, click to filter to this project'}
              style={{
                background: projectScoped ? 'var(--surface-hover)' : 'transparent',
                color: projectScoped ? 'var(--accent)' : 'var(--dim)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                cursor: 'pointer',
                fontSize: 9,
                fontFamily: "'SF Mono', monospace",
                padding: '1px 6px',
                lineHeight: 1.4,
              }}
            >
              {projectScoped ? '⊙ this project' : '○ all'}
            </button>
          )}
          {viewMode === 'history' && (
            <button
              onClick={toggleShowAutomated}
              data-testid="toggle-automated"
              title={showAutomated
                ? 'Showing Agent SDK runs (review hooks, scripted agents), click to hide them'
                : 'Automated runs are hidden, click to show them'}
              style={{
                background: showAutomated ? 'var(--surface-hover)' : 'transparent',
                color: showAutomated ? 'var(--accent)' : 'var(--dim)',
                border: '1px solid var(--border)',
                borderRadius: 3,
                cursor: 'pointer',
                fontSize: 9,
                fontFamily: "'SF Mono', monospace",
                padding: '1px 6px',
                lineHeight: 1.4,
              }}
            >
              {showAutomated ? '⊙ bots' : '○ bots'}
            </button>
          )}
          {viewMode === 'tabs' && (
            <span
              className="text-xs italic"
              style={{ color: 'var(--dim)', fontSize: '10px' }}
            >
              tap to open
            </span>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="p-2 pt-1 shrink-0">
        <div className="relative">
          <svg
            className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3"
            style={{ color: searchFocused ? 'var(--fg)' : 'var(--dim)' }}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            placeholder={viewMode === 'history' ? 'Search... (double-click to resume)' : 'Search...'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded outline-none transition-all duration-150"
            style={{
              backgroundColor: 'var(--bg)',
              color: 'var(--fg)',
              border: searchFocused ? '1px solid var(--dim)' : '1px solid var(--border)',
            }}
          />
        </div>
      </div>

      {viewMode === 'tabs' ? (
        <ProjectTabsView search={search} onResumeSession={onResumeSession} />
      ) : (
      <>
      {/* Closed tabs section */}
      {recentlyClosedTabs.length > 0 && (
        <div className="shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <button
            onClick={() => setClosedTabsExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-1.5"
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--dim)',
              fontSize: 10,
              fontFamily: "'SF Mono', monospace",
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            <span>Closed Tabs ({recentlyClosedTabs.length})</span>
            <span style={{ fontSize: 8 }}>{closedTabsExpanded ? '\u25B2' : '\u25BC'}</span>
          </button>
          {closedTabsExpanded && (
            <div className="px-1 pb-1" style={{ maxHeight: 200, overflowY: 'auto' }}>
              {recentlyClosedTabs.map((closed, idx) => (
                <button
                  key={`closed-${idx}`}
                  onClick={() => {
                    const result = reopenClosedTab(idx);
                    if (result?.tab && result?.scrollback?.length > 0) {
                      setTimeout(() => {
                        window.electronAPI?.terminalSaveState?.(result.tab.id, {
                          scrollback: result.scrollback,
                          cols: 80, rows: 24, savedAt: Date.now(),
                        });
                      }, 100);
                    }
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1 rounded"
                  style={{
                    backgroundColor: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontFamily: "'SF Mono', monospace",
                    color: 'var(--fg)',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--surface-hover)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  <span className="truncate" style={{ flex: 1 }}>{closed.label || 'Tab'}</span>
                  <span style={{ color: 'var(--dim)', fontSize: 9, flexShrink: 0 }}>{timeAgo(closed.closedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Conversations list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-2 space-y-1">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="px-3 py-2 animate-pulse">
                <div className="h-3 w-3/4 rounded" style={{ backgroundColor: 'var(--border)' }} />
                <div className="h-2.5 w-1/2 mt-1.5 rounded" style={{ backgroundColor: 'var(--border)' }} />
              </div>
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-3 text-xs" style={{ color: 'var(--dim)' }}>
            {search ? 'No matching conversations' : 'No conversations yet'}
            {!showAutomated && ' (automated runs hidden)'}
          </div>
        ) : (
          <div className="min-h-full flex flex-col" data-testid="history-sections">
            {buckets.needs.length > 0 && (
              <>
                <SectionLabel color={STATUS_COLORS.needs}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: STATUS_COLORS.needs }} />
                  Needs you · {buckets.needs.length}
                </SectionLabel>
                {renderCards(buckets.needs)}
                <div className="mx-3 my-1" style={{ borderBottom: '1px solid var(--border)' }} />
              </>
            )}

            {buckets.pinned.length > 0 && (
              <>
                <SectionLabel>Pinned</SectionLabel>
                {renderCards(buckets.pinned)}
                <div className="mx-3 my-1" style={{ borderBottom: '1px solid var(--border)' }} />
              </>
            )}

            {buckets.recent.length > 0 && (
              <>
                <SectionLabel>Recent</SectionLabel>
                {renderCards(buckets.recent)}
              </>
            )}

            {/* Shelves sit at the bottom of the list so quiet sessions stay
                out of the way of the ones that need attention. */}
            <div className="mt-auto pt-2">
              {buckets.working.length > 0 && (
                <Shelf
                  label="Working"
                  count={buckets.working.length}
                  dot={STATUS_COLORS.working}
                  collapsed={!workingOpen}
                  onToggle={searching ? undefined : () => toggleShelf('working')}
                >
                  {renderCards(buckets.working)}
                </Shelf>
              )}
              {buckets.earlier.length > 0 && (
                <Shelf
                  label="Earlier"
                  count={buckets.earlier.length}
                  collapsed={!earlierOpen}
                  onToggle={searching ? undefined : () => toggleShelf('earlier')}
                >
                  {renderCards(earlierVisible)}
                  {earlierVisible.length < buckets.earlier.length && (
                    <button
                      onClick={() => setEarlierShown((n) => n + EARLIER_PAGE)}
                      className="w-full px-3 py-1.5 text-left"
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--accent)', fontSize: 11,
                      }}
                    >
                      Show {Math.min(EARLIER_PAGE, buckets.earlier.length - earlierVisible.length)} more
                    </button>
                  )}
                </Shelf>
              )}
            </div>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
