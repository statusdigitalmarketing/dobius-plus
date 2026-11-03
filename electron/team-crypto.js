/**
 * Team communicator crypto (docs/team-communicator.md). Pure functions over node:crypto.
 *
 * - Identity: an Ed25519 key (signing) and an X25519 key (encryption) per install. The fingerprint is the first
 *   10 chars of base64url(sha256(ed spki || x spki)), shown as XXXXX-XXXXX.
 * - Sealing: X25519 ECDH with a fresh ephemeral key, HKDF-SHA256 (salt = eph spki || recipient spki, info names the
 *   purpose), AES-256-GCM with the caller's header bytes as AAD. A different purpose ("msg", "link", ...) derives a
 *   different key, so a ciphertext made for one cannot be opened as another.
 * - Signatures: Ed25519 over exact bytes. Callers sign the raw wire body and domain-separated strings.
 */
import crypto from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  return Buffer.from(s, 'base64url');
};

const ED_SPKI_LEN = 44;
const X_SPKI_LEN = 44;

export function generateIdentity() {
  const ed = crypto.generateKeyPairSync('ed25519');
  const x = crypto.generateKeyPairSync('x25519');
  return {
    ed: b64u(ed.publicKey.export({ type: 'spki', format: 'der' })),
    x: b64u(x.publicKey.export({ type: 'spki', format: 'der' })),
    edPriv: b64u(ed.privateKey.export({ type: 'pkcs8', format: 'der' })),
    xPriv: b64u(x.privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

/** A public key object, or throws: wrong length or wrong type is refused (no key confusion between ed and x). */
export function publicKey(b64, kind) {
  const der = fromB64u(b64);
  if (der.length !== (kind === 'ed25519' ? ED_SPKI_LEN : X_SPKI_LEN)) throw new Error('bad key length');
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== kind) throw new Error('wrong key type');
  return key;
}

function privateKey(b64, kind) {
  const key = crypto.createPrivateKey({ key: fromB64u(b64), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== kind) throw new Error('wrong key type');
  return key;
}

export function fingerprint(ed, x) {
  const h = crypto.createHash('sha256').update(fromB64u(ed)).update(fromB64u(x)).digest();
  const s = b64u(h).slice(0, 10);
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function sign(identity, bytes) {
  return b64u(crypto.sign(null, Buffer.from(bytes), privateKey(identity.edPriv, 'ed25519')));
}

/** True only for a valid Ed25519 signature by `ed` over `bytes`. Never throws. */
export function verify(ed, bytes, sigB64) {
  try {
    const sig = fromB64u(sigB64);
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(bytes), publicKey(ed, 'ed25519'), sig);
  } catch {
    return false; // malformed key or signature: not valid
  }
}

function deriveKey(shared, ephSpki, recipientSpki, purpose) {
  const salt = Buffer.concat([ephSpki, recipientSpki]);
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(`dobius-team-v1|${purpose}`), 32));
}

/**
 * Encrypt `plaintext` (Buffer|string) to the X25519 key `toX`. `aad(eph, nonce)` returns the header bytes to bind.
 * Returns { eph, nonce, ct } (base64url).
 */
export function seal(toX, plaintext, purpose, aad) {
  const recipient = publicKey(toX, 'x25519');
  const eph = crypto.generateKeyPairSync('x25519');
  const ephSpki = eph.publicKey.export({ type: 'spki', format: 'der' });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = deriveKey(shared, ephSpki, fromB64u(toX), purpose);
  const nonce = crypto.randomBytes(12);
  const out = { eph: b64u(ephSpki), nonce: b64u(nonce) };
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad(out.eph, out.nonce)));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
  return { ...out, ct: b64u(ct) };
}

/** Open what seal() made for `identity`. Returns a Buffer, or null on any failure (tamper, wrong key, wrong AAD). */
export function open(identity, { eph, nonce, ct }, purpose, aad) {
  try {
    const ephKey = publicKey(eph, 'x25519');
    const n = fromB64u(nonce);
    const body = fromB64u(ct);
    if (n.length !== 12 || body.length < 16) return null;
    const shared = crypto.diffieHellman({ privateKey: privateKey(identity.xPriv, 'x25519'), publicKey: ephKey });
    const key = deriveKey(shared, fromB64u(eph), fromB64u(identity.x), purpose);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, n);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  } catch {
    return null; // any failure to open is "not for us / tampered"
  }
}

export const sha256hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** Constant-time string compare that cannot throw (both sides hashed to 32 bytes). */
export function sameSecret(a, b) {
  const h = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();
  return crypto.timingSafeEqual(h(a), h(b));
}
