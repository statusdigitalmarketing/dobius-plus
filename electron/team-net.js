/**
 * Team communicator HTTP client (docs/team-communicator.md). Every payload is sealed and signed end to end, so the
 * transport only has to carry bytes: HTTPS when the peer's phone server has a certificate, plain HTTP otherwise.
 *
 * - Own agents, no keep-alive, no proxy, a hard deadline per request, responses capped at 64 KB.
 * - Requests name the peer's full MagicDNS host (its /team routes require it) and never carry an Origin.
 * - `address` (optional): the peer's Tailscale IP to connect to; Host and TLS still use `host`.
 * - `reached`: the request body was fully handed to the socket. The outbox uses it to tell "may have arrived"
 *   (unconfirmed) from "never left" (not delivered).
 */
import http from 'node:http';
import https from 'node:https';

const MAX_RESPONSE = 64 * 1024;
const TIMEOUT_MS = 10_000;
const agents = { http: new http.Agent({ keepAlive: false }), https: new https.Agent({ keepAlive: false }) };
// host:port -> 'http' once HTTPS failed before sending anything there (it has no certificate). Re-tried after an hour.
const plainOnly = new Map();
const PLAIN_TTL_MS = 60 * 60 * 1000;

function once(scheme, { host, address, port, method, path, body, headers, timeoutMs }) {
  return new Promise((resolve) => {
    let reached = false;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...r, reached }); } };
    const lib = scheme === 'https' ? https : http;
    // `address`: connect to this Tailscale IP instead of resolving `host` (a shared-in machine whose name this
    // computer's resolver does not know). The Host header and the TLS name stay the MagicDNS name either way.
    const req = lib.request({
      host: address || host, port, method, path, agent: agents[scheme], servername: scheme === 'https' ? host : undefined,
      headers: { Host: `${host}:${port}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) { req.destroy(); done({ error: 'response too large' }); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; } // not JSON: status only
        done({ status: res.statusCode, json });
      });
      res.on('error', (err) => done({ error: err.code || err.message }));
    });
    const timer = setTimeout(() => { req.destroy(); done({ error: 'timeout' }); }, timeoutMs || TIMEOUT_MS);
    req.on('error', (err) => done({ error: err.code || err.message, tls: /TLS|SSL|CERT|EPROTO|self.signed|ERR_SSL/i.test(`${err.code} ${err.message}`) }));
    // Reached = the connection was really up (TLS handshake done for HTTPS) AND the body was flushed. A body queued
    // on a socket that never connected, or a TLS socket that failed its handshake, did not reach anyone.
    let connected = false;
    let finished = false;
    req.on('socket', (s) => {
      const up = () => { connected = true; if (finished) reached = true; };
      if (scheme === 'https') s.once('secureConnect', up); else if (s.connecting) s.once('connect', up); else up();
    });
    req.on('finish', () => { finished = true; if (connected) reached = true; });
    req.end(body || undefined);
  });
}

/**
 * One request to a peer. Resolves { status, json, reached, scheme } or { error, reached }.
 * HTTPS first; plain HTTP only when HTTPS failed before anything was sent (no certificate there, or a TLS error).
 */
export async function teamRequest(opts, now = Date.now()) {
  const key = `${opts.host}:${opts.port}`;
  const plainSince = plainOnly.get(key);
  if (!plainSince || now - plainSince > PLAIN_TTL_MS) {
    const r = await once('https', opts);
    if (r.status || r.reached || !r.tls) return { ...r, scheme: 'https' };
    plainOnly.set(key, now);
  }
  const r = await once('http', opts);
  return { ...r, scheme: 'http' };
}

export const _plainOnly = plainOnly;

/**
 * Wraps a team request for teammates on other Tailscale networks (docs/team-communicator.md, "Teammates on another
 * Tailscale network"). When the peer's MagicDNS name does not resolve, this computer's own `tailscale status` says
 * whether that machine is in its netmap at all:
 *   - listed (it was shared with us, or it is ours): try once more at its Tailscale IP, same Host and TLS name. That
 *     covers a recipient whose resolver does not know shared-in names (MagicDNS off on their tailnet).
 *   - not listed: `reach: 'not-shared'` (another tailnet's machine nobody shared with us), or 'not-in-tailnet' for a
 *     name on our own tailnet (renamed or removed).
 * Offline machines are marked `reach: 'offline'` when the IP try also fails. The transport is still untrusted:
 * everything on it is sealed and signed, and an IP taken from our own netmap for that exact name changes nothing.
 * statusFn() -> parsed `tailscale status --json` or null (unknown: the original error is returned as is).
 */
export function withTailnetFallback(request, statusFn, { tailnetOf, peerInStatus, isNameError }) {
  return async function teamRequestVia(opts) {
    const r = await request(opts);
    if (opts.address || !isNameError(r.error) || !tailnetOf(opts.host)) return r;
    let status = null;
    try { status = await statusFn(); } catch (err) { console.warn('[team] tailscale status failed:', err?.message || err); }
    if (!status) return r;
    // This computer's own Tailscale is logged out or stopped: that is the problem, not their sharing (Codex r2).
    if (status.BackendState && status.BackendState !== 'Running') return { ...r, reach: 'tailscale-off' };
    const p = peerInStatus(status, opts.host);
    // Missing from our netmap: another tailnet's machine nobody shared with us, or one of OUR tailnet's machines that
    // was renamed or removed (Codex r1: that is not a sharing problem).
    const own = String(status.MagicDNSSuffix || status.CurrentTailnet?.MagicDNSSuffix || '').toLowerCase().replace(/\.$/, '');
    if (!p.found) return { ...r, reach: own && tailnetOf(opts.host) === own ? 'not-in-tailnet' : 'not-shared' };
    if (!p.ip) return { ...r, reach: p.online ? undefined : 'offline' };
    const r2 = await request({ ...opts, address: p.ip });
    // A connection that got as far as sending is not "offline", whatever the (up to 15 s old) netmap said (Codex r5).
    return { ...r2, viaIp: true, ...(r2.error && !r2.reached ? { reach: p.online ? 'unreachable' : 'offline' } : {}) };
  };
}
