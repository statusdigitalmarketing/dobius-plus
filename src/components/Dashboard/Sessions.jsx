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

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--accent)' }}>Sessions</h2>
        <input
          type="text"
          placeholder="Filter..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          className="px-2 py-1 text-xs rounded outline-none"
          style={{ backgroundColor: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)' }}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ color: 'var(--dim)' }}>
              <th className="text-left p-2 cursor-pointer" onClick={() => setSortBy('project')}>Project</th>
              <th className="text-left p-2 cursor-pointer" onClick={() => setSortBy('display')}>Description</th>
              <th className="text-left p-2 cursor-pointer" onClick={() => setSortBy('timestamp')}>Time</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr
                key={s.sessionId}
                className="hover:opacity-80"
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <td className="p-2" style={{ color: 'var(--accent)' }}>
                  {s.project?.split('/').filter(Boolean).pop() || 'Unknown'}
                </td>
                <td className="p-2 truncate max-w-xs" style={{ color: 'var(--fg)' }}>
                  {s.display || 'Untitled'}
                </td>
                <td className="p-2 whitespace-nowrap" style={{ color: 'var(--dim)' }}>
                  {timeAgo(s.timestamp)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="p-4 text-center text-sm" style={{ color: 'var(--dim)' }}>
            {filterText ? 'No matching sessions' : 'No sessions found'}
          </div>
        )}
      </div>
    </div>
  );
}
