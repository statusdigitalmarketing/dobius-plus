// How the sidebar's Tabs list orders the tabs inside each project (settings.sidebarTabOrder). Brett, 2026-11-09:
// "keep the tabs in a specific order ... the tabs on the left sidebar match the same order as the ones up top, or ...
// Working goes to the top, the Waiting is below it, and then Done is below that".
//   activity  most recently active first (live tabs first): the original order, and the default
//   tabs      the same order as the tab bar up top; rows never move on their own
//   status    working, then needs input, then waiting, then done, then the rest; tab bar order within each
export const SIDEBAR_ORDERS = ['activity', 'tabs', 'status'];
export const normalizeSidebarOrder = (v) => (SIDEBAR_ORDERS.includes(v) ? v : 'activity');

// The row's activity kind (tabActivityLabel's kind, what the row shows) to its place in the status order.
const STATUS_RANK = { working: 0, input: 1, waiting: 2, done: 3 };
export const statusRank = (kind) => STATUS_RANK[kind] ?? 4;

/**
 * tabs: one project's rows; each row's savedIndex (from main) is its place in the project's saved tab bar order.
 * barIndex(tab): the tab's place in THIS window's tab bar, or -1 when it is not in it (another window's, or closed).
 * kind(tab): its activity kind ('working' | 'input' | 'waiting' | 'done' | null).
 * Returns a new array; never mutates.
 */
export function orderSidebarTabs(tabs, mode, { barIndex = () => -1, kind = () => null } = {}) {
  // i: the saved tab order (main's savedIndex; main hands the rows over sorted by recency), else the array position.
  const rows = (tabs || []).map((t, i) => ({ t, i: Number.isFinite(t?.savedIndex) ? t.savedIndex : i, bar: barIndex(t) }));
  // Tab bar order: this window's bar first, in its order, then the rest in their saved order.
  const byBar = (a, b) => {
    const ab = a.bar >= 0 ? a.bar : Infinity;
    const bb = b.bar >= 0 ? b.bar : Infinity;
    return ab === bb ? a.i - b.i : ab - bb;
  };
  const m = normalizeSidebarOrder(mode);
  if (m === 'tabs') rows.sort(byBar);
  else if (m === 'status') {
    const rank = new Map(rows.map((r) => [r, statusRank(kind(r.t))]));
    rows.sort((a, b) => rank.get(a) - rank.get(b) || byBar(a, b));
  } else {
    rows.sort((a, b) => (
      (b.t.live ? 1 : 0) - (a.t.live ? 1 : 0)
      || (b.t.lastActiveAt || 0) - (a.t.lastActiveAt || 0)
      || a.i - b.i
    ));
  }
  return rows.map((r) => r.t);
}
