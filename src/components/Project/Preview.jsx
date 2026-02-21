import { useState, useEffect } from 'react';
import { timeAgo } from '../../lib/time-ago';

/**
 * Preview — transcript viewer panel.
 */
export default function Preview({ session, onClose, onResume }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session || !window.electronAPI) return;
    setLoading(true);
    window.electronAPI
      .dataLoadTranscript(session.sessionId, session.project)
      .then((data) => {
        setMessages(data);
        setLoading(false);
      });
  }, [session]);

  if (!session) return null;

  const projectName = session.project?.split('/').filter(Boolean).pop() || 'Unknown';

  return (
    <div
      className="h-full flex flex-col"
      style={{ backgroundColor: 'var(--bg)' }}
    >
      {/* Header */}
      <div
        className="px-3 py-2 flex items-center justify-between shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: 'var(--fg)' }}>
            {session.display || 'Untitled'}
          </div>
          <div className="text-xs" style={{ color: 'var(--dim)' }}>
            {projectName} &middot; {timeAgo(session.timestamp)}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onResume}
            className="px-2 py-1 text-xs rounded"
            style={{
              backgroundColor: 'var(--accent)',
              color: 'var(--bg)',
              fontWeight: 600,
            }}
          >
            Resume in Terminal
          </button>
          <button
            onClick={onClose}
            className="px-2 py-1 text-xs rounded"
            style={{ color: 'var(--dim)' }}
          >
            Close
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading ? (
          <div className="text-xs" style={{ color: 'var(--dim)' }}>Loading transcript...</div>
        ) : messages.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--dim)' }}>No messages found</div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className="text-xs">
              <div
                className="font-medium mb-0.5"
                style={{
                  color: msg.role === 'user' ? '#3FB950' : '#58A6FF',
                }}
              >
                {msg.role === 'user' ? 'You' : 'Claude'}
              </div>
              <div
                className="whitespace-pre-wrap break-words rounded p-2"
                style={{
                  backgroundColor: 'var(--surface)',
                  color: 'var(--fg)',
                  maxHeight: '200px',
                  overflow: 'hidden',
                }}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
