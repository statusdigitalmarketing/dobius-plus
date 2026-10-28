import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store/store';
import ThemePicker from './ThemePicker';
import TasksDropdown from './TasksDropdown';
import SpeakButton from './SpeakButton';

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

  // Git context shown in the top bar: which branch / worktree / fork you're on.
  const currentBranch = useStore((s) => s.currentBranch);
  const currentIsWorktree = useStore((s) => s.currentIsWorktree);
  const currentDetached = useStore((s) => s.currentDetached);
  const currentIsFork = useStore((s) => s.currentIsFork);
  const showGit = activeView === 'terminal' && (currentDetached || !!currentBranch);
  // A fork takes label priority over worktree (you can be both); detached has no kind tag.
  const gitKind = currentDetached ? null : (currentIsFork ? 'fork' : (currentIsWorktree ? 'worktree' : null));

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
          title="Home, back to project list"
          aria-label="Home, back to project list"
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)'; e.currentTarget.style.backgroundColor = 'var(--surface-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; e.currentTarget.style.backgroundColor = 'transparent'; }}
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
          aria-label="Toggle sidebar"
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)'; e.currentTarget.style.backgroundColor = 'var(--surface-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; e.currentTarget.style.backgroundColor = 'transparent'; }}
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
        <ToolPanelDropdown setActiveView={setActiveView} />
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
        {showGit && (
          <>
            <span style={{ opacity: 0.5 }}>·</span>
            <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ opacity: 0.7 }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 3v12m0 0a3 3 0 103 3m-3-3a3 3 0 013 3m9-9a3 3 0 11-3-3m3 3v3a3 3 0 01-3 3H9" />
            </svg>
            <span
              style={{ color: 'var(--fg)' }}
              title={currentDetached
                ? 'Detached HEAD — not on a branch'
                : `On branch ${currentBranch}${gitKind ? ` (${gitKind})` : ''}. Polled every 20s, follows the active tab's cwd.`}
            >
              {currentDetached ? 'detached' : currentBranch}
            </span>
            {gitKind && (
              <span
                style={{
                  color: 'var(--accent)',
                  fontWeight: 600,
                }}
              >
                {gitKind}
              </span>
            )}
          </>
        )}
      </span>

      {/* Right: visual + tasks dropdown + theme picker */}
      <div className="no-drag flex items-center gap-2">
        <ViewModeToggle />
        <button
          onClick={() => currentProjectPath && window.electronAPI?.visualOpenWindow?.(currentProjectPath)}
          disabled={!currentProjectPath}
          title="Visual Preview, open a phone preview that updates as Claude edits"
          aria-label="Open visual preview"
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
        <SpeakButton />
        <ThemePicker currentIndex={themeIndex} onChange={setThemeIndex} />
      </div>
    </div>
    </>
  );
}

/**
 * Terminal / Chat switch for the active tab (Cmd+Shift+C). Chat reads the
 * running Claude session as messages over the same PTY; the choice is per tab.
 */
function ViewModeToggle() {
  const activeView = useStore((s) => s.activeView);
  const tab = useStore((s) => s.terminalTabs.find((t) => t.id === s.activeTabId));
  const setTabViewMode = useStore((s) => s.setTabViewMode);
  if (activeView !== 'terminal' || !tab || tab.kind === 'browser') return null;
  const mode = tab.viewMode === 'chat' ? 'chat' : 'terminal';
  const seg = (value, label) => {
    const on = mode === value;
    return (
      <button
        key={value}
        onClick={() => setTabViewMode(tab.id, value)}
        aria-pressed={on}
        title={`${label} view for this tab (Cmd+Shift+C)`}
        style={{
          padding: '2px 9px',
          fontSize: 11,
          fontFamily: "'SF Mono', monospace",
          color: on ? 'var(--fg)' : 'var(--dim)',
          backgroundColor: on ? 'var(--surface-hover)' : 'transparent',
          border: 'none',
          borderRadius: 4,
          cursor: on ? 'default' : 'pointer',
          transition: 'all 150ms',
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      className="no-drag"
      role="group"
      aria-label="Tab view"
      style={{ display: 'flex', gap: 2, padding: 2, border: '1px solid var(--border)', borderRadius: 6 }}
    >
      {seg('terminal', 'Terminal')}
      {seg('chat', 'Chat')}
    </div>
  );
}

/**
 * Chevron dropdown beside the Terminal tab (v1.0.52): opens the Files or
 * Git Tree SIDE PANEL. Panels live in the terminal view, so selecting one
 * also switches there. The active panel shows a check.
 */
function ToolPanelDropdown({ setActiveView }) {
  const toolPanel = useStore((s) => s.toolPanel);
  const toggleToolPanel = useStore((s) => s.toggleToolPanel);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (panel) => {
    setOpen(false);
    setActiveView('terminal');
    toggleToolPanel(panel);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-0.5 py-2.5 text-xs transition-colors duration-150"
        style={{ color: toolPanel ? 'var(--accent)' : 'var(--dim)' }}
        title="Terminal side panels (Files, Git Tree)"
        aria-label="Terminal side panels"
        aria-expanded={open}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-50 rounded shadow-lg py-1"
          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', minWidth: 140 }}
        >
          {[['files', 'Files'], ['gittree', 'Git Tree']].map(([panel, label]) => (
            <button
              key={panel}
              onClick={() => pick(panel)}
              className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2"
              style={{ color: 'var(--fg)', cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--border)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <span className="flex-1">{label}</span>
              {toolPanel === panel && <span style={{ color: 'var(--accent)' }}>✓</span>}
            </button>
          ))}
        </div>
      )}
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
            width: '70%',
            backgroundColor: 'var(--accent)',
          }}
        />
      )}
    </button>
  );
}
