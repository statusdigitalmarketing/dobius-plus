// Team communicator crypto + protocol (docs/team-communicator.md). Every check the design audits named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateIdentity, fingerprint, seal, open, sign, verify, publicKey } from '../team-crypto.js';
import * as P from '../team-protocol.js';

const mk = (name, port) => {
  const identity = generateIdentity();
  const fp = fingerprint(identity.ed, identity.x);
  const me = { name, host: `${name.toLowerCase()}.tail0.ts.net`, port };
  return { identity, fp, me, asPeer: { id: fp, name, host: me.host, port, ed: identity.ed, x: identity.x, enabled: true } };
};
const sam = mk('Sam', 8420);
const bryan = mk('Bryan', 8420);
const brett = mk('Brett', 8420);
const NOW = 1_800_000_000_000;
const memRecords = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m }; };
const env = (over = {}) => ({ id: crypto.randomUUID(), kind: 'ask', replyTo: null, text: 'where is the Axiom catalog', firstSentAt: NOW, deadline: NOW + 864e5, ...over });

test('seal/open: round trip, and any change to purpose, AAD, ciphertext or recipient fails', () => {
  const aad = (e, n) => `h|${e}|${n}`;
  const s = seal(bryan.identity.x, 'hello', 'msg', aad);
  assert.equal(open(bryan.identity, s, 'msg', aad(s.eph, s.nonce)).toString(), 'hello');
  assert.equal(open(bryan.identity, s, 'link', aad(s.eph, s.nonce)), null, 'another purpose derives another key');
  assert.equal(open(bryan.identity, s, 'msg', 'h|other'), null, 'AAD is bound');
  const bad = { ...s, ct: s.ct.slice(0, -2) + (s.ct.endsWith('A') ? 'BB' : 'AA') };
  assert.equal(open(bryan.identity, bad, 'msg', aad(s.eph, s.nonce)), null, 'tamper is caught');
  assert.equal(open(brett.identity, s, 'msg', aad(s.eph, s.nonce)), null, 'only the recipient can open');
});

test('keys of one type are never accepted as the other', () => {
  assert.throws(() => publicKey(sam.identity.ed, 'x25519'));
  assert.throws(() => publicKey(sam.identity.x, 'ed25519'));
  assert.equal(verify(sam.identity.x, 'm', sign(sam.identity, 'm')), false);
  assert.equal(verify(sam.identity.ed, 'm', 'not-a-sig'), false);
});

test('hello: accepted only from the expected fingerprint over our nonce', () => {
  const n = P.newNonce();
  const h = P.makeHello(sam.identity, sam.me, n);
  assert.equal(P.checkHello(h, n, sam.fp)?.id, sam.fp);
  assert.equal(P.checkHello(h, P.newNonce(), sam.fp), null, 'a replayed hello for another nonce');
  assert.equal(P.checkHello(h, n, bryan.fp), null, 'a different install at that address');
  assert.equal(P.checkHello({ ...h, name: 'Evil' }, n, sam.fp), null, 'signed fields cannot change');
});

test('invite: round trip and strict parsing', () => {
  const inv = P.makeInvite(sam.me, sam.fp, NOW);
  assert.equal(inv.expiresAt, NOW + P.INVITE_MS);
  assert.deepEqual(P.parseInvite(inv.text), { host: sam.me.host, port: 8420, fp: sam.fp, secret: inv.secret });
  for (const bad of ['', 'dobius-team:2:a:1:xxxxx-xxxxx:' + inv.secret, inv.text + 'x', inv.text.replace(':8420:', ':99999:')]) {
    assert.equal(P.parseInvite(bad), null, bad);
  }
});

