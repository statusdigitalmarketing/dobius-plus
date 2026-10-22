// Harness for the DESKTOP OfficeView: seeds the Zustand store with synthetic
// terminals + statuses, mocks window.electronAPI so agentsList does not crash,
// mounts <OfficeView /> standalone. Playwright uses this to screenshot the
// desktop version with no isolated Electron instance.
import { createRoot } from 'react-dom/client';
import { useStore } from '../../src/store/store.js';
import OfficeView from '../../src/components/Dashboard/Office/OfficeView.jsx';

// Minimal electronAPI shim: Office calls agentsList at mount; return [].
window.electronAPI = {
  agentsList: async () => [],
};

// Multi-project synthetic world: 4 project rooms + lobby, mix of tab counts
// and statuses so the floor plan shows a realistic agent fleet.
const SYNTH = [
  // dobius-plus: 5 tabs
  { id: 'd1', projectPath: '/projects/dobius-plus', projectName: 'dobius-plus', label: 'office view',   cwd: '/' },
  { id: 'd2', projectPath: '/projects/dobius-plus', projectName: 'dobius-plus', label: 'kokoro',       cwd: '/' },
  { id: 'd3', projectPath: '/projects/dobius-plus', projectName: 'dobius-plus', label: 'release',      cwd: '/' },
  { id: 'd4', projectPath: '/projects/dobius-plus', projectName: 'dobius-plus', label: 'codex check',  cwd: '/' },
  { id: 'd5', projectPath: '/projects/dobius-plus', projectName: 'dobius-plus', label: 'needs you',    cwd: '/' },
  // b2b-portal: 4 tabs
  { id: 'b1', projectPath: '/projects/b2b-portal',  projectName: 'b2b-portal',  label: 'cart flow',    cwd: '/' },
  { id: 'b2', projectPath: '/projects/b2b-portal',  projectName: 'b2b-portal',  label: 'tests',        cwd: '/' },
  { id: 'b3', projectPath: '/projects/b2b-portal',  projectName: 'b2b-portal',  label: 'review',       cwd: '/' },
  { id: 'b4', projectPath: '/projects/b2b-portal',  projectName: 'b2b-portal',  label: 'deploy',       cwd: '/' },
  // slimject: 3 tabs
  { id: 's1', projectPath: '/projects/slimject',    projectName: 'slimject',    label: 'affiliates',   cwd: '/' },
  { id: 's2', projectPath: '/projects/slimject',    projectName: 'slimject',    label: 'orders',       cwd: '/' },
  { id: 's3', projectPath: '/projects/slimject',    projectName: 'slimject',    label: 'ship labels',  cwd: '/' },
  // better-health: 2 tabs
  { id: 'h1', projectPath: '/projects/better-health', projectName: 'better-health', label: 'landing',  cwd: '/' },
  { id: 'h2', projectPath: '/projects/better-health', projectName: 'better-health', label: 'checkout', cwd: '/' },
];

useStore.setState({
  terminalTabs: SYNTH,
  tabStatus: {
    d1: 'working', d2: 'working', d3: 'done',    d4: 'idle', d5: 'needs',
    b1: 'working', b2: 'done',    b3: 'working', b4: 'idle',
    s1: 'working', s2: 'needs',   s3: 'done',
    h1: 'working', h2: 'idle',
  },
  runningAgents: {},
  activeTabId: 'd1',
  currentProjectPath: '/projects/dobius-plus',
});

// Expose a tiny API the ship-test can call to animate state transitions
// during a recording ("tab finished", "tab needs you") so the reel actually
// shows action instead of a frozen frame.
window.__officeHarness = {
  setStatus(id, status) {
    const { tabStatus } = useStore.getState();
    useStore.setState({ tabStatus: { ...tabStatus, [id]: status } });
  },
};

createRoot(document.getElementById('root')).render(<OfficeView />);
