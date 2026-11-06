// Web Push for the mobile remote control (v1.0.43 Phase 5b). Notifies the phone
// when a session needs input or a session failed, even when the PWA is closed,
// so Sam can pocket the phone and get pulled back for the moments that matter.
//
// Push requires a browser-trusted secure context (the Phase 4 Tailscale HTTPS)
// to subscribe; the Mac then sends to the browser push service over the
// internet using VAPID. Keys live in config (generated once); subscriptions are
// per device, pruned when the push service reports them gone (404/410).

import webpush from 'web-push';
import {
  getPushVapid, setPushVapid, getPushSubscriptions, addPushSubscription, removePushSubscription,
} from './config-manager.js';

const VAPID_SUBJECT = 'mailto:sam@statusdigitalmarketing.com';

function ensureVapid() {
  let v = getPushVapid();
  if (!v) {
    v = webpush.generateVAPIDKeys();
    setPushVapid(v);
  }
  return v;
}

/** The public VAPID key the phone needs to subscribe. */
export function getVapidPublicKey() {
  return ensureVapid().publicKey;
}

/** Store a phone's PushSubscription, bound to its paired device token. */
export function subscribePush(sub, token) {
  return addPushSubscription(sub, token);
}

/**
 * Send a notification to every subscribed device. Prunes subscriptions the push
 * service reports as gone. Never throws. No-op if nothing is subscribed.
 * payload: { title, body, tag?, url? }
 */
export async function sendPush(payload) {
  const subs = getPushSubscriptions();
  if (subs.length === 0) return;
  const vapid = ensureVapid();
  // A timeout so one push service that never answers cannot hold every send open.
  const opts = { vapidDetails: { subject: VAPID_SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 600, timeout: 15000 };
  const body = JSON.stringify({
    title: String(payload?.title || 'Dobius+').slice(0, 120),
    body: String(payload?.body || '').slice(0, 300),
    tag: payload?.tag ? String(payload.tag).slice(0, 80) : undefined,
    url: typeof payload?.url === 'string' ? payload.url : undefined,
  });
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, opts);
    } catch (err) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) removePushSubscription(s.endpoint); // gone
      else console.warn('[push] send failed:', code || err?.message || 'unknown');
    }
  }));
}

export function hasPushSubscribers() {
  return getPushSubscriptions().length > 0;
}
