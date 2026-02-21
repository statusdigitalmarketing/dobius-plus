import { useStore } from '../../store/store';
import { useStats } from '../../hooks/useStats';
import { AnimatePresence, motion } from 'framer-motion';
import Overview from './Overview';
import MCPServers from './MCPServers';
import Skills from './Skills';
import Stats from './Stats';
import Sessions from './Sessions';
import Plans from './Plans';
import BuildMonitorView from './BuildMonitor/BuildMonitorView';
import GitView from './Git/GitView';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'stats', label: 'Stats' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'plans', label: 'Plans' },
  { id: 'builds', label: 'Builds' },
  { id: 'git', label: 'Git' },
];

const TAB_CONTENT = {
  overview: (props) => <Overview {...props} />,
  mcp: (props) => <MCPServers settings={props.settings} bridgeServers={props.bridgeServers} />,
  skills: (props) => <Skills skills={props.skills} />,
  stats: (props) => <Stats stats={props.stats} />,
  sessions: () => <Sessions />,
  plans: (props) => <Plans plans={props.plans} />,
  builds: () => <BuildMonitorView />,
  git: () => <GitView />,
};

export default function DashboardView() {
  const dashboardTab = useStore((s) => s.dashboardTab);
  const setDashboardTab = useStore((s) => s.setDashboardTab);
  const buildComplete = useStore((s) => s.buildComplete);
  const { stats, settings, bridgeServers, plans, skills, loading } = useStats();

  if (loading) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-1 px-4 py-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          {TABS.map((tab) => (
            <div key={tab.id} className="px-3 py-1.5">
              <div className="h-3 w-10 rounded animate-pulse" style={{ backgroundColor: 'var(--border)' }} />
            </div>
          ))}
        </div>
        <div className="flex-1 p-4">
          <div className="grid grid-cols-4 gap-3 mb-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="p-3 rounded animate-pulse" style={{ backgroundColor: 'var(--surface)' }}>
                <div className="h-2.5 w-16 rounded mb-2" style={{ backgroundColor: 'var(--border)' }} />
                <div className="h-5 w-12 rounded" style={{ backgroundColor: 'var(--border)' }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const renderTab = TAB_CONTENT[dashboardTab];

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <div
        className="flex items-center gap-0.5 px-4 shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setDashboardTab(tab.id)}
            className="relative px-3 py-2.5 text-xs transition-colors duration-150"
            style={{
              color: dashboardTab === tab.id ? 'var(--fg)' : 'var(--dim)',
              fontWeight: dashboardTab === tab.id ? 500 : 400,
            }}
          >
            {tab.label}
            {tab.id === 'builds' && buildComplete && dashboardTab !== 'builds' && (
              <span
                className="absolute top-1.5 right-1 w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: 'var(--accent)' }}
              />
            )}
            {dashboardTab === tab.id && (
              <span
                className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 rounded-full"
                style={{ width: '70%', backgroundColor: 'var(--accent)' }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={dashboardTab}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            className="h-full"
          >
            {renderTab && renderTab({ stats, settings, bridgeServers, plans, skills })}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
