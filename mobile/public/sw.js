// Dobius+ Mobile service worker (v1.0.43 Phase 4). Makes the PWA installable
// and openable offline (last-known app shell), and is the registration Web
// Push will attach to in Phase 5. Network-first with a cache fallback: a remote
// control should show fresh content when online, and the cached shell when the
// link is down. Never touches cross-origin requests or the WebSocket.
const CACHE = 'dobius-mobile-v1';
const APP_BASE = new URL('./', self.location.href);
const scopeMatch = new URL(self.registration.scope).pathname.match(/\/__dobius_push__\/([^/]+)\/$/);
const PAIRING_ID = scopeMatch ? decodeURIComponent(scopeMatch[1]) : null;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Web Push (Phase 5b): show the notification the Mac sent, and focus/open the
// app when it's tapped.
self.addEventListener('push', (e) => {
  let data;
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Dobius+';
  const url = new URL('./', APP_BASE);
  try {
    const id = new URL(data.url || './', APP_BASE).searchParams.get('open');
    if (id) url.searchParams.set('open', id);
  } catch { /* malformed notification URL */ }
  if (PAIRING_ID) url.searchParams.set('mac', PAIRING_ID);
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag ? `${PAIRING_ID || APP_BASE.origin}:${data.tag}` : undefined,
    data: { url: url.href, pairingId: PAIRING_ID, origin: APP_BASE.origin },
    icon: './icon.png',
    badge: './icon.png',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || './';
  // The session to jump to is encoded in the url as ?open=<id>. Extract it so a
  // warm client can be told to switch to it (focus() alone just brings the app
  // forward on whatever screen it last showed). Audit MED-12.
  let openId = null;
  try { openId = new URL(url, self.location.origin).searchParams.get('open'); } catch { openId = null; }
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (!c.url.startsWith(APP_BASE.href)) continue;
      if ('focus' in c) {
        if (openId) { try { c.postMessage({ type: 'open-session', id: openId, pairingId: e.notification.data?.pairingId, origin: e.notification.data?.origin || APP_BASE.origin }); } catch { /* noop */ } }
        return c.focus();
      }
    }
    // Cold start: open the url (carries ?open=<id> so App.jsx routes to it).
    if (self.clients.openWindow) return self.clients.openWindow(url);
    return undefined;
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('Authorization')) return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return; // leave cross-origin alone
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit
        || (req.mode === 'navigate' ? caches.match('./') : undefined))),
  );
});
