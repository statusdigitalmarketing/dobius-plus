import { timeAgo } from '../../../lib/time-ago';

const STATE_COLORS = {
  OPEN: '#3fb950',
  CLOSED: '#f85149',
  MERGED: '#a371f7',
};

export default function PullRequests({ pullRequests, ghAvailable }) {
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

  if (!pullRequests.length) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-xs" style={{ color: 'var(--dim)' }}>No open pull requests</p>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
      {pullRequests.map((pr) => {
        const state = pr.state || 'OPEN';
        const checks = pr.statusCheckRollup || [];
        const passing = checks.filter((c) => c.conclusion === 'SUCCESS').length;
        const total = checks.length;

        return (
          <div
            key={pr.number}
            className="px-4 py-3 flex items-start gap-3"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            {/* State badge */}
            <span
              className="text-xs px-1.5 py-0.5 rounded shrink-0 mt-0.5"
              style={{
                backgroundColor: STATE_COLORS[state] + '22',
                color: STATE_COLORS[state],
                fontWeight: 500,
              }}
            >
              {state}
            </span>

            <div className="min-w-0 flex-1">
              <p className="text-xs" style={{ color: 'var(--fg)' }}>
                <span style={{ color: 'var(--dim)' }}>#{pr.number}</span>{' '}
                {pr.title}
              </p>
              <div className="flex items-center gap-2 mt-1 text-xs" style={{ color: 'var(--dim)' }}>
                <span>{pr.author?.login || 'unknown'}</span>
                <span>&middot;</span>
                <span
                  style={{ fontFamily: "'SF Mono', monospace" }}
                >
                  {pr.headRefName}
                </span>
                {total > 0 && (
                  <>
                    <span>&middot;</span>
                    <span style={{ color: passing === total ? '#3fb950' : '#d29922' }}>
                      {passing}/{total} checks
                    </span>
                  </>
                )}
                <span>&middot;</span>
                <span>{timeAgo(new Date(pr.createdAt).getTime())}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
