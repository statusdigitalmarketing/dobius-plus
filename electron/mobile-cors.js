// CORS grants browser access, never authentication. Protected routes still
// require the device's explicit bearer token; no ambient credentials are used.
export function isAllowedMobileOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.username || u.password || u.search || u.hash) return false;
  if (!/^[a-z]+:\/\/[^/?#\\\s]+$/i.test(origin)) return false;
  if (u.protocol === 'capacitor:' || u.protocol === 'ionic:') return u.hostname === 'localhost';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.hostname === 'localhost') return true;
  if (/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+ts\.net$/.test(u.hostname)) return true;
  if (u.hostname.startsWith('[fd7a:115c:a1e0:')) return true;
  const parts = u.hostname.split('.');
  return parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255)
    && Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}
