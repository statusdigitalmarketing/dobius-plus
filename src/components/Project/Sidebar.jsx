import { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSessions } from '../../hooks/useSessions';
import { useStore } from '../../store/store';
import ConversationCard from './ConversationCard';
import Preview from './Preview';

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function Sidebar({ pinnedIds = [], onTogglePin, onResumeSession, onCdToProject }) {
  const { sessions, loading, search, setSearch } = useSessions();
  const [selectedId, setSelectedId] = useState(null);
  const [previewSession, setPreviewSession] = useState(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [closedTabsExpanded, setClosedTabsExpanded] = useState(false);
  const recentlyClosedTabs = useStore((s) => s.recentlyClosedTabs);
  const reopenClosedTab = useStore((s) => s.reopenClosedTab);
  const searchInputRef = useRef(null);

  // Auto-focus search on open (Sidebar mounts/unmounts with sidebarVisible)
  useEffect(() => {
    requestAnimationFrame(() => searchInputRef.current?.focus());
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

  const pinned = sessions.filter((s) => pinnedIds.includes(s.sessionId));
  const unpinned = sessions.filter((s) => !pinnedIds.includes(s.sessionId));

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
      {/* Header + hint */}
      <div className="px-3 pt-3 pb-1 shrink-0 flex items-center justify-between">
        <span
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--fg)', fontSize: '11px', letterSpacing: '0.1em' }}
        >
          Sessions
        </span>
        <span
          className="text-xs italic"
          style={{ color: 'var(--dim)', fontSize: '10px' }}
        >
          double-click to resume
        </span>
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
            placeholder="Search..."
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
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--border)'; }}
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
          </div>
        ) : (
          <>
            {/* Pinned section */}
            {pinned.length > 0 && (
              <>
                <div
                  className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wider"
                  style={{ color: 'var(--dim)', fontSize: '10px' }}
                >
                  Pinned
                </div>
                <AnimatePresence>
                  {pinned.map((session, i) => (
                    <motion.div
                      key={session.sessionId}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: i * 0.03 }}
                    >
                      <ConversationCard
                        session={session}
                        selected={selectedId === session.sessionId}
                        pinned
                        onSelect={(e) => handleClick(session, e)}
                        onTogglePin={() => onTogglePin?.(session.sessionId)}
                      />
                    </motion.div>
                  ))}
                </AnimatePresence>
                <div className="mx-3 my-1" style={{ borderBottom: '1px solid var(--border)' }} />
              </>
            )}

            {/* Recent section */}
            <div
              className="px-3 pt-2 pb-1 text-xs font-medium uppercase tracking-wider"
              style={{ color: 'var(--dim)', fontSize: '10px' }}
            >
              Recent
            </div>
            <AnimatePresence>
              {unpinned.map((session, i) => (
                <motion.div
                  key={session.sessionId}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.03 }}
                >
                  <ConversationCard
                    session={session}
                    selected={selectedId === session.sessionId}
                    pinned={false}
                    onSelect={(e) => handleClick(session, e)}
                    onTogglePin={() => onTogglePin?.(session.sessionId)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  );
}
