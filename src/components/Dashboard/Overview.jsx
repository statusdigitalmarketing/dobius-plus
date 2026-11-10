import { useMemo, useState } from 'react';
import { useStore } from '../../store/store';

export default function Overview({ stats, settings, sessionCount }) {
  const activeProcesses = useStore((s) => s.activeProcesses);
  const setActiveProcesses = useStore((s) => s.setActiveProcesses);

  const dailyActivity = stats?.dailyActivity;
  // Sessions is the Sessions page's own count (sessionCount, from DashboardView), so the card and the "Sessions (N)"
  // nav label always agree. Summing dailyActivity's per-day counts gave a third number that counted a session once
  // for every day it ran in (Max, Windows 2.2.17 pass: 12 here, 26 in the nav, 7 in the status bar).
  const { totalMessages, totalTools, todaySessions } = useMemo(() => {
    if (!dailyActivity) return { totalMessages: 0, totalTools: 0, todaySessions: 0 };
    let msgs = 0, tools = 0;
    for (const d of dailyActivity) {
      msgs += d.messageCount || 0;
      tools += d.toolCallCount || 0;
    }
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const t = dailyActivity.find((d) => d.date === today);
    return { totalMessages: msgs, totalTools: tools, todaySessions: t?.sessionCount || 0 };
  }, [dailyActivity]);

  return (
    <div className="p-4 space-y-5">
      {/* Quick stats. Tool-call totals only exist in the CLI's stats-cache, which
          current Claude Code no longer writes; when stats are history-derived we
          show a real Projects count instead of a misleading 0. */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Sessions" value={sessionCount == null ? '...' : sessionCount.toLocaleString()} />
        <StatCard label="Messages" value={totalMessages.toLocaleString()} />
        {stats?.derived ? (
          <StatCard label="Projects" value={(stats?.projectCount || 0).toLocaleString()} />
        ) : (
          <StatCard label="Tool Calls" value={totalTools.toLocaleString()} />
        )}
        <StatCard label="Sessions today" value={todaySessions.toLocaleString()} />
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
            className="rounded overflow-x-auto"
            style={{ border: '1px solid var(--border)' }}
          >
            {/* Fixed layout: the command cell truncates to whatever width is
                left, so the kill buttons stay on screen in a narrow window. */}
            <table className="w-full text-xs table-fixed">
              <colgroup>
                <col style={{ width: 88 }} />
                <col />
                <col style={{ width: 76 }} />
              </colgroup>
              <thead>
                <tr style={{ backgroundColor: 'var(--surface)' }}>
                  <th className="text-left px-3 py-1.5 font-medium" style={{ color: 'var(--dim)' }}>PID</th>
                  <th className="text-left px-3 py-1.5 font-medium" style={{ color: 'var(--dim)' }}>Command</th>
                  <th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {activeProcesses.map((p) => (
                  <ProcessRow
                    key={p.pid}
                    process={p}
                    onKilled={() => setActiveProcesses(activeProcesses.filter((x) => x.pid !== p.pid))}
                  />
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

function ProcessRow({ process: p, onKilled }) {
  const [confirm, setConfirm] = useState(false);
  const [killing, setKilling] = useState(false);

  const handleKill = async () => {
    if (!confirm) {
      setConfirm(true);
      setTimeout(() => setConfirm(false), 3000);
      return;
    }
    setKilling(true);
    try {
      await window.electronAPI?.dataKillProcess(p.pid);
      onKilled();
    } catch {
      setKilling(false);
      setConfirm(false);
    }
  };

  return (
    <tr
      style={{
        borderTop: '1px solid var(--border)',
        opacity: killing ? 0.4 : 1,
        transition: 'opacity 0.2s',
        backgroundColor: confirm ? 'rgba(248,81,73,0.05)' : 'transparent',
      }}
    >
      <td className="px-3 py-1.5" style={{ color: 'var(--accent)', fontFamily: "'SF Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p.pid}
      </td>
      <td className="px-3 py-1.5" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.command}>
        {p.command}
      </td>
      <td className="px-3 py-1.5 text-right">
        {/* Only a Claude running in a Dobius tab can be killed here. Others (the Claude desktop app's own, a session
            in another terminal) belong to something else, and main refuses them anyway. */}
        {!p.owned ? (
          <span title="Not started by Dobius+, so it can't be stopped from here" style={{ fontSize: 9, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
            outside
          </span>
        ) : (
        <button
          onClick={handleKill}
          title={confirm ? 'Click again to send SIGTERM' : 'Kill process'}
          style={{
            padding: '2px 7px',
            fontSize: 9,
            fontFamily: "'SF Mono', monospace",
            borderRadius: 3,
            cursor: 'pointer',
            border: `1px solid ${confirm ? 'rgba(248,81,73,0.5)' : 'var(--border)'}`,
            backgroundColor: confirm ? 'rgba(248,81,73,0.12)' : 'transparent',
            color: confirm ? '#f85149' : 'var(--dim)',
            transition: 'all 0.15s',
            whiteSpace: 'nowrap',
          }}
          onMouseEnter={(e) => { if (!confirm) { e.currentTarget.style.color = '#f85149'; e.currentTarget.style.borderColor = 'rgba(248,81,73,0.4)'; } }}
          onMouseLeave={(e) => { if (!confirm) { e.currentTarget.style.color = 'var(--dim)'; e.currentTarget.style.borderColor = 'var(--border)'; } }}
        >
          {confirm ? 'kill?' : '× kill'}
        </button>
        )}
      </td>
    </tr>
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
