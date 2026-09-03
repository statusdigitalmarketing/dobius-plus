// A config with NO autoResume key. loadConfig shallow-merges DEFAULT_CONFIG,
// so cfg.autoResume aliases the shared module-level default object and a
// migration that mutated it would poison every later read in the process.
// Separate file from autoresume-cap.test.mjs because config-manager reads its
// userData once at module load.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/autoresume-cap-nokey.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-nokey-'));
process.env.DOBIUS_TEST_USERDATA = userData;
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ projects: {} }));

const cm = await import('../config-manager.js');
const cfg = cm.loadConfig();

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

check('a config with no autoResume key gets the new default', () => {
  assert.equal(cfg.autoResume.skipOversizedMB, 4000);
  assert.equal(cfg.autoResume.staggerMs, 50);
});

check('the one-time marker is recorded even when no value changed', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.equal(onDisk.autoResumeCapMigrated, true);
});

check('the shared DEFAULT_CONFIG object was not mutated by the migration', () => {
  cm.updateAutoResume({ skipOversizedMB: 200 });
  assert.equal(cm.getAutoResume().skipOversizedMB, 200);
  // If DEFAULT_CONFIG had been aliased and mutated, this would read 200 too.
  assert.equal(cm.getAutoResume().staggerMs, 50);
});

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\nALL PASS  (${pass} passed)`);
