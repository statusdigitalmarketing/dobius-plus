// Test temp folders that delete themselves when the test process exits.
// 2026-11-10: tests that called mkdtempSync without cleanup left ~100,000 dobius-* folders in $TMPDIR.
// `npm test` also runs under scripts/test-tmp.mjs, which deletes the whole run's temp folder; this helper
// covers a test file run on its own (`node --test <file>`). The set holds one entry per folder a test made,
// so it is bounded by the number of tests in the file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = new Set();

process.on('exit', () => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`tmp.mjs: could not remove ${dir}: ${err.message}`);
    }
  }
});

export function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
}
