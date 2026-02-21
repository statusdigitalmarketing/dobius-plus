export default function GitStatusBar({ status, onRefresh }) {
  if (!status?.isRepo) return null;

  return (
    <div
      className="flex items-center justify-between px-4 py-2 shrink-0"
      style={{ backgroundColor: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-3">
        {/* Branch */}
        <div className="flex items-center gap-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
            {status.branch}
          </span>
        </div>

        {/* Ahead/Behind */}
        {(status.ahead > 0 || status.behind > 0) && (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--dim)' }}>
            {status.ahead > 0 && <span>{status.ahead}&uarr;</span>}
            {status.behind > 0 && <span>{status.behind}&darr;</span>}
          </div>
        )}

        {/* File counts */}
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--dim)' }}>
          {status.staged > 0 && (
            <span style={{ color: '#3fb950' }}>{status.staged} staged</span>
          )}
          {status.modified > 0 && (
            <span style={{ color: '#d29922' }}>{status.modified} modified</span>
          )}
          {status.untracked > 0 && (
            <span>{status.untracked} untracked</span>
          )}
        </div>
      </div>

      <button
        onClick={onRefresh}
        className="p-1 rounded transition-colors duration-150 hover:opacity-80"
        title="Refresh"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      </button>
    </div>
  );
}
