import { motion } from 'framer-motion';

/**
 * Displays supervisor process status, build metadata, and recent log lines.
 */
export default function SupervisorStatus({ progress, supervisorLog, activeBuilds }) {
  const isRunning = activeBuilds?.length > 0;
  const isFailed = progress?.status === 'failed';

  const statusLabel = isFailed ? 'Failed' : isRunning ? 'Running' : 'Idle';
  const statusColor = isFailed
    ? 'var(--danger)'
    : isRunning
      ? 'var(--accent)'
      : 'var(--dim)';

  const lastLines = (supervisorLog || []).slice(-5);

  return (
    <div
      className="p-4 rounded-lg flex flex-col h-full"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <h3
        className="text-xs font-medium uppercase tracking-wider mb-3"
        style={{ color: 'var(--dim)' }}
      >
        Supervisor
      </h3>

      {/* Status badge */}
      <div className="flex items-center gap-2 mb-3">
        {isRunning ? (
          <motion.div
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: statusColor }}
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        ) : (
          <div
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: statusColor }}
          />
        )}
        <span
          className="text-xs font-medium"
          style={{ color: statusColor, fontFamily: "'SF Mono', monospace" }}
        >
          {statusLabel}
        </span>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 mb-3 text-xs">
        {progress?.build_branch && (
          <>
            <span style={{ color: 'var(--dim)' }}>Branch</span>
            <span style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>
              {progress.build_branch}
            </span>
          </>
        )}
        {progress?.restart_count != null && (
          <>
            <span style={{ color: 'var(--dim)' }}>Restarts</span>
            <span style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>
              {progress.restart_count}
            </span>
          </>
        )}
        {activeBuilds?.length > 0 && (
          <>
            <span style={{ color: 'var(--dim)' }}>Processes</span>
            <span style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>
              {activeBuilds.length}
            </span>
          </>
        )}
      </div>

      {/* Mini-terminal: last 5 log lines */}
      {lastLines.length > 0 && (
        <div
          className="flex-1 rounded p-2 overflow-y-auto min-h-0"
          style={{
            backgroundColor: 'var(--bg)',
            border: '1px solid var(--border)',
            fontFamily: "'SF Mono', monospace",
            fontSize: '10px',
            lineHeight: '1.5',
          }}
        >
          {lastLines.map((line, i) => (
            <div
              key={i}
              className="whitespace-pre-wrap break-all"
              style={{ color: 'var(--dim)' }}
            >
              {typeof line === 'string' ? line : JSON.stringify(line)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
