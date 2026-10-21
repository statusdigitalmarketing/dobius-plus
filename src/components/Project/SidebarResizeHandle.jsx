import { useEffect, useRef, useState } from 'react';
import {
  clampSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_KEY_STEP, TERMINAL_MIN,
} from '../../lib/sidebar-width';

/**
 * Drag strip on the sidebar's right edge. Live resize while dragging (the
 * terminals refit on their own 50ms debounce, same as a window resize), saved
 * once on release. Double-click resets; arrow keys nudge when focused.
 * `width` is the saved value, `onChange(w)` updates it live, `onCommit(w)`
 * persists it.
 *
 * Every adjustment starts from the RENDERED width, never `width`: flex may
 * have shrunk the sidebar to keep the terminal at TERMINAL_MIN, and starting
 * from the saved value made the edge lag the pointer.
 */

// How wide the sidebar may grow right now without pushing the terminal
// column (its next sibling) under TERMINAL_MIN. Measured on every move, not
// once per drag: a panel opened or closed mid-drag changes the room.
function bounds(el) {
  const box = el.parentElement;
  const rendered = Math.round(box.getBoundingClientRect().width);
  const next = box.nextElementSibling;
  const room = next ? Math.max(0, next.getBoundingClientRect().width - TERMINAL_MIN) : Infinity;
  // Never below the rendered width: a terminal already under TERMINAL_MIN
  // (Git/Files panels open) means "do not grow", not "snap narrower".
  return { rendered, max: Math.max(SIDEBAR_MIN, rendered, Math.min(SIDEBAR_MAX, rendered + room)) };
}

export default function SidebarResizeHandle({ width, onChange, onCommit }) {
  const drag = useRef(null);
  const [active, setActive] = useState(false);
  // Latest callbacks for the unmount cleanup below.
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const resetBody = () => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  // Cmd+B (or a tear-off closing) can unmount the handle mid-drag; the
  // capture-loss event then goes to the document, not here. Clean up and
  // keep the width the user had dragged to.
  useEffect(() => () => {
    if (!drag.current) return;
    const w = drag.current.last;
    drag.current = null;
    resetBody();
    commitRef.current(w);
  }, []);

  const end = (e) => {
    if (!drag.current) return;
    const w = drag.current.last;
    drag.current = null;
    setActive(false);
    resetBody();
    if (e?.currentTarget?.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(w);
  };

  const nudge = (el, delta) => {
    const { rendered, max } = bounds(el);
    const w = Math.min(max, clampSidebarWidth(rendered + delta));
    onChange(w);
    onCommit(w);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      data-testid="sidebar-resize-handle"
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const { rendered } = bounds(e.currentTarget);
        drag.current = { startX: e.clientX, startW: rendered, last: rendered };
        // Claims the width now, so a settings read landing mid-drag cannot
        // replace it (and the release cannot then save a stale value).
        onChange(rendered);
        setActive(true);
        // Keep the resize cursor and stop text selection while the pointer is
        // over the terminal or the list mid-drag.
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const d = drag.current;
        const w = Math.min(bounds(e.currentTarget).max, clampSidebarWidth(d.startW + e.clientX - d.startX));
        if (w === d.last) return;
        d.last = w;
        onChange(w);
      }}
      onPointerUp={end}
      // Capture can be lost without a pointerup (window blur, OS gesture).
      onLostPointerCapture={() => end()}
      onDoubleClick={(e) => {
        const w = Math.min(bounds(e.currentTarget).max, SIDEBAR_DEFAULT);
        onChange(w);
        onCommit(w);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        // Keep window-level shortcut handlers and terminals out of it.
        e.stopPropagation();
        // Mid-drag the pointer owns the width; the release would overwrite.
        if (drag.current) return;
        nudge(e.currentTarget, e.key === 'ArrowRight' ? SIDEBAR_KEY_STEP : -SIDEBAR_KEY_STEP);
      }}
      className="group"
      style={{
        position: 'absolute', top: 0, right: -3, width: 6, height: '100%',
        cursor: 'col-resize', zIndex: 5, outline: 'none',
      }}
    >
      {/* The visible line: hidden at rest, accent on hover, drag or focus. */}
      {/* Opacity lives in classes: an inline opacity would beat group-hover. */}
      <div
        className={active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}
        style={{
          position: 'absolute', top: 0, bottom: 0, left: 2, width: 2,
          backgroundColor: 'var(--accent)', transition: 'opacity 120ms',
        }}
      />
    </div>
  );
}