test('link request: opened only by its recipient, signature checked with the key inside', () => {
  const nonce = P.newNonce();
  const req = P.buildLinkRequest(bryan.identity, bryan.me, sam.asPeer, 'SECRET', nonce);
  const got = P.openLinkRequest(sam.identity, sam.fp, req.body, req.sig);
  assert.equal(got.id, bryan.fp);
  assert.equal(got.secret, 'SECRET');
  assert.equal(got.reqNonce, nonce);
  assert.equal(P.openLinkRequest(brett.identity, brett.fp, req.body, req.sig), null, 'not for Brett');
  assert.equal(P.openLinkRequest(sam.identity, sam.fp, req.body, sign(brett.identity, req.body)), null, 'signed by someone else');
  const huge = Buffer.alloc(P.MAX_BODY + 1, 0x7b);
  assert.equal(P.openLinkRequest(sam.identity, sam.fp, huge, req.sig), null, 'size cap');
});

test('link confirmation binds this attempt: a replayed one for another nonce or another joiner fails', () => {
  const inv = P.makeInvite(sam.me, sam.fp, NOW);
  const parsed = P.parseInvite(inv.text);
  const nonce = P.newNonce();
  const conf = P.linkConfirmation(sam.identity, sam.me, inv.secret, bryan.fp, nonce);
  assert.equal(P.checkLinkConfirmation(conf, parsed, bryan.fp, nonce)?.id, sam.fp);
  assert.equal(P.checkLinkConfirmation(conf, parsed, bryan.fp, P.newNonce()), null, 'old confirmation, new attempt');
  assert.equal(P.checkLinkConfirmation(conf, parsed, brett.fp, nonce), null, 'made for another joiner');
  const forged = P.linkConfirmation(brett.identity, sam.me, inv.secret, bryan.fp, nonce);
  assert.equal(P.checkLinkConfirmation(forged, parsed, bryan.fp, nonce), null, 'not the invite fingerprint');
});

const peersOfSam = () => ({ [bryan.fp]: { ...bryan.asPeer }, [brett.fp]: { ...brett.asPeer } });

test('message: accepted once, duplicate gets the same receipt, changed content conflicts', () => {
  const records = memRecords();
  const e = env();
  const m1 = P.buildMessage(bryan.identity, bryan.fp, sam.asPeer, e, NOW);
  const r1 = P.receiveMessage({ identity: sam.identity, myFp: sam.fp, peers: peersOfSam(), records, body: m1.body, sig: m1.sig, now: NOW });
  assert.equal(r1.status, 'new');
  assert.equal(r1.env.text, e.text);
  assert.equal(r1.from.id, bryan.fp);
  assert.equal(P.checkReceipt(sam.asPeer, bryan.fp, e, r1.receipt), true);
  // a retry: re-sealed, fresh ts, same id and content
  const m2 = P.buildMessage(bryan.identity, bryan.fp, sam.asPeer, e, NOW + 60_000);
  const r2 = P.receiveMessage({ identity: sam.identity, myFp: sam.fp, peers: peersOfSam(), records, body: m2.body, sig: m2.sig, now: NOW + 60_000 });
  assert.equal(r2.status, 'duplicate');
  assert.equal(r2.receipt, r1.receipt);
  const m3 = P.buildMessage(bryan.identity, bryan.fp, sam.asPeer, { ...e, text: 'different' }, NOW + 60_000);
  assert.equal(P.receiveMessage({ identity: sam.identity, myFp: sam.fp, peers: peersOfSam(), records, body: m3.body, sig: m3.sig, now: NOW + 60_000 }).status, 'conflict');
  // the same id from ANOTHER sender is a different record (r2 #6)
  const m4 = P.buildMessage(brett.identity, brett.fp, sam.asPeer, { ...e, text: 'brett' }, NOW);
  assert.equal(P.receiveMessage({ identity: sam.identity, myFp: sam.fp, peers: peersOfSam(), records, body: m4.body, sig: m4.sig, now: NOW }).status, 'new');
});

