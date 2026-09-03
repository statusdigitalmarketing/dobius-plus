// The 80MB auto-resume cap (v1.0.66). It skipped 10 of 24 tracked sessions and
// produced the "transcript is too big" message on exactly the sessions Sam
// wanted back, while a 725MB transcript actually resumes in 10s. A stored 80 is
// a persisted DEFAULT (there is no UI for it), so it migrates; a value someone
// deliberately chose does not.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/autoresume-cap.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-captest-'));
process.env.DOBIUS_TEST_USERDATA = userData;

fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  autoResume: { enabled: true, staggerMs: 50, skipOversizedMB: 80, cancelOnUserInput: true },
  projects: {},
}));

const cm = await import('../config-manager.js');
const cfg = cm.loadConfig();

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

check('the stale 80MB default is lifted on load', () => {
  assert.notEqual(cfg.autoResume.skipOversizedMB, 80);
  assert.ok(cfg.autoResume.skipOversizedMB >= 1000,
    `expected a cap above every real transcript, got ${cfg.autoResume.skipOversizedMB}`);
});

check('the new cap clears the largest transcript measured on this machine (725MB)', () => {
  assert.ok(cfg.autoResume.skipOversizedMB > 725);
});

check('the migration is persisted, not recomputed every launch', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.equal(onDisk.autoResume.skipOversizedMB, cfg.autoResume.skipOversizedMB);
});

check('other autoResume settings are untouched by the migration', () => {
  assert.equal(cfg.autoResume.staggerMs, 50);
  assert.equal(cfg.autoResume.enabled, true);
  assert.equal(cfg.autoResume.cancelOnUserInput, true);
});

check('a deliberately chosen cap is preserved', () => {
  const updated = cm.updateAutoResume({ skipOversizedMB: 120 });
  assert.equal(updated.skipOversizedMB, 120);
  assert.equal(cm.loadConfig().autoResume.skipOversizedMB, 120);
});

check('the migration runs ONCE, so a later deliberate 80 is never overwritten', () => {
  cm.updateAutoResume({ skipOversizedMB: 80 });
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.equal(onDisk.autoResumeCapMigrated, true, 'marker should be recorded');
  // A fresh load must leave the user's 80 exactly where they put it.
  assert.equal(cm.loadConfig().autoResume.skipOversizedMB, 80);
  cm.updateAutoResume({ skipOversizedMB: 4000 });
});

check('the clamp ceiling is high enough to set a cap above real transcripts', () => {
  assert.equal(cm.updateAutoResume({ skipOversizedMB: 5000 }).skipOversizedMB, 5000);
});

check('an absurd value is still clamped', () => {
  assert.equal(cm.updateAutoResume({ skipOversizedMB: 999999 }).skipOversizedMB, 8000);
});

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\nALL PASS  (${pass} passed)`);
