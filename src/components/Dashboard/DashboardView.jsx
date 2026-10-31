import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { useStore } from '../../store/store';
import { useStats } from '../../hooks/useStats';
import { SHOW_AUTOMATED_EVENT } from '../../hooks/useSessions';
import { AnimatePresence, motion } from 'framer-motion';
import Overview from './Overview';
import MCPServers from './MCPServers';
import Skills from './Skills';
// Lazy: Stats is the only recharts consumer, and recharts is ~475KB minified.
// Splitting it keeps every window's initial bundle (launcher included) light;
// the chunk loads on first visit to the Stats tab.
const Stats = lazy(() => import('./Stats'));
import Sessions from './Sessions';
import LooseEnds from './LooseEnds';
import Plans from './Plans';
import BuildMonitorView from './BuildMonitor/BuildMonitorView';
import GitView from './Git/GitView';
import Checkpoints from './Checkpoints';
import Agents from './Agents';
import ClaudeMdEditor from './ClaudeMdEditor';
import Settings from './Settings';
import BoardView from './Board/BoardView';
import KanbanView from './Kanban/KanbanView';
import OrchestratorView from './Orchestrator/OrchestratorView';
import Updates from './Updates';
import Prompts from './Prompts';
import Notes from './Notes';
import Costs from './Costs';
import ChangeFeed from './ChangeFeed';
import Search from './Search';
import BrowserProfiles from './BrowserProfiles';
import { SETTINGS_SECTIONS, settingsSectionSelector, sectionScrollTop } from '../../lib/settings-sections';

// Wide enough for the longest label plus a count ("Sessions (1234)"), narrow
// enough to leave a 900px window most of its width for the page itself.
const NAV_WIDTH = 152;

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
  { id: 'stats', label: 'Stats' },
  { id: 'costs', label: 'Costs' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'looseends', label: 'Loose Ends' },
  { id: 'search', label: 'Search' },
  { id: 'checkpoints', label: 'Checkpoints' },
  { id: 'plans', label: 'Plans' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'notes', label: 'Notes' },
  { id: 'agents', label: 'Mission Control' },
  { id: 'board', label: 'Board' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'orchestrator', label: 'Orchestrator' },
  { id: 'builds', label: 'Builds' },
  { id: 'git', label: 'Git' },
  { id: 'changes', label: 'Changes' },
  { id: 'browser', label: 'Browser' },
  { id: 'claudemd', label: 'CLAUDE.md' },
  { id: 'updates', label: 'Updates' },
  { id: 'settings', label: 'Settings' },
];

const TAB_CONTENT = {
  overview: (props) => <Overview {...props} />,
  mcp: (props) => <MCPServers settings={props.settings} bridgeServers={props.bridgeServers} />,
  skills: (props) => <Skills skills={props.skills} />,
  stats: (props) => (
    <Suspense fallback={<div className="p-6 text-xs" style={{ color: 'var(--dim)' }}>Loading charts...</div>}>
      <Stats stats={props.stats} />
    </Suspense>
  ),
  costs: () => <Costs />,
  sessions: () => <Sessions />,
  looseends: () => <LooseEnds />,
  search: () => <Search />,
  checkpoints: () => <Checkpoints />,
  agents: () => <Agents />,
  board: () => <BoardView />,
  pipeline: () => <KanbanView />,
  orchestrator: () => <OrchestratorView />,
  plans: (props) => <Plans plans={props.plans} />,
  prompts: () => <Prompts />,
  notes: () => <Notes />,
  builds: () => <BuildMonitorView />,
  git: () => <GitView />,
  changes: () => <ChangeFeed />,
  browser: () => <BrowserProfiles />,
  claudemd: () => <ClaudeMdEditor />,
  updates: () => <Updates />,
  settings: () => <Settings />,
};

