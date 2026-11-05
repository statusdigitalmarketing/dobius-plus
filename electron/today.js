/**
 * Today: a short list worth finishing, picked from the Inbox board, plus what SamKnows
 * noticed, shown apart because its items are not reliable enough to rank as obligations
 * (docs/my-day.md). Runs in main, reads only this Mac, and hands the renderer display
 * fields. Never reports "all clear" unless every source answered.
 */
import http from 'http';
import { readBoard } from './inbox-board.js';

export const SUGGESTED = 15;
const RECENT_OVERDUE_DAYS = 7;
const RECENT_WAITING_DAYS = 3;
const NOTICED_MAX = 5;
const NOTICED_READ = 500;
const DAY = 86_400_000;

const dayNumber = (d) => Date.parse(`${d}T00:00:00Z`) / DAY;

// Lower is more pressing. A high-priority card is never aged out of the suggestion.
function bucket(c, today, nowMs) {
  if (c.priority === 'high') return 0;
  if (c.due === today) return 1;
  if (c.due && c.due < today && dayNumber(today) - dayNumber(c.due) <= RECENT_OVERDUE_DAYS) return 2;
  const since = c.since ? Date.parse(c.since) : NaN;
  if (!c.due && Number.isFinite(since) && nowMs - since <= RECENT_WAITING_DAYS * DAY) return 3;
  return null;
}

/**
 * { suggested, otherCount, withinReach, total }. Everything the board holds is counted, and
 * what is not suggested stays one tap away in the Inbox tab. Deterministic: the list does
 * not jump between refreshes.
 */
export function planToday(cards, { today, nowMs = Date.now(), limit = SUGGESTED } = {}) {
  const ranked = [];
  for (const card of cards) {
    const b = bucket(card, today, nowMs);
    if (b !== null) ranked.push({ card, b });
  }
  const PRIORITY = { high: 0, medium: 1, low: 2 };
  // Today, then overdue with the most recent first, then undated, then not due yet.
  const when = (c) => (c.due === today ? 0 : c.due && c.due < today ? 1 : !c.due ? 2 : 3);
  ranked.sort((x, y) => x.b - y.b
    || PRIORITY[x.card.priority] - PRIORITY[y.card.priority]
    || when(x.card) - when(y.card)
    || (when(x.card) === 3 ? (x.card.due || '').localeCompare(y.card.due || '') : (y.card.due || '').localeCompare(x.card.due || ''))
    || (y.card.since || '').localeCompare(x.card.since || '')
    || x.card.id.localeCompare(y.card.id));
  return {
    suggested: ranked.slice(0, limit).map((r) => r.card),
    withinReach: ranked.length,
    otherCount: cards.length - Math.min(ranked.length, limit),
    total: cards.length,
  };
}

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * What SamKnows noticed, display fields only: action items marked high or urgent or due within
 * a week either side of today, and promises this person made that are due in that window.
 * `owner` drops items its own extraction says belong to someone else.
 */
export function noticedFrom(actionItems, followUps, { nowMs = Date.now(), max = NOTICED_MAX } = {}) {
  const near = (ms) => typeof ms === 'number' && Math.abs(ms - nowMs) <= 7 * DAY;
  const out = [];
  for (const a of Array.isArray(actionItems) ? actionItems : []) {
    if (!a || typeof a !== 'object' || a.status !== 'pending') continue;
    if (a.priority !== 'high' && a.priority !== 'urgent' && !near(a.dueDate)) continue;
    out.push({ key: `action:${a.id}`, kind: 'task', title: text(a.title, 200), who: text(a.author, 80), due: typeof a.dueDate === 'number' ? a.dueDate : null, at: a.extractedAt || 0 });
  }
  for (const f of Array.isArray(followUps) ? followUps : []) {
    if (!f || typeof f !== 'object' || f.status !== 'pending' || f.direction !== 'outgoing' || !near(f.dueDate)) continue;
    out.push({ key: `followup:${f.id}`, kind: 'promise', title: text(f.commitment || f.content, 200), who: text(f.person, 80), due: f.dueDate, at: f.detectedAt || 0 });
  }
  const usable = out.filter((n) => n.title);
  usable.sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || b.at - a.at || a.key.localeCompare(b.key));
  return { items: usable.slice(0, max), found: usable.length };
}

// Harness only: an isolated instance must never pull someone's real SamKnows data into a test.
const HARNESS_PORT = process.env.DOBIUS_USERDATA_DIR ? Number(process.env.DOBIUS_SAMKNOWS_PORT) || 1 : null;

function getLocal(path, { port = HARNESS_PORT || 9150, request = http.request, deadlineMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); req?.destroy(); resolve(v); };
    const timer = setTimeout(() => done(null), deadlineMs);
    req = request({ host: '127.0.0.1', port, path, method: 'GET', agent: new http.Agent({ keepAlive: false }), headers: { Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return done(null);
        try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done(null); }
      });
      res.on('error', () => done(null));
    });
    req.on('error', () => done(null));
    req.end();
  });
}

async function readNoticed(opts) {
  const [a, f] = await Promise.all([
    getLocal(`/action-items?status=pending&limit=${NOTICED_READ}`, opts),
    getLocal(`/follow-ups?status=pending&direction=outgoing&limit=${NOTICED_READ}`, opts),
  ]);
  if (!Array.isArray(a?.items) || !Array.isArray(f?.items)) return { state: 'unavailable' };
  const noticed = noticedFrom(a.items, f.items, opts);
  // A cap on what was read means this may have missed some, and it says so.
  const partial = (a.counts?.pending > a.items.length) || (f.items.length >= NOTICED_READ);
  return { state: partial ? 'partial' : 'ok', ...noticed, pending: (a.counts?.pending || 0) + (f.counts?.pending || 0) };
}

export async function readToday(opts = {}) {
  const today = opts.today;
  const [board, noticed] = await Promise.all([
    (opts.readBoard || readBoard)({ ...opts, maxCards: Infinity }),
    (opts.readNoticed || readNoticed)(opts),
  ]);
  const plan = board.ok ? planToday(board.cards, { today: today || board.today, nowMs: opts.nowMs }) : null;
  return {
    board: board.ok ? { state: 'ok', ...plan, overdue: board.overdue, checkedAt: board.checkedAt || null, held: board.held || 0, failing: board.failing || [] } : { state: board.reason || 'unavailable' },
    noticed,
    url: board.url,
  };
}
