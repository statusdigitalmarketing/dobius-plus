// Phone mode on the phone (docs/phone-mode-design.md, "What the person sees"; protocol in docs/mobile-ws-protocol.md,
// "Phone mode"). Pure helpers, no React and no I/O, tested in electron/__tests__/mobile-phone-mode.test.mjs.

/** The Mac offers phone mode (its setting is on, macOS). */
export const phoneOffered = (features) => Array.isArray(features) && features.includes('phone');
/**
 * The Mac runs phone mode at all, setting on or off: its writes carry the tab's generation and its tabs may be on the
 * phone. Only a Mac without either feature (an older app, Windows) takes writes with no generation.
 */
export const phoneKnown = (features) => Array.isArray(features) && (features.includes('phoneGen') || features.includes('phone'));

/** A fresh id for a request (reqId) or a message (sendId): 1 to 64 of [A-Za-z0-9_-]. */
export function freshId(prefix) {
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${r}`.slice(0, 64);
}

const STATUSES = new Set(['starting', 'idle', 'working', 'waiting', 'ending']);

/**
 * A phoneState message as the screen uses it, or null when it is not one for `tabId`. Unknown fields are dropped and
 * every card keeps only what the screen shows (all of it is shown as text, never markup).
 */
export function readPhoneState(msg, tabId) {
  if (!msg || msg.type !== 'phoneState' || msg.id !== tabId) return null;
  const gen = Number.isSafeInteger(msg.gen) && msg.gen >= 0 ? msg.gen : null;
  if (msg.on !== true) return { on: false, gen };
  return {
    on: true, gen,
    runId: typeof msg.runId === 'string' ? msg.runId : null,
    sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
    status: STATUSES.has(msg.status) ? msg.status : 'starting',
    error: typeof msg.error === 'string' ? msg.error : '',
    pending: Array.isArray(msg.pending) ? msg.pending.filter((c) => c && typeof c.requestId === 'string' && ['question', 'permission', 'plan'].includes(c.kind)) : [],
  };
}

/** What the header says while the conversation is on the phone. */
export const STATUS_WORDS = {
  starting: 'Moving to your phone...',
  idle: 'On your phone',
  working: 'Claude is working',
  waiting: 'Claude is waiting for you',
  ending: 'Going back to the Mac...',
};

/**
 * The answer a question card sends: every question answered, by the option labels picked (several joined by ", ")
 * and the person's own words. Returns { answer } or { missing: question } for the first question with nothing.
 * `picks` maps a question's text to { labels: string[], own: string }.
 */
export function questionAnswer(card, picks) {
  const answers = {};
  for (const q of card?.questions || []) {
    const p = picks?.[q.question] || {};
    const labels = Array.isArray(p.labels) ? p.labels.filter((l) => typeof l === 'string' && l) : [];
    const own = typeof p.own === 'string' ? p.own.trim() : '';
    const parts = q.multiSelect ? [...labels] : labels.slice(0, 1);
    if (own) parts.push(own);
    if (parts.length === 0) return { missing: q.question };
    answers[q.question] = parts.join(', ');
  }
  return { answer: { kind: 'question', answers } };
}

/** Pick or unpick an option label: one at a time for a single choice, any number for a several-choice question. */
export function togglePick(current, label, multiSelect) {
  const labels = Array.isArray(current) ? current : [];
  if (labels.includes(label)) return labels.filter((l) => l !== label);
  return multiSelect ? [...labels, label] : [label];
}

/** The permission answer, with a note only when there is one. */
export function permissionAnswer(allow, { always = false, note = '' } = {}) {
  const a = { kind: 'permission', allow: allow === true };
  if (allow === true && always === true) a.always = true;
  const n = typeof note === 'string' ? note.trim() : '';
  if (n) a.note = n;
  return a;
}

/** The plan answer: approve (optionally into a mode) or keep planning with a note. */
export function planAnswer(approve, { mode = null, note = '' } = {}) {
  const a = { kind: 'plan', approve: approve === true };
  if (approve === true && (mode === 'default' || mode === 'acceptEdits')) a.mode = mode;
  const n = typeof note === 'string' ? note.trim() : '';
  if (n) a.note = n;
  return a;
}

// Codes that mean the Mac or the runner did not take a message. Anything else (no answer, timeout, failed, a code
// this app does not know) leaves it unknown whether it arrived.
const NOT_TAKEN = new Set(['off', 'bad_request', 'unknown_tab', 'not_authorized', 'revoked', 'stale_run', 'not_live',
  'too_large', 'busy', 'stale_view', 'on_phone']);

/**
 * What became of a phone message: 'sent' (acked), 'failed' (clearly not taken) or 'unconfirmed' (`msg` null for no
 * answer, or a code that does not say). Either failure keeps the message's sendId for Send again: the Mac forgets an id
 * it did not take and answers `duplicate` for one that did arrive, so a retry is delivered at most once.
 */
export function sendOutcome(msg) {
  if (msg && msg.type === 'ack') return 'sent';
  if (msg && msg.type === 'opError' && NOT_TAKEN.has(msg.code)) return 'failed';
  return 'unconfirmed';
}

// How far a Mac's transcript time may sit before the phone's send time and still be that send (clock skew, a slow
// write).
export const ARRIVAL_SKEW_MS = 30_000;
const MAX_KNOWN = 50;

/**
 * What the transcript already held with the same words when a phone message was sent: those rows' ids, and how many
 * queued rows. A row in this baseline is an earlier message, never this one (Codex r27, r28).
 */
export function echoBaseline(content, rows, norm = (t) => String(t).trim()) {
  const want = norm(content);
  const known = [];
  let knownQueued = 0;
  for (const m of rows || []) {
    if (!m || m.role !== 'user' || norm(m.content) !== want) continue;
    if (m.queued === true) knownQueued += 1;
    else if (typeof m.id === 'string' && m.id) known.push(m.id);
  }
  return { known: known.slice(-MAX_KNOWN), knownQueued };
}

/**
 * Takes away the bubbles of phone messages the transcript now shows. Only a message the Mac said it took (`acked`) is
 * matched to a row: a row carries no sendId, so the same words from another phone, or an earlier message, would look
 * the same, and a message whose answer was lost must keep its bubble and Send again until its own sendId settles it
 * (Send again answers `duplicate` for one that arrived) or it is removed (Codex r30). One row per message, oldest first,
 * never a row that was there when it was sent. Echoes without a sendId are left alone. The same array when nothing
 * changed.
 */
export function reconcileEchoes(echoes, rows, norm = (t) => String(t).trim()) {
  const list = echoes || [];
  const used = new Set();
  const queuedUsed = new Map();
  const cleared = new Set();
  const order = list.filter((e) => e && e.sendId && e.acked === true && !e.fail).sort((a, b) => a.since - b.since);
  for (const e of order) {
    const want = norm(e.content);
    const known = new Set(Array.isArray(e.known) ? e.known : []);
    const since = e.since - ARRIVAL_SKEW_MS;
    let queued = 0;
    let hit = false;
    for (const m of rows || []) {
      if (!m || m.role !== 'user' || norm(m.content) !== want) continue;
      if (m.queued === true) { queued += 1; continue; }
      if (typeof m.id === 'string' && m.id && !used.has(m.id) && !known.has(m.id) && Date.parse(m.timestamp) >= since) {
        used.add(m.id);
        hit = true;
        break;
      }
    }
    if (!hit) {
      const taken = queuedUsed.get(want) || 0;
      if (queued - taken > (Number.isInteger(e.knownQueued) ? e.knownQueued : 0)) {
        queuedUsed.set(want, taken + 1);
        hit = true;
      }
    }
    if (hit) cleared.add(e);
  }
  return cleared.size ? list.filter((e) => !cleared.has(e)) : list;
}

/** How long a bubble waits for its row before it goes. A phone message that failed or was never confirmed stays. */
export const ECHO_TTL_MS = 90_000;

/** Echoes past their wait dropped, except a phone message that failed or was never confirmed. Same array if none. */
export function ageEchoes(cur, now = Date.now()) {
  if (!cur || cur.length === 0) return cur;
  const kept = cur.filter((e) => e.fail || now - e.at < ECHO_TTL_MS);
  return kept.length === cur.length ? cur : kept;
}

/**
 * The chat's echoes after a transcript reply: acked phone messages matched by reconcileEchoes, other local echoes
 * dropped once a user row has their words, then ageEchoes. The same array when nothing changed.
 */
export function pruneEchoes(cur, rows, norm = (t) => String(t).trim(), now = Date.now()) {
  if (!cur || cur.length === 0) return cur;
  const seen = new Set((rows || []).filter((m) => m && m.role === 'user').map((m) => norm(m.content)));
  const matched = reconcileEchoes(cur, rows, norm);
  const local = matched.filter((e) => e.sendId || !seen.has(norm(e.content)));
  return ageEchoes(local.length === cur.length ? cur : local, now);
}

/** Phone messages on this tab still waiting for the Mac's answer. */
export const waitingCount = (echoes) => (echoes || []).filter((e) => e && e.sendId && !e.acked).length;

/** How many phone messages may wait for an answer on one tab: the outbox keeps exactly these, so none is dropped. */
export const MAX_OUTSTANDING = 5;
/** How many tabs may have phone messages waiting at once; past it the composer refuses rather than drop a tab's. */
export const OUTBOX_TABS = 20;
const OUTBOX_DAYS = 7;
// ponytail: hard ceilings for storage written past the composer's checks (two phone pages sending on one tab, or saving
// at once). Only those can reach them; the oldest entries go then.
const OUTBOX_TABS_HARD = 40;
const OUTBOX_PER_TAB_HARD = 20;

const fresh = (e, now) => e && typeof e.content === 'string' && e.content && typeof e.sendId === 'string' && typeof e.runId === 'string'
  && Number.isFinite(e.since) && now - e.since < OUTBOX_DAYS * 86_400_000;

/**
 * The phone messages not yet known to have reached a tab, as kept between visits (the chat screen unmounts when the
 * person leaves the tab): at most 5 per tab, 20 tabs (the composer's limits), 7 days. One read on load means "the
 * answer was never seen", so each comes back as not confirmed, with Send again (Codex r28).
 */
export function readOutbox(map, tabId, now = Date.now()) {
  const list = map && typeof map === 'object' && Array.isArray(map[tabId]) ? map[tabId] : [];
  return list.filter((e) => fresh(e, now))
    .slice(-OUTBOX_PER_TAB_HARD)
    .map((e) => ({
      content: e.content, sendId: e.sendId, runId: e.runId, since: e.since, at: e.since,
      known: Array.isArray(e.known) ? e.known.filter((k) => typeof k === 'string').slice(-MAX_KNOWN) : [],
      knownQueued: Number.isInteger(e.knownQueued) ? e.knownQueued : 0,
      fail: e.fail === 'failed' ? 'failed' : 'unconfirmed',
    }));
}

/** True when this tab may not start keeping messages: OUTBOX_TABS other tabs already have some waiting. */
export function outboxFull(map, tabId, now = Date.now()) {
  if (!map || typeof map !== 'object') return false;
  if (Array.isArray(map[tabId]) && map[tabId].some((e) => fresh(e, now))) return false;
  return Object.entries(map).filter(([k, v]) => k !== tabId && Array.isArray(v) && v.some((e) => fresh(e, now))).length >= OUTBOX_TABS;
}

/**
 * The outbox map with this page's entries for the tab replaced by `echoes` (phone messages not yet answered as taken).
 * `owned` is every sendId this page loaded or sent: stored entries it does not own belong to another open page on the
 * same phone and are kept (Codex r31). Without `owned`, the tab's entries are replaced outright.
 */
export function writeOutbox(map, tabId, echoes, now = Date.now(), owned = null) {
  const next = { ...(map && typeof map === 'object' ? map : {}) };
  const mine = (echoes || []).filter((e) => e && e.sendId && !e.acked)
    .map(({ content, sendId, runId, since, known, knownQueued, fail }) => ({ content, sendId, runId, since, known, knownQueued, fail: fail || null }));
  const ids = new Set(mine.map((e) => e.sendId));
  const others = owned && Array.isArray(next[tabId])
    ? next[tabId].filter((e) => e && typeof e.sendId === 'string' && !owned.has(e.sendId) && !ids.has(e.sendId)) : [];
  const keep = [...others, ...mine].slice(-OUTBOX_PER_TAB_HARD);
  if (keep.length) next[tabId] = keep; else delete next[tabId];
  const newest = (v) => Math.max(0, ...(Array.isArray(v) ? v.map((e) => e?.since || 0) : [0]));
  const entries = Object.entries(next).filter(([, v]) => Array.isArray(v) && now - newest(v) < OUTBOX_DAYS * 86_400_000)
    .sort((a, b) => newest(b[1]) - newest(a[1])).slice(0, OUTBOX_TABS_HARD);
  return Object.fromEntries(entries);
}

/** Why a move did not happen, in the words the sheet shows. The Mac's own sentence wins when it sent one. */
export function refusalText(code, message) {
  if (typeof message === 'string' && message.trim() && message.length <= 300) {
    const m = message.trim();
    return m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? '' : '.');
  }
  return {
    off: 'Phone mode is off on this Mac.',
    stale_view: 'The tab changed since you looked. Look again and try once more.',
    stale_run: 'That phone session is over.',
    revoked: 'This phone was unpaired from the Mac.',
  }[code] || 'It could not be moved right now.';
}
