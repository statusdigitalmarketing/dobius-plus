// App Store Connect API client for the iOS release script (scripts/ios-release.mjs).
//
// Token auth with the team API key (.p8): an ES256 JWT, 20 minutes at most, audience appstoreconnect-v1. The key and
// the token are never printed or put into an error message. Requests go only to api.appstoreconnect.apple.com.
// Docs: docs/ios-release.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ASC_ORIGIN = 'https://api.appstoreconnect.apple.com';
const REQUEST_TIMEOUT_MS = 60_000;

// Where the key and its ids come from. Env wins so CI or another Mac can point elsewhere; the defaults are this team's
// "Dobius iOS upload" key (App Manager), whose .p8 lives where Apple's tools look for it.
export function ascConfig(env = process.env) {
  const keyId = env.ASC_KEY_ID || 'RVU59FRA7H';
  const issuerId = env.ASC_ISSUER_ID || 'c7167f5f-1a8d-4d63-8af9-1f032a24e66c';
  // Absolute, so it still names the same file from the build's own checkout (Xcode runs there).
  const keyPath = path.resolve(env.ASC_KEY_PATH || path.join(os.homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${keyId}.p8`));
  return { keyId, issuerId, keyPath };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A signed ASC token. `nowSeconds` is injectable for tests. */
export function ascJwt({ keyId, issuerId, key }, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  // Apple refuses a token that lives over 20 minutes; 15 leaves room for clock drift.
  const payload = b64url(JSON.stringify({ iss: issuerId, iat: nowSeconds, exp: nowSeconds + 15 * 60, aud: 'appstoreconnect-v1' }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(sig)}`;
}

export class AscError extends Error {
  constructor(status, method, route, detail) {
    super(`App Store Connect ${method} ${route} answered ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
  }
}

/**
 * A small client: get/post/patch/del on paths under /v1 (or a full next-page link from Apple), JSON in and out.
 * Each call mints a fresh token when the cached one is over 10 minutes old. `fetchImpl` is injectable for tests.
 */
export function createAscClient({ keyId, issuerId, keyPath, key: keyIn, fetchImpl = fetch, now = () => Date.now() } = ascConfig()) {
  let key = keyIn;
  if (!key) {
    // Neither the path nor the reader's message is passed on: a key's contents put in ASC_KEY_PATH by mistake would be
    // in both (Codex round 9).
    try { key = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8')); } catch (err) { throw new Error(`could not read the App Store Connect key named by ASC_KEY_PATH (${err?.code || 'not a valid key'})`); }
  }
  let token = null;
  let madeAt = 0;
  const auth = () => {
    if (!token || now() - madeAt > 10 * 60_000) { madeAt = now(); token = ascJwt({ keyId, issuerId, key }, Math.floor(madeAt / 1000)); }
    return token;
  };
  const url = (route) => {
    const u = route.startsWith('https://') ? new URL(route) : new URL(route, ASC_ORIGIN);
    if (u.origin !== ASC_ORIGIN) throw new Error('refusing a request outside App Store Connect');
    return u;
  };
  async function call(method, route, body) {
    const u = url(route);
    const res = await fetchImpl(u, {
      method,
      headers: { Authorization: `Bearer ${auth()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      // A redirect could carry the token to another host; a hung socket would hold the release lock forever.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let json = null;
    let parsed = true;
    try { json = text ? JSON.parse(text) : null; } catch { parsed = false; }
    if (!res.ok) {
      // Apple's own error titles and details only: they never carry the token.
      const detail = (json?.errors || []).map((e) => [e.title, e.detail].filter(Boolean).join(': ')).join(' | ').slice(0, 600);
      throw new AscError(res.status, method, u.pathname, detail);
    }
    // A 2xx that is not JSON (a proxy page, a cut-off body) must not read as "nothing there".
    if (!parsed) throw new AscError(res.status, method, u.pathname, 'the answer was not JSON');
    if (method === 'GET' && (!json || !('data' in json))) throw new AscError(res.status, method, u.pathname, 'the answer had no data');
    return json;
  }
  return {
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body),
    patch: (route, body) => call('PATCH', route, body),
    del: (route, body) => call('DELETE', route, body),
    /**
     * Every item across pages (Apple's links.next), with every page's `included` objects. A list longer than maxPages
     * throws: a partial list is not "all".
     */
    async pages(route, maxPages = 20) {
      const data = [];
      const included = [];
      let next = route;
      for (let i = 0; next; i += 1) {
        if (i >= maxPages) throw new AscError(200, 'GET', url(route).pathname, `more than ${maxPages} pages`);
        const page = await call('GET', next);
        if (!Array.isArray(page.data)) throw new AscError(200, 'GET', url(next).pathname, 'the answer was not a list');
        data.push(...page.data);
        if (Array.isArray(page.included)) included.push(...page.included);
        next = page.links?.next || null;
      }
      return { data, included };
    },
    async all(route, maxPages = 20) { return (await this.pages(route, maxPages)).data; },
  };
}
