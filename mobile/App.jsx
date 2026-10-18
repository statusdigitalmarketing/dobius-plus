import { useState, useEffect } from 'react';
import Pairing from './Pairing';
import Board from './Board';
import TerminalScreen from './Terminal';
import History from './History';
import { Connection } from './connection';
import { get, set, remove } from './storage';
import { HOST_KEY, TOKEN_KEY, normaliseHost, initHost } from './host';

export default function App() {
  // null = loading from async storage, '' = empty (needs pairing), string = present
  const [token, setToken] = useState(null);
  const [host, setHost] = useState(null);
  // deepLink carries a monotonically-incrementing `nonce` so Pairing's effect
  // fires on every scan, including rescans of an identical QR after a
  // transient failure. Without the nonce, React dep-equality on primitive
  // host/code would see no change and the rescan would silently drop.
  const [deepLink, setDeepLink] = useState({ host: '', code: '', nonce: 0 });
  const [conn, setConn] = useState(null);
  const [status, setStatus] = useState('disconnected');
  const [view, setView] = useState('board'); // 'board' | 'terminal' | 'history'
  const [openTabId, setOpenTabId] = useState(null); // terminal opened from the board

  // Load persisted host + token on mount. @capacitor/preferences is async
  // so we render a brief Connecting state until this resolves. Falls back to
  // legacy localStorage keys so a user upgrading from the self-use TestFlight
  // build keeps their pairing (there was no host there, so the stored null
  // forces the first-run host entry; that's correct for the ATS-removed
  // bundled WebView).
  useEffect(() => {
    (async () => {
      try {
        const [t, h] = await Promise.all([get(TOKEN_KEY), initHost()]);
        setToken(t || '');
        setHost(h || '');
      } catch {
        setToken(''); setHost('');
      }
    })();
  }, []);

  // Deep-link listener: dobiusplus://pair?host=HOST&code=CODE. Both the Mac
  // QR flow and a shared link land here. Dynamically imports @capacitor/app
  // so the browser dev build (which has no native listener) doesn't blow up
  // in listenerHandler.remove().
  //
  // Cancellation is explicit so a Strict-Mode mount-unmount-mount cycle (or
  // any unmount that races the async addListener) does not leak a listener:
  // if cleanup fired before addListener resolved, we remove the handle as
  // soon as we have it.
  useEffect(() => {
    let cancelled = false;
    let handle;
    (async () => {
      try {
        const mod = await import('@capacitor/app');
        if (cancelled) return;
        const next = await mod.App.addListener('appUrlOpen', ({ url }) => {
          try {
            const u = new URL(url);
            if (u.protocol !== 'dobiusplus:') return;
            if (u.hostname !== 'pair' && u.pathname.replace(/^\/+/, '').split('/')[0] !== 'pair') return;
            const h = normaliseHost(u.searchParams.get('host') || '');
            const c = (u.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);
            if (h || c) setDeepLink((prev) => ({ host: h, code: c, nonce: prev.nonce + 1 }));
          } catch { /* malformed URL: ignore */ }
        });
        handle = next;
        if (cancelled) { try { await handle.remove(); } catch { /* noop */ } handle = undefined; }
      } catch { /* not on native: ignore */ }
    })();
    return () => {
      cancelled = true;
      try { handle?.remove?.(); } catch { /* noop */ }
    };
  }, []);

  useEffect(() => {
    if (!token) { setConn(null); return undefined; }

    const c = new Connection(token, host);
    const offStatus = c.onStatus(setStatus);
    const offMsg = c.onMessage((msg) => {
      if (msg.type === 'authFailed') {
        // The stored token was rejected, so wipe it and drop back to pairing.
        // Host stays: the pairing code UI should remember the Mac even after a
        // token revoke on the desktop.
        remove(TOKEN_KEY).catch(() => {});
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
  }, [token, host]);

  // Deep-link from a push tap: a cold start lands on ?open=<id>, and a warm app
  // gets a postMessage {type:'open-session'} from the service worker. Either way,
  // jump to that session instead of the last-shown screen. Audit MED-12.
  useEffect(() => {
    const openSession = (id) => { if (id) { setOpenTabId(id); setView('terminal'); } };
    try {
      const p = new URLSearchParams(window.location.search).get('open');
      if (p) {
        openSession(p);
        window.history.replaceState(null, '', window.location.pathname); // don't re-trigger on refresh
      }
    } catch { /* noop */ }
    const onSwMsg = (e) => { if (e.data?.type === 'open-session') openSession(e.data.id); };
    navigator.serviceWorker?.addEventListener('message', onSwMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onSwMsg);
  }, []);

  const handlePaired = async ({ token: newToken, host: newHost }) => {
    // Consume the deep-link payload SYNCHRONOUSLY, before any await: a
    // scan that arrives during the storage writes below would otherwise
    // be clobbered when the stale reset lands seconds later. The token
    // set also runs synchronously so Pairing unmounts immediately and
    // any further scans fall through to the Board (which ignores them).
    setDeepLink({ host: '', code: '', nonce: 0 });
    setToken(newToken);
    if (newHost) setHost(newHost);
    // Backend persistence (async). The UI has already transitioned.
    try {
      await set(TOKEN_KEY, newToken);
      if (newHost) await set(HOST_KEY, newHost);
      // Also update the module-level cached host so absUrl() picks it up
      // without waiting for the next initHost().
      if (newHost) await initHost();
    } catch { /* storage write failed; token still kept in-memory for this session */ }
  };

  if (token === null || host === null) {
    return <div className="screen center"><p className="muted">Loading...</p></div>;
  }
  if (!token) {
    return (
      <Pairing
        initialHost={deepLink.host || host}
        initialCode={deepLink.code}
        scanNonce={deepLink.nonce}
        onPaired={handlePaired}
      />
    );
  }
  if (!conn) {
    return <div className="screen center"><p className="muted">Connecting...</p></div>;
  }
  if (view === 'history') {
    return <History connection={conn} onBack={() => setView('board')} />;
  }
  if (view === 'terminal') {
    return (
      <TerminalScreen
        connection={conn}
        status={status}
        initialId={openTabId}
        onBack={() => setView('board')}
        onShowHistory={() => setView('history')}
      />
    );
  }
  // Home: the session board.
  return (
    <Board
      connection={conn}
      status={status}
      onOpen={(id) => { setOpenTabId(id); setView('terminal'); }}
      onShowHistory={() => setView('history')}
    />
  );
}
