/**
 * Phone mode: the shape of every phone request, checked before anything acts on it (docs/phone-mode-design.md,
 * "Phone protocol additions"). Pure: no I/O, no state. A request that does not match is refused whole; nothing is
 * coerced or trimmed into shape.
 */

export const MAX_TEXT = 8 * 1024; // a message, an answer or a note
export const MAX_QUESTIONS = 20;
export const MAX_TAB_ID = 4096;
// The modes a person can leave plan mode into from the phone, as the TUI's own plan prompt offers.
export const PLAN_MODES = new Set(['default', 'acceptEdits']);

const RUN_ID = /^[0-9a-f]{32}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEND_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A tool use id (SDK `toolUseID`, scoped by agent id for subagents): printable, no spaces, bounded.
const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;

const bad = (code, error) => ({ ok: false, code, error });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max = MAX_TEXT) => typeof v === 'string' && v.length <= max;
const isTabId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TAB_ID;
const isGen = (v) => Number.isSafeInteger(v) && v >= 0;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** An answer to one pending card. Returns { ok, value } with a fresh object, or { ok: false, code, error }. */
export function validateAnswer(a) {
  if (!isObj(a)) return bad('bad_answer', 'answer must be an object');
  if (a.kind === 'question') {
    if (!isObj(a.answers)) return bad('bad_answer', 'answers must be an object');
    const keys = Object.keys(a.answers);
    if (keys.length === 0 || keys.length > MAX_QUESTIONS) return bad('bad_answer', 'between 1 and 20 answers');
    // Null prototype: a question text of "__proto__" is just a key here.
    const answers = Object.create(null);
    for (const q of keys) {
      if (!isText(q) || q.length === 0) return bad('bad_answer', 'a question must be non-empty text');
      if (!isText(a.answers[q])) return bad('bad_answer', 'an answer must be text of at most 8 KB');
      answers[q] = a.answers[q];
    }
    return { ok: true, value: { kind: 'question', answers } };
  }
  if (a.kind === 'permission') {
    if (typeof a.allow !== 'boolean') return bad('bad_answer', 'allow must be true or false');
    if (own(a, 'always') && typeof a.always !== 'boolean') return bad('bad_answer', 'always must be true or false');
    if (a.always && !a.allow) return bad('bad_answer', 'always applies only to allow');
    if (own(a, 'note') && !isText(a.note)) return bad('bad_answer', 'note must be text of at most 8 KB');
    return { ok: true, value: { kind: 'permission', allow: a.allow, always: a.always === true, note: a.note ?? '' } };
  }
  if (a.kind === 'plan') {
    if (typeof a.approve !== 'boolean') return bad('bad_answer', 'approve must be true or false');
    if (own(a, 'mode') && !(typeof a.mode === 'string' && PLAN_MODES.has(a.mode))) return bad('bad_answer', 'unknown mode');
    if (own(a, 'mode') && !a.approve) return bad('bad_answer', 'mode applies only to approve');
    if (own(a, 'note') && !isText(a.note)) return bad('bad_answer', 'note must be text of at most 8 KB');
    return { ok: true, value: { kind: 'plan', approve: a.approve, mode: a.mode ?? null, note: a.note ?? '' } };
  }
  return bad('bad_answer', 'unknown answer kind');
}

/**
 * One phone request (an already parsed WS message). Returns { ok, value } where value holds only the checked fields,
 * or { ok: false, code, error }. Auth and run/state checks are the caller's; this is shape only.
 */
export function validatePhoneRequest(m) {
  if (!isObj(m) || typeof m.type !== 'string') return bad('bad_request', 'not a request');
  if (!isTabId(m.id)) return bad('bad_request', 'id must be a tab id');
  const id = m.id;
  switch (m.type) {
    case 'phoneTake':
      if (typeof m.sessionId !== 'string' || !SESSION_ID.test(m.sessionId)) return bad('bad_request', 'sessionId must be a session id');
      if (!isGen(m.gen)) return bad('bad_request', 'gen must be a non-negative integer');
      return { ok: true, value: { type: m.type, id, sessionId: m.sessionId, gen: m.gen } };
    case 'phoneSend':
    case 'phoneAnswer':
    case 'phoneStop':
    case 'phoneGiveBack': {
      if (typeof m.runId !== 'string' || !RUN_ID.test(m.runId)) return bad('bad_request', 'runId must be a run id');
      if (m.type === 'phoneSend') {
        if (!isText(m.text) || m.text.trim() === '') return bad('bad_request', 'text must be non-empty and at most 8 KB');
        if (typeof m.sendId !== 'string' || !SEND_ID.test(m.sendId)) return bad('bad_request', 'sendId must be 1 to 64 letters, digits, _ or -');
        return { ok: true, value: { type: m.type, id, runId: m.runId, text: m.text, sendId: m.sendId } };
      }
      if (m.type === 'phoneAnswer') {
        if (typeof m.requestId !== 'string' || !REQUEST_ID.test(m.requestId)) return bad('bad_request', 'requestId must be a request id');
        const ans = validateAnswer(m.answer);
        if (!ans.ok) return ans;
        return { ok: true, value: { type: m.type, id, runId: m.runId, requestId: m.requestId, answer: ans.value } };
      }
      return { ok: true, value: { type: m.type, id, runId: m.runId } };
    }
    case 'phoneStateGet':
      return { ok: true, value: { type: m.type, id } };
    default:
      return bad('bad_request', 'unknown request');
  }
}

/** The generation a legacy phone tab write carries (input, submitPrompt, selectorKey, resize), or null if absent/bad. */
export function viewGenOf(m) {
  return isObj(m) && isGen(m.gen) ? m.gen : null;
}
