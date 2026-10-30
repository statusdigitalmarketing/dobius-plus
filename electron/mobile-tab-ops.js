// The three phone WS requests that write to (or authorize writes to) a tab:
// authorizeTab, input and submitPrompt. Each one is ANSWERED: an `ack` once the
// tab is authorized or the text is in the PTY, an `opError` with a code
// otherwise. Before v1.0.88 all three dropped a bad request silently, so an
// orchestrator relaying to a short id (`better-telehealth-83` for
// `term-/Users/.../better-telehealth-83`) printed SENT for an afternoon of
// messages that never arrived (2026-10-30).
//
// The refusal is `opError`, not `error`: the phone's Board shows every `error`
// frame as a failed create and Terminal.jsx releases its create guard on one,
// and phones running an older cached bundle would do that for every refused
// keystroke. Old clients ignore unknown types, so `ack` and `opError` are
// invisible to them. Docs: docs/mobile-ws-protocol.md.
//
// Pure apart from the injected deps, so the rules are tested without a PTY
// (electron/__tests__/mobile-tab-ops.test.mjs).

export const TAB_OPS = new Set(['authorizeTab', 'input', 'submitPrompt']);
export const ACK_FEATURES = Object.freeze(['ack']);
export const MAX_REQ_ID_CHARS = 64;
export const MAX_CANDIDATES = 5;

// chat-service reasons -> wire codes. 'not_allowed' there is the pairing check
// (knownToken), so on this socket it means the token was revoked while queued.
const REASON_CODES = {
  tab_exited: 'tab_exited',
  not_allowed: 'revoked',
  cancelled: 'cancelled',
  stranded: 'stranded',
  empty: 'empty_text',
};

const MESSAGES = {
  bad_request: 'Malformed request',
  unknown_tab: 'No live tab has that id',
  not_authorized: 'This connection has not authorized that tab',
  empty_text: 'Nothing to send',
  too_large: 'Text is over the size limit',
  revoked: 'This device was unpaired before the write',
  tab_exited: 'The tab exited before the write',
  cancelled: 'A cancel key dropped the write',
  stranded: 'Pasted, but Enter was withheld because something else typed into the tab',
  write_failed: 'The write failed',
};

/** A client reqId is optional; when present it is a short string or a safe integer. */
export function validReqId(v) {
  return v === undefined || v === null
    || (typeof v === 'string' && v.length > 0 && v.length <= MAX_REQ_ID_CHARS)
    || Number.isSafeInteger(v);
}

/**
 * Full live ids a short id probably meant: those whose last path segment is
 * the short id (`better-telehealth-83` for `term-/Users/x/better-telehealth-83`),
 * or is it minus a leading `term-`. A HINT only, never acted on: two projects
 * can share a final segment, and typing into the wrong project's Claude is far
 * worse than an error, so even a single candidate is returned as unknown_tab.
 * The same socket can list every terminal with full ids (listTerminals), so
 * this discloses nothing it could not already read.
 */
export function tabCandidates(shortId, liveIds) {
  if (typeof shortId !== 'string' || !shortId || shortId.includes('/')) return [];
  const bare = shortId.startsWith('term-') ? shortId.slice(5) : null;
  const out = [];
  for (const id of liveIds) {
    const last = id.slice(id.lastIndexOf('/') + 1);
    if (last === shortId || (bare && last === bare)) out.push(id);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * Handle one tab op. `deps`:
 *   send(obj)                    reply on this socket
 *   isLive(id)                   a terminal with this exact id exists
 *   liveIds()                    every live terminal id (only read on a miss)
 *   authed                       this socket's Set of authorized tab ids
 *   maxBytes                     byte cap for input data and prompt text
 *   stillOk()                    the socket's pairing is still valid
 *   writeRawInput(id, data, ok)  chat-service, resolves { ok, reason }
 *   submitPrompt(id, text, ok)   chat-service submitPromptDetailed
 *   onAccepted(op, id, msg)      side effects that ran before acks existed
 *                                (selector refresh), once a write is accepted
 * Returns a promise that settles after the reply is sent (tests await it).
 */
export async function handleTabOp(msg, deps) {
  const op = msg.type;
  const reqId = validReqId(msg.reqId) ? (msg.reqId ?? null) : null;
  const id = typeof msg.id === 'string' ? msg.id : null;
  const fail = (code, extra) => deps.send({
    type: 'opError', op, code, id, reqId, message: MESSAGES[code] || code, ...extra,
  });
  if (!validReqId(msg.reqId) || id === null) return fail('bad_request');
  if (!deps.isLive(id)) {
    let candidates = [];
    try { candidates = tabCandidates(id, deps.liveIds()); } catch { candidates = []; }
    return fail('unknown_tab', { candidates });
  }
  if (op === 'authorizeTab') {
    deps.authed.add(id);
    return deps.send({ type: 'ack', op, id, reqId });
  }
  if (!deps.authed.has(id)) return fail('not_authorized');
  const text = op === 'input' ? msg.data : msg.text;
  if (typeof text !== 'string') return fail('bad_request');
  // A prompt of only whitespace is refused as before; raw input may be any
  // non-empty keys (a lone space or Enter is a real keypress).
  if (op === 'submitPrompt' ? !text.trim() : !text) return fail('empty_text');
  if (Buffer.byteLength(text, 'utf8') > deps.maxBytes) return fail('too_large');
  deps.onAccepted?.(op, id, msg);
  let r;
  try {
    r = op === 'input'
      ? await deps.writeRawInput(id, text, deps.stillOk)
      : await deps.submitPrompt(id, text, deps.stillOk);
  } catch {
    r = { ok: false, reason: 'write_failed' };
  }
  if (r?.ok) return deps.send({ type: 'ack', op, id, reqId });
  return fail(REASON_CODES[r?.reason] || 'write_failed');
}
