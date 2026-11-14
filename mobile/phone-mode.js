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
// write). An older row with the same words is an earlier message, not this one (Codex r27).
export const ARRIVAL_SKEW_MS = 30_000;

/**
 * Whether the transcript shows this phone message: a user row with the same words (`norm`ed both sides) that is
 * queued, or was written no earlier than the message was first sent (less the skew allowance).
 */
export function echoArrived(echo, rows, norm = (t) => String(t).trim()) {
  const want = norm(echo.content);
  const since = echo.since - ARRIVAL_SKEW_MS;
  return (rows || []).some((m) => m && m.role === 'user' && norm(m.content) === want
    && (m.queued === true || Date.parse(m.timestamp) >= since));
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
