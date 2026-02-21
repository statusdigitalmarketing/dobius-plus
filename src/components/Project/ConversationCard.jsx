import { timeAgo } from '../../lib/time-ago';

/**
 * ConversationCard — single conversation entry in the sidebar.
 */
export default function ConversationCard({ session, selected, pinned, onSelect, onTogglePin }) {
  const projectName = session.project?.split('/').filter(Boolean).pop() || 'Unknown';

  return (
    <button
      onClick={onSelect}
      className="w-full text-left px-3 py-2 transition-colors"
      style={{
        backgroundColor: selected ? 'var(--bg)' : 'transparent',
        borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div
            className="text-xs font-medium truncate"
            style={{ color: selected ? 'var(--accent)' : 'var(--fg)' }}
          >
            {session.display || 'Untitled'}
          </div>
          <div className="text-xs truncate mt-0.5" style={{ color: 'var(--dim)' }}>
            {projectName}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {pinned && (
            <span className="text-xs" style={{ color: 'var(--accent)' }}>*</span>
          )}
          <span className="text-xs whitespace-nowrap" style={{ color: 'var(--dim)' }}>
            {timeAgo(session.timestamp)}
          </span>
        </div>
      </div>
    </button>
  );
}
