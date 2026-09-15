import { useState, useEffect, useRef } from 'react';

/**
 * Chat history. Lists Claude Code sessions across all projects; tapping one
 * shows its transcript. "Resume" spawns a terminal that runs
 * `claude --resume <id>` in that session's project.
 */
export default function History({ connection, onBack }) {
  const [sessions, setSessions] = useState(null);   // null = loading
  const [sourceFilter, setSourceFilter] = useState('claude'); // 'claude' | 'codex' | 'all'
  const sourceRef = useRef('claude');
  const [openSession, setOpenSession] = useState(null);
  const [transcript, setTranscript] = useState(null);
  // Mirror of the open session so the onMessage handler (which closes over the
  // initial state) can re-request its transcript on reconnect. Audit HIGH-5.
  const openSessionRef = useRef(null);

  const sourcesFor = (src) => (src === 'codex' ? ['codex'] : src === 'all' ? ['claude', 'codex'] : ['claude']);

  const requestSessions = (src) => {
    sourceRef.current = src;
    connection.send({ type: 'listSessions', sources: sourcesFor(src) });
  };

  const changeSource = (src) => { setSourceFilter(src); setSessions(null); requestSessions(src); };

  useEffect(() => {
    const off = connection.onMessage((msg) => {
      if (msg.type === 'authed') {
        // Reconnect (iOS foreground kills the socket): re-issue our reads so a
        // request dropped during the ~1-2s reconnect window doesn't leave us
        // stuck on "Loading...". Matches Board/Terminal's re-issue-on-authed.
        connection.send({ type: 'listSessions', sources: sourcesFor(sourceRef.current) });
        const open = openSessionRef.current;
        if (open) {
          connection.send({ type: 'loadTranscript', sessionId: open.sessionId, projectPath: open.projectPath, source: open.source });
        }
      } else if (msg.type === 'sessions') {
        const list = [...(msg.list || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setSessions(list);
      } else if (msg.type === 'transcript') {
        // Only render a reply for the session that is CURRENTLY open. Tapping A
        // then B could otherwise land A's slower reply after B's, showing B's
        // header over A's messages. Match sessionId (+ projectPath, since ids
        // could repeat across projects). Audit MED-13.
        const open = openSessionRef.current;
        if (open && msg.sessionId === open.sessionId
            && (msg.projectPath == null || msg.projectPath === open.projectPath)) {
          setTranscript(msg.entries || []);
        }
      }
    });
    connection.send({ type: 'listSessions', sources: sourcesFor(sourceRef.current) });
    return off;
  }, [connection]);

  const openTranscript = (s) => {
    setOpenSession(s);
    openSessionRef.current = s;
    setTranscript(null);
    connection.send({ type: 'loadTranscript', sessionId: s.sessionId, projectPath: s.projectPath, source: s.source });
  };

  const resume = (s) => {
    connection.send({
      type: s.source === 'codex' ? 'resumeCodexSession' : 'resumeSession',
      sessionId: s.sessionId, projectPath: s.projectPath,
    });
    onBack(); // jump back to the terminal view where the resumed session opens
  };

  if (openSession) {
    return (
      <div className="screen history">
        <header className="top-bar">
          <button className="icon-btn" onClick={() => { setOpenSession(null); openSessionRef.current = null; }} aria-label="Back">‹</button>
          <span className="terminal-name">{openSession.projectName}</span>
          <button className="resume-btn" onClick={() => resume(openSession)}>Resume</button>
        </header>
        <main className="transcript">
          {transcript === null && <p className="muted pad">Loading transcript...</p>}
          {transcript && transcript.length === 0 && <p className="muted pad">No messages in this session.</p>}
          {transcript && transcript.map((m, i) => (
            <div key={i} className={`msg ${m.role === 'assistant' ? 'assistant' : 'user'}`}>
              <div className="msg-role">{m.role === 'assistant' ? 'Claude' : 'You'}</div>
              <div className="msg-content">{m.content}</div>
            </div>
          ))}
        </main>
      </div>
    );
  }

  return (
    <div className="screen history">
      <header className="top-bar">
        <button className="icon-btn" onClick={onBack} aria-label="Back">‹</button>
        <span className="terminal-name">Chat History</span>
        <span className="spacer" />
      </header>
      <div className="source-filter" style={{ display: 'flex', gap: 0, padding: '8px 12px' }}>
        {['claude', 'codex', 'all'].map((src) => (
          <button
            key={src}
            onClick={() => changeSource(src)}
            className="source-tab"
            style={{
              flex: 1, padding: '8px 0', fontSize: 13, textTransform: 'capitalize',
              background: sourceFilter === src ? 'var(--accent, #b0724b)' : 'transparent',
              color: sourceFilter === src ? '#fff' : 'var(--muted, #9a9a9a)',
              border: '1px solid var(--border, #333)',
              borderLeft: src === 'claude' ? '1px solid var(--border, #333)' : 'none',
            }}
          >{src}</button>
        ))}
      </div>
      <main className="session-list">
        {sessions === null && <p className="muted pad">Loading sessions...</p>}
        {sessions && sessions.length === 0 && <p className="muted pad">No sessions found.</p>}
        {sessions && sessions.map((s) => (
          <div key={s.sessionId} className="session-item">
            <button className="session-main" onClick={() => openTranscript(s)}>
              <div className="session-head">
                <span className="terminal-name">{s.projectName}</span>
                {s.source === 'codex' && <span className="muted small" style={{ color: '#10a37f' }}>Codex</span>}
                <span className="muted small">{s.age}</span>
              </div>
              <div className="session-preview">{s.preview}</div>
            </button>
            <button className="resume-btn" onClick={() => resume(s)}>Resume</button>
          </div>
        ))}
      </main>
    </div>
  );
}
