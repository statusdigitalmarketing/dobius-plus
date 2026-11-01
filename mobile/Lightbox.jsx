import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampView, pinchView, doubleTapView } from '../shared/pinch-zoom.js';

const TAP_SLOP = 10; // px a finger may wander and still be a tap
const DOUBLE_TAP_MS = 300;

// Full size, modal: it takes focus and keeps it (Tab cannot reach the chat or
// a selector card behind it, Codex), Escape/Enter or the close button closes it.
// Pinch to zoom (to 5x) on the spot between the fingers, drag to look around
// while zoomed, double-tap to zoom in on a point or back out. A single tap
// closes it only at 1x, so a tap while studying a detail never throws it away.
// The page itself cannot zoom (viewport user-scalable=no), so this is the one
// place a picture can be looked at closely.
export default function Lightbox({ url, onClose }) {
  const ref = useRef(null);
  const imgRef = useRef(null);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [live, setLive] = useState(false); // a finger is down: no easing
  const viewRef = useRef(view);
  viewRef.current = view;
  const g = useRef({ pts: new Map(), start: null, moved: false, lastTap: 0, tapTimer: null });

  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => () => clearTimeout(g.current.tapTimer), []);
  // Rotating the phone resizes the image: keep it inside its new bounds.
  useEffect(() => {
    const onResize = () => setView((v) => clampView(v, size()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Pointer position relative to the image's centre at 1x. Measured from the
  // image's LAYOUT box (offsetLeft/Top ignore transforms), not the viewer: the
  // safe-area padding is uneven top and bottom, so the viewer's centre is not
  // where the image sits, and a rendered rect would include an animation
  // still in flight (a drag started mid double-tap zoom would jump).
  const at = (e) => {
    const box = ref.current.getBoundingClientRect();
    const img = imgRef.current;
    return {
      x: e.clientX - (box.left + img.offsetLeft + img.offsetWidth / 2),
      y: e.clientY - (box.top + img.offsetTop + img.offsetHeight / 2),
    };
  };
  const size = () => {
    const img = imgRef.current;
    return img ? { w: img.offsetWidth, h: img.offsetHeight } : null;
  };
  const commit = (v) => setView(clampView(v, size()));

  const beginFrom = (pts) => {
    const list = [...pts.values()];
    g.current.start = list.length >= 2
      ? { kind: 'pinch', a: list[0], b: list[1], view: viewRef.current }
      : list.length === 1 ? { kind: 'pan', p: list[0], view: viewRef.current } : null;
  };

  const onPointerDown = (e) => {
    if (e.target.closest?.('.chat-lightbox-close')) return;
    ref.current.setPointerCapture?.(e.pointerId);
    const st = g.current;
    // Any new touch cancels a pending single-tap close (a tap then a pinch).
    clearTimeout(st.tapTimer);
    // The first finger of a new gesture: forget fingers whose release was lost.
    if (e.isPrimary) st.pts.clear();
    if (st.pts.size === 0) st.moved = false;
    st.pts.set(e.pointerId, at(e));
    if (st.pts.size > 1) st.moved = true; // two fingers is never a tap
    beginFrom(st.pts);
    setLive(true);
  };

  const onPointerMove = (e) => {
    const st = g.current;
    if (!st.pts.has(e.pointerId) || !st.start) return;
    st.pts.set(e.pointerId, at(e));
    const list = [...st.pts.values()];
    if (st.start.kind === 'pinch' && list.length >= 2) {
      commit(pinchView(st.start, { a: list[0], b: list[1] }));
    } else if (st.start.kind === 'pan') {
      const p = list[0];
      const dx = p.x - st.start.p.x;
      const dy = p.y - st.start.p.y;
      if (Math.abs(dx) + Math.abs(dy) > TAP_SLOP) st.moved = true;
      if (st.start.view.s > 1) commit({ ...st.start.view, x: st.start.view.x + dx, y: st.start.view.y + dy });
    }
  };

  const onPointerEnd = (e) => {
    const st = g.current;
    if (!st.pts.has(e.pointerId)) return;
    const p = st.pts.get(e.pointerId);
    st.pts.delete(e.pointerId);
    if (st.pts.size > 0) { beginFrom(st.pts); return; } // pinch -> pan with the finger left
    st.start = null;
    setLive(false);
    if (st.moved || e.type === 'pointercancel') return;
    const now = Date.now();
    if (now - st.lastTap < DOUBLE_TAP_MS) {
      clearTimeout(st.tapTimer);
      st.lastTap = 0;
      commit(doubleTapView(viewRef.current, p));
      return;
    }
    st.lastTap = now;
    // A single tap closes, but only at 1x and only once it is clearly not
    // the first half of a double tap.
    clearTimeout(st.tapTimer);
    st.tapTimer = setTimeout(() => { if (viewRef.current.s === 1) onClose(); }, DOUBLE_TAP_MS);
  };

  return createPortal(
    <div
      ref={ref}
      className="chat-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Image, pinch to zoom"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); onClose(); } else if (e.key === 'Tab') e.preventDefault();
      }}
    >
      <img
        ref={imgRef}
        src={url}
        alt="Tool output, full size"
        draggable={false}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          transition: live ? 'none' : 'transform 0.18s ease-out',
        }}
      />
      <button type="button" className="chat-lightbox-close" aria-label="Close image" onClick={onClose}>✕</button>
    </div>,
    document.body,
  );
}
