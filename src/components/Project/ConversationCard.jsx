import { useState, useRef, useEffect, useCallback } from 'react';
import { timeAgo } from '../../lib/time-ago';

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
  onTogglePin,
  onRename,
  onClearRename,
  hasCustomLabel,
}) {
  const projectName = session.project?.split('/').filter(Boolean).pop() || 'Unknown';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.displayName || '');
  const inputRef = useRef(null);
  // Tracks whether the most recent edit ended via Escape so onBlur doesn't
  // commit the stale draft when the input loses focus immediately after.
  const cancelledRef = useRef(false);

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
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = 'transparent';
        if (!selected) e.currentTarget.style.borderLeftColor = 'transparent';
      }}
    >
      <div className="flex items-start justify-between gap-2">
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
                <button
                  type="button"
                  onClick={startEdit}
                  title="Rename"
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
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
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
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
                maxWidth: 90,
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
    </div>
  );
}
