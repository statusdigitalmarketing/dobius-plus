// The stored "Mac host" is the authority (bundled Capacitor PWA has no
// server to be relative to; location.host is capacitor://localhost). Every
// REST fetch and the WebSocket URL build off the host read from storage.
//
// We store the full ORIGIN including scheme (http:// or https://) so a Mac
// with HTTPS enabled (Settings, Mobile Access, "Enable HTTPS") pairs with
// its TLS listener rather than silently falling back to plaintext. Accepted
// user input: `host`, `host:port`, `http(s)://host[:port][/path?query]`.
// Everything normalises to a scheme-prefixed origin like
// `http://100.89.143.67:8420` or `https://my-mac.ts.net:8420`.

import { get, set, remove } from './storage';

export const HOST_KEY = 'dobius-mobile-host';
export const TOKEN_KEY = 'dobius-mobile-token';
const DEFAULT_PORT = '8420';

let cachedHost = '';
export function syncHost() { return cachedHost; }
export async function initHost() {
  const h = await getHost();
  cachedHost = h || '';
  return cachedHost;
}

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
  if (!u.hostname) return '';
  let host = u.host.toLowerCase();
  // URL() may have stripped a scheme-default port the user asked for
  // (`my-mac:80`, `my-mac.ts.net:443`). Put it back verbatim.
  if (!u.port && explicitPort) host = `${host}:${explicitPort}`;
  // Default to the Dobius+ server port only when the user did NOT include
  // a scheme AND did NOT include an explicit port. An explicit scheme is
  // trusted verbatim (default 443/80 implied by the scheme); Settings QR
  // encodes an explicit port when the Mac is listening on 8420.
  if (!hadScheme && !explicitPort && !u.port) host += `:${DEFAULT_PORT}`;
  return `${scheme}://${host}`;
}

export async function getHost() {
  const v = await get(HOST_KEY);
  return v ? v.trim() : '';
}

export async function setHost(raw) {
  const h = normaliseHost(raw);
  if (!h) return '';
  await set(HOST_KEY, h);
  cachedHost = h;
  return h;
}

export async function clearHost() { cachedHost = ''; await remove(HOST_KEY); }

// Build an absolute URL for `path` using the given origin, or (one-arg form)
// the cached stored origin from syncHost(). `path` can be `./pair`, `/pair`,
// `pair`, or already absolute (returned unchanged). If no origin is set
// (browser dev), returns the relative path so Vite's proxy still works.
export function absUrl(hostOrPath, maybePath) {
  const origin = maybePath === undefined ? cachedHost : (hostOrPath || cachedHost);
  const path = maybePath === undefined ? hostOrPath : maybePath;
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  if (!origin) return path;
  const base = origin.replace(/\/+$/, '');
  const clean = String(path).replace(/^\.\//, '').replace(/^\//, '');
  return `${base}/${clean}`;
}

// WebSocket URL for the stored origin. ws: pairs with http:, wss: with https:.
export function wsUrl(origin) {
  if (!origin) return '';
  return origin.replace(/^http(s?):\/\//i, (_m, s) => `ws${s}://`).replace(/\/+$/, '') + '/ws';
}
