import { useMemo } from 'react';
import { useStore } from '../../store/store';

export default function Overview({ stats, settings }) {
  const sessions = useStore((s) => s.sessions);
  const activeProcesses = useStore((s) => s.activeProcesses);

  const dailyActivity = stats?.dailyActivity;
  const { totalMessages, totalSessions, totalTools } = useMemo(() => {
    if (!dailyActivity) return { totalMessages: 0, totalSessions: 0, totalTools: 0 };
    let msgs = 0, sess = 0, tools = 0;
    for (const d of dailyActivity) {
      msgs += d.messageCount || 0;
      sess += d.sessionCount || 0;
      tools += d.toolCallCount || 0;
    }
    return { totalMessages: msgs, totalSessions: sess, totalTools: tools };
  }, [dailyActivity]);

  return (
    <div className="p-4 space-y-5">
      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Sessions" value={totalSessions.toLocaleString()} />
        <StatCard label="Messages" value={totalMessages.toLocaleString()} />
        <StatCard label="Tool Calls" value={totalTools.toLocaleString()} />
        <StatCard label="Recent" value={sessions.length} />
      </div>

      {/* Active processes */}
      <div>
        <h3 className="text-xs font-medium mb-2 uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
          Active Processes
        </h3>
        {activeProcesses.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--dim)' }}>No active Claude processes</div>
        ) : (
          <div
            className="rounded overflow-hidden"
            style={{ border: '1px solid var(--border)' }}
          >
            <table className="w-full text-xs">
              <thead>
                <tr style={{ backgroundColor: 'var(--surface)' }}>
                  <th className="text-left px-3 py-1.5 font-medium" style={{ color: 'var(--dim)' }}>PID</th>
                  <th className="text-left px-3 py-1.5 font-medium" style={{ color: 'var(--dim)' }}>Command</th>
                </tr>
              </thead>
              <tbody>
                {activeProcesses.map((p, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                    <td
                      className="px-3 py-1.5"
                      style={{ color: 'var(--accent)', fontFamily: "'SF Mono', monospace" }}
                    >
                      {p.pid}
                    </td>
                    <td
                      className="px-3 py-1.5 truncate max-w-md"
                      style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}
                    >
                      {p.command}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* MCP + Plugins summary */}
      {settings && (
        <div className="grid grid-cols-2 gap-3">
          <SummaryCard label="MCP Servers" value={Object.keys(settings.mcpServers || {}).length} />
          <SummaryCard label="Plugins" value={(settings.enabledPlugins || []).length} />
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div
      className="p-3 rounded-lg"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="text-xs" style={{ color: 'var(--dim)' }}>{label}</div>
      <div
        className="text-xl font-bold mt-1"
        style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}
      >
        {value}
      </div>
    </div>
  );
}

function SummaryCard({ label, value }) {
  return (
    <div
      className="p-3 rounded-lg flex items-center justify-between"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <span className="text-xs" style={{ color: 'var(--dim)' }}>{label}</span>
      <span
        className="text-sm font-semibold"
        style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}
      >
        {value}
      </span>
    </div>
  );
}
