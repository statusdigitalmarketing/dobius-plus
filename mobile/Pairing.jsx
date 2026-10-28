import { useState, useRef, useEffect } from 'react';
import { absUrl, normaliseHost, setHost as persistHost } from './host';
import Intro from './Intro';

/**
 * First-run pairing. Two steps when there's no stored Mac host (public App
 * Store build): host entry, then the 6-digit code. On the second launch the
 * host is already stored and the user only sees the code step. A
 * `dobiusplus://pair?host=...&code=...` deep link pre-fills both fields and
 * skips the host step. The TestFlight self-use build hardcoded the host via
 * capacitor.config.json's server.url; that is removed in this PR so the
 * app can ship to users who are not on Sam's Tailnet.
 */
export default function Pairing({ initialHost = '', initialCode = '', scanNonce = 0, requireConfirm = false, onPaired, onCancel }) {
  const [step, setStep] = useState(initialHost ? 'code' : 'host');
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
  // sentinel so the FIRST run always applies (a scan that completed before
  // Pairing mounted, for example, still fires the effect with its scheduled
  // submit).
  const appliedNonceRef = useRef(null);

  // submit() is declared BEFORE the deep-link useEffect so the useEffect's
  // closure captures an initialized binding even on renders that return
  // early (showIntro). If submit lived below the early return it would be
  // in the Temporal Dead Zone when the deep-link scheduled callback fired.
  const submit = async (c, hArg) => {
    const codeToSend = (c ?? code).replace(/\D/g, '');
    const hostToUse = hArg ?? host;
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
      const res = await fetch(absUrl(hostToUse, '/pair'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeToSend, deviceName: navigator.userAgent.includes('iPad') ? 'iPad' : 'Phone' }),
      });
      const data = await res.json();
      if (generation !== generationRef.current) return; // superseded
      if (data.ok && data.token) {
        onPaired({ token: data.token, host: hostToUse });
      } else {
        setError(data.error || 'Pairing failed.');
        setCode('');
      }
    } catch {
      if (generation !== generationRef.current) return; // superseded
      setError('Could not reach Dobius+. Check Tailscale is on and the Mac is awake.');
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
    // Share the generation counter with submit() so a scan or Change Mac
    // Address tap during the slow /health probe invalidates this attempt:
    // its continuation would otherwise call persistHost() for Mac A after
    // the user has already paired Mac B, overwriting the stored origin
    // while keeping B's token.
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
      const probe = await fetch(absUrl(normalised, '/health'));
      if (!stillCurrent()) return;
      if (!probe.ok) throw new Error('bad');
      const data = await probe.json();
      if (!stillCurrent()) return;
      if (!data || data.app !== 'dobius-plus') throw new Error('wrong app');
    } catch {
      if (!stillCurrent()) return;
      setError('Could not reach that address. Check Tailscale is on, the Mac is awake, and Dobius+ is running.');
      return;
    }
    if (!stillCurrent()) return;
    // Already paired (onCancel): the stored address stays the paired Mac's
    // until a new pairing succeeds, or backing out would send the old token
    // to this one. handlePaired saves the new address on success.
    if (!onCancel) await persistHost(normalised);
    if (!stillCurrent()) return;
    setHost(normalised);
    setStep('code');
  };

  // Deep-link sync: whenever App.jsx receives a dobiusplus://pair?host&code
  // URL (cold or warm start), update state and auto-submit. scanNonce is a
  // monotonic counter so a RESCAN of an identical QR (after a transient
  // pairing failure, say) still fires this effect: dep equality on host/code
  // alone would see no change and silently drop the retry. The appliedNonce
  // guard prevents unrelated re-renders (busy/error state, showIntro
  // flipping) from clobbering a user's manual edits by re-applying stale
  // initialHost/initialCode props.
  //
  // Supersession and dedupe are governed by inFlightKeyRef. If the scan's
  // (host, code) differs from any pending in-flight request, we bump
  // generation BEFORE the deferred submit runs so an older response that
  // settles in the gap cannot still complete pairing against the Mac the
  // scan is replacing. If the scan is the SAME payload as what is in
  // flight, we skip both bump and submit: the original request's response
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
    const willSubmit = false;
    if (!sameAsInflight) {
      generationRef.current += 1;
      inFlightKeyRef.current = '';
      setBusy(false);
    }
    setHost(initialHost);
    if (initialCode) setCode(initialCode);
    setStep(requireConfirm ? 'confirm' : 'code');
    if (willSubmit) {
      // Defer the actual submit so React commits the step change first.
      // submit reads the host arg explicitly so a race on the host state
      // does not matter. Capture generation at scheduling time: if a later
      // scan supersedes before this timer fires, the pending submission
      // self-cancels so a response for the old selection cannot complete
      // pairing against the Mac the user just replaced.
      const scheduledGeneration = generationRef.current;
      setTimeout(() => {
        if (scheduledGeneration !== generationRef.current) return;
        submit(initialCode, initialHost);
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <h1>Dobius+</h1>
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
              style={{ marginTop: 12, background: 'none', border: 'none', color: 'inherit', opacity: 0.7, fontSize: 14 }}
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
                // Bump generation so any pending deferred submit from a
                // scan self-cancels, and clear in-flight bookkeeping so a
                // later same-payload action does not dedupe against a dead
                // request.
                generationRef.current += 1;
                inFlightKeyRef.current = '';
                setBusy(false);
                setStep('host');
                setCode('');
                setError('');
              }}
              disabled={busy}
              style={{ marginTop: 12, background: 'none', border: 'none', color: 'inherit', opacity: 0.7, fontSize: 14 }}
            >
              Change Mac address
            </button>
            {error && <p className="error">{error}</p>}
          </>
        )}
        {/* Already paired (a re-pair from the board, or a new pairing link):
            leave without touching the current pairing. */}
        {onCancel && (
          <button
            className="link-button"
            onClick={() => { generationRef.current += 1; inFlightKeyRef.current = ''; setBusy(false); onCancel(); }}
            style={{ display: 'block', margin: '20px auto 0', background: 'none', border: 'none', color: 'inherit', opacity: 0.7, fontSize: 14, cursor: 'pointer' }}
          >
            Keep current pairing
          </button>
        )}
      </div>
    </div>
  );
}
