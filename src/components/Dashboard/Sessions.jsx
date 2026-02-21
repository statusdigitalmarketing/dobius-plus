import { useState } from 'react';
import { useStore } from '../../store/store';
import { timeAgo } from '../../lib/time-ago';

export default function Sessions() {
  const sessions = useStore((s) => s.sessions);
  const [sortBy, setSortBy] = useState('timestamp');
  const [filterText, setFilterText] = useState('');

  const filtered = filterText
    ? sessions.filter((s) =>
        s.display?.toLowerCase().includes(filterText.toLowerCase()) ||
        s.project?.toLowerCase().includes(filterText.toLowerCase())
      )
    : sessions;

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'timestamp') return (b.timestamp || 0) - (a.timestamp || 0);
    if (sortBy === 'project') return (a.project || '').localeCompare(b.project || '');
    if (sortBy === 'display') return (a.display || '').localeCompare(b.display || '');
    return 0;
  });

  const SortHeader = ({ id, children }) => (
    <th
      className="text-left px-3 py-2 font-medium cursor-pointer select-none transition-colors duration-100"
      style={{ color: sortBy === id ? 'var(--fg)' : 'var(--dim)' }}
      onClick={() => setSortBy(id)}
    >
      {children}
      {sortBy === id && <span className="ml-1">↓</span>}
    </th>
  );

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
          Sessions
        </h3>
        <input
          type="text"
          placeholder="Filter..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          className="px-2 py-1 text-xs rounded outline-none transition-all duration-150"
          style={{
            backgroundColor: 'var(--surface)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="p-4 text-center text-xs" style={{ color: 'var(--dim)' }}>
            {filterText ? 'No matching sessions' : 'No sessions found'}
          </div>
        ) : (
          <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ backgroundColor: 'var(--surface)' }}>
                  <SortHeader id="project">Project</SortHeader>
                  <SortHeader id="display">Description</SortHeader>
                  <SortHeader id="timestamp">Time</SortHeader>
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => (
                  <tr
                    key={s.sessionId}
                    className="transition-colors duration-100"
                    style={{ borderTop: '1px solid var(--border)' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--surface-hover)'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    <td className="px-3 py-2" style={{ color: 'var(--fg)' }}>
                      {s.project?.split('/').filter(Boolean).pop() || 'Unknown'}
                    </td>
                    <td className="px-3 py-2 truncate max-w-xs" style={{ color: 'var(--dim)' }}>
                      {s.display || 'Untitled'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                      {timeAgo(s.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
