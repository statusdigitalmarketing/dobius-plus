import { timeAgo } from '../../../lib/time-ago';

export default function CommitLog({ commits, onSelectCommit }) {
  if (!commits.length) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-xs" style={{ color: 'var(--dim)' }}>No commits yet</p>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
      {commits.map((c) => (
        <button
          key={c.hash}
          onClick={() => onSelectCommit(c.hash)}
          className="w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors duration-100"
          style={{ borderBottom: '1px solid var(--border)' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface)')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
        >
          {/* Hash */}
          <span
            className="text-xs shrink-0 mt-0.5"
            style={{ color: 'var(--accent)', fontFamily: "'SF Mono', monospace" }}
          >
            {c.hash.slice(0, 7)}
          </span>

          {/* Subject + meta */}
          <div className="min-w-0 flex-1">
            <p className="text-xs truncate" style={{ color: 'var(--fg)' }}>
              {c.subject}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
              {c.author} &middot; {timeAgo(new Date(c.date).getTime())}
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}
