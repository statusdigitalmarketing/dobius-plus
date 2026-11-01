// Pinch-zoom math for the phone's full-size image viewer (mobile/Lightbox.jsx).
// A view is { s, x, y }: scale, and the image centre's offset from the
// viewer's centre in CSS px. Pure, so the gestures are unit tested
// (electron/__tests__/pinch-zoom.test.mjs).

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
export const DOUBLE_TAP_SCALE = 2.5;

/** Keep the scale in range and the image covering the viewer: at 1x it is
 * centred, zoomed in it can be dragged only as far as its own edges. */
export function clampView(v, size) {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(v.s) ? v.s : 1));
  if (s === MIN_SCALE || !size) return { s, x: 0, y: 0 };
  const mx = (size.w * s - size.w) / 2;
  const my = (size.h * s - size.h) / 2;
  const x = Number.isFinite(v.x) ? v.x : 0;
  const y = Number.isFinite(v.y) ? v.y : 0;
  return { s, x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
}

/** Zoom to scale `s` keeping the image point under `p` (viewer coordinates,
 * relative to the viewer's centre) under it. */
export function zoomAt(view, s, p) {
  // The image point under p before: (p - offset) / scale.
  const ix = (p.x - view.x) / view.s;
  const iy = (p.y - view.y) / view.s;
  return { s, x: p.x - ix * s, y: p.y - iy * s };
}

/** A two-finger move: scale by the change in finger distance around the
 * starting midpoint, and follow the midpoint as it moves. */
export function pinchView(start, now) {
  const d0 = Math.hypot(start.b.x - start.a.x, start.b.y - start.a.y);
  const d1 = Math.hypot(now.b.x - now.a.x, now.b.y - now.a.y);
  if (!(d0 > 0)) return start.view;
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, start.view.s * (d1 / d0)));
  const m0 = { x: (start.a.x + start.b.x) / 2, y: (start.a.y + start.b.y) / 2 };
  const m1 = { x: (now.a.x + now.b.x) / 2, y: (now.a.y + now.b.y) / 2 };
  const z = zoomAt(start.view, s, m0);
  return { s, x: z.x + (m1.x - m0.x), y: z.y + (m1.y - m0.y) };
}

/** Double tap: zoom in on the tapped point, or back out if already zoomed. */
export function doubleTapView(view, p) {
  return view.s > MIN_SCALE ? { s: MIN_SCALE, x: 0, y: 0 } : zoomAt(view, DOUBLE_TAP_SCALE, p);
}
