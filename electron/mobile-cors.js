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
export function isAllowedMobileOrigin(origin, { hosts = null } = {}) {
  if (typeof origin !== 'string' || !origin) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.username || u.password || u.search || u.hash) return false;
  if (!/^[a-z]+:\/\/[^/?#\\\s]+$/i.test(origin)) return false;
  if (u.protocol === 'capacitor:' || u.protocol === 'ionic:') return u.hostname === 'localhost';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname === 'localhost') return true;
  return !!hosts && hosts.has(u.hostname.toLowerCase());
}
