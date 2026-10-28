// Explicit HTTP(S) origins shared by pairing, REST and WebSocket clients.
export const HOST_KEY = 'dobius-mobile-host';
export const TOKEN_KEY = 'dobius-mobile-token';
const DEFAULT_PORT = '8420';

// Extract an EXPLICITLY supplied port from the raw input, independent of
// what URL() does with scheme-default ports. URL() strips `:80` from HTTP
// and `:443` from HTTPS, which otherwise makes `my-mac:80` indistinguishable
// from `my-mac`. Returns the numeric port string or null.
function extractExplicitPort(raw) {
  const noScheme = raw.replace(/^https?:\/\//i, '');
  const hostOnly = noScheme.split('/')[0].split('?')[0].split('#')[0];
  if (hostOnly.startsWith('[')) {
    const m = hostOnly.match(/\]:(\d+)$/);
    return m ? m[1] : null;
  }
  const m = hostOnly.match(/:(\d+)$/);
  return m ? m[1] : null;
}

export function normaliseHost(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return '';
  const explicitPort = extractExplicitPort(s);
  // A trailing bare colon ("my-mac:" or "[::1]:") means the user did not
  // specify a port; trim it so URL() does not reject the input.
  s = s.replace(/:$/, '');
  const hadScheme = /^https?:\/\//i.test(s);
  const toParse = hadScheme ? s : `http://${s}`;
  let u;
  try { u = new URL(toParse); } catch { return ''; }
  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return '';
  if (!u.hostname || u.username || u.password) return '';
  let host = u.host.toLowerCase();
  // URL() may have stripped a scheme-default port the user asked for
  // (`my-mac:80`, `my-mac.ts.net:443`). Preserve its meaning before
  // producing the canonical origin below, which omits default ports.
  if (!u.port && explicitPort) host = `${host}:${explicitPort}`;
  // Default to the Dobius+ server port only when the user did NOT include
  // a scheme AND did NOT include an explicit port. An explicit scheme is
  // trusted verbatim (default 443/80 implied by the scheme); Settings QR
  // encodes an explicit port when the Mac is listening on 8420.
  if (!hadScheme && !explicitPort && !u.port) host += `:${DEFAULT_PORT}`;
  return new URL(`${scheme}://${host}`).origin;
}

// Callers must supply an origin. Never fall back to a mutable active host.
export function absUrl(origin, path) {
  return new URL(path, `${origin}/`).href;
}

export function wsUrl(origin) {
  return origin.replace(/^http/, 'ws') + '/ws';
}

export function mixedContent(origin, pageOrigin) {
  return pageOrigin.startsWith('https:') && origin.startsWith('http:');
}

export function reachabilityMessage(origin, pageOrigin) {
  if (mixedContent(origin, pageOrigin)) {
    return 'This app uses HTTPS and cannot connect to an HTTP Mac. Enable HTTPS in Dobius+ on that Mac, or open it directly.';
  }
  const crossOrigin = new URL(origin).origin !== pageOrigin && /^https?:/.test(pageOrigin);
  return crossOrigin
    ? 'Could not reach this Mac. Check Tailscale and that the Mac is awake. If it is reachable directly, update Dobius+ on that Mac to allow connections from this app.'
    : 'Could not reach this Mac. Check Tailscale is on, the Mac is awake, and Dobius+ is running.';
}
