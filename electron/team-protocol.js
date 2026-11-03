/**
 * Team communicator protocol (docs/team-communicator.md). Pure: identity, peers, accepted-message records and the
 * clock are passed in, so every rule here is unit-tested. Network, storage, UI and delivery live elsewhere.
 */
import crypto from 'node:crypto';
import { b64u, fingerprint, sign, verify, seal, open, sha256hex, sameSecret } from './team-crypto.js';

export const V = 1;
export const MAX_BODY = 48 * 1024;
export const MAX_TEXT = 8000;
export const SKEW_MS = 5 * 60 * 1000;
export const CUTOFF_MS = 6 * 24 * 3600 * 1000;      // a message's firstSentAt may be at most this old
export const RETAIN_MS = 7 * 24 * 3600 * 1000;      // accepted records kept this long from first acceptance
export const INVITE_MS = 15 * 60 * 1000;
export const KINDS = new Set(['ask', 'reply', 'note']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FP = /^[A-Za-z0-9_-]{43}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const NONCE = /^[0-9a-f]{32}$/;
const isPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
const shortText = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;

function parseJson(bytes, max) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > max) return null;
  try {
    const v = JSON.parse(bytes.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null; // not JSON
  }
}

export const newNonce = () => crypto.randomBytes(16).toString('hex');

// ---------- hello: prove which keys answer at an address ----------

const helloBytes = (nonce, h) => `dobius-team-hello|${nonce}|${h.ed}|${h.x}|${h.name}|${h.host}|${h.port}`;

export function makeHello(identity, me, nonce) {
  const h = { v: V, name: me.name, host: me.host, port: me.port, ed: identity.ed, x: identity.x };
  return { ...h, sig: sign(identity, helloBytes(nonce, h)) };
}

/** The keys behind a hello, only if they hash to `expectedFp` and signed our nonce. */
export function checkHello(h, nonce, expectedFp) {
  if (!h || h.v !== V || typeof h.ed !== 'string' || typeof h.x !== 'string') return null;
  if (!shortText(h.name, 80) || !HOST.test(h.host || '') || !isPort(h.port)) return null;
  let fp;
  try { fp = fingerprint(h.ed, h.x); } catch { return null; } // malformed keys
  if (fp !== expectedFp || !verify(h.ed, helloBytes(nonce, h), h.sig)) return null;
  return { id: fp, name: h.name, host: h.host, port: h.port, ed: h.ed, x: h.x };
}

// ---------- invite ----------

export function makeInvite(me, fp, now) {
  const secret = b64u(crypto.randomBytes(16));
  return { secret, expiresAt: now + INVITE_MS, text: `dobius-team:${V}:${me.host}:${me.port}:${fp}:${secret}` };
}

