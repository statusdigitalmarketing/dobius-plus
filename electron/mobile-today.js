// Today, the Inbox and a few settings for the phone, over the phone server's authed WebSocket.
// main.js hands in the SAME functions its desktop IPC handlers use (setTodayBridge), so the phone
// never has a second code path to the board, the picks or the snoozes. Docs: docs/mobile-ws-protocol.md.
//
// Card text goes only to an authed phone, as the reply to its own request. It is never logged
// here and nothing here writes it to disk.

export const TODAY_FEATURES = Object.freeze(['today', 'settings']);

const MAX_REQ_ID = 64;
const MAX_ID = 200;
const NUDGE_DEFAULTS = Object.freeze({ imessage: true, mac: true, push: true, morningAt: '08:00', quietAfter: '20:00' });
const NEW_TAB_TOOLS = new Set(['claude', 'codex', 'shell']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

let bridge = null;
export function setTodayBridge(b) { bridge = b || null; }

const minutes = (hhmm) => { const m = HHMM.exec(hhmm); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** The nudge settings with defaults filled in and anything malformed replaced. */
export function nudgeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...NUDGE_DEFAULTS };
  for (const k of ['imessage', 'mac', 'push']) if (typeof r[k] === 'boolean') out[k] = r[k];
  const morning = minutes(r.morningAt);
  const quiet = minutes(r.quietAfter);
  // Only a pair that leaves a daytime window counts: 08:00 and 07:00 would silence every nudge.
  if (morning !== null && quiet !== null && quiet >= morning + 120) { out.morningAt = r.morningAt; out.quietAfter = r.quietAfter; }
  return out;
}

/**
 * Validate one phone settings write against the allowlist. Returns { ok, apply } where apply is
 * what main should do, or { ok:false, error }. Nothing here can turn off the phone server, touch
 * pairing, keys or hooks: a phone must never be able to lock itself out.
 */
export function checkSettingWrite(key, value, current = {}) {
  if (key === 'newTabTool') {
    return NEW_TAB_TOOLS.has(value) ? { ok: true, apply: { settings: { newTabTool: value } } } : { ok: false, error: 'bad-value' };
  }
  if (key === 'autoMode') {
    return typeof value === 'boolean' ? { ok: true, apply: { autoMode: value } } : { ok: false, error: 'bad-value' };
  }
  if (key === 'todayNudges') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'bad-value' };
    const merged = { ...nudgeSettings(current), ...value };
    for (const k of ['imessage', 'mac', 'push']) if (typeof merged[k] !== 'boolean') return { ok: false, error: 'bad-value' };
    const morning = minutes(merged.morningAt);
    const quiet = minutes(merged.quietAfter);
    if (morning === null || quiet === null) return { ok: false, error: 'bad-time' };
    // At least two hours, so the morning nudge (which can wait 30 minutes for Claude) has a window.
    if (quiet < morning + 120) return { ok: false, error: 'quiet-before-morning' };
    if (morning < 5 * 60 || morning > 12 * 60) return { ok: false, error: 'bad-time' };
    const { imessage, mac, push, morningAt, quietAfter } = merged;
    return { ok: true, apply: { settings: { todayNudges: { imessage, mac, push, morningAt, quietAfter } } } };
  }
  return { ok: false, error: 'not-allowed' };
}

const reqIdOf = (msg) => (typeof msg.reqId === 'string' && msg.reqId.length <= MAX_REQ_ID ? msg.reqId : null);
const idOk = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID;

// The board's own address is a loopback URL the phone cannot open: never send it.
const withoutUrl = (r) => { if (!r || typeof r !== 'object') return r; const { url: _url, ...rest } = r; return rest; };

/**
 * Handle one phone message if it is ours. Returns true when handled. `send` writes to that one
 * socket. Every reply carries the request's reqId so a screen can match it.
 */
export function handleTodayMessage(msg, send) {
  const type = msg?.type;
  if (!['todayRead', 'inboxRead', 'todaySnooze', 'todayUnsnooze', 'inboxAct', 'settingsRead', 'settingsWrite'].includes(type)) return false;
  const reqId = reqIdOf(msg);
  const fail = (extra) => send({ type: type === 'settingsWrite' ? 'settingsResult' : type.endsWith('Read') ? type.replace('Read', '') : 'todayResult', reqId, ok: false, ...extra });
  if (!bridge) { fail({ error: 'unavailable' }); return true; }
  const run = async () => {
    switch (type) {
      case 'todayRead': {
        const data = await bridge.readToday();
        return send({ type: 'today', reqId, ok: true, data: withoutUrl(data) });
      }
      case 'inboxRead': {
        const data = await bridge.readInbox();
        return send({ type: 'inbox', reqId, ok: true, data: withoutUrl(data) });
      }
      case 'todaySnooze': {
        if (!idOk(msg.id) || (msg.choice !== 'tomorrow' && msg.choice !== 'week') || typeof msg.print !== 'string') return fail({ op: 'snooze', id: msg.id, error: 'bad-request' });
        const r = bridge.snooze(msg.id, msg.choice, msg.print);
        return send({ type: 'todayResult', reqId, op: 'snooze', id: msg.id, ok: !!r?.ok, changed: !!r?.changed });
      }
      case 'todayUnsnooze': {
        if (!idOk(msg.id)) return fail({ op: 'unsnooze', id: msg.id, error: 'bad-request' });
        if (typeof msg.print !== 'string') return fail({ op: 'unsnooze', id: msg.id, error: 'bad-request' });
        const r = bridge.unsnooze(msg.id, msg.print);
        return send({ type: 'todayResult', reqId, op: 'unsnooze', id: msg.id, ok: !!r?.ok });
      }
      case 'inboxAct': {
        // 'complete' closes an Asana task in Asana; the phone asks before it sends one, like the Mac.
        if (!['done', 'complete', 'undo'].includes(msg.kind) || !idOk(msg.id)) return fail({ op: msg.kind, id: msg.id, error: 'bad-request' });
        if (typeof msg.rev !== 'number' && typeof msg.rev !== 'string') return fail({ op: msg.kind, id: msg.id, error: 'bad-request' });
        // Done and Close carry the print of the card as shown: an edit that kept its rev still counts.
        if (msg.kind !== 'undo' && typeof msg.print !== 'string') return fail({ op: msg.kind, id: msg.id, error: 'bad-request' });
        const r = await bridge.act({ kind: msg.kind, id: msg.id, rev: msg.rev, print: msg.kind === 'undo' ? undefined : msg.print });
        // Only the fixed messages the desktop shows, never whatever came back from the board.
        return send({ type: 'todayResult', reqId, op: msg.kind, id: msg.id, ok: !!r?.ok, changed: r?.reason === 'changed', reason: typeof r?.reason === 'string' ? r.reason.slice(0, 40) : undefined });
      }
      case 'settingsRead':
        return send({ type: 'settings', reqId, ok: true, data: await bridge.readSettings() });
      case 'settingsWrite': {
        const r = await bridge.writeSetting(msg.key, msg.value);
        return send({ type: 'settingsResult', reqId, key: typeof msg.key === 'string' ? msg.key.slice(0, 40) : null, ok: !!r?.ok, error: r?.ok ? undefined : (r?.error || 'failed') });
      }
      default:
        return undefined;
    }
  };
  // A failure says only that it failed: an error message could carry card text.
  run().catch(() => fail({ error: 'failed' }));
  return true;
}
