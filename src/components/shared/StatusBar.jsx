import { useStore } from '../../store/store';

export default function StatusBar() {
  const sessions = useStore((s) => s.sessions);
  const activeProcesses = useStore((s) => s.activeProcesses);
  const tabs = useStore((s) => s.terminalTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const currentBranch = useStore((s) => s.currentBranch);

  const hasActive = activeProcesses.length > 0;
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div
      className="flex items-center justify-between px-4 h-6 shrink-0 text-xs"
      style={{
        backgroundColor: 'var(--surface)',
        borderTop: '1px solid var(--border)',
        color: 'var(--dim)',
        fontFamily: "'SF Mono', monospace",
      }}
    >
      <div className="flex items-center gap-4">
        {currentBranch && (
          <span
            className="flex items-center gap-1"
            title="Current git branch (or worktree). Polled every 20s."
            style={{ color: 'var(--fg)' }}
          >
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm-2.25.75a2.25 2.25 0 1 1 3 2.122v1.005A2.25 2.25 0 0 1 10.25 8.5h-3.5a.75.75 0 0 0-.75.75v2.378a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.875a2.25 2.25 0 0 1 .75-.128h3.5a.75.75 0 0 0 .75-.75V5.372A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
            </svg>
            {currentBranch}
          </span>
        )}
        <span>{sessions.length} sessions</span>
        <span className="flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full inline-block"
            style={{ backgroundColor: hasActive ? 'var(--accent)' : 'var(--dim)' }}
          />
          {hasActive ? `${activeProcesses.length} active` : 'idle'}
        </span>
        {tabs.length > 0 && (
          <span>
            {tabs.length} tab{tabs.length !== 1 ? 's' : ''}
            {activeTab ? ` \u00B7 ${activeTab.label}` : ''}
          </span>
        )}
      </div>
      <span>v2.0</span>
    </div>
  );
}
