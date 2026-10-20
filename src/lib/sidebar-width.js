// Project-window sidebar width, user-resizable and saved as the
// `sidebarWidth` setting. Pure so it is tested under plain node
// (electron/__tests__/sidebar-polish.test.mjs). In the layout the sidebar is
// allowed to SHRINK below the saved value (down to SIDEBAR_MIN) so the
// terminal column keeps TERMINAL_MIN when the window is narrow or the Git and
// Files panels are open.

export const SIDEBAR_DEFAULT = 280;
// Below this a History row with a tab badge has no room left for its title.
export const SIDEBAR_MIN = 240;
export const TERMINAL_MIN = 320;
export const SIDEBAR_MAX = 600;
export const SIDEBAR_KEY_STEP = 16;

/**
 * The widest the sidebar may render in a row `rowWidth` wide whose OTHER
 * panels (Git, Files, Git Tree: everything but the sidebar and the terminal)
 * take `othersWidth`, so the terminal keeps TERMINAL_MIN. Never under
 * SIDEBAR_MIN: when even that does not fit, the terminal gives way, as it
 * did before the sidebar was resizable.
 */
export function sidebarCap(rowWidth, othersWidth) {
  const cap = Math.floor(rowWidth - othersWidth - TERMINAL_MIN);
  return Number.isFinite(cap) ? Math.max(SIDEBAR_MIN, cap) : SIDEBAR_MAX;
}

/** Any input (a saved setting, a drag position) to a usable width. */
export function clampSidebarWidth(value) {
  // Number(null) and Number('') are 0, which would read as "narrowest".
  const n = value === null || value === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n)));
}
