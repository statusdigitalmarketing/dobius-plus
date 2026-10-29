import { timeAgo } from './format';

// Status -> label + which CSS var drives the LED. Colors live in styles.css so
// the whole app stays on one palette.
const STATUS = {
  working: { label: 'working', cls: 'working' },
  needs: { label: 'needs you', cls: 'needs' },
  done: { label: 'done', cls: 'done' },
  idle: { label: 'idle', cls: 'idle' },
};

// One session on the board: a status LED, the tab label, a status + last-active
// subline, and a chevron. The card is the tap target; the optional pin toggle
// is an OVERLAY sibling (never a nested button) so pinning doesn't open the
// session. v1.0.53: pins + titlePrefix ("project / tab" rows in the pinned
// section at the top of the board).
export default function SessionCard({ term, onOpen, pinned, onTogglePin, titlePrefix }) {
  const s = STATUS[term.status] || STATUS.idle;
  const hasCtx = typeof term.ctxPct === 'number';
  return (
    <div className="session-card-wrap">
      <button className={`session-card led-${s.cls}${onTogglePin ? ' has-pin' : ''}`} onClick={() => onOpen(term.id)}>
        <span className="card-led" aria-hidden="true">{s.cls === 'done' ? '✓' : null}</span>
        <span className="card-main">
          <span className="card-title">
            {titlePrefix ? <span className="card-proj">{titlePrefix} / </span> : null}
            {term.label || 'terminal'}
          </span>
          <span className="card-sub">
            {/* While working, Claude's own spinner word ("Flibbertigibbeting…")
                beats a flat "working": it is what the desktop shows and it
                tells you the session is genuinely mid-thought. */}
            <span className="card-status">
              {term.status === 'working' && term.verb ? `${term.verb}…` : s.label}
            </span>
            {term.lastActivityAt ? <span className="card-time"> · {timeAgo(term.lastActivityAt)}</span> : null}
            {term.model ? <span className="card-time"> · {term.model}</span> : null}
          </span>
        </span>
        {hasCtx && (
          <span className="card-ctx" style={{ '--pct': term.ctxPct }} title={`context ${term.ctxPct}%`}>
            <span className="card-ctx-num">{term.ctxPct}</span>
          </span>
        )}
        <span className="card-chevron" aria-hidden="true">›</span>
      </button>
      {onTogglePin && (
        <button
          className={`card-pin${pinned ? ' pinned' : ''}`}
          onClick={(e) => { e.stopPropagation(); onTogglePin(term.id); }}
          aria-label={pinned ? 'Unpin session' : 'Pin session to top'}
          title={pinned ? 'Unpin' : 'Pin to top'}
        >
          {pinned ? '★' : '☆'}
        </button>
      )}
    </div>
  );
}
