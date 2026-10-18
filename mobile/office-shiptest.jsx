// Standalone harness for Playwright screenshots of the mobile Office page.
// Mounts <Office> with a MOCK connection that replays a scripted terminals
// payload, so we can validate rendering of all four states (working, done,
// idle, needs), recording mode, and the needs red bubble without needing a
// paired Mac WS.
//
// Not part of the shipping PWA: this file is included in the mobile vite dev
// server (root=mobile/) and vite production build only if explicitly imported.
// The default App.jsx entry does not reference it.
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import Office from './Office.jsx';

// Minimal mock connection matching the surface Office consumes:
// { onMessage(cb)->off, send(obj), status }
function makeMockConnection(terms) {
  const listeners = new Set();
  const emit = (msg) => { for (const cb of listeners) cb(msg); };
  const conn = {
    status: 'authed',
    onMessage(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    send() { /* ignore outgoing in the harness */ },
    _publish(list) { emit({ type: 'terminals', list, recentExits: [] }); },
    _authed() { emit({ type: 'authed' }); },
  };
  // Deliver the initial list asynchronously so React's effect runs first.
  setTimeout(() => { conn._authed(); conn._publish(terms); }, 50);
  return conn;
}

const SYNTH = [
  { id: 't1', projectPath: '/office/demo', projectName: 'office-demo', label: 'fix auth',       status: 'working', verb: 'Onioning', model: 'opus',   claudeLive: true  },
  { id: 't2', projectPath: '/office/demo', projectName: 'office-demo', label: 'mockups',        status: 'done',    verb: '',          model: 'opus',   claudeLive: true  },
  { id: 't3', projectPath: '/office/demo', projectName: 'office-demo', label: 'codex review',   status: 'working', verb: 'Reviewing', model: '',       claudeLive: false },
  { id: 't4', projectPath: '/office/demo', projectName: 'office-demo', label: 'onboarding',     status: 'idle',    verb: '',          model: 'sonnet', claudeLive: true  },
  { id: 't5', projectPath: '/office/demo', projectName: 'office-demo', label: 'needs you',      status: 'needs',   verb: '',          model: 'opus',   claudeLive: true  },
  { id: 't6', projectPath: '/office/demo', projectName: 'office-demo', label: 'docs',           status: 'working', verb: 'Writing',   model: 'haiku',  claudeLive: true  },
];

function Harness() {
  const [conn, setConn] = useState(null);
  useEffect(() => {
    setConn(makeMockConnection(SYNTH));
  }, []);
  if (!conn) return <div style={{ padding: 20 }}>Loading harness...</div>;
  return <Office connection={conn} onBack={() => {}} onOpen={() => {}} />;
}

createRoot(document.getElementById('root')).render(<Harness />);
