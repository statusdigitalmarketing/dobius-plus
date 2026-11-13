// Swipe down to close a bottom sheet, the way an iPhone sheet closes (Sam, 2026-11-13: "i can't use my finger to slide
// it down. i have to hit the x button"). Spread the returned handlers on the sheet: a drag that starts on its handle
// or heading (or anywhere, when nothing under the finger can scroll up) moves the sheet with the finger, and letting go
// far enough down, or with a downward flick, closes it. Anything else springs back. Touch and pen only: a mouse keeps
// clicks and text selection as they are.
import { useRef } from 'react';

const CLOSE_PX = 110; // dragged this far down closes it
const FLICK_PX_PER_MS = 0.6; // or released moving down this fast
const START_PX = 8; // movement before a drag is decided (a tap stays a tap)
const FLICK_FRESH_MS = 80; // the last move must be this recent at release for its speed to count

// The nearest element from `el` up to `stop` (the sheet included) that is scrolled away from its top: dragging down
// there scrolls it.
function scrolledAncestor(el, stop) {
  for (let n = el; n; n = n.parentElement) {
    if (n.scrollTop > 0 && n.scrollHeight > n.clientHeight) return n;
    if (n === stop) break;
  }
  return null;
}

// Things a finger presses or types into: a drag never starts on them, so a slightly moving tap still activates a
// button (Codex P2). The handle and the heading's empty space carry the drag.
const INTERACTIVE = 'input, textarea, select, button, a, [role="button"], [contenteditable="true"]';

export function useSwipeDown(onDismiss, { enabled = true } = {}) {
  const st = useRef(null);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!onDismiss) return {};
  return swipeHandlers(st, onDismiss, reduce, enabled);
}

/**
 * The pointer handlers, outside React so they can be tested: `st` is a { current } box holding the gesture. While
 * not `enabled` no drag starts, but one already under way still ends and springs back (never closes): dropping the
 * handlers mid-drag left the sheet stuck part way down (Codex P2).
 */
export function swipeHandlers(st, onDismiss, reduce = false, enabled = true) {
  // The latest render's answer, read when a close lands: pairing can start between the release and the close, and
  // closing then would throw the pairing away (Codex P2). Off by then: the sheet slides back instead.
  st.on = enabled;
  const settle = (el, close) => {
    el.style.transition = reduce ? 'none' : 'transform 0.22s cubic-bezier(.2,.8,.2,1)';
    el.style.transform = close ? 'translateY(100%)' : '';
    if (close) {
      setTimeout(() => {
        if (st.on) { onDismiss?.(); return; }
        el.style.transform = '';
        setTimeout(() => { el.style.transition = ''; }, 240);
      }, reduce ? 0 : 200);
    } else setTimeout(() => { el.style.transition = ''; }, 240);
  };

  return {
    onPointerDown: (e) => {
      if (!enabled || e.pointerType === 'mouse' || !e.isPrimary) return;
      const sheet = e.currentTarget;
      if (e.target.closest?.(INTERACTIVE)) return;
      if (scrolledAncestor(e.target, sheet)) return;
      st.current = { id: e.pointerId, y: e.clientY, x: e.clientX, t: e.timeStamp, dragging: false, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    },
    onPointerMove: (e) => {
      const s = st.current;
      if (!s || e.pointerId !== s.id) return;
      const dy = e.clientY - s.y;
      const dx = e.clientX - s.x;
      if (!s.dragging) {
        if (Math.abs(dx) > START_PX && Math.abs(dx) > Math.abs(dy)) { st.current = null; return; } // sideways: not ours
        if (dy < START_PX) { if (dy < -START_PX) st.current = null; return; } // up, or not far enough yet
        s.dragging = true;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer already ended */ }
        e.currentTarget.style.transition = 'none';
      }
      const dt = Math.max(1, e.timeStamp - s.lastT);
      s.v = (e.clientY - s.lastY) / dt;
      s.lastY = e.clientY;
      s.lastT = e.timeStamp;
      e.currentTarget.style.transform = `translateY(${Math.max(0, dy)}px)`;
    },
    onPointerUp: (e) => {
      const s = st.current;
      if (!s || e.pointerId !== s.id) return; // another finger lifting is not this drag ending
      st.current = null;
      if (!s.dragging) return;
      const dy = e.clientY - s.y;
      // A flick is a release while still moving: a finger that paused before lifting is not one (Codex P2).
      const flick = e.timeStamp - s.lastT < FLICK_FRESH_MS && s.v > FLICK_PX_PER_MS;
      settle(e.currentTarget, enabled && (dy > CLOSE_PX || (dy > START_PX * 2 && flick)));
    },
    onPointerCancel: (e) => {
      const s = st.current;
      if (!s || e.pointerId !== s.id) return;
      st.current = null;
      if (s.dragging) settle(e.currentTarget, false);
    },
  };
}
