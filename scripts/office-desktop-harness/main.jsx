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

const SYNTH = [
  { id: 't1', projectPath: '/office/demo', projectName: 'office-demo', label: 'fix auth',     cwd: '/office/demo' },
  { id: 't2', projectPath: '/office/demo', projectName: 'office-demo', label: 'mockups',      cwd: '/office/demo' },
  { id: 't3', projectPath: '/office/demo', projectName: 'office-demo', label: 'codex review', cwd: '/office/demo' },
  { id: 't4', projectPath: '/office/demo', projectName: 'office-demo', label: 'onboarding',   cwd: '/office/demo' },
  { id: 't5', projectPath: '/office/demo', projectName: 'office-demo', label: 'needs you',    cwd: '/office/demo' },
  { id: 't6', projectPath: '/office/demo', projectName: 'office-demo', label: 'docs',         cwd: '/office/demo' },
];

useStore.setState({
  terminalTabs: SYNTH,
  tabStatus: {
    t1: 'working',
    t2: 'done',
    t3: 'working',
    t4: 'idle',
    t5: 'needs',
    t6: 'working',
  },
  runningAgents: {},
  activeTabId: 't1',
  currentProjectPath: '/office/demo',
});

createRoot(document.getElementById('root')).render(<OfficeView />);