export default function DashboardView() {
  const dashboardTab = useStore((s) => s.dashboardTab);
  const setDashboardTab = useStore((s) => s.setDashboardTab);
  const buildComplete = useStore((s) => s.buildComplete);
  const runningAgents = useStore((s) => s.runningAgents);
  const boardNotification = useStore((s) => s.boardNotification);
  const clearBoardNotification = useStore((s) => s.clearBoardNotification);
  const { stats, settings, bridgeServers, plans, skills, loading } = useStats();
  const [sessionCount, setSessionCount] = useState(0);
  const runningCount = Object.keys(runningAgents).length;

  // Keep the selected page visible when the window is too short for the whole
  // side nav. The ref sits on the entry's group, so Settings brings its
  // section list into view with it.
  const activeTabRef = useRef(null);
  const contentRef = useRef(null);
  const jumpSeq = useRef(0);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest' });
    jumpSeq.current++; // a pending section jump belongs to the page it was asked on
  }, [dashboardTab, loading]); // loading: the nav is a skeleton until stats arrive
  useEffect(() => () => { jumpSeq.current++; }, []);

  // Settings renders its sections only after its async settings load (and after
  // the page transition), so wait for the anchor instead of no-oping. Leaving
  // the page cancels the wait; the 30s cap only stops a page that never loads.
  const jumpToSettingsSection = (id) => {
    const mine = ++jumpSeq.current;
    let tries = 0;
    let settles = 0;
    // Only real input means the user took over: scrollTop also moves by itself
    // (clamping while the page animates in), so it cannot tell us.
    let userMoved = false;
    let unlisten = null;
    const stop = () => { unlisten?.(); unlisten = null; };
    const attempt = () => {
      if (mine !== jumpSeq.current || userMoved) { stop(); return; }
      const box = contentRef.current;
      const el = box?.querySelector(settingsSectionSelector(id));
      if (!el) {
        if (++tries < 300) setTimeout(attempt, 100);
        return;
      }
      if (!unlisten) {
        const onUser = () => { userMoved = true; };
        const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
        events.forEach((e) => box.addEventListener(e, onUser, { passive: true }));
        unlisten = () => events.forEach((e) => box.removeEventListener(e, onUser));
      }
      box.scrollTo({
        top: sectionScrollTop({
          scrollTop: box.scrollTop,
          boxTop: box.getBoundingClientRect().top,
          elTop: el.getBoundingClientRect().top,
        }),
        // Instant, not smooth: Settings' sections are still growing as their
        // data loads, and a smooth scroll aims at a target that moves under it.
        behavior: 'auto',
      });
      // Rows that load above the section (accounts, Google accounts) can push
      // it down, and scroll anchoring is off during the page's entrance
      // animation, so re-aim a few times over the next ~1.5s unless the user
      // has wheeled, touched, clicked or typed in the page since.
      if (settles < 4) setTimeout(attempt, [150, 300, 500, 600][settles++]);
      else stop();
    };
    attempt();
  };

  // Clear board notification badge when user switches to Board tab
  useEffect(() => {
    if (dashboardTab === 'board' && boardNotification) {
      clearBoardNotification();
    }
  }, [dashboardTab, boardNotification, clearBoardNotification]);

  // Count what the Sessions page lists: automated runs follow the shared
  // toggle. Only the newest count may land; a toggle beats the initial read.
  useEffect(() => {
    if (!window.electronAPI?.dataLoadAllSessions) return;
    let alive = true;
    let seq = 0;
    let toggled = false;
    let counting = null; // the value the latest count was asked for
    const count = (show) => {
      if (show === counting) return;
      counting = show;
      const mine = ++seq;
      window.electronAPI.dataLoadAllSessions(undefined, { excludeAutomated: !show })
        .then((sessions) => { if (alive && mine === seq) setSessionCount(sessions?.length || 0); })
        .catch((err) => console.warn('[DashboardView] session count failed:', err?.message));
    };
    Promise.resolve(window.electronAPI.configGetSettings?.())
      .catch(() => ({}))
      .then((s) => { if (alive && !toggled) count(s?.showAutomatedSessions === true); });
    const onChange = (e) => {
      if (typeof e.detail !== 'boolean') return;
      toggled = true;
      count(e.detail);
    };
    window.addEventListener(SHOW_AUTOMATED_EVENT, onChange);
    return () => { alive = false; window.removeEventListener(SHOW_AUTOMATED_EVENT, onChange); };
  }, []);

  if (loading) {
    return (
      <div className="h-full flex">
        <div className="shrink-0 py-2 overflow-hidden" style={{ width: NAV_WIDTH, borderRight: '1px solid var(--border)' }}>
          {TABS.map((tab) => (
            <div key={tab.id} className="px-3 py-[5px]">
              <div className="h-3 w-16 rounded animate-pulse" style={{ backgroundColor: 'var(--border)' }} />
            </div>
          ))}
        </div>
        <div className="flex-1 min-w-0 p-4">
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
    <div className="h-full flex">
      {/* Side nav: every page listed top to bottom, so none hides off the edge
          the way they did in the old horizontal strip. Scrolls on its own only
          when the window is too short. */}
      <nav
        aria-label="Dashboard pages"
        className="shrink-0 overflow-y-auto py-2"
        style={{ width: NAV_WIDTH, borderRight: '1px solid var(--border)', scrollbarWidth: 'thin' }}
      >
        {TABS.map((tab) => {
          const active = dashboardTab === tab.id;
          return (
            <div key={tab.id} ref={active ? activeTabRef : null}>
              <button
                onClick={() => setDashboardTab(tab.id)}
                aria-current={active ? 'page' : undefined}
                className="relative w-full flex items-center gap-1 pl-4 pr-2 py-[3px] text-xs text-left transition-colors duration-150 hover:bg-[var(--surface-hover)]"
                style={{
                  color: active ? 'var(--fg)' : 'var(--dim)',
                  fontWeight: active ? 500 : 400,
                  backgroundColor: active ? 'var(--accent-muted)' : undefined,
                }}
              >
                {active && (
                  <span
                    className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
                    style={{ backgroundColor: 'var(--accent)' }}
                  />
                )}
                <span className="truncate">{tab.label}</span>
                {tab.id === 'sessions' && sessionCount > 0 && (
                  <span
                    className="shrink-0"
                    style={{
                      color: 'var(--dim)',
                      fontFamily: "'SF Mono', monospace",
                      fontSize: 9,
                    }}
                  >
                    ({sessionCount})
                  </span>
                )}
                {tab.id === 'board' && runningCount > 0 && (
                  <span
                    className="shrink-0 inline-flex items-center gap-0.5"
                    style={{
                      fontFamily: "'SF Mono', monospace",
                      fontSize: 9,
                    }}
                  >
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: '#3FB950' }}
                    />
                    <span style={{ color: '#3FB950' }}>
                      {runningCount}
                    </span>
                  </span>
                )}
                {tab.id === 'board' && boardNotification && !active && (
                  <span
                    className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: '#3FB950' }}
                  />
                )}
                {tab.id === 'builds' && buildComplete && !active && (
                  <span
                    className="ml-auto shrink-0 w-1.5 h-1.5 rounded-full"
                    style={{ backgroundColor: 'var(--accent)' }}
                  />
                )}
              </button>
              {/* Settings is one long page: list its sections under the entry
                  so they read at a glance and jump on click. Here rather than
                  beside the settings column, it costs no content width and
                  works at any window width. */}
              {tab.id === 'settings' && active && (
                <div className="py-0.5" aria-label="Settings sections" role="group">
                  {SETTINGS_SECTIONS.map((sec) => (
                    <button
                      key={sec.id}
                      onClick={() => jumpToSettingsSection(sec.id)}
                      className="w-full block pl-7 pr-2 py-[2px] text-left truncate transition-colors duration-150 hover:bg-[var(--surface-hover)]"
                      style={{ color: 'var(--dim)', fontSize: 11 }}
                      title={`Jump to ${sec.label}`}
                    >
                      {sec.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Tab content */}
      <div ref={contentRef} className="flex-1 min-w-0 overflow-y-auto">
        {/* One scroller serves every page: start each new page at its top
            rather than wherever the last one (often a section jump) left it. */}
        <AnimatePresence
          mode="wait"
          onExitComplete={() => { if (contentRef.current) contentRef.current.scrollTop = 0; }}
        >
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
