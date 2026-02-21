import { useState } from 'react';
import { useSessions } from '../../hooks/useSessions';
import ConversationCard from './ConversationCard';
import Preview from './Preview';

/**
 * Sidebar — conversation history with search and preview.
 */
export default function Sidebar({ pinnedIds = [], onTogglePin, onResumeSession }) {
  const { sessions, loading, search, setSearch } = useSessions();
  const [selectedId, setSelectedId] = useState(null);
  const [previewSession, setPreviewSession] = useState(null);

  const selectedSession = sessions.find((s) => s.sessionId === selectedId);

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

  // Separate pinned from unpinned
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
        <input
          type="text"
          placeholder="Search conversations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-2 py-1.5 text-xs rounded outline-none"
          style={{
            backgroundColor: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
          }}
        />
      </div>

      {/* Conversations list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-3 text-xs" style={{ color: 'var(--dim)' }}>
            Loading...
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
                <div className="px-3 pt-2 pb-1 text-xs font-medium" style={{ color: 'var(--dim)' }}>
                  Pinned
                </div>
                {pinned.map((session) => (
                  <div
                    key={session.sessionId}
                    onDoubleClick={() => handleDoubleClick(session)}
                  >
                    <ConversationCard
                      session={session}
                      selected={selectedId === session.sessionId}
                      pinned
                      onSelect={() => handleSelect(session)}
                      onTogglePin={() => onTogglePin?.(session.sessionId)}
                    />
                  </div>
                ))}
              </>
            )}

            {/* Recent section */}
            <div className="px-3 pt-2 pb-1 text-xs font-medium" style={{ color: 'var(--dim)' }}>
              Recent
            </div>
            {unpinned.map((session) => (
              <div
                key={session.sessionId}
                onDoubleClick={() => handleDoubleClick(session)}
              >
                <ConversationCard
                  session={session}
                  selected={selectedId === session.sessionId}
                  pinned={false}
                  onSelect={() => handleSelect(session)}
                  onTogglePin={() => onTogglePin?.(session.sessionId)}
                />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
