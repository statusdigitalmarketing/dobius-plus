import { useState, useEffect } from 'react';

/**
 * Chat history. Lists Claude Code sessions across all projects; tapping one
 * shows its transcript. "Resume" spawns a terminal that runs
 * `claude --resume <id>` in that session's project.
 */
export default function History({ connection, onBack }) {
  const [sessions, setSessions] = useState(null);   // null = loading
  const [openSession, setOpenSession] = useState(null);
  const [transcript, setTranscript] = useState(null);

  useEffect(() => {
    const off = connection.onMessage((msg) => {
      if (msg.type === 'sessions') {
        const list = [...(msg.list || [])].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setSessions(list);
      } else if (msg.type === 'transcript') {
        setTranscript(msg.entries || []);
      }
    });
    connection.send({ type: 'listSessions' });
    return off;
  }, [connection]);

  const openTranscript = (s) => {
    setOpenSession(s);
    setTranscript(null);
    connection.send({ type: 'loadTranscript', sessionId: s.sessionId, projectPath: s.projectPath });
  };

  const resume = (s) => {
    connection.send({ type: 'resumeSession', sessionId: s.sessionId, projectPath: s.projectPath });
    onBack(); // jump back to the terminal view where the resumed session opens
  };

  if (openSession) {
    return (
      <div className="screen history">
        <header className="top-bar">
          <button className="icon-btn" onClick={() => setOpenSession(null)} aria-label="Back">‹</button>
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
      <main className="session-list">
        {sessions === null && <p className="muted pad">Loading sessions...</p>}
        {sessions && sessions.length === 0 && <p className="muted pad">No sessions found.</p>}
        {sessions && sessions.map((s) => (
          <div key={s.sessionId} className="session-item">
            <button className="session-main" onClick={() => openTranscript(s)}>
              <div className="session-head">
                <span className="terminal-name">{s.projectName}</span>
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
