import { useState, useEffect } from 'react';
import { timeAgo } from '../../lib/time-ago';

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
    <div className="h-full flex flex-col" style={{ backgroundColor: 'var(--bg)' }}>
      {/* Header */}
      <div
        className="px-3 py-2 flex items-center justify-between shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: 'var(--fg)' }}>
            {session.display || 'Untitled'}
          </div>
          <div
            className="text-xs mt-0.5"
            style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}
          >
            {projectName} &middot; {timeAgo(session.timestamp)}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onResume}
            className="px-2.5 py-1 text-xs rounded transition-opacity duration-150 hover:opacity-90"
            style={{
              backgroundColor: 'var(--accent)',
              color: 'var(--bg)',
              fontWeight: 600,
            }}
          >
            Resume
          </button>
          <button
            onClick={onClose}
            className="px-2 py-1 text-xs rounded transition-colors duration-150"
            style={{ color: 'var(--dim)' }}
          >
            Close
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse">
                <div className="h-2.5 w-12 rounded mb-1.5" style={{ backgroundColor: 'var(--border)' }} />
                <div className="rounded p-3" style={{ backgroundColor: 'var(--surface)' }}>
                  <div className="h-2.5 w-full rounded mb-1" style={{ backgroundColor: 'var(--border)' }} />
                  <div className="h-2.5 w-3/4 rounded" style={{ backgroundColor: 'var(--border)' }} />
                </div>
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div className="text-xs" style={{ color: 'var(--dim)' }}>No messages found</div>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              className="text-xs"
              style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start' }}
            >
              <div
                className="mb-1"
                style={{
                  color: 'var(--dim)',
                  fontSize: '10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {msg.role === 'user' ? 'You' : 'Claude'}
                {msg.timestamp && (
                  <span style={{ fontFamily: "'SF Mono', monospace", marginLeft: '6px' }}>
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
              <div
                className="whitespace-pre-wrap break-words rounded-lg px-3 py-2"
                style={{
                  backgroundColor: 'var(--surface)',
                  color: 'var(--fg)',
                  maxHeight: '200px',
                  overflow: 'hidden',
                  maxWidth: '90%',
                  border: '1px solid var(--border)',
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
