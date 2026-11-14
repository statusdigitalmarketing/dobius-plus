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
  const ended = readEnded(msg.ended);
  if (msg.on !== true) return { on: false, gen, ended };
  return {
    on: true, gen, ended,
    delivered: Array.isArray(msg.delivered) ? msg.delivered.filter((x) => typeof x === 'string').slice(-64) : [],
    runId: typeof msg.runId === 'string' ? msg.runId : null,
    sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
    status: STATUSES.has(msg.status) ? msg.status : 'starting',
    error: typeof msg.error === 'string' ? msg.error : '',
    pending: Array.isArray(msg.pending) ? msg.pending.filter((c) => c && typeof c.requestId === 'string' && ['question', 'permission', 'plan'].includes(c.kind)) : [],
  };
}

// Ended runs as the Mac reports them: which phone messages never reached Claude ('not_sent') or reached it unread
// ('unsure'), and `truncated` when the Mac kept only part of that list.
function readEnded(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-8).filter((e) => e && typeof e.runId === 'string').map((e) => ({
    runId: e.runId,
    truncated: e.truncated === true,
    lost: new Map((Array.isArray(e.lost) ? e.lost : []).slice(0, 64)
      .filter((x) => x && typeof x.sendId === 'string')
      .map((x) => [x.sendId, x.why === 'not_sent' ? 'not_sent' : 'unsure'])),
  }));
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
 * Takes away the bubbles of phone messages the transcript now shows. Only a message the Mac said Claude read
 * (`delivered`) is matched to a row: a row carries no sendId, so the same words from another phone, or an earlier message, would look
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
  const order = list.filter((e) => e && e.sendId && e.delivered === true && !e.fail).sort((a, b) => a.since - b.since);
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

/** How long a bubble waits for its row before it goes. A phone message Claude has not read stays. */
export const ECHO_TTL_MS = 90_000;

/** Echoes past their wait dropped, except a phone message Claude is not known to have read. Same array if none. */
export function ageEchoes(cur, now = Date.now()) {
  if (!cur || cur.length === 0) return cur;
  const kept = cur.filter((e) => e.fail || (e.sendId && !e.delivered) || now - e.at < ECHO_TTL_MS);
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

/**
 * Applies what the Mac says about a tab's runs to its phone messages (Codex r34). The Mac's answer to a send says only
 * that the runner queued it: the message is read by Claude when the Mac lists its sendId as delivered (that also
 * settles one whose answer was lost). Once its run is over, the Mac's list of that run's losses decides: never sent
 * ('not_sent') comes back Not sent, reached Claude unread ('unsure') Not confirmed; a queued message missing from a
 * complete list was read. A run the Mac no longer knows leaves its queued messages Not confirmed. `s` is a
 * readPhoneState result; the same array when nothing changed.
 */
export function applyRunState(echoes, s, now = Date.now()) {
  if (!echoes || echoes.length === 0 || !s) return echoes;
  const read = new Set(s.on ? s.delivered || [] : []);
  let changed = false;
  const next = echoes.map((e) => {
    if (!e || !e.sendId || e.delivered) return e;
    const live = s.on && s.runId === e.runId;
    if (live) {
      if (!read.has(e.sendId)) return e;
      changed = true;
      return { ...e, acked: true, delivered: true, fail: null, at: now };
    }
    if (!e.acked) return e; // never taken, or its answer was lost: Send again settles it
    const ended = (s.ended || []).find((x) => x.runId === e.runId);
    const why = ended?.lost.get(e.sendId);
    changed = true;
    if (why) return { ...e, acked: false, fail: why === 'not_sent' ? 'failed' : 'unconfirmed' };
    if (!ended || ended.truncated) return { ...e, acked: false, fail: 'unconfirmed' };
    return { ...e, delivered: true, at: now };
  });
  return changed ? next : echoes;
}

/** Phone messages on this tab Claude is not known to have read (each kept in the outbox until it is). */
export const waitingCount = (echoes) => (echoes || []).filter((e) => e && e.sendId && !e.delivered).length;

/** How many phone messages may wait to reach Claude on one tab: the outbox keeps exactly these, so none is dropped. */
export const MAX_OUTSTANDING = 5;
/** How many tabs may have phone messages waiting at once; past it the composer refuses rather than drop a tab's. */
export const OUTBOX_TABS = 20;
const OUTBOX_DAYS = 7;
// ponytail: what one tab brings back on load. The composer keeps one page to MAX_OUTSTANDING; only several pages
// sending on one tab can store more, and the oldest past this stay stored until they expire.
const OUTBOX_PER_TAB_LOAD = 20;

const fresh = (e, now) => e && typeof e.content === 'string' && e.content && typeof e.sendId === 'string' && typeof e.runId === 'string'
  && Number.isFinite(e.since) && now - e.since < OUTBOX_DAYS * 86_400_000;

// The outbox keeps each phone message under its own key, `<base>|<tab>|<sendId>`, so a save writes or removes only its
// own messages and never rewrites another page's: two pages on one phone cannot lose each other's by saving at the same
// time (Codex r31, r32). `storage` is localStorage or anything with its methods.
const msgKey = (base, tabId, sendId) => `${base}|${encodeURIComponent(tabId)}|${sendId}`;
function* outboxKeys(storage, base) {
  const keys = [];
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (typeof k === 'string' && k.startsWith(`${base}|`)) keys.push(k); }
  for (const k of keys) {
    const parts = k.slice(base.length + 1).split('|');
    if (parts.length !== 2) continue;
    let tab;
    try { tab = decodeURIComponent(parts[0]); } catch { continue; }
    yield { key: k, tab, sendId: parts[1] };
  }
}
function readEntry(storage, key, now) {
  try {
    const e = JSON.parse(storage.getItem(key));
    return fresh(e, now) ? e : null;
  } catch { return null; }
}

