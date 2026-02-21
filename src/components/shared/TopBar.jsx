import { useStore } from '../../store/store';
import ThemePicker from './ThemePicker';

export default function TopBar({ projectName }) {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const themeIndex = useStore((s) => s.themeIndex);
  const setThemeIndex = useStore((s) => s.setThemeIndex);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  return (
    <div
      className="drag-region flex items-center justify-between px-4 h-10 shrink-0"
      style={{
        backgroundColor: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        paddingLeft: '80px',
      }}
    >
      {/* Left: sidebar toggle + view tabs */}
      <div className="no-drag flex items-center gap-1">
        <button
          onClick={toggleSidebar}
          className="px-2 py-1 text-xs rounded transition-colors duration-150"
          style={{ color: 'var(--dim)' }}
          title="Toggle Sidebar (Cmd+B)"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <ViewTab
          label="Terminal"
          active={activeView === 'terminal'}
          onClick={() => setActiveView('terminal')}
        />
        <ViewTab
          label="Dashboard"
          active={activeView === 'dashboard'}
          onClick={() => setActiveView('dashboard')}
        />
      </div>

      {/* Center: project name */}
      <span
        className="text-xs font-medium absolute left-1/2 -translate-x-1/2 max-w-48 truncate"
        style={{ color: 'var(--dim)' }}
      >
        {projectName || 'Dobius+'}
      </span>

      {/* Right: theme picker */}
      <div className="no-drag">
        <ThemePicker currentIndex={themeIndex} onChange={setThemeIndex} />
      </div>
    </div>
  );
}

function ViewTab({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="relative px-3 py-2.5 text-xs transition-colors duration-150"
      style={{
        color: active ? 'var(--fg)' : 'var(--dim)',
        fontWeight: active ? 500 : 400,
      }}
    >
      {label}
      {active && (
        <span
          className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 rounded-full"
          style={{
            width: '60%',
            backgroundColor: 'var(--accent)',
          }}
        />
      )}
    </button>
  );
}