export function parseInvite(text) {
  const m = /^dobius-team:1:([A-Za-z0-9.-]{1,253}):(\d{1,5}):([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{22})$/.exec(String(text || '').trim());
  if (!m || !isPort(Number(m[2]))) return null;
  return { host: m[1], port: Number(m[2]), fp: m[3], secret: m[4] };
}

// ---------- link request (B -> A), sealed to A, signed by B ----------

const linkAad = (toFp, eph, nonce) => `dobius-team-link|${V}|${toFp}|${eph}|${nonce}`;

export function buildLinkRequest(identity, me, to, secret, reqNonce) {
  const inner = { secret, name: me.name, host: me.host, port: me.port, ed: identity.ed, x: identity.x, reqNonce };
  const sealed = seal(to.x, JSON.stringify(inner), 'link', (eph, nonce) => linkAad(to.id, eph, nonce));
  const body = Buffer.from(JSON.stringify({ v: V, ...sealed }));
  return { body, sig: sign(identity, body) };
}

/**
 * Bootstrap order (design r2 #8): size, open with our key (AEAD), parse a bounded inner object, verify the
 * signature over the raw body with the key found inside. The secret is checked by the caller.
 */
export function openLinkRequest(identity, myFp, body, sig) {
  const outer = parseJson(body, MAX_BODY);
  if (!outer || outer.v !== V) return null;
  const plain = open(identity, outer, 'link', linkAad(myFp, outer.eph, outer.nonce));
  const inner = parseJson(plain, 8 * 1024);
  if (!inner) return null;
  const { secret, name, host, port, ed, x, reqNonce } = inner;
  if (typeof secret !== 'string' || !shortText(name, 80) || !HOST.test(host || '') || !isPort(port)) return null;
  if (typeof ed !== 'string' || typeof x !== 'string' || !NONCE.test(reqNonce || '')) return null;
  let fp;
  try { fp = fingerprint(ed, x); } catch { return null; } // malformed keys
  if (!verify(ed, body, sig)) return null;
  return { id: fp, name, host, port, ed, x, secret, reqNonce };
}

// Binds the attempt AND every field B will store about A (name, endpoint), so nothing in the confirmation can be
// changed on the way.
const linkOkBytes = (secret, bFp, reqNonce, c) =>
  `dobius-team-link-ok|${sha256hex(secret)}|${bFp}|${reqNonce}|${c.name}|${c.host}|${c.port}`;

export function linkConfirmation(identity, me, secret, bFp, reqNonce) {
  const c = { v: V, name: me.name, host: me.host, port: me.port, ed: identity.ed, x: identity.x };
  return { ...c, sig: sign(identity, linkOkBytes(secret, bFp, reqNonce, c)) };
}

/** A as a peer, only if the confirmation comes from the invite's fingerprint and binds THIS attempt (r3 #6). */
export function checkLinkConfirmation(conf, invite, myFp, reqNonce) {
  if (!conf || conf.v !== V || typeof conf.ed !== 'string' || typeof conf.x !== 'string') return null;
  if (!shortText(conf.name, 80) || !HOST.test(conf.host || '') || !isPort(conf.port)) return null;
  let fp;
  try { fp = fingerprint(conf.ed, conf.x); } catch { return null; } // malformed keys
  if (fp !== invite.fp || !verify(conf.ed, linkOkBytes(invite.secret, myFp, reqNonce, conf), conf.sig)) return null;
  return { id: fp, name: conf.name, host: conf.host, port: conf.port, ed: conf.ed, x: conf.x };
}

export const secretMatches = (a, b) => typeof a === 'string' && typeof b === 'string' && sameSecret(a, b);

// ---------- messages ----------

const msgAad = (from, to, eph, nonce) => `dobius-team-msg|${V}|${from}|${to}|${eph}|${nonce}`;
export const contentHash = (env) => sha256hex(`${env.kind}|${env.replyTo || ''}|${env.text}`);
const ackBytes = (from, id, hash) => `dobius-team-ack|${from}|${id}|${hash}`;

/** Seal and sign one attempt of `env` ({ id, kind, replyTo, text, firstSentAt, deadline }) with a fresh ts. */
export function buildMessage(identity, myFp, peer, env, now) {
  const inner = { v: V, id: env.id, from: myFp, to: peer.id, kind: env.kind, replyTo: env.replyTo || null,
    text: env.text, ts: now, firstSentAt: env.firstSentAt, deadline: env.deadline };
  const sealed = seal(peer.x, JSON.stringify(inner), 'msg', (eph, nonce) => msgAad(myFp, peer.id, eph, nonce));
  const body = Buffer.from(JSON.stringify({ v: V, from: myFp, to: peer.id, ...sealed }));
  return { body, sig: sign(identity, body) };
}

/**
 * The receiver's whole check, in the design's order. `peers` maps fingerprint -> peer; `records` is the
 * accepted-message store ({ get(key), set(key, rec) }). Returns
 *   { status: 'new', env, receipt, from }        store + route it
 *   { status: 'duplicate', receipt }             already accepted with the same content: same receipt, no routing
 *   { status: 'conflict' }                        same (sender, id), different content: 409
 *   { status: 'refused', reason }                 4xx, logged, no detail to the caller
 */
export function receiveMessage({ identity, myFp, peers, records, body, sig, now }) {
  const refuse = (reason) => ({ status: 'refused', reason });
  const outer = parseJson(body, MAX_BODY);
  if (!outer || outer.v !== V || !FP.test(outer.from || '') || !FP.test(outer.to || '')) return refuse('shape');
  const peer = peers[outer.from];
  if (!peer || !peer.enabled) return refuse('unknown sender');
  if (!verify(peer.ed, body, sig)) return refuse('signature');
  if (outer.to !== myFp) return refuse('not for us');
  const plain = open(identity, outer, 'msg', msgAad(outer.from, outer.to, outer.eph, outer.nonce));
  const env = parseJson(plain, MAX_BODY);
  if (!env || env.v !== V) return refuse('sealed body');
  if (env.from !== outer.from || env.to !== outer.to) return refuse('identity mismatch');
  if (!UUID.test(env.id || '') || !KINDS.has(env.kind)) return refuse('fields');
  if (env.replyTo != null && !UUID.test(env.replyTo)) return refuse('fields');
  if (!shortText(env.text, MAX_TEXT)) return refuse('text');
  const { ts, firstSentAt } = env;
  if (!Number.isFinite(ts) || Math.abs(ts - now) > SKEW_MS) return refuse('stale');
  if (!Number.isFinite(firstSentAt) || firstSentAt < now - CUTOFF_MS || firstSentAt > now + SKEW_MS
      || firstSentAt > ts + SKEW_MS) return refuse('cutoff');
  const hash = contentHash(env);
  const key = `${outer.from}|${env.id}`;
  const receipt = sign(identity, ackBytes(outer.from, env.id, hash));
  const seen = records.get(key);
  if (seen) return seen.hash === hash ? { status: 'duplicate', receipt } : { status: 'conflict' };
  records.set(key, { hash, firstAcceptedAt: now });
  return { status: 'new', env, receipt, from: peer };
}

/** The sender's check of a receipt: signed by the peer over exactly what we sent. */
export function checkReceipt(peer, myFp, env, receipt) {
  return verify(peer.ed, ackBytes(myFp, env.id, contentHash(env)), receipt);
}

/** Drop records older than RETAIN_MS from their first acceptance. */
export function pruneRecords(map, now) {
  for (const [k, r] of Object.entries(map)) if (!r || now - r.firstAcceptedAt > RETAIN_MS) delete map[k];
  return map;
}
