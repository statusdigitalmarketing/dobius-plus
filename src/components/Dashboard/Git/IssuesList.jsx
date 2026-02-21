import { timeAgo } from '../../../lib/time-ago';

export default function IssuesList({ issues, ghAvailable }) {
  if (!ghAvailable) {
    return (
      <div className="flex flex-col items-center justify-center h-40 gap-2">
        <p className="text-xs" style={{ color: 'var(--dim)' }}>
          GitHub CLI not installed
        </p>
        <p className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
          brew install gh && gh auth login
        </p>
      </div>
    );
  }

  if (!issues.length) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-xs" style={{ color: 'var(--dim)' }}>No open issues</p>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
      {issues.map((issue) => (
        <div
          key={issue.number}
          className="px-4 py-3 flex items-start gap-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          {/* State dot */}
          <span
            className="w-2 h-2 rounded-full shrink-0 mt-1.5"
            style={{
              backgroundColor: issue.state === 'OPEN' ? '#3fb950' : '#f85149',
            }}
          />

          <div className="min-w-0 flex-1">
            <p className="text-xs" style={{ color: 'var(--fg)' }}>
              <span style={{ color: 'var(--dim)' }}>#{issue.number}</span>{' '}
              {issue.title}
            </p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {/* Labels */}
              {issue.labels?.map((label) => (
                <span
                  key={label.name}
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: label.color ? `#${label.color}33` : 'var(--surface)',
                    color: label.color ? `#${label.color}` : 'var(--dim)',
                    fontSize: '10px',
                  }}
                >
                  {label.name}
                </span>
              ))}

              <span className="text-xs" style={{ color: 'var(--dim)' }}>
                {issue.author?.login || 'unknown'} &middot;{' '}
                {timeAgo(new Date(issue.createdAt).getTime())}
              </span>

              {issue.assignees?.length > 0 && (
                <span className="text-xs" style={{ color: 'var(--dim)' }}>
                  &rarr; {issue.assignees.map((a) => a.login).join(', ')}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
