// Board ordering. Pure, so it can be unit-tested without a browser.
//
// Sized against the real thing: a live read of the running app found 39 tabs
// of which only 10 had Claude running and 32 were idle. Ordering by project
// alone buries the handful that matter under a wall of dormant shells, and on
// a phone that means scrolling past everything to reach the one tab you came
// for.

// What each status means for "should I look at this now".
const STATUS_RANK = { needs: 0, working: 1, done: 2, idle: 3 };

export function statusRank(status) {
  const r = STATUS_RANK[status];
  return r === undefined ? STATUS_RANK.idle : r;
}

/** A tab worth surfacing: anything that is not a dormant shell. */
export function isActive(term) {
  return statusRank(term?.status) < STATUS_RANK.idle;
}

/**
 * Tabs within a project, most-deserving-of-attention first.
 * Needs you, then working, then just-finished, then idle; ties broken by
 * recency so the thing you touched last floats up. Stable for equal keys.
 */
export function sortTermsByAttention(terms) {
  return [...(terms || [])]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (
      statusRank(a.t.status) - statusRank(b.t.status)
      || (b.t.lastActivityAt || 0) - (a.t.lastActivityAt || 0)
      || a.i - b.i
    ))
    .map((x) => x.t);
}

/** Per-group counts the header shows so a collapsed group still informs. */
export function groupSummary(terms) {
  const list = terms || [];
  const needs = list.filter((t) => t.status === 'needs').length;
  const working = list.filter((t) => t.status === 'working').length;
  const done = list.filter((t) => t.status === 'done').length;
  const active = list.filter(isActive).length;
  return { total: list.length, needs, working, done, active, idle: list.length - active };
}

/**
 * The header label for a group, e.g. "1 needs you · 2 working · 4 idle".
 * Built from parts rather than nested ternaries: the first version omitted
 * `done` entirely, so a group whose tabs had all just finished rendered an
 * EMPTY count and the board called them idle (Codex, Medium). Every status
 * that exists has to appear here or a group can silently render blank.
 */
export function summaryLabel(summary) {
  const s = summary || {};
  const parts = [];
  if (s.needs) parts.push(`${s.needs} needs you`);
  if (s.working) parts.push(`${s.working} working`);
  if (s.done) parts.push(`${s.done} done`);
  if (s.idle) parts.push(`${s.idle} idle`);
  return parts.join(' · ');
}

/**
 * Should this project's tabs be hidden?
 *
 * v1.0.65 (Sam 8/24: "doesnt work with the mobile dobius for all the tabs
 * only some"): groups are EXPANDED by default now, so every tab is visible.
 * The old rule auto-collapsed any all-idle group, which on an account with
 * many idle tabs hid most of them behind headers and read as "missing." A
 * group is hidden only when the user has explicitly collapsed it; collapse
 * still wins over expand if both are somehow recorded (hiding is the
 * recoverable error). `terms` is retained for signature stability.
 */
export function isGroupCollapsed(projectPath, terms, { collapsed = [] } = {}) {
  void terms;
  if (collapsed.includes(projectPath)) return true;
  return false;
}
