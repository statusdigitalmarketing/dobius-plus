import { useStore } from '../../store/store';

export default function StatusBar() {
  const sessions = useStore((s) => s.sessions);
  const activeProcesses = useStore((s) => s.activeProcesses);
  const tabs = useStore((s) => s.terminalTabs);
  const activeTabId = useStore((s) => s.activeTabId);

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
