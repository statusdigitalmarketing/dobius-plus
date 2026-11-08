// Native push for the App Store app (APNs). Docs: docs/native-push.md.
//
// The Capacitor iOS app runs in a WKWebView, which has no PushManager, so Web Push (push.js) never reaches it. This
// sends Apple Push Notification service requests over HTTP/2 with token-based auth: an ES256 JWT signed by the .p8 key
// Sam creates in the Apple developer portal.
//
// The key lives in <userData>/apns/ as Apple's own download, AuthKey_<KEYID>.p8 (the file name gives the Key ID), with
// an optional apns.json { keyId, teamId, bundleId }. No key: status() says so and every send does nothing.
// The key and the JWT are never logged and never put into an error: every failure here is a fixed reason code.
//
// Pure apart from what comes in (connect, now, the folder), so it is tested against a local http2 stand-in
// (electron/__tests__/apns.test.mjs). The real hosts are constants: nothing at runtime can point it anywhere else.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import tls from 'node:tls';

export const APNS_ORIGINS = Object.freeze({
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
});
export const DEFAULT_TEAM_ID = 'Z349CC556Z';
export const DEFAULT_BUNDLE_ID = 'com.statusdigital.dobiusplus';
const KEY_FILE_RE = /^AuthKey_([A-Z0-9]{10})\.p8$/;
const ID10_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const DEVICE_TOKEN_RE = /^[0-9a-f]{64,200}$/;
const MAX_KEY_BYTES = 8192;
const MAX_CONFIG_BYTES = 4096;
const JWT_MAX_AGE_S = 40 * 60; // Apple accepts up to 60 minutes and asks for no more than one new token per 20
const KEY_RECHECK_MS = 30_000;

export const isDeviceToken = (t) => typeof t === 'string' && DEVICE_TOKEN_RE.test(t);

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

