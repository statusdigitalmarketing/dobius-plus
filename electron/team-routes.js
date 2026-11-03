/**
 * /team/* on the phone server (docs/team-communicator.md, "Transport does not need to be trusted"). Mounted BEFORE
 * the server's JSON parser and its CORS middleware, so:
 *   - admission runs before any body is read: per source IP at most 2 in flight and 30 a minute, at most 8 in flight
 *     overall, and the whole body within 5 s or the socket is destroyed;
 *   - only the full MagicDNS host (strict), never a request with an Origin header, never CORS headers;
 *   - POST bodies only as application/octet-stream, at most 48 KB, verified over the raw bytes by the service.
 */
import express from 'express';
import { MAX_BODY } from './team-protocol.js';

export const PER_IP_IN_FLIGHT = 2;
export const TOTAL_IN_FLIGHT = 8;
export const PER_IP_PER_MIN = 30;
export const BODY_DEADLINE_MS = 5000;

/** Admission state and middleware, separate so it is unit tested without a server. */
export function createAdmission({ now = () => Date.now() } = {}) {
  const inFlight = new Map(); // ip -> n
  const recent = new Map();   // ip -> number[] (last minute)
  let total = 0;
  return function admit(req, res, next) {
    const ip = req.socket?.remoteAddress || 'unknown';
    const t = now();
    const times = (recent.get(ip) || []).filter((x) => t - x < 60_000);
    if (total >= TOTAL_IN_FLIGHT || (inFlight.get(ip) || 0) >= PER_IP_IN_FLIGHT || times.length >= PER_IP_PER_MIN) {
      recent.set(ip, times);
      res.set('Connection', 'close');
      return res.status(429).end();
    }
    times.push(t);
    recent.set(ip, times);
    if (recent.size > 4096) for (const [k, v] of recent) if (!v.some((x) => t - x < 60_000)) recent.delete(k);
    total += 1;
    inFlight.set(ip, (inFlight.get(ip) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(deadline);
      total -= 1;
      const n = (inFlight.get(ip) || 1) - 1;
      if (n > 0) inFlight.set(ip, n); else inFlight.delete(ip);
    };
    // A slow sender cannot hold a slot: the body arrives in full within the deadline or the socket goes.
    const deadline = setTimeout(() => { if (!req.complete) req.socket?.destroy(); }, BODY_DEADLINE_MS);
    deadline.unref?.();
    res.on('finish', release);
    res.on('close', release);
    return next();
  };
}

/**
 * @param {import('express').Express} expApp
 * @param {{ hostOk: (host: string, strict: boolean) => boolean, service: () => object | null }} opts
 *   service() is the team service, or null while the feature is unavailable (no secure storage): every route 404s.
 */
export function mountTeamRoutes(expApp, { hostOk, service }) {
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use((req, res, next) => {
    if (!hostOk(req.headers.host, true)) return res.status(421).end();
    if (req.headers.origin !== undefined) return res.status(403).end();
    if (!service()) return res.status(404).end();
    return next();
  });
  router.use(createAdmission());
  const raw = express.raw({ type: 'application/octet-stream', limit: `${Math.floor(MAX_BODY / 1024)}kb` });
  const octetOnly = (req, res, next) => (req.is('application/octet-stream') ? next() : res.status(415).end());
  const sig = (req) => (typeof req.headers['x-dobius-team-sig'] === 'string' ? req.headers['x-dobius-team-sig'] : '');
  const reply = (res, r) => res.status(r.status).json(r.json);
  const guard = (fn) => (req, res) => {
    try { reply(res, fn(req)); } catch (err) {
      console.error('[team] route failed:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ ok: false });
    }
  };

  router.get('/hello', guard((req) => service().hello(typeof req.query.nonce === 'string' ? req.query.nonce : '')));
  router.post('/link', octetOnly, raw, guard((req) => service().link(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), sig(req))));
  router.post('/message', octetOnly, raw, guard((req) => service().receive(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), sig(req))));
  // Anything else under /team, and a parser error (413 too large, 400 bad length), ends here without detail.
  router.use((req, res) => res.status(404).end());
  router.use((err, req, res, _next) => res.status(err?.status && err.status < 500 ? err.status : 400).end());
  expApp.use('/team', router);
}
