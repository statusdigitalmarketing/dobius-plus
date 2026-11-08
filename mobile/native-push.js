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
// iOS gives the same token to every call while the app is installed; one registration is shared by every Mac.
function deviceToken() {
  if (tokenPromise) return tokenPromise;
  tokenPromise = new Promise((resolve) => {
    const handles = [];
    const finish = (v) => { clearTimeout(timer); for (const h of handles) h.then((x) => x.remove()).catch(() => {}); resolve(v); };
    const timer = setTimeout(() => finish(null), 15000);
    handles.push(PushNotifications.addListener('registration', (t) => finish(typeof t?.value === 'string' ? t.value.toLowerCase() : null)));
    handles.push(PushNotifications.addListener('registrationError', () => finish(null)));
    PushNotifications.register().catch(() => finish(null));
  }).then((v) => { if (!v) tokenPromise = null; return v; }); // a failed attempt may be retried
  return tokenPromise;
}

let seq = 0;
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
      resolve(m.ok ? { ok: true } : { ok: false, error: 'Your Mac would not take this phone for notifications.' });
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
  return sendRegister(connection, token);
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
