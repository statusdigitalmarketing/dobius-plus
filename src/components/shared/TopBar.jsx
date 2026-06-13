import { useStore } from '../../store/store';
import ThemePicker from './ThemePicker';
import TasksDropdown from './TasksDropdown';

export default function TopBar({ projectName }) {
  const activeView = useStore((s) => s.activeView);
  const setActiveView = useStore((s) => s.setActiveView);
  const themeIndex = useStore((s) => s.themeIndex);
  const setThemeIndex = useStore((s) => s.setThemeIndex);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const tabs = useStore((s) => s.terminalTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeTabLabel = activeView === 'terminal'
    ? (tabs.find((t) => t.id === activeTabId)?.label || '')
    : '';

  return (
    <>
    <div
      className="drag-region flex items-center justify-between px-4 h-10 shrink-0"
      style={{
        backgroundColor: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        paddingLeft: '80px',
      }}
    >
      {/* Left: home + sidebar toggle + view tabs */}
      <div className="no-drag flex items-center gap-1">
        <button
          onClick={() => window.electronAPI?.windowShowLauncher?.()}
          className="px-2 py-1 text-xs rounded transition-colors duration-150"
          style={{ color: 'var(--dim)' }}
          title="Home — back to project list"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
        </button>
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

      {/* Center: project name + active tab */}
      <span
        className="text-xs font-medium absolute left-1/2 -translate-x-1/2 max-w-96 truncate flex items-center gap-1.5"
        style={{ color: 'var(--dim)' }}
      >
        <span>{projectName || 'Dobius+'}</span>
        {activeTabLabel && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ color: 'var(--fg)' }}>{activeTabLabel}</span>
          </>
        )}
      </span>

      {/* Right: visual + tasks dropdown + theme picker */}
      <div className="no-drag flex items-center gap-2">
        <button
          onClick={() => currentProjectPath && window.electronAPI?.visualOpenWindow?.(currentProjectPath)}
          disabled={!currentProjectPath}
          title="Visual Preview — open a phone preview that updates as Claude edits"
          className="no-drag"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '3px 8px',
            fontSize: 11,
            fontFamily: "'SF Mono', monospace",
            color: 'var(--dim)',
            backgroundColor: 'transparent',
            border: '1px solid transparent',
            borderRadius: 5,
            cursor: currentProjectPath ? 'pointer' : 'default',
            opacity: currentProjectPath ? 1 : 0.4,
            transition: 'all 150ms',
          }}
          onMouseEnter={(e) => { if (currentProjectPath) { e.currentTarget.style.color = 'var(--fg)'; e.currentTarget.style.border = '1px solid var(--border)'; }}}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; e.currentTarget.style.border = '1px solid transparent'; }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          Visual
        </button>
        <TasksDropdown />
        <ThemePicker currentIndex={themeIndex} onChange={setThemeIndex} />
      </div>
    </div>
    </>
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
