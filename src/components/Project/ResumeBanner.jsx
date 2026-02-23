import { useState, useEffect } from 'react';
import { useStore } from '../../store/store';
import { timeAgo } from '../../lib/time-ago';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_DISMISS_MS = 30000;

export default function ResumeBanner({ projectPath }) {
  const [session, setSession] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const resumeSession = useStore((s) => s.resumeSession);

  useEffect(() => {
    if (!projectPath || !window.electronAPI?.dataGetLatestSession) return;
    window.electronAPI.dataGetLatestSession(projectPath).then((result) => {
      if (result && result.timestamp && Date.now() - result.timestamp < SEVEN_DAYS_MS) {
        setSession(result);
      }
    });
  }, [projectPath]);

  // Auto-dismiss after 30 seconds
  useEffect(() => {
    if (!session || dismissed) return;
    const timer = setTimeout(() => setDismissed(true), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [session, dismissed]);

  if (!session || dismissed) return null;

  const preview = (session.preview || '').slice(0, 60);
  const age = timeAgo(session.timestamp);

  return (
    <div
      className="flex items-center gap-3 px-3 py-1.5 text-xs shrink-0"
      style={{
        backgroundColor: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span style={{ color: 'var(--dim)' }}>Resume last session?</span>
      <span
        className="truncate"
        style={{ color: 'var(--fg)', maxWidth: 300, fontFamily: "'SF Mono', monospace" }}
      >
        {preview || 'No preview'}
      </span>
      <span style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: 10 }}>
        {age}
      </span>
      <button
        onClick={() => {
          resumeSession(session.sessionId);
          setDismissed(true);
        }}
        className="px-2 py-0.5 rounded text-xs"
        style={{
          backgroundColor: 'var(--accent)',
          color: 'var(--bg)',
          border: 'none',
          cursor: 'pointer',
          fontFamily: "'SF Mono', monospace",
          fontSize: 10,
        }}
      >
        Resume
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="ml-auto"
        style={{
          color: 'var(--dim)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}
