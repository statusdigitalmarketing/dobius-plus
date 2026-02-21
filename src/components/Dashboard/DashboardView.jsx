import { useStore } from '../../store/store';
import { useStats } from '../../hooks/useStats';
import Overview from './Overview';
import MCPServers from './MCPServers';
import Skills from './Skills';
import Stats from './Stats';
import Sessions from './Sessions';
import Plans from './Plans';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'skills', label: 'Skills' },
  { id: 'stats', label: 'Stats' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'plans', label: 'Plans' },
];

export default function DashboardView() {
  const dashboardTab = useStore((s) => s.dashboardTab);
  const setDashboardTab = useStore((s) => s.setDashboardTab);
  const { stats, settings, plans, skills, loading } = useStats();

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center" style={{ color: 'var(--dim)' }}>
        Loading dashboard...
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div
        className="flex items-center gap-1 px-4 py-2 shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setDashboardTab(tab.id)}
            className="px-3 py-1.5 text-xs rounded transition-colors"
            style={{
              color: dashboardTab === tab.id ? 'var(--accent)' : 'var(--dim)',
              backgroundColor: dashboardTab === tab.id ? 'var(--surface)' : 'transparent',
              fontWeight: dashboardTab === tab.id ? 600 : 400,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {dashboardTab === 'overview' && <Overview stats={stats} settings={settings} />}
        {dashboardTab === 'mcp' && <MCPServers settings={settings} />}
        {dashboardTab === 'skills' && <Skills skills={skills} />}
        {dashboardTab === 'stats' && <Stats stats={stats} />}
        {dashboardTab === 'sessions' && <Sessions />}
        {dashboardTab === 'plans' && <Plans plans={plans} />}
      </div>
    </div>
  );
}
