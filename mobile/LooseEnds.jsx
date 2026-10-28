import { useState, useEffect, useRef } from 'react';
import { timeAgo } from './format';
import { pairingKey } from './pairings';
import { parseDismissed, visibleLooseEnds, withDismissal } from '../shared/loose-dismiss.js';

/**
 * Loose ends on the phone: work you started and walked away from.
 *
 * Triage happens away from the desk, which is exactly where an abandoned
 * session is easiest to forget, so this lives on the board rather than behind
 * a nav entry. It renders NOTHING when there is nothing hanging: a list you
 * have to remember to go check is useless for remembering things, and a
 * permanent empty panel is just noise on a small screen.
 *
 * Collapsed by default so the count is a one-line nudge, not a wall of text
 * under the live sessions.
 */
const OPEN_KEY = 'dobius-mobile-loose-open';
const DISMISSED_KEY = 'dobius-mobile-loose-dismissed';

// Dismissals are device-local, matching pins and collapsed groups. The rule
// for what a dismissal covers lives in shared/loose-dismiss.js so the desktop
// tab and this one cannot drift.
const loadDismissed = (key) => {
  try { return parseDismissed(localStorage.getItem(key)); } catch { return {}; }
};

export default function LooseEnds({ connection }) {
  const openKey = pairingKey(connection.pairing, OPEN_KEY);
  const dismissedKey = pairingKey(connection.pairing, DISMISSED_KEY);
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(openKey) === '1'; } catch { return false; } });
  const [dismissed, setDismissed] = useState(() => loadDismissed(dismissedKey));
  // One resume per mount. A second tap during the Tailscale round-trip would
  // spawn a second terminal running `claude --resume` on the SAME session, so
  // the guard is not cosmetic. Board navigates away on `terminalCreated`.
  const resumingRef = useRef(false);
  const [resuming, setResuming] = useState('');
  // Two-tap confirm for an oversized transcript, kept in a ref as well so the
  // check inside resume() sees it without waiting for a re-render.
  const confirmingRef = useRef(null);
  const [confirming, setConfirming] = useState('');

  useEffect(() => {
    const off = connection.onMessage((msg) => {
      if (msg.type === 'authed') {
        // Re-issue on reconnect, same as the board's listTerminals: iOS kills
        // the socket whenever the PWA backgrounds.
        connection.send({ type: 'listLooseEnds' });
      } else if (msg.type === 'looseEnds') {
        setItems(Array.isArray(msg.list) ? msg.list : []);
        // Deliberately does NOT clear `confirming`: a refresh can land between
        // the two taps of an oversized-transcript confirm (the very first
        // listLooseEnds is often still in flight), and clearing it made the
        // second tap silently re-arm instead of resuming, so the button did
        // nothing twice in a row. Codex Medium.
      }
      // NOT cleared on {type:'error'}: the server sends errors with no
      // correlation id, so an unrelated failure (a stale createTerminal from
      // the board's picker) would release the guard while OUR resume is still
      // in flight, and a second tap would run the same transcript twice.
      // Codex High. The timer below is the only release for a failed resume.
    });
    if (connection.status === 'authed') connection.send({ type: 'listLooseEnds' });
    return off;
  }, [connection]);

  // Release the resume guard on a deadline. Success needs no timer (the board
  // navigates into the new terminal on `terminalCreated`, unmounting this),
  // so the timer exists purely so a REFUSED resume does not leave the section
  // permanently stuck. Long enough to outlast a slow Tailscale round trip.
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const dismiss = (item) => {
    setDismissed((cur) => {
      const next = withDismissal(cur, item);
      try { localStorage.setItem(dismissedKey, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };

  const resume = (item) => {
    if (resumingRef.current) return;
    // Same 80MB gate the desktop applies. A transcript this big takes minutes
    // for Claude to load and gets compacted on the way in, and the phone is
    // the LAST place to discover that: you tap, walk away, and come back to a
    // session that spent your context budget re-reading itself. Desktop uses
    // window.confirm; the PWA asks in place so the answer survives iOS.
    if (item.sizeMB > 80 && confirmingRef.current !== item.sessionId) {
      confirmingRef.current = item.sessionId;
      setConfirming(item.sessionId);
      return;
    }
    confirmingRef.current = null;
    setConfirming('');
    resumingRef.current = true;
    setResuming(item.sessionId);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      resumingRef.current = false;
      setResuming('');
    }, 15000);
    // projectPath is REQUIRED: the server routes it through the same known-
    // project allowlist createTerminal uses, and without it the session would
    // resume in the wrong directory (the desktop had this exact bug).
    connection.send({ type: 'resumeSession', sessionId: item.sessionId, projectPath: item.projectPath });
  };

  const visible = visibleLooseEnds(items, dismissed);
  if (visible.length === 0) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(openKey, next ? '1' : '0'); } catch { /* private mode */ }
  };

  return (
    <section className="board-group board-loose">
      <button className="board-group-head board-group-toggle" onClick={toggle}>
        <span className="board-group-caret">{open ? '▾' : '▸'}</span>
        <span className="board-group-name">Loose ends</span>
        <span className="board-group-count">
          {visible.length} unfinished
        </span>
      </button>
      {open && visible.map((item) => (
        <div key={item.sessionId} className="loose-row">
          <div className="loose-main">
            <div className="loose-head">
              <span className="card-title">{item.projectName}</span>
              <span className="muted small">{timeAgo(item.lastActivityAt)}</span>
            </div>
            <div className="card-sub">
              {item.ending === 'interrupted' ? 'you interrupted it'
                : item.ending === 'unanswered' ? 'never answered you' : 'stopped mid-task'}
              {item.sizeMB > 80 && ` · ${Math.round(item.sizeMB)}MB`}
            </div>
            {/* For an unanswered ending the snippet IS your hanging prompt. */}
            {item.snippet && (
              <div className="loose-snippet">
                {item.ending === 'unanswered' ? `You asked: ${item.snippet}` : item.snippet}
              </div>
            )}
            {confirming === item.sessionId && (
              <div className="loose-warn">
                {Math.round(item.sizeMB)}MB transcript. Claude can take a while to load
                it and may compact it. Tap Resume again to go ahead.
              </div>
            )}
          </div>
          <div className="loose-actions">
            {/* Disabled comes from STATE, not the ref: reading a ref during
                render is impure, and the ref exists only to block the second
                tap synchronously, before React has re-rendered. */}
            <button
              className="resume-btn"
              disabled={!!resuming}
              onClick={() => resume(item)}
            >
              {resuming === item.sessionId ? 'Opening…'
                : confirming === item.sessionId ? 'Resume anyway' : 'Resume'}
            </button>
            <button
              className="loose-dismiss"
              onClick={() => dismiss(item)}
              aria-label="Hide this loose end"
            >
              Not important
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