// Read one small file that must be a regular file owned by us, never through a symlink. Tightened to 0600 when looser.
function readOwnFile(file, maxBytes, uid) {
  let fd;
  try {
    // O_NONBLOCK: a FIFO named like a key must not hang the main process waiting for a writer (fstat refuses it next).
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (err) {
    return { error: err?.code === 'ENOENT' ? 'missing' : 'unsafe-file' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes || (uid != null && st.uid !== uid)) return { error: 'unsafe-file' };
    if ((st.mode & 0o077) !== 0) { try { fs.fchmodSync(fd, 0o600); } catch { return { error: 'unsafe-file' }; } }
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return { text: buf.subarray(0, n).toString('utf8'), mtimeMs: st.mtimeMs };
  } catch {
    return { error: 'unsafe-file' };
  } finally {
    try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * The key and its ids from `dir`, or { ok:false, reason } with a fixed reason:
 * no-key, several-keys, unsafe-file, bad-key, bad-config.
 */
export function readApnsKey(dir, { uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return { ok: false, reason: 'no-key' }; }
  if (!st.isDirectory() || st.isSymbolicLink() || (uid != null && st.uid !== uid)) return { ok: false, reason: 'unsafe-file' };
  if ((st.mode & 0o077) !== 0) { try { fs.chmodSync(dir, 0o700); } catch { return { ok: false, reason: 'unsafe-file' }; } }
  let names;
  try { names = fs.readdirSync(dir); } catch { return { ok: false, reason: 'unsafe-file' }; }
  const keys = names.filter((n) => KEY_FILE_RE.test(n));
  if (keys.length === 0) return { ok: false, reason: 'no-key' };
  if (keys.length > 1) return { ok: false, reason: 'several-keys' };
  const fileKeyId = KEY_FILE_RE.exec(keys[0])[1];
  const keyFile = readOwnFile(path.join(dir, keys[0]), MAX_KEY_BYTES, uid);
  if (keyFile.error) return { ok: false, reason: keyFile.error === 'missing' ? 'no-key' : keyFile.error };
  let cfg = {};
  let cfgMtime = 0;
  if (names.includes('apns.json')) {
    const c = readOwnFile(path.join(dir, 'apns.json'), MAX_CONFIG_BYTES, uid);
    if (c.error) return { ok: false, reason: c.error === 'missing' ? 'bad-config' : c.error };
    try { cfg = JSON.parse(c.text); } catch { return { ok: false, reason: 'bad-config' }; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, reason: 'bad-config' };
    cfgMtime = c.mtimeMs;
  }
  const keyId = cfg.keyId === undefined ? fileKeyId : cfg.keyId;
  const teamId = cfg.teamId === undefined ? DEFAULT_TEAM_ID : cfg.teamId;
  const bundleId = cfg.bundleId === undefined ? DEFAULT_BUNDLE_ID : cfg.bundleId;
  if (!ID10_RE.test(String(keyId)) || keyId !== fileKeyId || !ID10_RE.test(String(teamId)) || typeof bundleId !== 'string' || bundleId.length > 155 || !BUNDLE_RE.test(bundleId)) {
    return { ok: false, reason: 'bad-config' };
  }
  let key;
  try {
    key = crypto.createPrivateKey({ key: keyFile.text, format: 'pem' });
  } catch { return { ok: false, reason: 'bad-key' }; }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return { ok: false, reason: 'bad-key' };
  return { ok: true, keyId, teamId, bundleId, key, stamp: `${keys[0]}|${keyFile.mtimeMs}|${cfgMtime}` };
}

/** An ES256 provider token: header { alg, kid }, claims { iss: team id, iat }. */
export function makeJwt({ keyId, teamId, key }, iatSeconds) {
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: iatSeconds }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${b64url(sig)}`;
}

const clean = (s, max) => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim().slice(0, max);

/**
 * The JSON body Apple delivers. Only what the notifier hands in, and the notifier hands in a label and a fixed phrase:
 * title, body, kind (thread), mac (the phone's own id for this Mac) and ref (an opaque handle a tap resolves on the Mac).
 */
export function apnsPayload({ title, body, kind, mac, ref }) {
  const out = { aps: { alert: { title: clean(title || 'Dobius+', 120), body: clean(body, 200) }, sound: 'default' } };
  if (typeof kind === 'string' && /^[a-z]{1,20}$/.test(kind)) out.aps['thread-id'] = kind;
  if (typeof mac === 'string' && mac.length <= 64 && /^[\w.:-]+$/.test(mac)) out.mac = mac;
  if (typeof ref === 'string' && /^[0-9a-f]{32}$/.test(ref)) out.ref = ref;
  if (kind === 'today') out.view = 'tasks'; // a Today nudge opens Today
  return out;
}

/** The HTTP/2 request for one device: headers and body. */
export function buildRequest({ token, bundleId, jwt, payload, tag, nowSeconds }) {
  const headers = {
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    authorization: `bearer ${jwt}`,
    'apns-topic': bundleId,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(nowSeconds + 600),
    'content-type': 'application/json',
  };
  // A later notification with the same id replaces the earlier one on the phone. Apple caps it at 64 bytes.
  if (typeof tag === 'string' && tag) {
    let id = tag.replace(/[^\w:.-]/g, '');
    while (Buffer.byteLength(id) > 64) id = id.slice(0, -1);
    if (id) headers['apns-collapse-id'] = id;
  }
  return { headers, body: JSON.stringify(payload) };
}

/**
 * What Apple's answer means for this device token.
 *   sent: delivered to Apple. drop: the token is dead (410, Unregistered, BadDeviceToken).
 *   retry-auth: the provider token was refused; make a new one once. other-host: BadDeviceToken while the host was not
 *   known yet (a development build's token is only valid on the sandbox host). failed: anything else, token kept.
 */
export function outcomeFor(status, reason, { envKnown }) {
  if (status === 200) return 'sent';
  if (status === 410 || reason === 'Unregistered') return 'drop';
  if (status === 403 && (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')) return 'retry-auth';
  if (status === 400 && reason === 'BadDeviceToken') return envKnown ? 'drop' : 'other-host';
  return 'failed';
}

/**
 * deps: dir (the apns folder), connect(origin) -> ClientHttp2Session (tests point it at a stand-in), now() ms,
 * readKey (default readApnsKey), idleMs, timeoutMs.
 */
// The real connection, keeping hold of its own TLS socket: session.socket is a proxy that refuses destroy() and throws
// once the session is torn down, so a stalled socket could never be closed through it (Codex round 3).
function connectApple(origin) {
  let raw = null;
  const session = http2.connect(origin, {
    createConnection: (url) => {
      raw = tls.connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, ALPNProtocols: ['h2'] });
      return raw;
    },
  });
  session.rawSocket = () => raw;
  return session;
}

export function createApnsSender({ dir, connect = connectApple, now = () => Date.now(), readKey = readApnsKey, idleMs = 60_000, timeoutMs = 10_000 } = {}) {
  let cached = null; // { at, result }
  let jwt = null; // { value, iat, stamp }
  const sessions = new Map(); // origin -> { session, timer }
  // The constant hosts, looked up by name only.
  const APNS_ORIGIN_FOR = (env) => APNS_ORIGINS[env];

  function key() {
    const t = now();
    if (!cached || t - cached.at > KEY_RECHECK_MS) {
      let result;
      try { result = dir ? readKey(dir) : { ok: false, reason: 'no-key' }; } catch { result = { ok: false, reason: 'unsafe-file' }; }
      if (cached?.result?.stamp !== result.stamp) jwt = null; // a new key never signs with the old token
      cached = { at: t, result };
    }
    return cached.result;
  }

  function token(k, fresh = false) {
    const nowS = Math.floor(now() / 1000);
    if (fresh || !jwt || jwt.stamp !== k.stamp || nowS - jwt.iat >= JWT_MAX_AGE_S) jwt = { value: makeJwt(k, nowS), iat: nowS, stamp: k.stamp };
    return jwt.value;
  }

  function sessionFor(origin) {
    let s = sessions.get(origin);
    if (s && !s.session.closed && !s.session.destroyed) {
      clearTimeout(s.timer);
    } else {
      const session = connect(origin);
      s = { session, timer: null };
      const forget = () => { if (sessions.get(origin) === s) { clearTimeout(s.timer); sessions.delete(origin); } };
      // Errors are swallowed to a reason code: an http2 error can name the host but never carries the key.
      session.on('error', forget);
      session.on('close', forget);
      session.on('goaway', forget);
      sessions.set(origin, s);
    }
    s.timer = setTimeout(() => { if (sessions.get(origin) === s) sessions.delete(origin); retire(s.session); }, idleMs);
    s.timer.unref?.();
    return s.session;
  }

  // Close gracefully, and destroy if it is still open shortly after (a stream that never got its connection, a TLS
  // handshake that never finished, would otherwise hold the session forever).
  // The raw TLS socket (connectApple) is held separately: Node can mark a closing session destroyed while that socket
  // is still open, and the session's own socket proxy cannot destroy it.
  function retire(session, graceMs = 5000) {
    let socket = null;
    try { socket = typeof session.rawSocket === 'function' ? session.rawSocket() : null; } catch { socket = null; }
    try { session.close(); } catch { /* closed */ }
    const t = setTimeout(() => {
      try { if (!session.destroyed) session.destroy(); } catch { /* gone */ }
      try { if (socket && !socket.destroyed) socket.destroy(); } catch { /* gone */ }
    }, graceMs);
    t.unref?.();
  }

  function post(origin, headers, body) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      let req;
      let session;
      try {
        session = sessionFor(origin);
        req = session.request(headers);
      } catch { finish({ status: 0, reason: 'connect' }); return; }
      let status = 0;
      let text = '';
      req.setTimeout(timeoutMs, () => {
        try { req.close(http2.constants.NGHTTP2_CANCEL); } catch { /* closed */ }
        // A request that timed out says the connection is not healthy: the next send starts a fresh one. The old one is
        // retired, not destroyed, so other requests already on it keep their own full timeout.
        const s = sessions.get(origin);
        if (s?.session === session) { clearTimeout(s.timer); sessions.delete(origin); retire(session, timeoutMs); }
        finish({ status: 0, reason: 'timeout' });
      });
      req.on('response', (h) => { status = Number(h[':status']) || 0; });
      req.setEncoding('utf8');
      req.on('data', (c) => { if (text.length < 1024) text += c; });
      req.on('end', () => {
        let reason = '';
        try { const j = JSON.parse(text || '{}'); reason = typeof j.reason === 'string' ? j.reason.slice(0, 60) : ''; } catch { /* no body */ }
        finish({ status, reason });
      });
      req.on('error', () => finish({ status: 0, reason: 'network' }));
      req.end(body);
    });
  }

  async function sendOne(k, device, notif, stillValid) {
    const payload = apnsPayload({ ...notif, mac: device.pairingId });
    // One phone paired with two Macs gets both Macs' notifications on one token: the collapse id names the pairing too,
    // so Mac A's "Today" never replaces Mac B's.
    const tag = notif.tag && device.pairingId ? `${notif.tag}.${device.pairingId}` : notif.tag;
    const order = device.env === 'sandbox' ? ['sandbox'] : device.env === 'production' ? ['production'] : ['production', 'sandbox'];
    for (const env of order) {
      let retried = false;
      for (;;) {
        // Checked before every request: a phone unpaired while an earlier request waited gets nothing more.
        if (!stillValid(device)) return { token: device.token, outcome: 'skipped' };
        const req = buildRequest({ token: device.token, bundleId: k.bundleId, jwt: token(k, retried), payload, tag, nowSeconds: Math.floor(now() / 1000) });
        const r = await post(APNS_ORIGIN_FOR(env), req.headers, req.body);
        const outcome = outcomeFor(r.status, r.reason, { envKnown: device.env === env || env === 'sandbox' });
        if (outcome === 'retry-auth' && !retried) { retried = true; continue; }
        if (outcome === 'other-host') break; // try the next host
        if (outcome === 'retry-auth') return { token: device.token, outcome: 'failed', reason: r.reason };
        return { token: device.token, outcome, env, status: r.status, reason: r.reason };
      }
    }
    return { token: device.token, outcome: 'drop', reason: 'BadDeviceToken' };
  }

  return {
    /** { ready, reason }: reason is one of the fixed codes when not ready. */
    status() {
      const k = key();
      return k.ok ? { ready: true } : { ready: false, reason: k.reason };
    },
    /**
     * Send one notification to each device ({ token, env, pairingId }). Never throws. Results say what to do with each
     * token: outcome sent (env is the host that took it), drop, failed, or skipped (stillValid said no).
     * stillValid(device): asked right before each request.
     */
    async send(devices, notif, stillValid = () => true) {
      const k = key();
      if (!k.ok) return [];
      const list = (Array.isArray(devices) ? devices : []).filter((d) => d && isDeviceToken(d.token));
      const out = [];
      for (const d of list) {
        // The key as it is now, for each device: one replaced while earlier requests waited signs the rest (Codex round 3).
        const kNow = key();
        if (!kNow.ok) { out.push({ token: d.token, outcome: 'failed', reason: kNow.reason }); continue; }
        try { out.push(await sendOne(kNow, d, notif, stillValid)); } catch { out.push({ token: d.token, outcome: 'failed', reason: 'error' }); }
      }
      return out;
    },
    close() {
      for (const [origin, s] of sessions) { clearTimeout(s.timer); sessions.delete(origin); try { s.session.close(); } catch { /* closed */ } }
    },
  };
}
