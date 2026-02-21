import { motion } from 'framer-motion';

export default function BuildTimeline({ progress }) {
  if (!progress) return null;

  const raw_completed = progress.tasks_completed || [];
  const raw_remaining = progress.tasks_remaining || [];
  const raw_current = progress.current_task;

  // Normalize: task entries might be strings or objects with id/name
  const toLabel = (t) => typeof t === 'string' ? t : (t?.id || t?.name || String(t));
  const completed = raw_completed.map(toLabel);
  const remaining = raw_remaining.map(toLabel);
  const current = raw_current ? toLabel(raw_current) : null;

  // Build timeline entries: completed → current → remaining
  const entries = [
    ...completed.map((id) => ({ id, status: 'completed' })),
    ...(current && !completed.includes(current)
      ? [{ id: current, status: 'active' }]
      : []),
    ...remaining
      .filter((id) => id !== current)
      .map((id) => ({ id, status: 'pending' })),
  ];

  if (entries.length === 0) return null;

  return (
    <div
      className="p-4 rounded-lg"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <h3
        className="text-xs font-medium uppercase tracking-wider mb-3"
        style={{ color: 'var(--dim)' }}
      >
        Timeline
      </h3>

      <div className="relative">
        {/* Vertical line */}
        <div
          className="absolute left-[7px] top-2 bottom-2 w-px"
          style={{ backgroundColor: 'var(--border)' }}
        />

        {entries.map((entry, i) => (
          <motion.div
            key={entry.id}
            className="flex items-start gap-3 relative"
            style={{ paddingBottom: i < entries.length - 1 ? '12px' : '0' }}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2, delay: i * 0.04, ease: 'easeOut' }}
          >
            {/* Dot */}
            <div className="relative z-10 mt-0.5 shrink-0">
              {entry.status === 'active' ? (
                <motion.div
                  className="w-[15px] h-[15px] rounded-full flex items-center justify-center"
                  style={{ backgroundColor: 'var(--accent-muted)' }}
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <div
                    className="w-[7px] h-[7px] rounded-full"
                    style={{ backgroundColor: 'var(--accent)' }}
                  />
                </motion.div>
              ) : (
                <div
                  className="w-[15px] h-[15px] rounded-full flex items-center justify-center"
                >
                  <div
                    className="w-[7px] h-[7px] rounded-full"
                    style={{
                      backgroundColor:
                        entry.status === 'completed' ? 'var(--accent)' : 'var(--dim)',
                    }}
                  />
                </div>
              )}
            </div>

            {/* Label */}
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="text-xs shrink-0"
                style={{
                  color: entry.status === 'pending' ? 'var(--dim)' : 'var(--fg)',
                  fontFamily: "'SF Mono', monospace",
                  fontWeight: entry.status === 'active' ? 500 : 400,
                }}
              >
                {entry.id}
              </span>
              {entry.status === 'active' && progress.task_name && (
                <span className="text-xs truncate" style={{ color: 'var(--dim)' }}>
                  {typeof progress.task_name === 'string' ? progress.task_name : String(progress.task_name)}
                </span>
              )}
              {entry.status === 'completed' && (
                <span className="text-xs" style={{ color: 'var(--dim)' }}>
                  ✓
                </span>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
