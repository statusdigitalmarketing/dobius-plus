// Keep a window's saved bounds on a display that is connected NOW. A window
// last placed on an external monitor that is gone came back off-screen: open,
// counted as "Open" in the launcher, and invisible (Brett, Asana
// 1220099565720834). Pure, so it can be tested without Electron.

// How much of the window's top strip (its title bar, where it is dragged)
// must lie on a display for the saved position to be kept.
const MIN_VISIBLE_W = 120;
const TITLE_STRIP_H = 40;

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * @param bounds { x?, y?, width?, height? } as saved
 * @param workAreas [{ x, y, width, height }] of the connected displays, the
 *        primary one first
 * @returns bounds to create the window with: the saved ones when their title
 *          strip is on a display (size capped to that display), else the
 *          saved size capped to the primary display and no position, so the
 *          window opens centred there.
 */
export function fitToDisplays(bounds, workAreas) {
  const b = bounds && typeof bounds === 'object' ? bounds : {};
  const areas = Array.isArray(workAreas) ? workAreas.filter((a) => a && a.width > 0 && a.height > 0) : [];
  if (areas.length === 0) return b;
  const capTo = (area) => ({
    ...(Number.isFinite(b.width) ? { width: Math.min(b.width, area.width) } : {}),
    ...(Number.isFinite(b.height) ? { height: Math.min(b.height, area.height) } : {}),
  });
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    // Tested at the size it will open at: capping a wide window to a display
    // keeps its left edge, so a window mostly on a monitor that is gone could
    // pass at full width and end up entirely off-screen once capped (Codex).
    const home = areas.find((a) => {
      const w = Number.isFinite(b.width) ? Math.min(b.width, a.width) : 0;
      return overlap(b.x, b.x + w, a.x, a.x + a.width) >= Math.min(MIN_VISIBLE_W, w || MIN_VISIBLE_W)
        && overlap(b.y, b.y + TITLE_STRIP_H, a.y, a.y + a.height) > 0;
    });
    if (home) return { x: b.x, y: b.y, ...capTo(home) };
  }
  return capTo(areas[0]);
}
