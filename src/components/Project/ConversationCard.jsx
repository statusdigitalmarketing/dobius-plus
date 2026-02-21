import { timeAgo } from '../../lib/time-ago';

export default function ConversationCard({ session, selected, pinned, onSelect, onTogglePin }) {
  const projectName = session.project?.split('/').filter(Boolean).pop() || 'Unknown';

  return (
    <button
      onClick={onSelect}
      className="w-full text-left px-3 py-2 transition-all duration-100"
      style={{
        backgroundColor: selected ? 'var(--bg)' : 'transparent',
        borderLeft: selected ? '3px solid var(--accent)' : '3px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
        if (!selected) e.currentTarget.style.borderLeftColor = 'var(--border)';
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = 'transparent';
        if (!selected) e.currentTarget.style.borderLeftColor = 'transparent';
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div
            className="text-xs font-medium truncate"
            style={{ color: 'var(--fg)' }}
          >
            {session.display || 'Untitled'}
          </div>
          <div
            className="text-xs truncate mt-0.5"
            style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: '10px' }}
          >
            {projectName}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {pinned && (
            <span
              className="w-1.5 h-1.5 rounded-full inline-block"
              style={{ backgroundColor: 'var(--accent)' }}
            />
          )}
          <span
            className="text-xs whitespace-nowrap"
            style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: '10px' }}
          >
            {timeAgo(session.timestamp)}
          </span>
        </div>
      </div>
    </button>
  );
}
