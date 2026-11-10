// Snooze quick picks for a tab (Brett, Asana 1220362133877230): "till night, 9 pm, 24 hours, 2 days".
// Pure: every time is computed from `now` in local time, so tests pass a fixed date.

const HOUR = 60 * 60 * 1000;

function at(base, dayOffset, hour) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0);
  return d.getTime();
}

/**
 * The picks shown under Snooze, in order. `at` is a ms timestamp, or null for "until I bring it back".
 * Tonight 9 PM only while it is still ahead (after 9 PM the first pick is tomorrow night instead).
 * @returns {{ id: string, label: string, at: number|null }[]}
 */
export function snoozePicks(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const ninePmToday = at(now, 0, 21);
  const night = ninePmToday > nowMs
    ? { id: 'tonight', label: 'Tonight', at: ninePmToday }
    : { id: 'tomorrow-night', label: 'Tomorrow night', at: at(now, 1, 21) };
  // Next Monday 9 AM, never today: on a Monday it is a week out.
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return [
    night,
    { id: 'morning', label: 'Tomorrow morning', at: at(now, 1, 9) },
    { id: '24h', label: '24 hours', at: nowMs + 24 * HOUR },
    { id: '2d', label: '2 days', at: nowMs + 48 * HOUR },
    { id: 'week', label: 'Next week', at: at(now, toMonday, 9) },
    { id: 'manual', label: 'Until I bring it back', at: null },
  ];
}

/** "9:00 PM", "Wed 9:00 AM", or "Nov 18, 9:00 AM" past a week; how a pick or a snoozed row shows its time. */
export function snoozeTimeLabel(atMs, nowMs = Date.now()) {
  if (atMs == null) return 'until you bring it back';
  const d = new Date(atMs);
  const now = new Date(nowMs);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  if (atMs - nowMs < 6.5 * 24 * HOUR) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
