import { motion } from 'framer-motion';

export default function BuildProgressBar({ progress }) {
  if (!progress) return null;

  const completed = progress.tasks_completed?.length || 0;
  const total = completed + (progress.tasks_remaining?.length || 0);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isActive = progress.status === 'in_progress';

  return (
    <div
      className="p-4 rounded-lg"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h3
          className="text-xs font-medium uppercase tracking-wider"
          style={{ color: 'var(--dim)' }}
        >
          Build Progress
        </h3>
        <span
          className="text-xs"
          style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}
        >
          {completed}/{total} tasks ({pct}%)
        </span>
      </div>

      {/* Phase + task labels */}
      <div className="flex items-center gap-3 mb-3 text-xs">
        {progress.current_phase != null && (
          <span style={{ color: 'var(--dim)' }}>
            Phase <span style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>{progress.current_phase}</span>
          </span>
        )}
        {progress.current_task && (
          <span style={{ color: 'var(--dim)' }}>
            Task{' '}
            <span style={{ color: 'var(--accent)', fontFamily: "'SF Mono', monospace" }}>
              {progress.current_task}
            </span>
          </span>
        )}
        {progress.task_name && (
          <span className="truncate" style={{ color: 'var(--dim)' }}>
            {progress.task_name}
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div
        className="h-2 rounded-full overflow-hidden"
        style={{ backgroundColor: 'var(--border)' }}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: 'var(--accent)' }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>

      {/* Status indicator */}
      <div className="flex items-center gap-2 mt-2">
        {isActive && (
          <motion.div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: 'var(--accent)' }}
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
        <span
          className="text-xs"
          style={{
            color: isActive ? 'var(--accent)' : 'var(--dim)',
            fontFamily: "'SF Mono', monospace",
          }}
        >
          {progress.status || 'unknown'}
        </span>
      </div>
    </div>
  );
}
