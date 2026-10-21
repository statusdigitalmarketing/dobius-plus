import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { timeAgo } from '../../lib/time-ago';

/**
 * Hover preview for a History row: enough of the conversation to tell
 * sessions apart without opening them. Portaled to <body> so the sidebar's
 * overflow does not clip it; pointer-events none so it never steals the hover
 * from the row it describes. Data comes from main (data:sessionHoverInfo),
 * which tail-reads the transcript and caches by size + mtime.
 */

const CARD_WIDTH = 320;
const GAP = 8;
const ACTIVE_MS = 120 * 1000;
const REFRESH_MS = 3000;

const ENDINGS = {
  interrupted: 'You interrupted it',
  'mid-tool': 'Stopped mid tool call',
  unanswered: 'Ends on your message',
  delivered: 'Claude finished its turn',
};

function shortModel(model) {
  return (model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr', gap: 6 }}>
      <span style={{ color: 'var(--dim)' }}>{label}</span>
      <span
        style={{
          color: 'var(--fg)', overflow: 'hidden', display: '-webkit-box',
          WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', wordBreak: 'break-word',
        }}
      >
        {children}
      </span>
    </div>
  );
}

export default function SessionHoverCard({ session, anchor, tabLabel }) {
  const [info, setInfo] = useState(undefined); // undefined = loading, null = unavailable
  const [pos, setPos] = useState({ left: anchor.right + GAP, top: anchor.top, width: CARD_WIDTH });
  const cardRef = useRef(null);

  // Re-asked every few seconds while open: the History list is not refreshed
  // on every transcript write, and main answers an unchanged file from its
  // stat-keyed cache. Old details stay up until a newer answer lands and a
  // failed refresh never blanks a card that loaded. The parent keys this
  // component by session id + project, so a new identity remounts fresh.
  useEffect(() => {
    let cancelled = false;
    // A slow older reply must not overwrite a newer one that landed first.
    let seq = 0;
    let applied = 0;
    const api = window.electronAPI?.dataSessionHoverInfo;
    if (!api || session.source === 'codex') { setInfo(null); return undefined; }
    const load = () => {
      const mine = ++seq;
      const current = () => !cancelled && mine > applied;
      return api(session.sessionId, session.project)
        .then((r) => {
          if (!current()) return;
          applied = mine;
          setInfo((prev) => r || (prev === undefined ? null : prev));
        })
        .catch((err) => {
          console.warn('[SessionHoverCard] load failed:', err?.message);
          if (current()) setInfo((prev) => (prev === undefined ? null : prev));
        });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [session.sessionId, session.project, session.source]);

  // Right of the row when it fits, else left of it; clamped to the viewport.
  // Re-placed when the row moves AND whenever the card's own height changes
  // (details arriving, a footer wrapping as "9m ago" becomes "10m ago").
  useLayoutEffect(() => {
    const place = () => {
      const h = cardRef.current?.offsetHeight || 0;
      // Narrower than the card in a small or zoomed window, never wider.
      const width = Math.max(0, Math.min(CARD_WIDTH, window.innerWidth - 2 * GAP));
      const fitsRight = anchor.right + GAP + width <= window.innerWidth - GAP;
      const left = fitsRight ? anchor.right + GAP : Math.max(GAP, anchor.left - GAP - width);
      const top = Math.max(GAP, Math.min(anchor.top, window.innerHeight - h - GAP));
      setPos((p) => (p.left === left && p.top === top && p.width === width ? p : { left, top, width }));
    };
    place();
    const ro = new ResizeObserver(place);
    if (cardRef.current) ro.observe(cardRef.current);
    return () => ro.disconnect();
  }, [anchor]);

  const heading = session.customLabel || info?.title || session.displayName || 'Untitled';
  const pct = info?.tokens && info?.maxTokens ? Math.round((info.tokens / info.maxTokens) * 100) : null;
  // A transcript written in the last two minutes is mid-turn, whatever its
  // tail looks like; same window as the History "working" status.
  const active = info?.lastWriteAt && Date.now() - info.lastWriteAt < ACTIVE_MS;
  const meta = info ? [
    active ? 'Active now' : ENDINGS[info.ending],
    shortModel(info.model),
    pct !== null ? `${pct}% context` : '',
    info.sizeBytes ? `${(info.sizeBytes / 1e6).toFixed(1)} MB` : '',
  ].filter(Boolean) : [];

  return createPortal(
    <div
      ref={cardRef}
      role="tooltip"
      data-testid="session-hover-card"
      style={{
        position: 'fixed', left: pos.left, top: pos.top, width: pos.width, zIndex: 1000,
        maxHeight: `calc(100vh - ${2 * GAP}px)`, overflow: 'hidden',
        pointerEvents: 'none',
        backgroundColor: 'var(--surface, var(--bg))', color: 'var(--fg)',
        border: '1px solid var(--border)', borderRadius: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        padding: '10px 12px', fontSize: 11, lineHeight: 1.45,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {heading}
      </div>
      <div style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: 10, wordBreak: 'break-all' }}>
        {session.project}
        {info?.branch && <span style={{ color: 'var(--accent)' }}>{`  ⎇ ${info.branch}`}</span>}
      </div>
      {info === undefined && <div style={{ color: 'var(--dim)' }}>Loading...</div>}
      {info === null && <div style={{ color: 'var(--dim)' }}>{session.preview || 'No details available'}</div>}
      {info && (
        <>
          {/* "Prompt", not "You": agent-to-agent messages arrive as user turns too. */}
          {info.lastPrompt && <Row label="Prompt">{info.lastPrompt}</Row>}
          {info.lastReply && <Row label="Reply">{info.lastReply}</Row>}
          {/* Older flat transcript shapes carry neither; the row's own
              preview (parsed by the History loader) still says something. */}
          {!info.lastPrompt && !info.lastReply && session.preview && (
            <div style={{ color: 'var(--dim)' }}>{session.preview}</div>
          )}
        </>
      )}
      <div
        style={{
          borderTop: '1px solid var(--border)', paddingTop: 6, color: 'var(--dim)',
          fontFamily: "'SF Mono', monospace", fontSize: 10, display: 'flex', flexWrap: 'wrap', gap: '2px 10px',
        }}
      >
        <span>{timeAgo(info?.lastWriteAt || session.timestamp)}</span>
        {meta.map((m) => <span key={m}>{m}</span>)}
        {tabLabel && <span style={{ color: 'var(--accent)' }}>{`in ${tabLabel}`}</span>}
        <span>{session.sessionId.slice(0, 8)}</span>
      </div>
    </div>,
    document.body,
  );
}
