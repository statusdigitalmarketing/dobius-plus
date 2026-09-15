// Who a Codex account actually is (v1.0.72), for the Accounts panel.
//
// Same idea as account-identity.js for Claude: read-only, never the secret.
// A Codex login's email + plan live in the id_token JWT inside
// <codexHome>/auth.json (auth.json.tokens.id_token, payload field `email`;
// plan under the "https://api.openai.com/auth" claim). The JWT is decoded, NOT
// verified: this is a display hint, not an auth decision. loginState is just
// whether an auth.json with a usable token exists.

import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_AUTH_JSON = 5 * 1024 * 1024;

function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); }
  catch { return null; }
}

/**
 * { email, plan, login } for a Codex home. login is 'in' when auth.json holds a
 * token, 'out' when the file is absent/empty, 'unknown' when it exists but
 * cannot be read/parsed (never say "logged out" on a read error).
 */
export async function codexIdentityFor(codexHome) {
  if (typeof codexHome !== 'string' || !codexHome) return { email: null, plan: null, login: 'out' };
  const p = path.join(codexHome, 'auth.json');
  let raw;
  try {
    const st = await fs.stat(p);
    if (!st.isFile() || st.size === 0) return { email: null, plan: null, login: 'out' };
    if (st.size > MAX_AUTH_JSON) return { email: null, plan: null, login: 'unknown' };
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    return { email: null, plan: null, login: err && err.code === 'ENOENT' ? 'out' : 'unknown' };
  }
  let data;
  try { data = JSON.parse(raw); } catch { return { email: null, plan: null, login: 'unknown' }; }
  const tokens = data && typeof data === 'object' ? data.tokens : null;
  // Guard data itself: a literal `null` in auth.json parses to null, so
  // data.OPENAI_API_KEY would throw and crash every Codex identity row
  // (reviewer P3).
  const hasToken = !!(tokens && (tokens.id_token || tokens.access_token))
    || !!(data && typeof data === 'object' && data.OPENAI_API_KEY);
  const payload = tokens ? decodeJwtPayload(tokens.id_token) : null;
  const email = payload && typeof payload.email === 'string' ? payload.email : null;
  const authClaim = payload && payload['https://api.openai.com/auth'];
  const plan = authClaim && typeof authClaim.chatgpt_plan_type === 'string' ? authClaim.chatgpt_plan_type : null;
  return { email, plan, login: hasToken ? 'in' : 'out' };
}
