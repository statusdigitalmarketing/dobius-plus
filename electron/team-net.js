/**
 * Team communicator HTTP client (docs/team-communicator.md). Every payload is sealed and signed end to end, so the
 * transport only has to carry bytes: HTTPS when the peer's phone server has a certificate, plain HTTP otherwise.
 *
 * - Own agents, no keep-alive, no proxy, a hard deadline per request, responses capped at 64 KB.
 * - Requests name the peer's full MagicDNS host (its /team routes require it) and never carry an Origin.
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

function once(scheme, { host, port, method, path, body, headers, timeoutMs }) {
  return new Promise((resolve) => {
    let reached = false;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...r, reached }); } };
    const lib = scheme === 'https' ? https : http;
    const req = lib.request({
      host, port, method, path, agent: agents[scheme], servername: scheme === 'https' ? host : undefined,
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
