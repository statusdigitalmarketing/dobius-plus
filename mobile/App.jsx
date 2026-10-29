import { useState, useEffect, useRef, useCallback } from 'react';
import Pairing from './Pairing';
import Board from './Board';
import TerminalScreen from './Terminal';
import History from './History';
import MacSwitcher from './MacSwitcher';
import { Connection } from './connection';
import * as storage from './storage';
import { normaliseHost, mixedContent, reachabilityMessage } from './host';
import { forgetPush } from './push-client';
import { PAIRINGS_KEY, activePairing, loadPairings, readPairings, savePairings, upsertPairing, switchPairing, renamePairing, removePairing } from './pairings';

// A keyed tree owns all state for one connection lifetime, including terminal,
// selector, transcript, History and skills state. Rename does not remount it.
// Notification taps can arrive before App has loaded its Macs (the load waits
// on storage and a Web Lock), so the listener is installed at module load and
// taps are held until App takes them (Codex).
const pendingTaps = [];
let tapHandler = null;
if (typeof navigator !== 'undefined') {
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type !== 'open-session') return;
    if (tapHandler) tapHandler(e.data); else pendingTaps.push(e.data);
  });
}

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
      <header className="board-header elevated">
        <div className="board-title-row">
          <button className="tb-round" onClick={onMacs} aria-label={`Switch Mac, current Mac: ${pairing.name}`}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2.5 19h19" /></svg>
          </button>
          <button className="board-title-mid" onClick={onMacs} aria-label={`Switch Mac, current Mac: ${pairing.name}`}>
            <span className="board-title-main">{pairing.name}</span>
            <span className="board-title-sub">{problem ? 'offline' : 'connecting'}</span>
          </button>
          <span className="tb-spacer" aria-hidden="true" />
        </div>
      </header>
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

