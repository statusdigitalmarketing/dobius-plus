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
        paddingLeft: '80px', // Space for macOS traffic lights
      }}
    >
      {/* Left: view toggles */}
      <div className="no-drag flex items-center gap-1">
        <button
          onClick={toggleSidebar}
          className="px-2 py-1 text-xs rounded transition-colors"
          style={{ color: 'var(--dim)' }}
          title="Toggle Sidebar (Cmd+B)"
        >
          ☰
        </button>
        <ViewButton
          label="Terminal"
          active={activeView === 'terminal'}
          onClick={() => setActiveView('terminal')}
        />
        <ViewButton
          label="Dashboard"
          active={activeView === 'dashboard'}
          onClick={() => setActiveView('dashboard')}
        />
      </div>

      {/* Center: project name */}
      <span
        className="text-sm font-medium absolute left-1/2 -translate-x-1/2"
        style={{ color: 'var(--fg)' }}
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

function ViewButton({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1 text-xs rounded transition-colors"
      style={{
        color: active ? 'var(--accent)' : 'var(--dim)',
        backgroundColor: active ? 'var(--bg)' : 'transparent',
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}
