// The stale-cap migration must recognise a STRING "80". The check was strict
// (=== 80), so a hand-edited config.json holding "80" was missed while the
// one-time autoResumeCapMigrated marker was still burned, pinning that install
// at 80MB forever. Separate file because config-manager reads userData once at
// module load and the migration is one-time per install.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/autoresume-cap-string.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-str80-'));
process.env.DOBIUS_TEST_USERDATA = userData;
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  autoResume: { enabled: true, staggerMs: 50, skipOversizedMB: '80', cancelOnUserInput: true },
  projects: {},
}));

const cm = await import('../config-manager.js');
let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

const ar = cm.getAutoResume();

check('a string "80" is recognised as the stale default and migrated', () => {
  assert.equal(ar.skipOversizedMB, 4000);
});

check('the migrated value is persisted as a number', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.equal(onDisk.autoResume.skipOversizedMB, 4000);
  assert.equal(typeof onDisk.autoResume.skipOversizedMB, 'number');
  assert.equal(onDisk.autoResumeCapMigrated, true);
});

check('the largest real transcript on this machine (725MB) now passes the cap', () => {
  assert.ok(ar.skipOversizedMB > 725);
});

check('the marker is written as a real boolean, which is what the strict read expects', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.strictEqual(onDisk.autoResumeCapMigrated, true);
});

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\nALL PASS  (${pass} passed)`);
