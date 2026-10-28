// certValidTo reads expiry from the certificate itself and rejects a key that
// does not belong to it. Real certs, made with openssl into a scratch userData.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-tlstest-'));
process.env.DOBIUS_TEST_USERDATA = dir;
const { certValidTo, certPathsFor } = await import('../tailscale.js');
const NAME = 'mac.tail123.ts.net';

function makePair(days, prefix) {
  const key = path.join(dir, `${prefix}.key`), crt = path.join(dir, `${prefix}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt,
    '-days', String(days), '-subj', `/CN=${NAME}`], { stdio: 'ignore' });
  return { key, crt };
}

let a, b;
before(() => { a = makePair(45, 'a'); b = makePair(10, 'b'); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function install(crt, key) {
  const p = certPathsFor(NAME);
  fs.copyFileSync(crt, p.certFile);
  fs.copyFileSync(key, p.keyFile);
}

test('no files is null', () => {
  assert.equal(certValidTo(NAME), null);
});

test('a matching pair reports the cert expiry, not the file age', () => {
  install(a.crt, a.key);
  const days = (certValidTo(NAME) - Date.now()) / 86_400_000;
  assert.ok(days > 44 && days < 46, `expected ~45 days, got ${days}`);
});

test('a key from another cert is rejected', () => {
  install(a.crt, b.key);
  assert.equal(certValidTo(NAME), null);
});

test('garbage cert is null, not a throw', () => {
  const p = certPathsFor(NAME);
  fs.writeFileSync(p.certFile, 'not a cert');
  fs.copyFileSync(a.key, p.keyFile);
  assert.equal(certValidTo(NAME), null);
});
