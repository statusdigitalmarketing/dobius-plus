import { useStore } from '../../store/store';

export default function StatusBar() {
  const sessions = useStore((s) => s.sessions);
  const activeProcesses = useStore((s) => s.activeProcesses);

  return (
    <div
      className="flex items-center justify-between px-4 h-6 shrink-0 text-xs"
      style={{
        backgroundColor: 'var(--surface)',
        borderTop: '1px solid var(--border)',
        color: 'var(--dim)',
      }}
    >
      <div className="flex items-center gap-4">
        <span>{sessions.length} sessions</span>
        {activeProcesses.length > 0 && (
          <span className="flex items-center gap-1">
            <span
              className="w-2 h-2 rounded-full inline-block"
              style={{ backgroundColor: '#3FB950' }}
            />
            {activeProcesses.length} active
          </span>
        )}
      </div>
      <span>Dobius+ v1.0</span>
    </div>
  );
}
