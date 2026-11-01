// Fireflies key storage: encrypted only, status never carries the key.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/fireflies-key.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-ffkey-'));
process.env.DOBIUS_TEST_USERDATA = dir;
const { setFirefliesKey, firefliesKey, firefliesKeyStatus } = await import('../fireflies-key.js');
const { flushConfig, loadConfig } = await import('../config-manager.js');

let pass = 0;
const check = async (label, fn) => { await fn(); pass += 1; console.log(`PASS  ${label}`); };
const KEY = 'ff_0123456789abcdef_WXYZ';

await check('nothing saved: no key, status unset', () => {
  assert.equal(firefliesKey(), null);
  assert.deepEqual(firefliesKeyStatus(), { set: false, hint: null, unreadable: false });
});
await check('a bad value is refused and nothing is saved', () => {
  assert.equal(setFirefliesKey('short').ok, false);
  assert.equal(setFirefliesKey('has a space in it 1234567').ok, false);
  assert.equal(firefliesKey(), null);
});
await check('a key saves encrypted; status gives only the last four', () => {
  const r = setFirefliesKey(`  ${KEY}\n`);
  assert.deepEqual(r, { ok: true, set: true, hint: 'WXYZ', unreadable: false });
  assert.equal(firefliesKey(), KEY);
  const stored = loadConfig().secrets.firefliesKey;
  assert.equal(typeof stored, 'string');
  assert.ok(!stored.includes(KEY), 'the key is not stored in plain text');
  assert.ok(!JSON.stringify(firefliesKeyStatus()).includes(KEY.slice(0, -4)), 'status never carries the key');
});
await check('written to disk encrypted, never the plain key', () => {
  flushConfig();
  const text = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(text.includes('"firefliesKey"'), 'the encrypted key is on disk');
  assert.ok(!text.includes(KEY), 'the plain key is not');
});
await check('without macOS encryption it refuses rather than storing plain text', () => {
  process.env.DOBIUS_TEST_NO_ENCRYPTION = '1';
  const r = setFirefliesKey('ff_another_key_1234567890');
  delete process.env.DOBIUS_TEST_NO_ENCRYPTION;
  assert.equal(r.ok, false);
  assert.equal(firefliesKey(), KEY, 'the previous key is untouched');
});
await check('empty removes it', () => {
  assert.deepEqual(setFirefliesKey(''), { ok: true, set: false, hint: null, unreadable: false });
  assert.equal(firefliesKey(), null);
  assert.equal(loadConfig().secrets?.firefliesKey, undefined);
});
await check('a saved key that cannot be decrypted reads as unreadable, and is retried, not cached', async () => {
  const cfg = loadConfig();
  cfg.secrets = { ...(cfg.secrets || {}), firefliesKey: Buffer.from('garbage, not ciphertext').toString('base64') };
  // A fresh module instance, as after a relaunch, so nothing is cached.
  const fresh = await import(`../fireflies-key.js?again=${Date.now()}`);
  assert.equal(fresh.firefliesKey(), null);
  assert.deepEqual(fresh.firefliesKeyStatus(), { set: false, hint: null, unreadable: true });
  cfg.secrets.firefliesKey = Buffer.from(`enc:${Buffer.from(KEY).toString('base64')}`).toString('base64');
  assert.equal(fresh.firefliesKey(), KEY, 'read again once decryptable');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nALL PASS  (${pass} passed)`);
