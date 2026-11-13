// The phone server's refusal log (diag.phone) never copies a Host name a peer chose (Codex, PR 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DOBIUS_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-refusal-'));
const { hostForLog } = await import('../mobile-server.js');

test('an IPv4 Host is written, a name never is', () => {
  assert.equal(hostForLog('100.64.1.2:8420'), 'host 100.64.1.2:8420');
  assert.equal(hostForLog('10.0.0.5'), 'host 10.0.0.5');
  const token = '0123456789abcdef'.repeat(4);
  for (const h of [`${token}:8420`, token, `${token}.ts.net`, `evil.example\r\nX: y`, `\x1b[31mred`, '[::1]:8420']) {
    const out = hostForLog(h);
    assert.ok(!out.includes('0123456789abcdef') && !out.includes('evil') && !out.includes('\x1b') && !out.includes('\n') && !out.includes('::1'), out);
  }
  assert.equal(hostForLog('other-mac.tail1234.ts.net:8420'), 'a tailnet host name that is not this Mac');
  assert.equal(hostForLog('evil.example'), 'a host name that is not this Mac');
  assert.equal(hostForLog('x'.repeat(300)), 'an overlong host name');
  assert.equal(hostForLog(''), 'no host');
  assert.equal(hostForLog(undefined), 'no host');
});
