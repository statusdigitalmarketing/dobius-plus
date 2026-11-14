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
  write_failed: 'write_failed',
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
  stale_view: 'The tab changed since this screen was drawn; reload it',
  on_phone: 'This conversation is on the phone; send from its phone card',
};

/**
 * Phone mode's check on a phone write (docs/phone-mode-design.md, "While on the phone"). `pm` is the phone mode
 * instance (null when it is not running). A write that names the tab generation it was typed against must match the
 * tab's current one, so a key delayed past a trip to the phone and back cannot answer a different prompt. A write
 * without one comes from a phone page older than phone mode (the App Store app bundles its own pages), which never
 * saw a generation: it is refused only while the tab is on the phone, where it would land on the gate and take the
 * conversation back.
 */
export function phoneViewGate(pm, id, msg) {
  if (!pm) return null;
  if (msg.gen === undefined || msg.gen === null) return pm.isPhoneTab(id) ? 'on_phone' : null;
  if (!Number.isSafeInteger(msg.gen) || msg.gen !== pm.gen(id)) return 'stale_view';
  return pm.isPhoneTab(id) ? 'on_phone' : null;
}

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
 *   viewGate(id, msg)            optional: a refusal code from phone mode
 *                                (phoneViewGate), checked on arrival and
 *                                again at the moment of the write
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
  const gated = deps.viewGate?.(id, msg);
  if (gated) return fail(gated);
  deps.onAccepted?.(op, id, msg);
  // Checked again when the write's turn comes: the tab may have moved to the phone while it queued.
  let gateAtWrite = null;
  const stillOk = () => {
    if (!deps.stillOk()) return false;
    gateAtWrite = deps.viewGate?.(id, msg) || null;
    return !gateAtWrite;
  };
  let r;
  try {
    r = op === 'input'
      ? await deps.writeRawInput(id, text, stillOk)
      : await deps.submitPrompt(id, text, stillOk);
  } catch (err) {
    console.error('[mobile] tab write threw:', err?.message || err);
    r = { ok: false, reason: 'write_failed', uncertain: true };
  }
  if (r?.ok) return deps.send({ type: 'ack', op, id, reqId });
  if (gateAtWrite && r?.reason === 'not_allowed') return fail(gateAtWrite);
  // uncertain: the text reached the tab and may have been submitted by
  // another writer's Enter. A client must not resend it as if unsent.
  const code = REASON_CODES[r?.reason] || 'write_failed';
  return fail(code, r?.uncertain ? { uncertain: true } : undefined);
}
