// Loopback bridge hardening (Codex design audit 2026-11-03): the token compare
// can never throw, and no generated CLI puts the token on a command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sameSecret } from '../voice-bridge.js';
import { buildTabCliScript } from '../tab-rename.js';

test('sameSecret never throws, whatever the lengths or bytes', () => {
  assert.equal(sameSecret('Bearer abc', 'Bearer abc'), true);
  assert.equal(sameSecret('Bearer abd', 'Bearer abc'), false);
  // same number of characters, different UTF-8 byte length: this used to throw and crash main
  assert.equal(sameSecret('Bearer ébc', 'Bearer abc'), false);
  assert.equal(sameSecret('', 'Bearer abc'), false);
  assert.equal(sameSecret('x'.repeat(10000), 'Bearer abc'), false);
});

function renderedScripts() {
  const src = fs.readFileSync(new URL('../voice-bridge.js', import.meta.url), 'utf8');
  const out = { 'dobius-tab': buildTabCliScript({ port: 8421, tokenFile: '/tmp/x/token' }) };
  const re = /const (CLI_[A-Z_]+_SCRIPT) = (`[\s\S]*?\n`);/g;
  let m;
  while ((m = re.exec(src))) {
    out[m[1]] = Function('TOKEN_FILE_PATH', 'PORT', 'CLI_MARKER', `return ${m[2]}`)('/tmp/x/token', 8421, '# DOBIUS-CLI');
  }
  return out;
}

test('no generated CLI passes the bridge token in arguments', () => {
  const scripts = renderedScripts();
  assert.ok(Object.keys(scripts).length >= 19, 'all scripts were found');
  for (const [name, body] of Object.entries(scripts)) {
    if (!/\nTOKEN=/.test(body)) continue;
    assert.doesNotMatch(body, /Bearer \$TOKEN"/, `${name} puts the token on curl's command line`);
    assert.match(body, /-H @"\$DOBIUS_AUTH_HDR"/, `${name} reads the header from a file`);
    assert.match(body, /trap 'rm -f "\$DOBIUS_AUTH_HDR"' EXIT/, `${name} removes the header file`);
  }
});
