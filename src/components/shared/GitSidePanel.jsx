import { useGit } from '../../hooks/useGit';
import { useStore } from '../../store/store';
import { timeAgo } from '../../lib/time-ago';
import { motion, AnimatePresence } from 'framer-motion';

export default function GitSidePanel({ projectDir }) {
  const visible = useStore((s) => s.gitPanelVisible);
  const { status, commits, pullRequests, loading } = useGit(visible ? projectDir : null);
  const buildComplete = useStore((s) => s.buildComplete);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 224, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="shrink-0 overflow-hidden flex flex-col"
          style={{
            backgroundColor: 'var(--surface)',
            borderLeft: '1px solid var(--border)',
          }}
        >
          {/* Header */}
          <div
            className="px-3 py-2 shrink-0"
            style={{ borderBottom: '1px solid var(--border)' }}
          >
            <span className="text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--dim)' }}>
              Git
            </span>
          </div>

          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="w-4 h-4 rounded-full animate-pulse" style={{ backgroundColor: 'var(--border)' }} />
            </div>
          ) : !status?.isRepo ? (
            <div className="flex-1 flex items-center justify-center px-3">
              <p className="text-xs text-center" style={{ color: 'var(--dim)' }}>Not a git repo</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
              {/* Branch */}
              <div>
                <p className="text-xs mb-0.5" style={{ color: 'var(--dim)' }}>Branch</p>
                <p
                  className="text-xs font-medium truncate"
                  style={{ color: 'var(--accent)', fontFamily: "'SF Mono', monospace" }}
                >
                  {status.branch}
                </p>
              </div>

              {/* Ahead / Behind */}
              {(status.ahead > 0 || status.behind > 0) && (
                <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--dim)' }}>
                  {status.ahead > 0 && <span>{status.ahead}&uarr;</span>}
                  {status.behind > 0 && <span>{status.behind}&darr;</span>}
                </div>
              )}

              {/* File counts */}
              <div className="space-y-1">
                <p className="text-xs" style={{ color: 'var(--dim)' }}>Changes</p>
                <div className="flex items-center gap-2 text-xs flex-wrap">
                  {status.staged > 0 && (
                    <span style={{ color: '#3fb950' }}>{status.staged} staged</span>
                  )}
                  {status.modified > 0 && (
                    <span style={{ color: '#d29922' }}>{status.modified} modified</span>
                  )}
                  {status.untracked > 0 && (
                    <span style={{ color: 'var(--dim)' }}>{status.untracked} untracked</span>
                  )}
                  {status.staged === 0 && status.modified === 0 && status.untracked === 0 && (
                    <span style={{ color: 'var(--dim)' }}>Clean</span>
                  )}
                </div>
              </div>

              {/* Build status */}
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: buildComplete ? '#3fb950' : 'var(--dim)' }}
                />
                <span className="text-xs" style={{ color: 'var(--dim)' }}>
                  {buildComplete ? 'Build complete' : 'No active build'}
                </span>
              </div>

              {/* Last commit */}
              {commits.length > 0 && (
                <div>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--dim)' }}>Last commit</p>
                  <p className="text-xs truncate" style={{ color: 'var(--fg)' }}>
                    {commits[0].subject}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--dim)' }}>
                    {timeAgo(new Date(commits[0].date).getTime())}
                  </p>
                </div>
              )}

              {/* Active PR */}
              {pullRequests.length > 0 && (
                <div>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--dim)' }}>Active PR</p>
                  <p className="text-xs truncate" style={{ color: 'var(--fg)' }}>
                    #{pullRequests[0].number} {pullRequests[0].title}
                  </p>
                </div>
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
