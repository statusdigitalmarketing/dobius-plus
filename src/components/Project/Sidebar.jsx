import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSessions } from '../../hooks/useSessions';
import ConversationCard from './ConversationCard';
import Preview from './Preview';

export default function Sidebar({ pinnedIds = [], onTogglePin, onResumeSession }) {
  const { sessions, loading, search, setSearch } = useSessions();
  const [selectedId, setSelectedId] = useState(null);
  const [previewSession, setPreviewSession] = useState(null);
  const [searchFocused, setSearchFocused] = useState(false);

  const handleSelect = (session) => {
    setSelectedId(session.sessionId);
  };

  const handleDoubleClick = (session) => {
    setPreviewSession(session);
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
      {/* Search */}
      <div className="p-2 shrink-0">
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
                      onDoubleClick={() => handleDoubleClick(session)}
                    >
                      <ConversationCard
                        session={session}
                        selected={selectedId === session.sessionId}
                        pinned
                        onSelect={() => handleSelect(session)}
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
                  onDoubleClick={() => handleDoubleClick(session)}
                >
                  <ConversationCard
                    session={session}
                    selected={selectedId === session.sessionId}
                    pinned={false}
                    onSelect={() => handleSelect(session)}
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
