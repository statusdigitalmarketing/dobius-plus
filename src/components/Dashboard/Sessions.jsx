import { useState, useEffect, useCallback } from 'react';
import { timeAgo } from '../../lib/time-ago';

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [tags, setTags] = useState({});
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});

  const loadData = useCallback(async () => {
    if (!window.electronAPI?.dataLoadAllSessions) return;
    const [allSessions, sessionTags] = await Promise.all([
      window.electronAPI.dataLoadAllSessions(),
      window.electronAPI.configGetSessionTags?.() || {},
    ]);
    setSessions(allSessions || []);
    setTags(sessionTags || {});
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Group sessions by projectName
  const groups = {};
  for (const s of sessions) {
    const key = s.projectName || 'Unknown';
    if (!groups[key]) {
      groups[key] = { projectName: key, projectPath: s.projectPath, sessions: [], latestTimestamp: 0 };
    }
    groups[key].sessions.push(s);
    if (s.timestamp > groups[key].latestTimestamp) {
      groups[key].latestTimestamp = s.timestamp;
    }
  }

  // Sort groups by most recent session
  const sortedGroups = Object.values(groups).sort(
    (a, b) => b.latestTimestamp - a.latestTimestamp
  );

  // Sort sessions within each group by recency
  for (const group of sortedGroups) {
    group.sessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  const toggleCollapsed = (projectName) => {
    setCollapsed((prev) => ({ ...prev, [projectName]: !prev[projectName] }));
  };

  const totalSessions = sessions.length;
  const totalProjects = sortedGroups.length;

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <div className="h-5 w-40 rounded animate-pulse" style={{ backgroundColor: 'var(--border)' }} />
            <div className="space-y-1.5">
              {[1, 2].map((j) => (
                <div key={j} className="h-14 rounded animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="p-6 h-full flex flex-col max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--fg)', letterSpacing: '0.1em' }}>
          Sessions
        </h2>
        <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
          {totalSessions} session{totalSessions !== 1 ? 's' : ''} across {totalProjects} project{totalProjects !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto space-y-4">
        {sortedGroups.length === 0 ? (
          <div className="text-center py-12" style={{ color: 'var(--dim)' }}>
            <div className="text-2xl mb-2" style={{ opacity: 0.3 }}>&#x1F4AC;</div>
            <div className="text-xs">No Claude sessions found</div>
            <div className="text-xs mt-1" style={{ fontSize: 10 }}>
              Start using Claude Code in a project directory to see sessions here
            </div>
          </div>
        ) : (
          sortedGroups.map((group) => (
            <div key={group.projectName}>
              {/* Project group header */}
              <button
                onClick={() => toggleCollapsed(group.projectName)}
                className="flex items-center gap-2 w-full text-left mb-1.5 group"
                style={{ padding: '2px 0' }}
              >
                <span
                  className="text-xs transition-transform duration-150"
                  style={{
                    color: 'var(--dim)',
                    transform: collapsed[group.projectName] ? 'rotate(-90deg)' : 'rotate(0deg)',
                    display: 'inline-block',
                  }}
                >
                  &#x25BE;
                </span>
                <span className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
                  {group.projectName}
                </span>
                <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                  ({group.sessions.length})
                </span>
                <span className="text-xs ml-auto" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: 10 }}>
                  {timeAgo(group.latestTimestamp)}
                </span>
              </button>

              {/* Session cards */}
              {!collapsed[group.projectName] && (
                <div className="space-y-1">
                  {group.sessions.map((s) => {
                    const tag = tags[s.sessionId];
                    return (
                      <SessionCard
                        key={s.sessionId}
                        session={s}
                        tag={tag}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SessionCard({ session, tag }) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded transition-colors duration-100"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
      onMouseEnter={(e) => e.currentTarget.style.borderColor = 'var(--dim)'}
      onMouseLeave={(e) => e.currentTarget.style.borderColor = 'var(--border)'}
    >
      {/* Preview text */}
      <div className="flex-1 min-w-0">
        <div className="text-xs truncate" style={{ color: 'var(--fg)' }}>
          {session.preview || 'No preview'}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: 10 }}>
            {timeAgo(session.timestamp)}
          </span>
          {tag && (
            <TagBadge label={tag.label} color={tag.color} />
          )}
        </div>
      </div>

      {/* Session ID (truncated) */}
      <span
        className="text-xs shrink-0 select-all"
        style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: 9, opacity: 0.5 }}
        title={session.sessionId}
      >
        {session.sessionId.slice(0, 8)}
      </span>
    </div>
  );
}

const TAG_COLORS = {
  red: '#F85149',
  orange: '#D29922',
  yellow: '#E3B341',
  green: '#3FB950',
  blue: '#58A6FF',
  purple: '#BC8CFF',
  pink: '#F778BA',
};

function TagBadge({ label, color }) {
  const bg = TAG_COLORS[color] || TAG_COLORS.blue;
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded-full"
      style={{
        backgroundColor: bg + '22',
        color: bg,
        fontSize: 9,
        fontWeight: 500,
        border: `1px solid ${bg}44`,
      }}
    >
      {label}
    </span>
  );
}
