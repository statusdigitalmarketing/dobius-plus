// autoResume values are coerced on READ, not only on write (v1.0.66). A
// hand-edited or legacy config.json can hold strings, and the size-scaled
// stagger accumulates with `+=`: a string staggerMs concatenates instead of
// adding, so delays became "050100" and Node clamped the overflowed timeout to
// ~1ms, firing resumes out of order and all at once.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/autoresume-coerce.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-coerce-'));
process.env.DOBIUS_TEST_USERDATA = userData;
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  autoResume: { enabled: 1, staggerMs: '50', skipOversizedMB: '4000', cancelOnUserInput: 'yes' },
  autoResumeCapMigrated: true,
  projects: {},
}));

const cm = await import('../config-manager.js');
let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

const ar = cm.getAutoResume();

check('a string staggerMs is read back as a number', () => {
  assert.equal(typeof ar.staggerMs, 'number');
  assert.equal(ar.staggerMs, 50);
});

check('a string skipOversizedMB is read back as a number', () => {
  assert.equal(typeof ar.skipOversizedMB, 'number');
  assert.equal(ar.skipOversizedMB, 4000);
});

check('truthy non-booleans become real booleans', () => {
  assert.equal(ar.enabled, true);
  assert.equal(ar.cancelOnUserInput, true);
});

// The actual failure: accumulating a string stagger concatenates.
check('the cumulative stagger adds instead of concatenating', () => {
  let cumulative = 0;
  const sizes = [50, 50, 50];
  const delays = [];
  for (const sizeMB of sizes) {
    delays.push(cumulative);
    cumulative += ar.staggerMs + Math.round(Math.min(sizeMB || 0, 2000) * 2);
  }
  assert.deepEqual(delays, [0, 150, 300]);
  for (const d of delays) assert.equal(typeof d, 'number');
  // Strictly increasing, which is what keeps the queue in order.
  assert.ok(delays[0] < delays[1] && delays[1] < delays[2]);
});

check('a garbage staggerMs falls back to the default rather than NaN', () => {
  const updated = cm.updateAutoResume({ staggerMs: 'not-a-number' });
  assert.equal(updated.staggerMs, 50);
  assert.equal(typeof updated.staggerMs, 'number');
});

check('an out-of-range string is clamped, not concatenated', () => {
  assert.equal(cm.updateAutoResume({ staggerMs: '99999' }).staggerMs, 2000);
});

check('the STRING "false" disables, it does not silently enable', () => {
  const off = cm.updateAutoResume({ enabled: 'false', cancelOnUserInput: 'false' });
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.cancelOnUserInput, false);
  assert.strictEqual(cm.getAutoResume().enabled, false);
});

check('"true"/1/0 coerce the way a reader expects', () => {
  assert.strictEqual(cm.updateAutoResume({ enabled: 'true' }).enabled, true);
  assert.strictEqual(cm.updateAutoResume({ enabled: 0 }).enabled, false);
  assert.strictEqual(cm.updateAutoResume({ enabled: 1 }).enabled, true);
});

check('an uninterpretable value falls back to the default rather than flipping', () => {
  assert.strictEqual(cm.updateAutoResume({ enabled: 'maybe' }).enabled, true);
});

check('a null autoResume section yields usable defaults', () => {
  const c = cm.loadConfig();
  c.autoResume = null;
  const back = cm.getAutoResume();
  assert.equal(typeof back.staggerMs, 'number');
  assert.equal(typeof back.skipOversizedMB, 'number');
});

fs.rmSync(userData, { recursive: true, force: true });
console.log(`\nALL PASS  (${pass} passed)`);
