import { useState, useRef } from 'react';

/**
 * Pairing screen. The PWA is served by the Dobius+ server, so the origin is
 * already the server, so we only need the 6-digit code shown on the desktop.
 */
export default function Pairing({ onPaired }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const submit = async () => {
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('./pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName: navigator.userAgent.includes('iPad') ? 'iPad' : 'Phone' }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        onPaired(data.token);
      } else {
        setError(data.error || 'Pairing failed.');
        setCode('');
      }
    } catch (err) {
      setError('Could not reach Dobius+. Is Tailscale on?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen pairing">
      <div className="pairing-card">
        <h1>Dobius+</h1>
        <p className="muted">Enter the 6-digit code from Settings &rsaquo; Mobile Access on your Mac.</p>
        <input
          ref={inputRef}
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
        <button className="primary" onClick={submit} disabled={code.length !== 6 || busy}>
          {busy ? 'Pairing...' : 'Pair this device'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
