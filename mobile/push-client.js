// VAPID keys belong to Macs. Separate worker scopes let one PWA retain a
// subscription for each Mac without replacing another Mac's subscription.
function urlB64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window && window.isSecureContext;
}

export function pushGranted() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

function workerUrls(connection) {
  const base = new URL('./', window.location.href);
  return { script: new URL('sw.js', base).href, scope: new URL(`__dobius_push__/${encodeURIComponent(connection.pairing.id)}/`, base).href, base: base.href };
}

async function existingRegistration(connection) {
  const { scope, base } = workerUrls(connection);
  const scoped = await navigator.serviceWorker.getRegistration(scope);
  if (scoped?.scope === scope) return scoped;
  // The pre-switcher root subscription belongs to the single Mac that was
  // migrated (pairing 'legacy'), whichever Mac serves this page (Codex).
  if (connection.pairing.id === 'legacy') {
    const legacy = await navigator.serviceWorker.getRegistration(base);
    if (legacy?.scope === base && await legacy.pushManager.getSubscription()) return legacy;
  }
  return null;
}

/**
 * Stop a removed Mac's notifications on this device: its own worker scope is
 * unregistered; the migrated Mac ('legacy') lives on the root worker, which
 * also serves the app shell, so only its subscription is dropped.
 */
export async function forgetPush(pairingId) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  const base = new URL('./', window.location.href);
  if (pairingId === 'legacy') {
    // Its subscription may be the pre-upgrade root one OR, when alerts were
    // first enabled after the upgrade, a scoped one: drop both (Codex).
    const root = await navigator.serviceWorker.getRegistration(base.href);
    if (root?.scope === base.href) await (await root.pushManager.getSubscription())?.unsubscribe();
  }
  const scope = new URL(`__dobius_push__/${encodeURIComponent(pairingId)}/`, base).href;
  const reg = await navigator.serviceWorker.getRegistration(scope);
  if (reg?.scope === scope) await reg.unregister();
}

export async function pushActive(connection) {
  if (!pushSupported() || !pushGranted() || connection.closed) return false;
  try {
    const reg = await existingRegistration(connection);
    return !!(reg && await reg.pushManager.getSubscription());
  } catch { return false; }
}

async function activated(reg) {
  if (reg.active) return;
  const worker = reg.installing || reg.waiting;
  if (!worker) throw new Error('Notification worker is unavailable');
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('Notification worker could not start'));
    };
    const timer = setTimeout(() => finish(new Error('Notification worker timed out')), 10000);
    worker.addEventListener('statechange', check);
    check();
  });
}

export async function enablePush(connection) {
  if (!pushSupported()) return { ok: false, error: 'Notifications need HTTPS (enable it in Dobius Settings) and an installed app.' };
  let perm = Notification.permission;
  if (perm !== 'granted') perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, error: 'Notification permission denied' };
  try {
    const vres = await connection.request('/push/vapid', { cache: 'no-store' });
    const vj = await vres.json();
    if (!vres.ok || !vj.ok || !vj.publicKey) return { ok: false, error: 'This Mac has no push key. Pair it again if access was revoked.' };
    const key = urlB64ToUint8Array(vj.publicKey);
    let reg = await existingRegistration(connection);
    const { script, scope } = workerUrls(connection);
    if (!reg) reg = await navigator.serviceWorker.register(script, { scope });
    await activated(reg);
    if (connection.closed) return { ok: false, error: 'Mac switched' };
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const existingKey = new Uint8Array(sub.options.applicationServerKey || []);
      if (existingKey.length !== key.length || existingKey.some((b, i) => b !== key[i])) {
        return { ok: false, error: 'This Mac changed its notification key. Its existing subscription has been kept. Reset notification permissions for this app to enable it again.' };
      }
    } else {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    const sres = await connection.request('/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    const sj = await sres.json();
    return sres.ok && sj.ok ? { ok: true } : { ok: false, error: sj.error || 'Could not register for notifications' };
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not enable notifications' };
  }
}
