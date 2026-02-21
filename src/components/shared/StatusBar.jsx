import { useStore } from '../../store/store';

export default function StatusBar() {
  const sessions = useStore((s) => s.sessions);
  const activeProcesses = useStore((s) => s.activeProcesses);

  const hasActive = activeProcesses.length > 0;

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
      </div>
      <span>v1.0</span>
    </div>
  );
}