// The id of a paired Mac, at an address other than `origin`, that is the same
// server as the one just paired. Proof: that address answers POST /same-mac
// with HMAC(record's token, nonce), which only the server holding that token
// can make, while accepting the token just issued. The saved token itself is
// never sent (a different Mac can hold the same tailnet IP: Codex P1), only
// its hash. The new token only goes to addresses the new Mac named itself.
// null when there is none, it cannot be reached, or WebCrypto is missing (a
// plain-HTTP browser page): both records then stay.
async function sameMacAs(state, origin, token, hosts) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const own = new Set(hosts.map((h) => String(h).toLowerCase().replace(/\.$/, '')));
  const hostOf = (o) => { try { return new URL(o).hostname.toLowerCase(); } catch { return ''; } };
  const target = normaliseHost(origin);
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  for (const p of state?.pairings || []) {
    if (p.origin === target || !own.has(hostOf(p.origin))) continue;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
      const key = await subtle.importKey('raw', enc.encode(p.token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const want = hex(await subtle.sign('HMAC', key, enc.encode(nonce)));
      const tokenHash = hex(await subtle.digest('SHA-256', enc.encode(p.token)));
      const res = await fetch(`${p.origin}/same-mac`, {
        method: 'POST', body: JSON.stringify({ tokenHash, nonce }), signal: ctl.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (body?.ok === true && body.proof === want) return p.id;
    } catch { /* unreachable from here (mixed content, offline): keep both */ } finally { clearTimeout(timer); }
  }
  return null;
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
  // Bumped to give the shown Mac a fresh connection after a notification tap
  // disconnected it and the switch then failed.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  // A notification tap is switching Macs: the screen is covered meanwhile.
  const [switchingTo, setSwitchingTo] = useState(null);
  const tapSeqRef = useRef(0);
  // Every operation is numbered when it is REQUESTED; a warning remembers the
  // number it was shown at, and only an operation requested after it may
  // clear it (a rename queued earlier must not erase a newer tap's warning).
  const opSeqRef = useRef(0);
  const errorSeqRef = useRef(0);
  // A tap in the current run closed a connection; the newest tap reconnects.
  const tapClosedRef = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const showPairing = (payload) => {
    connectionRef.current?.close();
    pairingUIRef.current = payload;
    setPairingUI(payload);
    setSwitcher(false);
  };

  // Tabs of the same PWA share the document, so loading (which may migrate)
  // and every read-change-write run under one Web Lock across all of them
  // (Codex High). Web Locks exist only in a secure context: on a plain-HTTP
  // page this serializes within the tab only. ACCEPTED: two HTTP tabs both
  // saving within the same few milliseconds can still overwrite each other;
  // iOS freezes background tabs, and HTTPS (Settings > Mobile) closes it.
  const exclusive = (fn) => (navigator.locks?.request ? navigator.locks.request('dobius-mobile-pairings', fn) : fn());

  useEffect(() => {
    let cancelled = false;
    setError('');
    exclusive(() => loadPairings(storage, window.location.origin)).then((loaded) => {
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

  // Scanned a Mac's QR code in a browser (shared/pairing-link.js
  // buildPairingWebLink): this page was opened at <origin>/#pair=<code>. Read
  // the code, take it out of the address bar, and send it through the same
  // path as a native scan, CONFIRM STEP INCLUDED: being served from an origin
  // does not prove it is the user's own Mac (anyone can host this bundle and
  // text the link). Already paired with other Macs, it adds this one. Native
  // builds take dobiusplus:// links above instead.
  useEffect(() => {
    if (window.Capacitor?.isNativePlatform?.() === true) return undefined;
    // Never inside a frame: a page that frames this one could lay the Pair
    // button under its own and hide the address shown for confirmation.
    if (window.top !== window.self) return undefined;
    const consume = () => {
      // `#pair=<code>` over HTTPS, bare `#pair` (address only) over HTTP.
      const m = /^#pair(?:=(\d{6}))?$/.exec(window.location.hash || '');
      if (!m) return;
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      showPairing({ host: window.location.origin, code: m[1] || '', nonce: (pairingUIRef.current?.nonce || 0) + 1, confirm: true });
    };
    consume();
    window.addEventListener('hashchange', consume); // a second scan in the same tab
    return () => window.removeEventListener('hashchange', consume);
  }, []);

  // Show a document as the current one, ending the old Mac's connection when
  // the active Mac or its token changed.
  const adopt = (next) => {
    const before = activePairing(stateRef.current);
    const after = activePairing(next);
    if (before?.id !== after?.id || before?.token !== after?.token) {
      connectionRef.current?.close();
      setOpenRequest(null);
      // Force a fresh session: batched A-to-B-to-A adoptions keep the same key
      // and would otherwise keep A's closed connection (Codex). Batched with a
      // key change, this still mounts once.
      setSessionEpoch((n) => n + 1);
    }
    stateRef.current = next;
    setState(next);
  };

  // Every change starts from the SAVED document, not this tab's copy: another
  // tab (or a save whose read-back failed after it was written) may hold a
  // newer one, and writing a stale copy over it erases a pairing whose token
  // cannot be recovered without walking to that Mac (Codex High, two lenses).
  const update = (change) => {
    const mySeq = ++opSeqRef.current;
    const work = writes.current.then(async () => {
      setBusy(true);
      try {
        await exclusive(async () => {
          const base = (await readPairings(storage)) || stateRef.current;
          const next = change(base);
          // A superseded tap returns the document unchanged, and an older
          // operation predates the warning: neither may clear it (Codex).
          if (next !== base && mySeq > errorSeqRef.current) setError('');
          await savePairings(storage, next);
          adopt(next);
        });
        return true;
      } catch {
        setError('Could not save your paired Macs. Check device storage and try again.');
        try { const saved = await readPairings(storage); if (saved) adopt(saved); } catch { /* keep what is shown */ }
        return false;
      } finally { setBusy(false); }
    });
    writes.current = work;
    return work;
  };

  // Another browser tab of this PWA saved a change: show it here too.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== PAIRINGS_KEY || e.newValue === null) return;
      readPairings(storage).then((saved) => { if (saved) adopt(saved); }).catch(() => { /* unreadable: keep what is shown */ });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!state) return undefined;
    // A notification tap: switch to the Mac it came from, and open its
    // session when it names one (a failure notice names none, but still
    // belongs to its own Mac: Codex). A notification from before multi-Mac
    // (no pairing id) or from a root-scope worker ('legacy') belongs to the
    // migrated single Mac. NEVER guess by the serving origin: when that Mac
    // was removed, the tap would land on another Mac whose tab ids collide.
    // Every tap goes through the ordered update queue, even for the Mac
    // already shown, so the LAST tap wins over an earlier one still waiting.
    // When the tap cannot reach its Mac (removed, or the switch did not save),
    // say so and show the Mac list, rather than leaving another Mac's terminal
    // (whose tab ids may match) in front with no sign anything failed (Codex).
    const cannotOpen = (message) => {
      setOpenRequest(null);
      setSwitcher(true);
      errorSeqRef.current = ++opSeqRef.current;
      setError(message);
    };
    const removedMessage = 'That notification came from a Mac that is no longer paired with this app.';
    // Taps are numbered and only the NEWEST one acts: an older tap still
    // waiting for the pairing lock leaves the document untouched when it gets
    // its turn, so it cannot switch Macs after a newer tap (Codex High).
    // While any tap is pending the screen is covered: nothing can be typed,
    // sent or confirmed into the Mac being left (Codex High and Medium).
    const openSession = async ({ id, pairingId }) => {
      const seq = ++tapSeqRef.current;
      const wanted = pairingId || 'legacy';
      const target = stateRef.current.pairings.find((p) => p.id === wanted);
      // Keyboard focus leaves the session: the overlay or the Mac list covers
      // it, but a focused composer or terminal would still take hardware keys.
      document.activeElement?.blur?.();
      if (!target) {
        // This tap is the newest: end any overlay an earlier tap left up, and
        // reconnect a Mac an earlier tap disconnected (Codex).
        setSwitchingTo(null);
        if (tapClosedRef.current) { tapClosedRef.current = false; setSessionEpoch((n) => n + 1); }
        cannotOpen(removedMessage);
        return;
      }
      setSwitchingTo(target.name);
      setOpenRequest(null);
      // Disconnect the shown Mac at once, before waiting on storage or the
      // lock, unless it is the one this tap wants.
      if (wanted !== stateRef.current.activeId) { connectionRef.current?.close(); tapClosedRef.current = true; }
      const ok = await update((s) => (seq === tapSeqRef.current ? switchPairing(s, wanted, Date.now()) : s));
      if (seq !== tapSeqRef.current) return; // superseded: the newer tap finishes
      setSwitchingTo(null);
      if (!ok) {
        // Removed by another tab meanwhile, or storage refused the switch.
        cannotOpen(stateRef.current.pairings.some((p) => p.id === wanted)
          ? 'Could not switch to the Mac that sent this notification. Check device storage and try again.'
          : removedMessage);
      }
      // Some tap in this run closed a connection: whichever Mac is shown now,
      // give its session a fresh one. Comparing Mac ids cannot tell, because
      // React may not have committed an earlier tap's switch yet (A to B to A
      // keeps the same key and would keep A's closed connection, Codex). A
      // bump batched with a key change mounts once.
      if (tapClosedRef.current) { tapClosedRef.current = false; setSessionEpoch((n) => n + 1); }
      if (ok && id) setOpenRequest({ pairingId: wanted, id });
    };
    const params = new URLSearchParams(window.location.search);
    if (params.has('open') || params.has('mac')) {
      openSession({ id: params.get('open'), pairingId: params.get('mac') });
      window.history.replaceState(null, '', window.location.pathname);
    }
    tapHandler = openSession;
    while (pendingTaps.length) openSession(pendingTaps.shift());
    return () => { tapHandler = null; };
    // The handler reads current state through stateRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!state]);

  if (!state) return <div className="screen center"><p className="mac-error">{error || 'Loading…'}</p>{error && <button onClick={() => setLoadAttempt((n) => n + 1)}>Retry</button>}</div>;
  const active = activePairing(state);
  const cancelPairing = () => { pairingUIRef.current = null; setPairingUI(null); };
  const handlePaired = async ({ token, host, name, hosts = [] }) => {
    const shown = pairingUI;
    // Already paired with this Mac at another of its addresses (HTTP before
    // HTTPS came on)? Keep ONE record, but only when proven: that address must
    // accept the token just issued here, which only the same server can.
    const replaceId = await sameMacAs(stateRef.current, host, token, hosts);
    const ok = await update((s) => upsertPairing(s, { origin: host, token, name }, { id: crypto.randomUUID?.() || `mac-${Date.now()}-${Math.random().toString(36).slice(2)}`, now: Date.now(), replaceId }));
    if (!ok) throw new Error('Could not save this pairing. Check device storage and get a new pairing code.');
    const current = pairingUIRef.current;
    // A scan can arrive during the storage write, or before React commits its
    // new props. Only dismiss the form that actually submitted this pairing.
    if (shown === current || (shown && current && shown.host === current.host && shown.code === current.code)) cancelPairing();
  };

  // First pairing in a browser: the page was served BY a Mac, so start at its
  // code step instead of asking for an address the page already knows.
  const servedBy = !active && !pairingUI && /^https?:$/.test(window.location.protocol) ? window.location.origin : '';
  if (pairingUI || !active) return <Pairing initialHost={pairingUI?.host || servedBy} initialCode={pairingUI?.code || ''}
    scanNonce={pairingUI?.nonce || 0} requireConfirm={pairingUI?.confirm || false} addMode={!!active}
    onCancel={active ? cancelPairing : undefined} onPaired={handlePaired} />;
  return <>
    {switchingTo !== null && <div className="mac-switching" role="status" aria-live="polite">Switching to {switchingTo}…</div>}
    {/* Inert while a tap switches Macs or the Mac list is open (a modal):
        hardware keys must not reach the session underneath (Codex). */}
    <div inert={switchingTo !== null || switcher} className="mac-session-wrap">
    <MacSession key={`${active.id}:${active.token}:${sessionEpoch}`} pairing={active} connectionRef={connectionRef} openRequest={openRequest}
      onMacs={() => { setError(''); setSwitcher(true); }} onRepair={() => showPairing({ host: active.origin })} />
    </div>
    {switcher && <MacSwitcher state={state} busy={busy} error={error} onClose={() => setSwitcher(false)}
      onSwitch={async (id) => {
        // A pick from the list is the newest action too: it supersedes pending
        // taps, and a NEWER tap supersedes it, so its completion never hides
        // a later tap's warning or switch (Codex).
        const seq = ++tapSeqRef.current;
        setSwitchingTo(null);
        const ok = await update((s) => (seq === tapSeqRef.current ? switchPairing(s, id, Date.now()) : s));
        if (ok && seq === tapSeqRef.current) setSwitcher(false);
      }}
      onRename={(id, name) => update((s) => renamePairing(s, id, name))}
      onRemove={async (id) => {
        const ok = await update((s) => removePairing(s, id));
        // A removed Mac must stop notifying this app (Codex). Decided by the
        // saved list, not the result: a save whose read-back failed may still
        // have removed it.
        if (!stateRef.current.pairings.some((p) => p.id === id)) forgetPush(id).catch(() => { /* best effort: the Mac drops a dead endpoint */ });
        return ok;
      }}
      onAdd={() => showPairing({ host: '' })} />}
  </>;
}
