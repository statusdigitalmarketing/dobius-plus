// One notification out to every phone paired with this Mac: Web Push subscribers (the PWA added to the Home Screen,
// push.js) and APNs device tokens (the App Store app, apns.js). Both lists are bound to a pairing token and removed when
// that phone is unpaired (mobile-server removeMobileDevice).
//
// APNs payloads pass through Apple, so they never carry the tab id (it names the project folder): a tap carries an
// opaque ref instead, which the phone resolves over its authed WebSocket (notifyResolve). Web Push payloads are
// end-to-end encrypted to the phone, so they keep the ?open=<id> link they always had.

import crypto from 'node:crypto';

export const REF_CAP = 500;
export const REF_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * deps:
 *   webPush(payload) -> Promise, hasWebPush() -> boolean            (push.js sendPush / hasPushSubscribers)
 *   apns: { status(), send(devices, notif) -> Promise<results> }     (apns.js createApnsSender)
 *   tokens: { list() -> [{ token, env, pairingId }], drop(token), setEnv(token, env) }
 *   now(), log(code)  log gets a fixed code, never a token or a payload
 */
export function createPhonePush({ webPush, hasWebPush, apns, tokens, now = () => Date.now(), log = () => {} }) {
  const refs = new Map(); // ref -> { tabId, at }

  function refFor(tabId) {
    const t = now();
    for (const [r, v] of refs) { if (t - v.at > REF_TTL_MS) refs.delete(r); else break; }
    while (refs.size >= REF_CAP) refs.delete(refs.keys().next().value);
    const ref = crypto.randomBytes(16).toString('hex');
    refs.set(ref, { tabId, at: t });
    return ref;
  }

  return {
    /** The tab a notification's ref points at, or null (unknown or expired). */
    resolve(ref) {
      if (typeof ref !== 'string' || !/^[0-9a-f]{32}$/.test(ref)) return null;
      const v = refs.get(ref);
      if (!v || now() - v.at > REF_TTL_MS) return null;
      return v.tabId;
    },
    /** Whether any phone could get a notification right now, and through which channel. */
    channels() {
      let st;
      try { st = apns.status(); } catch { st = { ready: false, reason: 'error' }; }
      const devices = (() => { try { return tokens.list().length; } catch { return 0; } })();
      return { webPush: !!hasWebPush(), apnsReady: !!st.ready, apnsReason: st.ready ? null : (st.reason || 'no-key'), apnsDevices: devices };
    },
    /** n: { kind, title, body, tag, tabId|null, url? } built by the notifier (label and fixed phrase only). Never throws. */
    async send(n) {
      const jobs = [];
      if (hasWebPush()) {
        const url = n.url || (n.tabId ? `./?open=${encodeURIComponent(n.tabId)}` : undefined);
        jobs.push(Promise.resolve(webPush({ title: n.title, body: n.body, tag: n.tag, url })).catch(() => log('webpush-failed')));
      }
      let devices = [];
      try { devices = tokens.list(); } catch { devices = []; }
      if (devices.length) {
        const ref = n.tabId ? refFor(n.tabId) : undefined;
        jobs.push((async () => {
          let results = [];
          // Each device is checked again right before its request: still listed (so still paired), same registration.
          // And the news itself must still be true (n.current, from the notifier): a prompt answered while an earlier
          // phone's request waited is not sent to the next phone.
          const stillValid = (dev) => {
            try {
              if (typeof n.current === 'function' && !n.current()) return false;
              return tokens.list().some((x) => x.token === dev.token && x.addedAt === dev.addedAt);
            } catch { return false; }
          };
          try { results = await apns.send(devices, { title: n.title, body: n.body, tag: n.tag, kind: n.kind, ref }, stillValid); } catch { log('apns-failed'); return; }
          for (const r of results) {
            // Only the registration this send used: the phone may have registered again while it was in flight.
            const dev = devices.find((x) => x.token === r.token);
            if (r.outcome === 'drop') { try { tokens.drop(r.token, dev?.addedAt, dev?.regAt); } catch { /* config write failed */ } log('apns-token-dropped'); }
            else if (r.outcome === 'sent') { if (dev && dev.env !== r.env) { try { tokens.setEnv(r.token, r.env, dev.addedAt); } catch { /* best effort */ } } }
            else if (r.outcome !== 'skipped') log(`apns-${String(r.reason || 'failed').replace(/[^\w-]/g, '').slice(0, 40)}`);
          }
        })());
      }
      await Promise.all(jobs);
    },
  };
}
