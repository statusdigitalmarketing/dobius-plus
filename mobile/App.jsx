import { useState, useEffect, useRef, useCallback } from 'react';
import Pairing from './Pairing';
import Board from './Board';
import TerminalScreen from './Terminal';
import History from './History';
import MacSwitcher from './MacSwitcher';
import { Connection } from './connection';
import * as storage from './storage';
import { normaliseHost, mixedContent, reachabilityMessage } from './host';
import { activePairing, loadPairings, savePairings, upsertPairing, switchPairing, renamePairing, removePairing } from './pairings';

// A keyed tree owns all state for one connection lifetime, including terminal,
// selector, transcript, History and skills state. Rename does not remount it.
function MacSession({ pairing, connectionRef, onMacs, onRepair, openRequest }) {
  const [connection, setConnection] = useState(null);
  const [status, setStatus] = useState('connecting');
  const [problem, setProblem] = useState('');
  const [authFailed, setAuthFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState('board');
  const [openTabId, setOpenTabId] = useState(null);
  const { id, origin, token } = pairing;

  useEffect(() => {
    const c = new Connection({ id, origin, token });
    connectionRef.current = c;
    let cancelled = false;
    let ready = false;
    setConnection(null);
    setProblem('');
    setAuthFailed(false);
    setStatus('connecting');
    const offStatus = c.onStatus(setStatus);
    const offMessage = c.onMessage((msg) => {
      if (msg.type === 'authFailed') {
        setAuthFailed(true);
        setProblem('This Mac no longer accepts this pairing. Pair it again with a new code.');
      }
    });
    let timeout;
    (async () => {
      if (mixedContent(origin, window.location.origin)) {
        setProblem(reachabilityMessage(origin, window.location.origin));
        return;
      }
      try {
        timeout = setTimeout(() => c.abortController.abort(), 10000);
        const res = await c.request('/health', { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok || data.app !== 'dobius-plus') throw new Error('Not Dobius+');
        if (cancelled) return;
        clearTimeout(timeout);
        ready = true;
        setConnection(c);
        c.connect();
      } catch {
        if (!cancelled) setProblem(reachabilityMessage(origin, window.location.origin));
      } finally { clearTimeout(timeout); }
    })();
    const onVisible = () => { if (ready && document.visibilityState === 'visible' && !c.abortController.signal.aborted) c.wake(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      document.removeEventListener('visibilitychange', onVisible);
      offStatus(); offMessage(); c.close();
      if (connectionRef.current === c) connectionRef.current = null;
    };
  }, [id, origin, token, attempt, connectionRef]);

  useEffect(() => {
    if (openRequest?.pairingId === id) { setOpenTabId(openRequest.id); setView('terminal'); }
  }, [id, openRequest]);

  const openTab = useCallback((tabId) => { setOpenTabId(tabId); setView('terminal'); }, []);

  if (problem || !connection) return (
    <div className="screen board-screen">
      <header className="board-header"><button className="mac-title" onClick={onMacs}>{pairing.name} ▾</button></header>
      <main className="mac-problem">
        <p className="mac-origin">{origin}</p>
        <p role="status">{problem || 'Connecting to this Mac…'}</p>
        {problem && <>
          <a href={origin} target="_blank" rel="noreferrer">Open this Mac directly</a>
          {!authFailed && <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>}
          <button onClick={onRepair}>Pair this Mac again</button>
        </>}
      </main>
    </div>
  );
  if (view === 'history') return <History connection={connection} onBack={() => setView('board')} />;
  if (view === 'terminal') return <TerminalScreen connection={connection} status={status} initialId={openTabId} onBack={() => setView('board')} onShowHistory={() => setView('history')} />;
  return <Board connection={connection} status={status} macName={pairing.name} onMacs={onMacs}
    onOpen={openTab} onShowHistory={() => setView('history')} />;
}

export default function App() {
  const [state, setState] = useState(null);
  const stateRef = useRef(null);
  const connectionRef = useRef(null);
  const writes = useRef(Promise.resolve());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [pairingUI, setPairingUI] = useState(null);
  const pairingUIRef = useRef(null);
  const [openRequest, setOpenRequest] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const showPairing = (payload) => {
    connectionRef.current?.close();
    pairingUIRef.current = payload;
    setPairingUI(payload);
    setSwitcher(false);
  };

  useEffect(() => {
    let cancelled = false;
    setError('');
    loadPairings(storage, window.location.origin).then((loaded) => {
      if (cancelled) return;
      stateRef.current = loaded;
      setState(loaded);
    }).catch(() => { if (!cancelled) setError('Could not read or save your paired Macs. Check device storage and try again.'); });
    return () => { cancelled = true; };
  }, [loadAttempt]);

  useEffect(() => {
    let cancelled = false;
    let handle;
    let received = false;
    const receive = ({ url }) => {
      if (cancelled) return;
      try {
        const u = new URL(url);
        if (u.protocol !== 'dobiusplus:') return;
        if (u.hostname !== 'pair' && u.pathname.replace(/^\/+/, '').split('/')[0] !== 'pair') return;
        const host = normaliseHost(u.searchParams.get('host') || '');
        const code = (u.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);
        if (!host && !code) return;
        received = true;
        // Every scan requires the existing human confirmation, even for a
        // Tailscale address. That address alone cannot establish ownership.
        showPairing({ host, code, nonce: (pairingUIRef.current?.nonce || 0) + 1, confirm: !!host });
      } catch { /* malformed link */ }
    };
    (async () => {
      try {
        const { App: NativeApp } = await import('@capacitor/app');
        if (cancelled) return;
        handle = await NativeApp.addListener('appUrlOpen', receive);
        if (cancelled) { await handle.remove(); return; }
        const launch = await NativeApp.getLaunchUrl();
        if (launch && !received) receive(launch);
      } catch { /* browser has no native listener */ }
    })();
    return () => { cancelled = true; handle?.remove(); };
  }, []);

  const update = (change) => {
    const work = writes.current.then(async () => {
      setBusy(true);
      setError('');
      try {
        const next = change(stateRef.current);
        await savePairings(storage, next);
        const before = activePairing(stateRef.current);
        const after = activePairing(next);
        if (before?.id !== after?.id || before?.token !== after?.token) {
          connectionRef.current?.close();
          setOpenRequest(null);
        }
        stateRef.current = next;
        setState(next);
        return true;
      } catch {
        setError('Could not save your paired Macs. Check device storage and try again.');
        return false;
      } finally { setBusy(false); }
    });
    writes.current = work;
    return work;
  };

  useEffect(() => {
    if (!state) return undefined;
    const openSession = async ({ id, pairingId, origin }) => {
      const current = stateRef.current;
      const target = pairingId ? current.pairings.find((p) => p.id === pairingId)
        : current.pairings.find((p) => p.origin === normaliseHost(origin || window.location.origin));
      if (!id || !target) return;
      if (target.id !== current.activeId && !await update((s) => switchPairing(s, target.id, Date.now()))) return;
      setOpenRequest({ pairingId: target.id, id });
    };
    const params = new URLSearchParams(window.location.search);
    if (params.has('open')) {
      openSession({ id: params.get('open'), pairingId: params.get('mac') });
      window.history.replaceState(null, '', window.location.pathname);
    }
    const onMessage = (e) => { if (e.data?.type === 'open-session') openSession(e.data); };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
    // The listener reads current state through stateRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!state]);

  if (!state) return <div className="screen center"><p className="mac-error">{error || 'Loading…'}</p>{error && <button onClick={() => setLoadAttempt((n) => n + 1)}>Retry</button>}</div>;
  const active = activePairing(state);
  const cancelPairing = () => { pairingUIRef.current = null; setPairingUI(null); };
  const handlePaired = async ({ token, host }) => {
    const shown = pairingUI;
    const ok = await update((s) => upsertPairing(s, { origin: host, token }, { id: crypto.randomUUID?.() || `mac-${Date.now()}-${Math.random().toString(36).slice(2)}`, now: Date.now() }));
    if (!ok) throw new Error('Could not save this pairing. Check device storage and get a new pairing code.');
    const current = pairingUIRef.current;
    // A scan can arrive during the storage write, or before React commits its
    // new props. Only dismiss the form that actually submitted this pairing.
    if (shown === current || (shown && current && shown.host === current.host && shown.code === current.code)) cancelPairing();
  };

  if (pairingUI || !active) return <Pairing initialHost={pairingUI?.host || ''} initialCode={pairingUI?.code || ''}
    scanNonce={pairingUI?.nonce || 0} requireConfirm={pairingUI?.confirm || false} addMode={!!active}
    onCancel={active ? cancelPairing : undefined} onPaired={handlePaired} />;
  return <>
    <MacSession key={`${active.id}:${active.token}`} pairing={active} connectionRef={connectionRef} openRequest={openRequest}
      onMacs={() => { setError(''); setSwitcher(true); }} onRepair={() => showPairing({ host: active.origin })} />
    {switcher && <MacSwitcher state={state} busy={busy} error={error} onClose={() => setSwitcher(false)}
      onSwitch={async (id) => { if (await update((s) => switchPairing(s, id, Date.now()))) setSwitcher(false); }}
      onRename={(id, name) => update((s) => renamePairing(s, id, name))}
      onRemove={(id) => update((s) => removePairing(s, id))}
      onAdd={() => showPairing({ host: '' })} />}
  </>;
}
