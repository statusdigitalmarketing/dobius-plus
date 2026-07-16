import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';
import { timeAgo } from '../../lib/time-ago';
import { STATUS_COLORS, STATUS_LABELS } from '../../lib/status-colors';

const SESSION_CAP = 500; // mirrors loadAllSessions() — surface when we hit it

function StatusDot({ status, size = 7 }) {
  const st = STATUS_COLORS[status] ? status : 'done';
  return (
    <span
      title={STATUS_LABELS[st]}
      className={st === 'needs' ? 'dobius-status-pulse' : undefined}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: STATUS_COLORS[st],
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [tags, setTags] = useState({});
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState({});
  const [searchText, setSearchText] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [sortBy, setSortBy] = useState('recent'); // 'recent' | 'alpha'

  const loadData = useCallback(async () => {
    if (!window.electronAPI?.dataLoadAllSessions) return;
    try {
      const [allSessions, sessionTags] = await Promise.all([
        window.electronAPI.dataLoadAllSessions(),
        window.electronAPI.configGetSessionTags?.() || {},
      ]);
      setSessions(allSessions || []);
      setTags(sessionTags || {});
    } catch {
      setSessions([]);
      setTags({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    // Live refresh: re-scan whenever the watcher reports session/history
    // activity. Debounced 500ms — during an active Claude session the
    // transcript flushes every few seconds, and a 6k-file scan even with
    // v1.0.23's bounded readTail isn't free to fire back-to-back.
    let timer = null;
    const remove = window.electronAPI?.onDataUpdated?.(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; loadData(); }, 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      remove?.();
    };
  }, [loadData]);

  // Filter sessions
  const searchLower = searchText.toLowerCase();
  const filtered = sessions.filter((s) => {
    if (projectFilter && s.projectName !== projectFilter) return false;
    if (searchText) {
      const tag = tags[s.sessionId];
      const matchesSearch =
        (s.projectName || '').toLowerCase().includes(searchLower) ||
        (s.preview || '').toLowerCase().includes(searchLower) ||
        (tag?.label || '').toLowerCase().includes(searchLower);
      if (!matchesSearch) return false;
    }
    return true;
  });

  // Get all unique project names for the filter dropdown
  const allProjectNames = [...new Set(sessions.map((s) => s.projectName || 'Unknown'))].sort();

  // Group filtered sessions by projectName
  const groups = {};
  for (const s of filtered) {
    const key = s.projectName || 'Unknown';
    if (!groups[key]) {
      groups[key] = { projectName: key, projectPath: s.projectPath, sessions: [], latestTimestamp: 0 };
    }
    groups[key].sessions.push(s);
    if (s.timestamp > groups[key].latestTimestamp) {
      groups[key].latestTimestamp = s.timestamp;
    }
  }

  // Sort groups
  const sortedGroups = Object.values(groups).sort(
    sortBy === 'alpha'
      ? (a, b) => a.projectName.localeCompare(b.projectName)
      : (a, b) => b.latestTimestamp - a.latestTimestamp
  );

  // Sort sessions within each group by recency
  for (const group of sortedGroups) {
    group.sessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  const toggleCollapsed = (projectName) => {
    setCollapsed((prev) => ({ ...prev, [projectName]: !prev[projectName] }));
  };

  const totalSessions = filtered.length;
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
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--fg)', letterSpacing: '0.1em' }}>
          Sessions
        </h2>
        <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
          {totalSessions} session{totalSessions !== 1 ? 's' : ''} across {totalProjects} project{totalProjects !== 1 ? 's' : ''}
          {sessions.length >= SESSION_CAP && (
            <span style={{ color: STATUS_COLORS.working, marginLeft: 6 }} title={`Showing the ${SESSION_CAP} most recent sessions; older ones are not listed.`}>
              (showing newest {SESSION_CAP})
            </span>
          )}
        </span>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 mb-4">
        <input
          type="text"
          placeholder="Search sessions..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="flex-1 px-2.5 py-1.5 text-xs rounded outline-none transition-all duration-150"
          style={{
            backgroundColor: 'var(--surface)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            fontFamily: "'SF Mono', monospace",
          }}
        />
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="px-2 py-1.5 text-xs rounded outline-none cursor-pointer"
          style={{
            backgroundColor: 'var(--surface)',
            color: projectFilter ? 'var(--fg)' : 'var(--dim)',
            border: '1px solid var(--border)',
            fontFamily: "'SF Mono', monospace",
            maxWidth: 160,
          }}
        >
          <option value="">All projects</option>
          {allProjectNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <button
          onClick={() => setSortBy((prev) => prev === 'recent' ? 'alpha' : 'recent')}
          className="px-2 py-1.5 text-xs rounded transition-colors duration-100 shrink-0"
          style={{
            backgroundColor: 'var(--surface)',
            color: 'var(--dim)',
            border: '1px solid var(--border)',
            fontFamily: "'SF Mono', monospace",
            cursor: 'pointer',
          }}
          title={sortBy === 'recent' ? 'Sorted by recent' : 'Sorted A-Z'}
        >
          {sortBy === 'recent' ? 'Recent' : 'A-Z'}
        </button>
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
                {/* Status rollup — surfaces "needs you" / "working" counts per project */}
                {(() => {
                  const needs = group.sessions.filter((s) => s.status === 'needs').length;
                  const working = group.sessions.filter((s) => s.status === 'working').length;
                  return (
                    <span className="flex items-center gap-1.5 ml-1">
                      {needs > 0 && (
                        <span className="flex items-center gap-1" title={`${needs} session${needs !== 1 ? 's' : ''} need your response`}>
                          <StatusDot status="needs" size={6} />
                          <span style={{ color: STATUS_COLORS.needs, fontSize: 10, fontFamily: "'SF Mono', monospace" }}>{needs}</span>
                        </span>
                      )}
                      {working > 0 && (
                        <span className="flex items-center gap-1" title={`${working} session${working !== 1 ? 's' : ''} working`}>
                          <StatusDot status="working" size={6} />
                          <span style={{ color: STATUS_COLORS.working, fontSize: 10, fontFamily: "'SF Mono', monospace" }}>{working}</span>
                        </span>
                      )}
                    </span>
                  );
                })()}
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
                        onTagsChanged={loadData}
                        onDeleted={(id) => setSessions((prev) => prev.filter((p) => p.sessionId !== id))}
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

const TAG_COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];

function SessionCard({ session, tag, onTagsChanged, onDeleted }) {
  const resumeSession = useStore((s) => s.resumeSession);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const [editing, setEditing] = useState(false);
  const [tagLabel, setTagLabel] = useState(tag?.label || '');
  const [tagColor, setTagColor] = useState(tag?.color || 'blue');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      // Auto-cancel confirm after 3s if user doesn't click again
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setDeleting(true);
    try {
      await window.electronAPI?.dataDeleteSession(session.sessionId, session.projectPath);
      onDeleted?.(session.sessionId);
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const isDifferentProject = currentProjectPath && session.projectPath !== currentProjectPath;

  const handleSaveTag = async () => {
    if (!tagLabel.trim()) return;
    try {
      await window.electronAPI?.configSetSessionTag(session.sessionId, tagLabel.trim(), tagColor);
      setEditing(false);
      onTagsChanged?.();
    } catch (_) {
      // IPC failure — tag not saved, editor stays open for retry
    }
  };

  const handleRemoveTag = async () => {
    try {
      await window.electronAPI?.configRemoveSessionTag(session.sessionId);
      setEditing(false);
      setTagLabel('');
      setTagColor('blue');
      onTagsChanged?.();
    } catch (_) {
      // IPC failure — tag not removed
    }
  };

  const handleTagClick = () => {
    setTagLabel(tag?.label || '');
    setTagColor(tag?.color || 'blue');
    setEditing(true);
  };

  return (
    <div
      className="px-3 py-2.5 rounded transition-colors duration-100"
      style={{
        backgroundColor: 'var(--surface)',
        border: `1px solid ${confirmDelete ? '#f85149' : 'var(--border)'}`,
        opacity: deleting ? 0.4 : 1,
        transition: 'opacity 0.2s, border-color 0.15s',
      }}
      onMouseEnter={(e) => { if (!confirmDelete) e.currentTarget.style.borderColor = 'var(--dim)'; }}
      onMouseLeave={(e) => { if (!confirmDelete) e.currentTarget.style.borderColor = 'var(--border)'; }}
    >
      <div className="flex items-center gap-3">
        {/* Status dot — green = done, yellow = working, red = needs your response */}
        <StatusDot status={session.status} />
        {/* Preview text */}
        <div className="flex-1 min-w-0">
          <div className="text-xs truncate" style={{ color: 'var(--fg)' }}>
            {session.preview || 'No preview'}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: 10 }}>
              {timeAgo(session.timestamp)}
            </span>
            {tag && !editing && (
              <span onClick={handleTagClick} style={{ cursor: 'pointer' }}>
                <TagBadge label={tag.label} color={tag.color} />
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <CardBtn
            label="Resume"
            onClick={() => resumeSession({ sessionId: session.sessionId, projectPath: session.projectPath })}
            accent
          />
          {isDifferentProject && (
            <CardBtn
              label="Open"
              onClick={() => window.electronAPI?.windowOpenProject(session.projectPath)}
            />
          )}
          <CardBtn label="Tag" onClick={handleTagClick} />
        </div>

        {/* Session ID */}
        <span
          className="text-xs shrink-0 select-all"
          style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: 9, opacity: 0.5 }}
          title={session.sessionId}
        >
          {session.sessionId.slice(0, 8)}
        </span>

        {/* Delete X */}
        <button
          onClick={handleDelete}
          title={confirmDelete ? 'Click again to confirm delete' : 'Delete session'}
          className="shrink-0 flex items-center justify-center w-5 h-5 rounded transition-all duration-150"
          style={{
            color: confirmDelete ? '#f85149' : 'var(--dim)',
            backgroundColor: confirmDelete ? 'rgba(248,81,73,0.12)' : 'transparent',
            border: confirmDelete ? '1px solid rgba(248,81,73,0.4)' : '1px solid transparent',
            fontSize: confirmDelete ? 9 : 11,
            fontFamily: "'SF Mono', monospace",
            cursor: 'pointer',
            lineHeight: 1,
          }}
          onMouseEnter={(e) => {
            if (!confirmDelete) {
              e.currentTarget.style.color = '#f85149';
              e.currentTarget.style.borderColor = 'rgba(248,81,73,0.3)';
            }
          }}
          onMouseLeave={(e) => {
            if (!confirmDelete) {
              e.currentTarget.style.color = 'var(--dim)';
              e.currentTarget.style.borderColor = 'transparent';
            }
          }}
        >
          {confirmDelete ? 'del?' : '×'}
        </button>
      </div>

      {/* Inline tag editor */}
      {editing && (
        <div className="flex items-center gap-2 mt-2 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
          <input
            autoFocus
            type="text"
            placeholder="Tag label..."
            value={tagLabel}
            onChange={(e) => setTagLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveTag();
              if (e.key === 'Escape') setEditing(false);
            }}
            className="flex-1 px-2 py-1 text-xs rounded outline-none"
            style={{
              backgroundColor: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              fontFamily: "'SF Mono', monospace",
            }}
          />
          <div className="flex items-center gap-1">
            {TAG_COLOR_NAMES.map((c) => (
              <button
                key={c}
                onClick={() => setTagColor(c)}
                className="rounded-full transition-transform duration-100"
                style={{
                  width: 14,
                  height: 14,
                  backgroundColor: TAG_COLORS[c],
                  border: tagColor === c ? '2px solid var(--fg)' : '2px solid transparent',
                  cursor: 'pointer',
                  transform: tagColor === c ? 'scale(1.2)' : 'scale(1)',
                }}
              />
            ))}
          </div>
          <button
            onClick={handleSaveTag}
            disabled={!tagLabel.trim()}
            className="text-xs px-2 py-1 rounded"
            style={{
              backgroundColor: tagLabel.trim() ? 'var(--accent)' : 'var(--border)',
              color: tagLabel.trim() ? 'var(--bg)' : 'var(--dim)',
              border: 'none',
              cursor: tagLabel.trim() ? 'pointer' : 'default',
              fontFamily: "'SF Mono', monospace",
              fontSize: 10,
            }}
          >
            Save
          </button>
          {tag && (
            <button
              onClick={handleRemoveTag}
              className="text-xs px-2 py-1 rounded"
              style={{
                backgroundColor: 'transparent',
                color: '#F85149',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                fontFamily: "'SF Mono', monospace",
                fontSize: 10,
              }}
            >
              Remove
            </button>
          )}
          <button
            onClick={() => setEditing(false)}
            className="text-xs"
            style={{ color: 'var(--dim)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}
          >
            x
          </button>
        </div>
      )}
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

function CardBtn({ label, onClick, accent }) {
  return (
    <button
      onClick={onClick}
      className="text-xs shrink-0 transition-colors duration-100"
      style={{
        padding: '2px 6px',
        fontFamily: "'SF Mono', monospace",
        fontSize: 9,
        color: accent ? 'var(--bg)' : 'var(--dim)',
        backgroundColor: accent ? 'var(--accent)' : 'transparent',
        border: accent ? 'none' : '1px solid var(--border)',
        borderRadius: 3,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!accent) {
          e.currentTarget.style.borderColor = 'var(--dim)';
          e.currentTarget.style.color = 'var(--fg)';
        }
      }}
      onMouseLeave={(e) => {
        if (!accent) {
          e.currentTarget.style.borderColor = 'var(--border)';
          e.currentTarget.style.color = 'var(--dim)';
        }
      }}
    >
      {label}
    </button>
  );
}

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
