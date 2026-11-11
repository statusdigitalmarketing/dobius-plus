// Tasks > Team: which rows a person still has to look at, and replies grouped under the message they answer.
// Pure, so the rules are tested without a window (electron/__tests__/team-threads.test.mjs).

import { isDone } from '../../shared/team-done.js';

// States where a person has to act (TeamList shows their labels).
const ATTENTION = new Set(['unconfirmed', 'not delivered', 'conflict', 'held', 'needs attention']);
// Still on its way: nothing for a person to do yet, but not finished either.
const IN_FLIGHT = new Set(['queued', 'sending', 'waiting', 'routing']);
// What a teammate's Mac reported that means it went wrong over there.
const PROBLEM_STAGES = new Set(['held', 'needs attention', 'failed', 'stopped']);

/** Marked done and still where it was when marked (shared/team-done.js): hidden from Open and not counted. */
export const isArchived = isDone;

export const needsPerson = (m) => !!m && ATTENTION.has(m.state) && !isArchived(m);

/** Not handled yet: needs a person, still on its way, or went wrong on the teammate's side. Done never is. */
export function isOpen(m) {
  if (!m || isArchived(m)) return false;
  if (needsPerson(m) || IN_FLIGHT.has(m.state)) return true;
  return m.dir === 'out' && PROBLEM_STAGES.has(m.stage);
}

export const FILTERS = ['open', 'attention', 'all', 'archived'];
function passes(m, filter) {
  if (filter === 'archived') return isArchived(m);
  if (filter === 'attention') return needsPerson(m);
  if (filter === 'all') return !isArchived(m);
  return isOpen(m);
}

const keyOf = (m) => `${m.dir}|${m.peer}|${m.id}`;
// A reply answers a message that went the OTHER way with the same teammate (ids are unique per sender only).
const parentKeyOf = (m) => (m.replyTo ? `${m.dir === 'in' ? 'out' : 'in'}|${m.peer}|${m.replyTo}` : null);

/**
 * Threads to show, newest activity first: [{ key, root, replies }], replies oldest first. `list` is the rows in any
 * order. A thread is shown when ANY of its rows passes the filter (and the teammate and text match), and then whole,
 * so an open reply keeps the message it answers in view.
 */
export function visibleThreads(list, { filter = 'open', peer = '', query = '' } = {}) {
  const rows = Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : [];
  const byKey = new Map(rows.map((m) => [keyOf(m), m]));
  // Up the reply chain to the first row whose parent is not in the list. A chain that loops back on itself (ids are
  // the sender's to choose) gets one root for all its rows: the loop's smallest key, so nothing shows twice.
  const rootOf = (m) => {
    const path = [m];
    const seen = new Set(path);
    for (let cur = m; ;) {
      const p = byKey.get(parentKeyOf(cur));
      if (!p) return cur;
      if (seen.has(p)) return path.slice(path.indexOf(p)).reduce((x, y) => (keyOf(y) < keyOf(x) ? y : x));
      path.push(p);
      seen.add(p);
      cur = p;
    }
  };
  const groups = new Map();
  for (const m of rows) {
    const r = rootOf(m);
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, { key: k, root: r, members: [] });
    groups.get(k).members.push(m);
  }
  const q = String(query || '').toLowerCase();
  const textMatch = (m) => !q || `${m.peerName || ''} ${m.text || ''}`.toLowerCase().includes(q);
  const out = [];
  for (const g of groups.values()) {
    if (peer && g.root.peer !== peer) continue;
    if (!g.members.some((m) => passes(m, filter) && textMatch(m))) continue;
    const replies = g.members.filter((m) => m !== g.root).sort((a, b) => (a.at || 0) - (b.at || 0));
    const latest = Math.max(...g.members.map((m) => m.at || 0));
    out.push({ key: g.key, root: g.root, replies, latest });
  }
  return out.sort((a, b) => b.latest - a.latest);
}

/** How many rows the current filter hides (for "N handled messages are hidden"). */
export function hiddenCount(list, { filter = 'open', peer = '' } = {}) {
  const rows = Array.isArray(list) ? list : [];
  const inPeer = rows.filter((m) => m && (!peer || m.peer === peer));
  const shown = new Set(visibleThreads(inPeer, { filter, peer }).flatMap((t) => [t.root, ...t.replies]));
  return inPeer.filter((m) => !shown.has(m) && !isArchived(m)).length;
}
