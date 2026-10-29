// CORS grants browser access, never authentication. Protected routes still
// require the device's explicit bearer token; no ambient credentials are used.
//
// Beyond the native app and localhost, an origin is allowed only when its
// host is one of THIS tailnet's own machines (`hosts`, from tailscale.js
// tailnetHostsFrom): a PWA served by another of the user's Macs. Neither a
// name suffix nor the 100.64.0.0/10 range is enough: Tailscale Funnel serves
// PUBLIC sites on *.ts.net, and a machine shared INTO the tailnet by someone
// else gets a 100.x address too. POST /pair answers with a full-control
// token, so either would let an attacker's page read one once the user typed
// a pairing code into it (Codex High, two rounds).
// A tailnet machine also runs other servers (a project preview on :8443):
// only its Dobius+ phone server is an approved app origin, so the port must
// be the Dobius+ mobile port too (this server's own, or the 8420 default),
// not any port on an approved host (Codex High).
export function isAllowedMobileOrigin(origin, { hosts = null, ports = null } = {}) {
  if (typeof origin !== 'string' || !origin) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.username || u.password || u.search || u.hash) return false;
  if (!/^[a-z]+:\/\/[^/?#\\\s]+$/i.test(origin)) return false;
  if (u.protocol === 'capacitor:' || u.protocol === 'ionic:') return u.hostname === 'localhost';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname === 'localhost') return true;
  if (!hosts || !hosts.has(u.hostname.toLowerCase())) return false;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return !ports || ports.includes(port);
}

/**
 * Whether a request's Host header names THIS Mac's phone server: its tailnet
 * IP or its MagicDNS name, at its port. Anything else is refused before any
 * route runs. Without it, a page at http://evil.example:8420 could rebind
 * that name to this Mac's tailnet IP and call /pair from its own origin, where
 * CORS never applies (DNS rebinding: Codex P1). Accepted names: the tailnet
 * IP (or any tailnet IP literal), the full MagicDNS name and its short
 * machine name (Tailscale resolves both), each at the port; on port 80 or 443 also without it, since browsers
 * drop a default port from Host. `name` may be null while the MagicDNS lookup
 * is unknown; the IP still works.
 */
export function isOwnHost(host, { ip, name = null, port, strict = false }) {
  if (typeof host !== 'string' || !host) return false;
  const h = host.trim().toLowerCase().replace(/\.(:\d+)?$/, '$1'); // a trailing-dot FQDN is the same name
  const full = name ? String(name).toLowerCase().replace(/\.$/, '') : '';
  // strict (for /pair, the one route that MINTS a token): no short name. A
  // short name resolves through the phone's search domain, which an attacker
  // can control (or a switch of tailnets can repoint), so a rebinding page at
  // http://my-mac:8420 could pair (Codex P1, two lenses). Every other route
  // needs a bearer token such a page never has.
  const names = [ip && String(ip).toLowerCase(), full, !strict && full.split('.')[0]].filter(Boolean);
  const own = names.map((x) => `${x}:${port}`);
  if (port === 80 || port === 443) own.push(...names);
  if (own.includes(h)) return true;
  // Any tailnet IP literal at the port: a machine shared to another tailnet is
  // reached there at a translated 100.x address (Codex P1). An IP has no DNS
  // to rebind, so it carries no more risk than this Mac's own IP.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d+))?$/);
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255)) return false;
  const inTailnet = Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
  const atPort = m[5] ? Number(m[5]) === port : port === 80 || port === 443;
  return inTailnet && atPort;
}
