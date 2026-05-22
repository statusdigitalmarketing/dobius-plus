import { useState, useEffect } from 'react';
import Pairing from './Pairing';
import TerminalScreen from './Terminal';
import { Connection } from './connection';

const TOKEN_KEY = 'dobius-mobile-token';

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [conn, setConn] = useState(null);
  const [status, setStatus] = useState('disconnected');

  useEffect(() => {
    if (!token) { setConn(null); return undefined; }

    const c = new Connection(token);
    const offStatus = c.onStatus(setStatus);
    const offMsg = c.onMessage((msg) => {
      if (msg.type === 'authFailed') {
        // The stored token was rejected, so wipe it and drop back to pairing.
        localStorage.removeItem(TOKEN_KEY);
        setToken('');
      }
    });
    c.connect();
    setConn(c);

    // iOS kills the WebSocket while the PWA is backgrounded; reconnect on return.
    const onVisible = () => {
      if (document.visibilityState === 'visible') c.wake();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      offStatus();
      offMsg();
      c.close();
    };
  }, [token]);

  const handlePaired = (newToken) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
  };

  if (!token) {
    return <Pairing onPaired={handlePaired} />;
  }
  if (!conn) {
    return <div className="screen center"><p className="muted">Connecting...</p></div>;
  }
  return <TerminalScreen connection={conn} status={status} />;
}
