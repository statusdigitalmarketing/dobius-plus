import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { timeAgo } from '../../lib/time-ago';
import { projectMonogram } from '../../lib/project-color';
import SessionHoverCard from './SessionHoverCard';

// Long enough that sweeping the pointer down the list does not flash a card
// per row, short enough to feel like a tooltip.
const HOVER_DELAY_MS = 450;

/**
 * Sidebar card for one Claude session.
 *
 * v1.0.26: supports inline rename. Hover over the title → ✎ icon appears.
 * Click it (or double-click the title) → input field. Enter saves, Esc cancels,
 * blur saves. Custom label persists via setLabel → config.sessionTags.
 *
 * The card root is a `<div role="button">` (NOT `<button>`) so the rename
 * `<input>` and the ✎/↺ control buttons can nest legally — HTML forbids
 * interactive descendants of a `<button>`, and Chromium quietly swallows
 * focus/blur/click events when that rule is violated. Per Codex v1.0.26 review.
 *
 * Falls back to session.displayName (which is itself sessionTags.label OR the
 * auto-display from useSessions) so the card always has a title.
 */
export default function ConversationCard({
  session,
  selected,
  pinned,
  tabLabel,
  onSelect,
  onRename,
  onClearRename,
  hasCustomLabel,
}) {
  const projectName = session.project?.split('/').filter(Boolean).pop() || 'Unknown';
  const monogram = useMemo(() => projectMonogram(session.project), [session.project]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.displayName || '');
  const inputRef = useRef(null);
  // Tracks whether the most recent edit ended via Escape so onBlur doesn't
  // commit the stale draft when the input loses focus immediately after.
  const cancelledRef = useRef(false);
  const [hoverAnchor, setHoverAnchor] = useState(null);
  const hoverTimerRef = useRef(null);
  const rowRef = useRef(null);
  const hoverOpen = !!hoverAnchor;

  const hideHover = useCallback(() => {
    clearTimeout(hoverTimerRef.current);
    setHoverAnchor(null);
  }, []);
  useEffect(() => () => clearTimeout(hoverTimerRef.current), []);
  useEffect(() => { if (editing) hideHover(); }, [editing, hideHover]);
  // While open: close when the app loses focus or the row's own list scrolls
  // (a scroll elsewhere, like the Changes feed following events, is not ours),
  // and follow the row if the layout moves it (a Closed Tabs header appearing,
  // a window resize) without a mouseleave ever firing.
  useEffect(() => {
    if (!hoverOpen) return undefined;
    const onScroll = (e) => {
      const t = e.target;
      if (t === document || (t instanceof Node && t.contains(rowRef.current))) hideHover();
    };
    let raf = 0;
    let last = '';
    const follow = () => {
      const el = rowRef.current;
      // Re-checked every frame because the listeners below only exist once
      // this effect runs: a blur, or a scroll that carried the row off the
      // pointer, landing before then would otherwise be missed for good.
      if (!el?.isConnected || !document.hasFocus() || !el.matches(':hover')) { hideHover(); return; }
      const r = el.getBoundingClientRect();
      const key = `${r.left}|${r.top}|${r.right}|${r.bottom}|${window.innerWidth}|${window.innerHeight}`;
      // Runs on the first frame too: the row may have moved between the
      // delay capturing its rect and this loop starting.
      // Functional: a hide queued earlier in this frame (scroll, blur) has not
      // committed yet, and a plain set would reopen the card it just closed.
      if (key !== last) setHoverAnchor((prev) => (prev ? r : prev));
      last = key;
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', hideHover);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', hideHover);
    };
  }, [hoverOpen, hideHover]);

  useEffect(() => {
    if (!editing) setDraft(session.displayName || '');
  }, [session.displayName, editing]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEdit = useCallback((e) => {
    e?.stopPropagation();
    setDraft(session.displayName || '');
    cancelledRef.current = false;
    setEditing(true);
  }, [session.displayName]);

  const commit = useCallback(() => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setEditing(false);
      return;
    }
    const next = draft.trim();
    setEditing(false);
    if (!next) return;
    if (next === (session.displayName || '')) return;
    onRename?.(session.sessionId, next);
  }, [draft, session.sessionId, session.displayName, onRename]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      cancelledRef.current = true;
      setEditing(false);
      // Calling blur after setting the cancel flag ensures the eventual blur
      // event sees the flag and skips commit (event-order is browser-dependent
      // — blur from focus loss vs blur from explicit .blur() can interleave
      // with the keydown's state update).
      inputRef.current?.blur();
    }
  }, [commit]);

  // Card root is a div+role=button so it can contain the input + nested
  // controls. Activation via Enter/Space mirrors native button semantics.
  const onRootKeyDown = useCallback((e) => {
    if (editing) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect?.(e);
    }
  }, [editing, onSelect]);

  return (
    // Card double-click is reserved for "resume session" (handled by parent
    // via e.detail === 2 in onSelect). Rename is triggered only by the ✎
    // affordance to avoid the gesture conflict Codex round-6 MED flagged.
    <div
      role="button"
      tabIndex={0}
      onClick={editing ? undefined : onSelect}
      onKeyDown={onRootKeyDown}
      className="w-full text-left px-3 py-2 transition-all duration-100 group"
      style={{
        backgroundColor: selected ? 'var(--bg)' : 'transparent',
        borderLeft: selected ? '3px solid var(--accent)' : '3px solid transparent',
        cursor: editing ? 'text' : 'pointer',
        outline: 'none',
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = 'var(--surface-hover)';
        if (!selected) e.currentTarget.style.borderLeftColor = 'var(--border)';
        if (editing) return;
        const el = e.currentTarget;
        rowRef.current = el;
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
          // Cmd+Tab away, or a scroll that carried the row off the pointer,
          // during the delay must not pop a card.
          if (el.isConnected && document.hasFocus() && el.matches(':hover')) setHoverAnchor(el.getBoundingClientRect());
        }, HOVER_DELAY_MS);
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = 'transparent';
        if (!selected) e.currentTarget.style.borderLeftColor = 'transparent';
        hideHover();
      }}
      // Clicking (select, resume, rename) means the preview has done its job.
      onMouseDown={hideHover}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          aria-hidden="true"
          data-testid="project-monogram"
          className="shrink-0 inline-flex items-center justify-center"
          style={{
            width: 18, height: 18, marginTop: 1, borderRadius: 4,
            backgroundColor: monogram.background, color: '#fff',
            fontSize: 10, fontWeight: 700, fontFamily: "'SF Mono', monospace",
          }}
        >
          {monogram.letter}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                onBlur={commit}
                onClick={(e) => e.stopPropagation()}
                spellCheck={false}
                maxLength={50}
                className="text-xs font-medium flex-1 min-w-0"
                style={{
                  backgroundColor: 'var(--bg)',
                  color: 'var(--fg)',
                  border: '1px solid var(--accent)',
                  borderRadius: 3,
                  padding: '1px 4px',
                  outline: 'none',
                }}
              />
            ) : (
              <>
                <span
                  className="text-xs font-medium truncate"
                  style={{ color: 'var(--fg)' }}
                  title={hasCustomLabel ? `Custom name (double-click to edit)` : session.displayName}
                >
                  {session.displayName || 'Untitled'}
                </span>
                {/* Out of layout until hover or keyboard focus (not just
                    transparent): at narrow widths they took the title's room. */}
                <button
                  type="button"
                  onClick={startEdit}
                  title="Rename"
                  className="hidden group-hover:inline-block group-focus-within:inline-block"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--dim)',
                    cursor: 'pointer',
                    fontSize: 10,
                    padding: '0 2px',
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ✎
                </button>
                {hasCustomLabel && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onClearRename?.(session.sessionId); }}
                    title="Reset to default name"
                    className="hidden group-hover:inline-block group-focus-within:inline-block"
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--dim)',
                      cursor: 'pointer',
                      fontSize: 10,
                      padding: '0 2px',
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    ↺
                  </button>
                )}
              </>
            )}
          </div>
          <div
            className="text-xs truncate mt-0.5"
            style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: '10px' }}
          >
            {projectName}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {tabLabel && (
            <span
              className="truncate"
              title={`Open in ${tabLabel}`}
              style={{
                color: 'var(--accent)',
                backgroundColor: 'var(--surface-hover)',
                borderRadius: 3,
                padding: '1px 5px',
                fontSize: '9px',
                fontFamily: "'SF Mono', monospace",
                // 72, not 90: the monogram took room from the title, and the
                // hover card names the tab in full.
                maxWidth: 72,
              }}
            >
              {tabLabel}
            </span>
          )}
          {pinned && (
            <span
              className="w-1.5 h-1.5 rounded-full inline-block"
              style={{ backgroundColor: 'var(--accent)' }}
            />
          )}
          <span
            className="text-xs whitespace-nowrap"
            style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace", fontSize: '10px' }}
          >
            {timeAgo(session.timestamp)}
          </span>
        </div>
      </div>
      {hoverAnchor && (
        // Rows are keyed by session id only; the project can change under one.
        <SessionHoverCard
          key={`${session.sessionId}|${session.project}|${session.source}`}
          session={session}
          anchor={hoverAnchor}
          tabLabel={tabLabel}
        />
      )}
    </div>
  );
}
