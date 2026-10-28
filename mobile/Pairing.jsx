import { useState, useRef, useEffect } from 'react';
import { absUrl, normaliseHost, mixedContent, reachabilityMessage } from './host';
import Intro from './Intro';

/** Pair a first or additional Mac. Scans always require a human confirmation. */
export default function Pairing({ initialHost = '', initialCode = '', scanNonce = 0, requireConfirm = false, addMode = false, onCancel, onPaired }) {
  const [step, setStep] = useState(requireConfirm ? 'confirm' : initialHost ? 'code' : 'host');
  const [host, setHost] = useState(initialHost || '');
  const [code, setCode] = useState(initialCode || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showIntro, setShowIntro] = useState(false);
  const hostRef = useRef(null);
  const codeRef = useRef(null);
  // Monotonic counter: every submit() bumps it, and continueFromHost /
  // the deep-link effect bump it when they start new async work. A response
  // whose captured generation is older than the current value is dropped,
  // so a scan or user action can supersede any pending request.
  const generationRef = useRef(0);
  // Deduplicate submits that share the SAME (host, code). Enter twice while
  // a request is pending otherwise bumps generation twice, drops the
  // successful first response as "superseded", and leaves the user staring
  // at "Invalid pairing code" because the server rotated the single-use
  // code after the first success. Same-payload scans dedupe through this
  // ref as well, keeping the original request alive to clear busy.
  const inFlightKeyRef = useRef('');
  // Last scan nonce whose payload we've applied to state. React would
  // otherwise re-run the deep-link effect on every unrelated re-render
  // (showIntro flipping, state changes), overwriting whatever the user
  // typed on the host step with a stale initialHost / initialCode. Null
  // sentinel so a scan received before Pairing mounted is still applied.
  const appliedNonceRef = useRef(null);
  const requestRef = useRef(null);
  useEffect(() => () => {
    generationRef.current += 1;
    requestRef.current?.abort();
  }, []);

  const request = async (origin, path, options = {}) => {
    if (mixedContent(origin, window.location.origin)) throw new Error(reachabilityMessage(origin, window.location.origin));
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(absUrl(origin, path), { ...options, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
      return { res, data: await res.json() };
    } finally { clearTimeout(timer); }
  };

  const submit = async (c, hArg) => {
    const codeToSend = (c ?? code).replace(/\D/g, '');
    const hostToUse = normaliseHost(hArg ?? host);
    if (!hostToUse) return;
    if (codeToSend.length !== 6) return;
    const requestKey = `${hostToUse}|${codeToSend}`;
    if (inFlightKeyRef.current === requestKey) return; // dedupe duplicate taps
    // Supersede any OLDER in-flight request by bumping generation. A
    // different-payload submit replaces an in-flight one; a same-payload
    // submit is dropped above.
    const generation = ++generationRef.current;
    inFlightKeyRef.current = requestKey;
    setBusy(true);
    setError('');
    try {
      const { data } = await request(hostToUse, '/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeToSend, deviceName: navigator.userAgent.includes('iPad') ? 'iPad' : 'Phone' }),
      });
      if (generation !== generationRef.current) return; // superseded
      if (data.ok && data.token) {
        await onPaired({ token: data.token, host: hostToUse, name: typeof data.name === 'string' ? data.name : '' });
      } else {
        setError(data.error || 'Pairing failed.');
        setCode('');
      }
    } catch (e) {
      if (generation !== generationRef.current) return; // superseded
      setError(e?.message?.startsWith('Could not save') ? e.message : reachabilityMessage(hostToUse, window.location.origin));
    } finally {
      if (generation === generationRef.current) {
        inFlightKeyRef.current = '';
        setBusy(false);
      }
    }
  };

  const continueFromHost = async () => {
    const normalised = normaliseHost(host);
    if (!normalised) { setError('Enter a host like 100.89.143.67:8420 or my-mac.ts.net.'); return; }
    // A scan or Change Mac Address tap invalidates the pending health probe.
    const generation = ++generationRef.current;
    const stillCurrent = () => generation === generationRef.current;
    // Also take over cleanup for any pending submit that this generation
    // bump just superseded: its finally will skip the busy/inFlight clear,
    // and without this the UI would stall or a later same-payload submit
    // would dedupe against the stale inFlightKey.
    if (inFlightKeyRef.current) {
      inFlightKeyRef.current = '';
      setBusy(false);
    }
    setError('');
    try {
      const { res: probe, data } = await request(normalised, '/health');
      if (!stillCurrent()) return;
      if (!probe.ok) throw new Error('bad');
      if (!stillCurrent()) return;
      if (!data || data.app !== 'dobius-plus') throw new Error('wrong app');
    } catch {
      if (!stillCurrent()) return;
      setError(reachabilityMessage(normalised, window.location.origin));
      return;
    }
    if (!stillCurrent()) return;
    setHost(normalised);
    setStep('code');
  };

  // Deep-link sync: whenever App.jsx receives a dobiusplus://pair?host&code
  // URL (cold or warm start), update state and require confirmation. scanNonce is a
  // monotonic counter so a RESCAN of an identical QR (after a transient
  // pairing failure, say) still fires this effect: dep equality on host/code
  // alone would see no change and silently drop the retry. The appliedNonce
  // guard prevents unrelated re-renders (busy/error state, showIntro
  // flipping) from clobbering a user's manual edits by re-applying stale
  // initialHost/initialCode props.
  //
  // Supersession and dedupe are governed by inFlightKeyRef. If the scan's
  // (host, code) differs from any pending in-flight request, we bump
  // generation so an older response cannot complete pairing against the
  // Mac the scan is replacing. For the SAME payload already in flight,
  // keep its generation: the original request's response
  // completes normally. Host-only scans (no code) still bump generation,
  // and because no replacement submit runs, THIS effect takes
  // responsibility for clearing busy and inFlightKeyRef so the UI does
  // not stall when the superseded request's finally skips those clears.
  useEffect(() => {
    if (showIntro) return;
    if (scanNonce === appliedNonceRef.current) return;
    appliedNonceRef.current = scanNonce;
    if (!initialHost) return;
    const requestKey = `${initialHost}|${initialCode || ''}`;
    const sameAsInflight = inFlightKeyRef.current && inFlightKeyRef.current === requestKey;
    // A deep-linked host is NEVER auto-submitted: no network-observable
    // property establishes that it is actually the user's own Mac (CGNAT
    // ranges are shared with other networks, .ts.net is per-tenant and
    // reachable publicly through Funnel). Every scan therefore routes to
    // the 'confirm' step for an explicit user tap, even when the deep
    // link had no code (user types the code there if they must).
    if (!sameAsInflight) {
      generationRef.current += 1;
      requestRef.current?.abort();
      inFlightKeyRef.current = '';
      setBusy(false);
    }
    setHost(initialHost);
    setCode(initialCode || '');
    setError('');
    setStep(requireConfirm ? 'confirm' : 'code');
  }, [initialHost, initialCode, scanNonce, requireConfirm, showIntro]);

  useEffect(() => {
    if (showIntro) return;
    if (step === 'host') hostRef.current?.focus();
    else codeRef.current?.focus();
  }, [step, showIntro]);

  if (showIntro) return <Intro onBack={() => setShowIntro(false)} />;

  return (
    <div className="screen pairing">
      <div className="pairing-card">
        <h1>{addMode ? 'Add a Mac' : 'Dobius+'}</h1>
        {step === 'confirm' ? (
          <>
            <p className="muted">Pair with this Mac?</p>
            <div
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                padding: '14px 16px',
                margin: '12px 0 16px',
                fontFamily: "'SF Mono', monospace",
                fontSize: 14,
                wordBreak: 'break-all',
                textAlign: 'left',
              }}
            >
              {host || '(no address)'}
            </div>
            <p className="muted" style={{ fontSize: 13, marginBottom: 16 }}>
              Only continue if this is YOUR Mac. Scanned addresses are not verified: a .ts.net name
              can be served publicly through Tailscale Funnel, and CGNAT addresses are shared with
              other networks.
            </p>
            <input
              ref={codeRef}
              className="code-input"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="one-time-code"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6 && !busy) submit(code, host); }}
            />
            <button
              className="primary"
              onClick={() => submit(code, host)}
              disabled={busy || !host || code.length !== 6}
            >
              {busy ? 'Pairing...' : 'Pair this device'}
            </button>
            <button
              className="link-button"
              onClick={() => {
                generationRef.current += 1;
                inFlightKeyRef.current = '';
                setBusy(false);
                setStep('host');
                setCode('');
                setError('');
              }}
              disabled={busy}
              style={{ marginTop: 12, background: 'none', border: 'none', opacity: 0.7, fontSize: 14 }}
            >
              Cancel
            </button>
            {error && <p className="error">{error}</p>}
          </>
        ) : step === 'host' ? (
          <>
            <p className="muted">Enter your Mac's Tailscale address or hostname. Open Dobius+ on your Mac &rsaquo; Settings &rsaquo; Mobile Access to see it.</p>
            <input
              ref={hostRef}
              className="code-input"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="100.89.143.67:8420"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') continueFromHost(); }}
              style={{ fontSize: 18, letterSpacing: 'normal' }}
            />
            <button className="primary" onClick={continueFromHost} disabled={!host.trim()}>Continue</button>
            {error && <p className="error">{error}</p>}
            <button
              className="link-button"
              onClick={() => setShowIntro(true)}
              style={{ marginTop: 20, background: 'none', border: 'none', color: '#D97757', fontSize: 14, cursor: 'pointer' }}
            >
              What is Dobius+?
            </button>
          </>
        ) : (
          <>
            <p className="muted">Enter the 6-digit code from Settings &rsaquo; Mobile Access on your Mac.</p>
            <input
              ref={codeRef}
              className="code-input"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="one-time-code"
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            />
            <button className="primary" onClick={() => submit()} disabled={code.length !== 6 || busy}>
              {busy ? 'Pairing...' : 'Pair this device'}
            </button>
            <button
              className="link-button"
              onClick={() => {
                // Invalidate requests for the previous address.
                generationRef.current += 1;
                inFlightKeyRef.current = '';
                setBusy(false);
                setStep('host');
                setCode('');
                setError('');
              }}
              disabled={busy}
              style={{ marginTop: 12, background: 'none', border: 'none', color: 'var(--fg)', opacity: 0.7, fontSize: 14 }}
            >
              Change Mac address
            </button>
            {error && <p className="error">{error}</p>}
          </>
        )}
        {error && normaliseHost(host) && <a className="mac-direct" href={normaliseHost(host)} target="_blank" rel="noreferrer">Open this Mac directly</a>}
        {onCancel && <button className="mac-cancel" onClick={onCancel} disabled={busy}>Back to your Macs</button>}
      </div>
    </div>
  );
}
