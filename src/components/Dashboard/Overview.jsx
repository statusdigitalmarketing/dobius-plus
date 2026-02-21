import { useStore } from '../../store/store';

export default function Overview({ stats, settings }) {
  const sessions = useStore((s) => s.sessions);
  const activeProcesses = useStore((s) => s.activeProcesses);

  const totalMessages = stats?.dailyActivity?.reduce((sum, d) => sum + (d.messageCount || 0), 0) || 0;
  const totalSessions = stats?.dailyActivity?.reduce((sum, d) => sum + (d.sessionCount || 0), 0) || 0;
  const totalTools = stats?.dailyActivity?.reduce((sum, d) => sum + (d.toolCallCount || 0), 0) || 0;

  return (
    <div className="p-4 space-y-4">
      <h2 className="text-lg font-semibold" style={{ color: 'var(--accent)' }}>Overview</h2>

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Total Sessions" value={totalSessions.toLocaleString()} />
        <StatCard label="Messages" value={totalMessages.toLocaleString()} />
        <StatCard label="Tool Calls" value={totalTools.toLocaleString()} />
        <StatCard label="Recent Sessions" value={sessions.length} />
      </div>

      {/* Active processes */}
      <div>
        <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--fg)' }}>Active Processes</h3>
        {activeProcesses.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--dim)' }}>No active Claude processes</div>
        ) : (
          <div className="space-y-1">
            {activeProcesses.map((p, i) => (
              <div key={i} className="text-xs p-2 rounded" style={{ backgroundColor: 'var(--surface)' }}>
                <span style={{ color: '#3FB950' }}>PID {p.pid}</span>
                <span className="ml-2" style={{ color: 'var(--dim)' }}>{p.command}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MCP + Plugins summary */}
      {settings && (
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded" style={{ backgroundColor: 'var(--surface)' }}>
            <div className="text-xs" style={{ color: 'var(--dim)' }}>MCP Servers</div>
            <div className="text-lg font-semibold" style={{ color: 'var(--fg)' }}>
              {Object.keys(settings.mcpServers || {}).length}
            </div>
          </div>
          <div className="p-3 rounded" style={{ backgroundColor: 'var(--surface)' }}>
            <div className="text-xs" style={{ color: 'var(--dim)' }}>Plugins</div>
            <div className="text-lg font-semibold" style={{ color: 'var(--fg)' }}>
              {(settings.enabledPlugins || []).length}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="p-3 rounded" style={{ backgroundColor: 'var(--surface)' }}>
      <div className="text-xs" style={{ color: 'var(--dim)' }}>{label}</div>
      <div className="text-xl font-bold mt-1" style={{ color: 'var(--fg)' }}>{value}</div>
    </div>
  );
}
