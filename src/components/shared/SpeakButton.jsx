import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store/store';

/**
 * TopBar "Speak" button (v1.0.32). Reads out Claude's last response for the
 * currently active tab via macOS `say`. Speed cycles 1x -> 1.5x -> 2x. A
 * second click while speaking stops playback; a third starts fresh.
 *
 * Rationale for the speed pill design: Sam asked for "1x and 1.5x 2x" as
 * distinct options. Rather than a dropdown that adds clicks, the current
 * speed is shown as a small pill next to the button; the pill is
 * clickable to cycle. That way both actions (start/stop + speed change)
 * are one click each.
 */
const SPEEDS = ['1x', '1.5x', '2x'];

const buttonBase = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  padding: '3px 8px',
  fontSize: 11,
  fontFamily: "'SF Mono', monospace",
  color: 'var(--dim)',
  backgroundColor: 'transparent',
  border: '1px solid transparent',
  borderRadius: 5,
  cursor: 'pointer',
  transition: 'all 150ms',
};

export default function SpeakButton() {
  const activeTabId = useStore((s) => s.activeTabId);
  const activeView = useStore((s) => s.activeView);
  const [speed, setSpeed] = useState(() => {
    try { return localStorage.getItem('dobius:speak:speed') || '1x'; } catch { return '1x'; }
  });
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [status, setStatus] = useState('');
  const pollRef = useRef(null);

  // Poll voice:isActive so the button flips back to "Speak" when `say`
  // finishes naturally (not just when the user clicks stop). Only polls
  // while a play attempt has been made, then stops on completion.
  useEffect(() => {
    if (!isSpeaking) return;
    const check = async () => {
      try {
        const active = await window.electronAPI?.voiceIsActive?.();
        if (!active) setIsSpeaking(false);
      } catch { /* noop */ }
    };
    pollRef.current = setInterval(check, 800);
    return () => { clearInterval(pollRef.current); };
  }, [isSpeaking]);

  // Enabled only when we're on a real terminal tab (Speak has no meaning
  // in Dashboard view).
  const enabled = activeView === 'terminal' && !!activeTabId;

  const doSpeak = async () => {
    if (!enabled) return;
    if (isSpeaking) {
      try { await window.electronAPI?.voiceStop?.(); } catch {}
      setIsSpeaking(false);
      return;
    }
    setStatus('');
    try {
      const r = await window.electronAPI?.voiceSpeakLast?.({ tabId: activeTabId, speed });
      if (r?.ok) {
        setIsSpeaking(true);
      } else {
        setStatus(r?.error || 'could not speak');
        setTimeout(() => setStatus(''), 3000);
      }
    } catch (err) {
      setStatus(String(err?.message || err).slice(0, 80));
      setTimeout(() => setStatus(''), 3000);
    }
  };

  const cycleSpeed = (e) => {
    e.stopPropagation();
    const idx = SPEEDS.indexOf(speed);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    setSpeed(next);
    try { localStorage.setItem('dobius:speak:speed', next); } catch { /* noop */ }
    // If currently speaking, restart at the new speed for immediate feedback.
    if (isSpeaking && enabled) {
      window.electronAPI?.voiceStop?.().then(() => {
        window.electronAPI?.voiceSpeakLast?.({ tabId: activeTabId, speed: next });
      });
    }
  };

  const buttonStyle = {
    ...buttonBase,
    color: isSpeaking ? 'var(--accent)' : buttonBase.color,
    borderColor: isSpeaking ? 'var(--accent)' : 'transparent',
    opacity: enabled ? 1 : 0.4,
    cursor: enabled ? 'pointer' : 'default',
  };

  return (
    <div className="no-drag flex items-center" style={{ gap: 4 }}>
      <button
        onClick={doSpeak}
        disabled={!enabled}
        title={
          !enabled
            ? 'Open a terminal tab to speak the last Claude response'
            : (isSpeaking ? 'Stop reading' : `Read out Claude's last response (${speed})`)
        }
        className="no-drag"
        style={buttonStyle}
        onMouseEnter={(e) => { if (enabled && !isSpeaking) { e.currentTarget.style.color = 'var(--fg)'; e.currentTarget.style.border = '1px solid var(--border)'; }}}
        onMouseLeave={(e) => { if (!isSpeaking) { e.currentTarget.style.color = 'var(--dim)'; e.currentTarget.style.border = '1px solid transparent'; }}}
      >
        {isSpeaking ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        )}
        {isSpeaking ? 'Stop' : 'Speak'}
      </button>
      <button
        onClick={cycleSpeed}
        disabled={!enabled}
        title="Cycle speed 1x / 1.5x / 2x"
        className="no-drag"
        style={{
          ...buttonBase,
          padding: '3px 6px',
          minWidth: 34,
          justifyContent: 'center',
          opacity: enabled ? 1 : 0.4,
          cursor: enabled ? 'pointer' : 'default',
        }}
        onMouseEnter={(e) => { if (enabled) { e.currentTarget.style.color = 'var(--fg)'; e.currentTarget.style.border = '1px solid var(--border)'; }}}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; e.currentTarget.style.border = '1px solid transparent'; }}
      >
        {speed}
      </button>
      {status && (
        <span
          title={status}
          style={{ color: '#f87171', fontSize: 10, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {status}
        </span>
      )}
    </div>
  );
}