test('message: the receipt does not verify for other content or another sender', () => {
  const records = memRecords();
  const e = env();
  const m = P.buildMessage(bryan.identity, bryan.fp, sam.asPeer, e, NOW);
  const r = P.receiveMessage({ identity: sam.identity, myFp: sam.fp, peers: peersOfSam(), records, body: m.body, sig: m.sig, now: NOW });
  assert.equal(P.checkReceipt(sam.asPeer, bryan.fp, { ...e, text: 'x' }, r.receipt), false);
  assert.equal(P.checkReceipt(sam.asPeer, brett.fp, e, r.receipt), false);
  assert.equal(P.checkReceipt(brett.asPeer, bryan.fp, e, r.receipt), false, 'signed by Sam, not Brett');
});

test('message: every refusal the design lists', () => {
  const recv = (m, over = {}) => P.receiveMessage({ identity: sam.identity, myFp: sam.fp, peers: peersOfSam(), records: memRecords(), body: m.body, sig: m.sig, now: NOW, ...over }).reason;
  const good = P.buildMessage(bryan.identity, bryan.fp, sam.asPeer, env(), NOW);
  assert.equal(recv(good, { peers: {} }), 'unknown sender');
  assert.equal(recv(good, { peers: { [bryan.fp]: { ...bryan.asPeer, enabled: false } } }), 'unknown sender');
  assert.equal(recv({ body: good.body, sig: sign(brett.identity, good.body) }), 'signature');
  const tampered = Buffer.from(good.body.toString().replace('"v":1', '"v":1 '));
  assert.equal(recv({ body: tampered, sig: good.sig }), 'signature');
  const toBrett = P.buildMessage(bryan.identity, bryan.fp, brett.asPeer, env(), NOW);
  assert.equal(recv(toBrett), 'not for us');
  assert.equal(recv(good, { now: NOW + P.SKEW_MS + 1 }), 'stale');
  assert.equal(recv(P.buildMessage(bryan.identity, bryan.fp, sam.asPeer, env({ firstSentAt: NOW - P.CUTOFF_MS - 1 }), NOW)), 'cutoff');
  assert.equal(recv(P.buildMessage(bryan.identity, bryan.fp, sam.asPeer, env({ firstSentAt: NOW + P.SKEW_MS + 1 }), NOW)), 'cutoff', 'a sender clock ahead cannot stretch the window');
  assert.equal(recv(P.buildMessage(bryan.identity, bryan.fp, sam.asPeer, env({ text: 'x'.repeat(P.MAX_TEXT + 1) }), NOW)), 'text');
  assert.equal(recv(P.buildMessage(bryan.identity, bryan.fp, sam.asPeer, env({ kind: 'run' }), NOW)), 'fields');
});

test('message: an inner sender that differs from the authenticated one is refused (r2 #5)', () => {
  // Bryan signs and is the outer sender, but claims to be Brett inside.
  const inner = { v: 1, id: crypto.randomUUID(), from: brett.fp, to: sam.fp, kind: 'ask', replyTo: null, text: 'from brett, honest', ts: NOW, firstSentAt: NOW, deadline: NOW + 1 };
  const sealed = seal(sam.identity.x, JSON.stringify(inner), 'msg', (e, n) => `dobius-team-msg|1|${bryan.fp}|${sam.fp}|${e}|${n}`);
  const body = Buffer.from(JSON.stringify({ v: 1, from: bryan.fp, to: sam.fp, ...sealed }));
  const r = P.receiveMessage({ identity: sam.identity, myFp: sam.fp, peers: peersOfSam(), records: memRecords(), body, sig: sign(bryan.identity, body), now: NOW });
  assert.equal(r.reason, 'identity mismatch');
});

test('records: kept 7 days from first acceptance, then pruned', () => {
  const map = { a: { hash: 'h', firstAcceptedAt: NOW - P.RETAIN_MS - 1 }, b: { hash: 'h', firstAcceptedAt: NOW - 1000 } };
  assert.deepEqual(Object.keys(P.pruneRecords(map, NOW)), ['b']);
});
