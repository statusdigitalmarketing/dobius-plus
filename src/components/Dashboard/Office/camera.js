// Camera with tweened pan + zoom. Not React state; the renderer owns a mutable
// camera and updates it in its RAF loop. Caller sets a target; the camera eases
// toward it on each tick.

export function makeCamera() {
  return {
    x: 0, y: 0, zoom: 1,
    tx: 0, ty: 0, tzoom: 1,
    // Recording auto-pan: a slow horizontal drift across the world bounds. Set
    // by the renderer when recording is on + reduce-motion is off.
    panMode: null,  // null | 'pan-lr'
    panT: 0,        // 0..1 progress for the drift
  };
}

// Fit the given world rect into the given viewport, snap the camera to that.
// worldBounds dimensions are in TILES; the renderer's transform converts via
// (world * tileSize) THEN scales by cam.zoom, so the fit math has to divide by
// (worldBounds.w * TILE) in pixels, not tiles. Earlier revisions divided by
// tiles alone and ended up zoomed in ~43x on 40-tile scenes.
const TILE = 16;
export function fit(cam, worldBounds, viewport, { padding = 24 } = {}) {
  const sx = (viewport.w - padding * 2) / Math.max(1, worldBounds.w * TILE);
  const sy = (viewport.h - padding * 2) / Math.max(1, worldBounds.h * TILE);
  // No lower bound: let a 10-project floor fit on a phone at 0.08x rather than
  // clip edge rooms. Earlier floors of 0.4 / 0.15 both clipped under some
  // scene sizes (Codex r2 P2-4). Still cap the upper end so a single-tab room
  // does not zoom in past readable.
  const z = Math.min(sx, sy, 6);
  cam.tzoom = z;
  cam.tx = worldBounds.x + worldBounds.w / 2;
  cam.ty = worldBounds.y + worldBounds.h / 2;
}

export function zoomTo(cam, worldRect, viewport, { padding = 60 } = {}) {
  fit(cam, worldRect, viewport, { padding });
}

export function tick(cam, dt) {
  const k = 1 - Math.exp(-dt * 6);
  cam.x += (cam.tx - cam.x) * k;
  cam.y += (cam.ty - cam.y) * k;
  cam.zoom += (cam.tzoom - cam.zoom) * k;
  if (cam.panMode === 'pan-lr' && cam.panBounds) {
    cam.panT = (cam.panT + dt / 20) % 1;
    const span = cam.panBounds.w;
    // Recompute half from the LIVE camera + viewport each tick rather than
    // the cached viewportTilesW. A ratio flip or zoom change would otherwise
    // keep using the pre-flip width and pan the camera off the new canvas
    // (Codex r2 P2-3).
    const liveW = cam.viewportPx && cam.zoom ? cam.viewportPx / cam.zoom / TILE : (cam.viewportTilesW || 10);
    const half = liveW / 2;
    // If the whole floor fits in view (half >= span/2), there is no horizontal
    // travel to pan across. Keep the camera centered and skip the ping-pong
    // instead of oscillating by a sub-pixel. Codex r1 P2-6.
    if (half >= span / 2) {
      cam.tx = cam.panBounds.x + span / 2;
      cam.ty = cam.panBounds.y + cam.panBounds.h / 2;
      return;
    }
    const leftEdge = cam.panBounds.x + half;
    const rightEdge = cam.panBounds.x + span - half;
    const t = Math.abs(cam.panT * 2 - 1);
    cam.tx = leftEdge + (rightEdge - leftEdge) * (1 - t);
    cam.ty = cam.panBounds.y + cam.panBounds.h / 2;
  }
}

export function startAutoPan(cam, worldBounds, viewportTilesW, viewportPx) {
  cam.panMode = 'pan-lr';
  cam.panBounds = worldBounds;
  cam.viewportTilesW = viewportTilesW;
  cam.viewportPx = viewportPx;
  cam.panT = 0;
}

export function stopAutoPan(cam) {
  cam.panMode = null;
  cam.panBounds = null;
}

// Pixel coord in canvas space -> world tile coord.
export function screenToWorld(cam, viewport, px, py) {
  const sx = (px - viewport.w / 2) / cam.zoom;
  const sy = (py - viewport.h / 2) / cam.zoom;
  return { x: cam.x + sx / TILE, y: cam.y + sy / TILE };
}
