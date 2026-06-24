import { useState, useCallback, useEffect } from 'react';
import { useGit } from '../../hooks/useGit';
import { useStore } from '../../store/store';
import { timeAgo } from '../../lib/time-ago';
import { motion, AnimatePresence } from 'framer-motion';

export default function GitSidePanel({ projectDir }) {
  const visible = useStore((s) => s.gitPanelVisible);
  const { status, commits, pullRequests, loading } = useGit(visible ? projectDir : null);
  const buildComplete = useStore((s) => s.buildComplete);

  // v1.0.29: commit history with right-click context menu (copy hash,
  // view diff, copy subject).
  const [contextMenu, setContextMenu] = useState(null);

  const onCommitContext = useCallback((e, commit) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, commit });
  }, []);

  // Dismiss the context menu on any outside click / Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = () => setContextMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') setContextMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // Mirrors the TerminalTabBar copy-with-fallback pattern: if the modern
  // Clipboard API is unavailable or denied, fall back to window.prompt
  // so the user can copy manually instead of a silent no-op.
  // Codex v1.0.29 round-2 LOW.
  const copyToClipboard = useCallback(async (text) => {
    setContextMenu(null);
    if (!navigator.clipboard?.writeText) {
      window.prompt('Copy this text (clipboard API unavailable):', text);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt('Clipboard write was denied. Copy this text manually:', text);
    }
  }, []);

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

              {/* Commit history. Recent commits with author/age. Right-click
                  for hash/diff/copy actions. Unpushed commits get an accent
                  border on the left and a badge in the section header. */}
              {commits.length > 0 && (
                <div>
                  <p className="text-xs mb-1 flex items-center justify-between" style={{ color: 'var(--dim)' }}>
                    <span>Recent commits</span>
                    {status.ahead > 0 && (
                      <span
                        title={`${status.ahead} commit${status.ahead === 1 ? '' : 's'} not yet pushed`}
                        style={{
                          color: 'var(--accent)',
                          fontWeight: 600,
                          fontFamily: "'SF Mono', monospace",
                          fontSize: 9,
                          padding: '1px 5px',
                          borderRadius: 3,
                          backgroundColor: 'var(--surface-hover)',
                        }}
                      >
                        {status.ahead} unpushed
                      </span>
                    )}
                  </p>
                  <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                    {commits.slice(0, 20).map((c, i) => {
                      const unpushed = i < status.ahead;
                      return (
                        <div
                          key={c.hash}
                          onContextMenu={(e) => onCommitContext(e, c)}
                          title={`${c.hash.slice(0, 7)} by ${c.author}. Right-click for actions.`}
                          style={{
                            padding: '4px 6px',
                            borderRadius: 3,
                            backgroundColor: 'var(--bg)',
                            borderLeft: unpushed ? '2px solid var(--accent)' : '2px solid transparent',
                            cursor: 'context-menu',
                          }}
                        >
                          <p
                            className="text-xs truncate"
                            style={{ color: 'var(--fg)', lineHeight: 1.3 }}
                          >
                            {c.subject}
                          </p>
                          <p
                            className="text-xs truncate"
                            style={{ color: 'var(--dim)', fontSize: 9, fontFamily: "'SF Mono', monospace" }}
                          >
                            {c.hash.slice(0, 7)} by {c.author?.split(' ')[0] || 'unknown'}, {timeAgo(new Date(c.date).getTime())}
                          </p>
                        </div>
                      );
                    })}
                  </div>
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

          {/* Commit context menu (fixed-position overlay). Clamped to viewport
              so it doesn't render off-screen near the bottom edge. */}
          {contextMenu && (() => {
            const { x, y, commit } = contextMenu;
            // Clamp on both axes so the menu stays fully on-screen on
            // narrow windows. Codex v1.0.29 round-1 LOW.
            const safeX = Math.max(0, Math.min(x, window.innerWidth - 180));
            const safeY = Math.max(0, Math.min(y, window.innerHeight - 140));
            return (
              <div
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: 'fixed',
                  top: safeY,
                  left: safeX,
                  width: 180,
                  padding: '4px 0',
                  backgroundColor: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                  zIndex: 1000,
                  fontSize: 11,
                }}
              >
                <MenuItem onClick={() => copyToClipboard(commit.hash)}>
                  Copy full hash
                </MenuItem>
                <MenuItem onClick={() => copyToClipboard(commit.hash.slice(0, 7))}>
                  Copy short hash
                </MenuItem>
                <MenuItem onClick={() => copyToClipboard(commit.subject)}>
                  Copy subject
                </MenuItem>
                <MenuItem onClick={() => copyToClipboard(`${commit.hash.slice(0, 7)} ${commit.subject}`)}>
                  Copy hash + subject
                </MenuItem>
              </div>
            );
          })()}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function MenuItem({ onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '5px 10px',
        background: 'transparent',
        border: 'none',
        color: 'var(--fg)',
        cursor: 'pointer',
        fontSize: 11,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--surface-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
    >
      {children}
    </button>
  );
}
