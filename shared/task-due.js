import { baseName } from './platform.js';
/**
 * Due dates for the Tasks dropdown. Days are local YYYY-MM-DD strings (Asana's
 * due_on and the Inbox board's due both use that shape), compared as days, so
 * a time zone never moves "today".
 */

export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(s) {
  const m = DAY.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
}

/** { text, tone } for a due day: tone is 'overdue' | 'today' | 'soon' | 'later'. Null when no valid day. */
export function dueLabel(due, today) {
  const d = dayNumber(due);
  const t = dayNumber(today);
  if (d === null || t === null) return null;
  const n = d - t;
  if (n < 0) return { text: n === -1 ? 'yesterday' : `${-n}d overdue`, tone: 'overdue' };
  if (n === 0) return { text: 'today', tone: 'today' };
  if (n === 1) return { text: 'tomorrow', tone: 'soon' };
  if (n < 7) return { text: `in ${n}d`, tone: 'soon' };
  const m = DAY.exec(due);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1];
  return { text: `${month} ${+m[3]}`, tone: 'later' };
}

/** Open tasks first by due day (undated last), then oldest first. Does not mutate. */
export function sortOpenTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const da = dayNumber(a.dueOn);
    const db = dayNumber(b.dueOn);
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    }
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

/** Case-insensitive match of every word in `query` against the given fields. */
export function matchesQuery(query, ...fields) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter((f) => typeof f === 'string').join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

const projectKey = (s) => String(s || '').toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');

/**
 * Does an Inbox board project name ("Dobius+", "Better Health") belong to
 * this project folder ("dobius-plus", "better-health-now")? Loose on purpose,
 * compared on letters and digits only; names under 4 characters never match.
 */
export function sameProject(boardProject, folderPath) {
  const a = projectKey(boardProject);
  const b = projectKey(baseName(String(folderPath || '')));
  if (a.length < 4 || b.length < 4) return false;
  return a === b || b.startsWith(a) || a.startsWith(b);
}
