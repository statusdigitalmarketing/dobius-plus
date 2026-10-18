// Web Push subscription flow for the mobile app (v1.0.43 Phase 5b). Needs a
// secure context (Phase 4 HTTPS) + an installed PWA on iOS. Fetches the VAPID
// public key, subscribes, and registers the subscription with the Mac.
import { absUrl, TOKEN_KEY } from './host';
import { get as storageGet } from './storage';

function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported() {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window
    && window.isSecureContext;
}

export function pushGranted() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

// True only if there is an ACTUAL active push subscription (permission alone is
// not enough: it may have been cleared/pruned). Async. Codex Phase 5b P2.
export async function pushActive() {
  if (!pushSupported() || !pushGranted()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    return !!(await reg.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/** Request permission (user gesture), subscribe, and register with the Mac. */
export async function enablePush() {
  if (!pushSupported()) return { ok: false, error: 'Notifications need HTTPS (enable it in Dobius Settings) and an installed app.' };
  let perm = Notification.permission;
  if (perm !== 'granted') perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, error: 'Notification permission denied' };

  const token = (await storageGet(TOKEN_KEY)) || '';
  try {
    const reg = await navigator.serviceWorker.ready;
    const vres = await fetch(absUrl('/push/vapid'), { headers: { Authorization: `Bearer ${token}` } });
    const vj = await vres.json();
    if (!vj.ok || !vj.publicKey) return { ok: false, error: 'Server has no push key' };

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(vj.publicKey),
      });
    }
    const sres = await fetch(absUrl('/push/subscribe'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    const sj = await sres.json();
    return sj.ok ? { ok: true } : { ok: false, error: sj.error || 'Could not register for notifications' };
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not enable notifications' };
  }
}
