/**
 * Phone mode on the phone's WebSocket (docs/phone-mode-design.md, "Phone protocol additions"): phoneTake, phoneSend,
 * phoneAnswer, phoneStop, phoneGiveBack and phoneStateGet. Each request is answered: `ack` (phoneState for
 * phoneStateGet) or `opError {code, message}`, like the tab ops in mobile-tab-ops.js.
 *
 * Auth is the tab ops' auth: the socket must have authorized the tab (`authorizeTab`), on a live tab, from a pairing
 * that is still valid. The shape of every request is checked whole by validatePhoneRequest before anything acts.
 * Pure apart from the injected deps (electron/__tests__/phone-mode-ws.test.mjs).
 */
import { validatePhoneRequest } from './phone-protocol.js';
import { validReqId } from './mobile-tab-ops.js';

export const PHONE_OPS = new Set(['phoneTake', 'phoneSend', 'phoneAnswer', 'phoneStop', 'phoneGiveBack', 'phoneStateGet']);

const MESSAGES = {
  off: 'Phone mode is off on this Mac',
  bad_request: 'Malformed request',
  unknown_tab: 'No live tab has that id',
  not_authorized: 'This connection has not authorized that tab',
  revoked: 'This device was unpaired',
  failed: 'Phone mode could not do that',
};

/**
 * Handle one phone mode request. `deps`:
 *   pm()          the phone mode instance (electron/phone-mode.js), or null when it is not running
 *   on()          the Mac's setting is on (macOS only)
 *   send(obj)     reply on this socket
 *   isLive(id)    a terminal with this exact id exists
 *   authed        this socket's Set of authorized tab ids
 *   stillOk()     the socket's pairing is still valid
 * Returns a promise that settles after the reply is sent.
 */
export async function handlePhoneOp(msg, deps) {
  const op = typeof msg?.type === 'string' ? msg.type : null;
  const reqId = validReqId(msg?.reqId) ? (msg.reqId ?? null) : null;
  const id = typeof msg?.id === 'string' ? msg.id : null;
  const fail = (code, error) => deps.send({ type: 'opError', op, code, id, reqId, message: error || MESSAGES[code] || code });
  const pm = deps.pm();
  if (!pm || !deps.on()) return fail('off');
  if (!validReqId(msg?.reqId)) return fail('bad_request');
  const v = validatePhoneRequest(msg);
  if (!v.ok) return fail(v.code, v.error);
  const r = v.value;
  if (!deps.isLive(r.id)) return fail('unknown_tab');
  if (!deps.authed.has(r.id)) return fail('not_authorized');
  if (!deps.stillOk()) return fail('revoked');
  if (r.type === 'phoneStateGet') return deps.send({ type: 'phoneState', ...pm.stateOf(r.id), id: r.id, reqId });
  let res;
  try {
    if (r.type === 'phoneTake') res = await pm.take(r.id, { sessionId: r.sessionId, gen: r.gen });
    else if (r.type === 'phoneSend') res = await pm.send(r.id, r.runId, r.text, r.sendId);
    else if (r.type === 'phoneAnswer') res = await pm.answer(r.id, r.runId, r.requestId, r.answer);
    else if (r.type === 'phoneStop') res = await pm.stopTurn(r.id, r.runId);
    else res = await pm.giveBack(r.id, r.runId);
  } catch (err) {
    console.error('[phone] request failed:', err?.message || err);
    res = { ok: false, code: 'failed' };
  }
  if (!res?.ok) return fail(res?.code || 'failed', res?.error);
  const ack = { type: 'ack', op, id: r.id, reqId };
  if (typeof res.runId === 'string') ack.runId = res.runId;
  if (Number.isSafeInteger(res.gen)) ack.gen = res.gen;
  if (res.duplicate === true) ack.duplicate = true;
  return deps.send(ack);
}