/**
 * The phone messages not yet known to have reached a tab, as kept between visits (the chat screen unmounts when the
 * person leaves the tab), oldest first, 7 days at most (older or unreadable entries are removed). One the Mac took
 * comes back queued, for the Mac's next state to settle (applyRunState); any other one's answer was never seen, so it
 * comes back as not confirmed, with Send again (Codex r28).
 */
export function loadOutbox(storage, base, tabId, now = Date.now()) {
  const list = [];
  for (const { key, tab, sendId } of outboxKeys(storage, base)) {
    if (tab !== tabId) continue;
    const e = readEntry(storage, key, now);
    if (!e || e.sendId !== sendId) { storage.removeItem(key); continue; }
    list.push(e);
  }
  return list.sort((a, b) => a.since - b.since).slice(-OUTBOX_PER_TAB_LOAD).map((e) => ({
    content: e.content, sendId: e.sendId, runId: e.runId, since: e.since, at: e.since,
    known: Array.isArray(e.known) ? e.known.filter((k) => typeof k === 'string').slice(-MAX_KNOWN) : [],
    knownQueued: Number.isInteger(e.knownQueued) ? e.knownQueued : 0,
    ...(e.acked === true && !e.fail ? { acked: true, fail: null } : { fail: e.fail === 'failed' ? 'failed' : 'unconfirmed' }),
  }));
}

/**
 * Saves this page's phone messages for a tab: each one Claude is not known to have read is written under its own key,
 * and each sendId in `owned` (what this page loaded or sent) that is no longer waiting is removed. Nothing else is
 * touched.
 */
export function saveOutbox(storage, base, tabId, echoes, owned) {
  const waiting = new Map((echoes || []).filter((e) => e && e.sendId && !e.delivered).map((e) => [e.sendId, e]));
  for (const id of new Set([...(owned || []), ...waiting.keys()])) {
    const key = msgKey(base, tabId, id);
    const e = waiting.get(id);
    if (!e) { storage.removeItem(key); continue; }
    const { content, sendId, runId, since, known, knownQueued, fail } = e;
    const value = JSON.stringify({ content, sendId, runId, since, known, knownQueued, fail: fail || null, acked: e.acked === true });
    if (storage.getItem(key) !== value) storage.setItem(key, value);
  }
}

/**
 * True when this tab may not start keeping messages: OUTBOX_TABS other tabs already have some waiting. It reads every
 * key, so it also removes expired or unreadable ones, whichever tab they belong to: a tab never opened again cannot
 * leave its entries behind for good (Codex r33).
 */
export function outboxFull(storage, base, tabId, now = Date.now()) {
  const tabs = new Set();
  let mine = false;
  for (const { key, tab, sendId } of outboxKeys(storage, base)) {
    const e = readEntry(storage, key, now);
    if (!e || e.sendId !== sendId) { storage.removeItem(key); continue; }
    if (tab === tabId) mine = true; else tabs.add(tab);
  }
  return !mine && tabs.size >= OUTBOX_TABS;
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
