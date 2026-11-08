// Notifications for the App Store app (Capacitor iOS). Its WKWebView has no PushManager, so Web Push (push-client.js)
// cannot reach it: the app asks iOS for an APNs device token and hands it to each paired Mac over that Mac's authed
// WebSocket (apnsRegister). The Mac sends through Apple with its own key (electron/apns.js, docs/native-push.md).
//
// A tap carries the Mac's id for this pairing (`mac`) and an opaque `ref` the Mac resolves to the tab; never the tab
// id itself, which names the project folder and would travel through Apple.

import { PushNotifications } from '@capacitor/push-notifications';

export const isNativeApp = () => {
  try { return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true; } catch { return false; }
};

/** 'granted' | 'denied' | 'prompt' | 'unsupported' */
export async function nativePushPermission() {
  if (!isNativeApp()) return 'unsupported';
  try {
    const p = await PushNotifications.checkPermissions();
    return p.receive === 'granted' ? 'granted' : p.receive === 'denied' ? 'denied' : 'prompt';
  } catch { return 'unsupported'; }
}

let tokenPromise = null;
// Asked of iOS afresh each time (it answers with its CURRENT token, which it may rotate): only a request still in flight
// is shared, never a token from an earlier one.
function deviceToken() {
  if (tokenPromise) return tokenPromise;
  tokenPromise = new Promise((resolve) => {
    const handles = [];
    const finish = (v) => { clearTimeout(timer); for (const h of handles) h.then((x) => x.remove()).catch(() => {}); resolve(v); };
    const timer = setTimeout(() => finish(null), 15000);
    handles.push(PushNotifications.addListener('registration', (t) => finish(typeof t?.value === 'string' ? t.value.toLowerCase() : null)));
    handles.push(PushNotifications.addListener('registrationError', () => finish(null)));
    // Register only once both listeners are attached, so the answer cannot arrive before anyone hears it.
    Promise.all(handles).then(() => PushNotifications.register()).catch(() => finish(null));
  }).then((v) => { tokenPromise = null; return v; });
  return tokenPromise;
}

let seq = 0;
// The token each connection last gave its Mac.
const sentTokens = new WeakMap();

/**
 * iOS may hand the app a new token while it stays open: pass it to this Mac. Only a token different from the one this
 * connection last sent goes out, so the registration answer to our own register() call never loops (Codex round 13).
 */
export function forwardTokenChanges(connection) {
  if (!isNativeApp()) return () => {};
  const h = PushNotifications.addListener('registration', (t) => {
    const token = typeof t?.value === 'string' ? t.value.toLowerCase() : null;
    if (!token || connection.closed || sentTokens.get(connection) === token || connection.status !== 'authed') return;
    sendRegister(connection, token).then((r) => { if (r.ok) sentTokens.set(connection, token); }).catch(() => {});
  });
  return () => { h.then((x) => x.remove()).catch(() => {}); };
}

function sendRegister(connection, token) {
  if (connection.status !== 'authed') return Promise.resolve({ ok: false, error: 'Not connected to your Mac.' });
  // A Mac from before native push does not know the message: do not send it at all.
  if (!(Array.isArray(connection.features) && connection.features.includes('apns'))) return Promise.resolve({ ok: false, error: 'This Mac needs a newer Dobius+ for notifications in this app.' });
  const reqId = `apns-${Date.now().toString(36)}-${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve({ ok: false, error: 'No answer from your Mac.' }); }, 15000);
    const off = connection.onMessage((m) => {
      if (m.type !== 'apnsResult' || m.reqId !== reqId) return;
      clearTimeout(timer);
      off();
      resolve(m.ok ? { ok: true } : { ok: false, code: typeof m.error === 'string' ? m.error : 'failed', error: 'Your Mac would not take this phone for notifications.' });
    });
    connection.send({ type: 'apnsRegister', token, pairingId: connection.pairing?.id || null, reqId });
  });
}

/**
 * Ask iOS (prompting only when `prompt` is true), get the device token and give it to this Mac.
 * Returns { ok, error }. Never prompts on its own: a background refresh passes prompt false.
 */
export async function enableNativePush(connection, { prompt = true } = {}) {
  if (!isNativeApp()) return { ok: false, error: 'Only in the App Store app.' };
  let perm = await nativePushPermission();
  if (perm === 'prompt' && prompt) {
    try { perm = (await PushNotifications.requestPermissions()).receive === 'granted' ? 'granted' : 'denied'; } catch { perm = 'denied'; }
  }
  if (perm !== 'granted') return { ok: false, error: perm === 'denied' ? 'Notifications are off for Dobius+ in iPhone Settings.' : 'Notifications are not on yet.' };
  const token = await deviceToken();
  if (!token) return { ok: false, error: 'iPhone did not give this app a notification token. Try again in a moment.' };
  if (connection.closed) return { ok: false, error: 'Mac switched' };
  const r = await sendRegister(connection, token);
  if (r.ok) sentTokens.set(connection, token);
  // Still held by this phone's previous pairing with the same Mac (re-paired at a new address): that pairing is being
  // unregistered as this runs, so ask once more shortly.
  if (!r.ok && r.code === 'token-in-use') {
    await new Promise((res) => setTimeout(res, 8000));
    if (connection.closed) return r;
    return sendRegister(connection, token);
  }
  return r;
}

/**
 * A Mac removed from this app must stop sending to it: tell it so over a short-lived connection with the pairing's own
 * token (the Mac also drops it when the phone is unpaired on the Mac). Best effort: a Mac that cannot be reached keeps
 * the token until it is unpaired there, and a tap then says the Mac is no longer paired.
 */
export function unregisterNativePush(pairing, ConnectionClass) {
  if (!isNativeApp() || !pairing?.origin || !pairing?.token) return Promise.resolve(false);
  return new Promise((resolve) => {
    let c;
    try { c = new ConnectionClass({ id: pairing.id, origin: pairing.origin, token: pairing.token }); } catch { resolve(false); return; }
    const done = (v) => { clearTimeout(timer); off(); try { c.close(); } catch { /* closed */ } resolve(v); };
    const timer = setTimeout(() => done(false), 8000);
    const off = c.onMessage((m) => {
      if (m.type === 'authed') {
        if (Array.isArray(m.features) && m.features.includes('apns')) c.send({ type: 'apnsUnregister', reqId: `unreg-${Date.now().toString(36)}` });
        else done(false);
      }
      if (m.type === 'apnsResult') done(!!m.ok);
    });
    try { c.connect(); } catch { done(false); }
  });
}

/** A notification tapped: { pairingId, ref, view } for App.jsx's openSession. */
export function onNativeTap(handler) {
  if (!isNativeApp()) return () => {};
  const h = PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
    const d = a?.notification?.data || {};
    handler({
      pairingId: typeof d.mac === 'string' && d.mac.length <= 64 ? d.mac : undefined,
      ref: typeof d.ref === 'string' && /^[0-9a-f]{32}$/.test(d.ref) ? d.ref : undefined,
      view: d.view === 'tasks' ? 'tasks' : undefined,
    });
  });
  return () => { h.then((x) => x.remove()).catch(() => {}); };
}
