// legacyListWaiting (electron/tasks-service.js): read-only, and true while an old-style list another folder may share
// is waiting, so the phone never triggers the legacy move. Run: npm run test:taskslegacy
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-legacy-'));
process.env.HOME = home;
const { legacyListWaiting } = await import('../tasks-service.js');

test('an old-style list two folders can share is reported waiting, and the check moves nothing', () => {
  const dir = path.join(home, '.claude', 'project-tasks');
  fs.mkdirSync(dir, { recursive: true });
  try {
    assert.equal(legacyListWaiting('/work/a_b'), false, 'nothing at all');
    fs.writeFileSync(path.join(dir, '_work_a_b.json'), '[]');
    assert.equal(legacyListWaiting('/work/a/b'), true, 'a shared legacy name is waiting');
    assert.equal(legacyListWaiting('/work/a_b'), true);
    assert.equal(fs.existsSync(path.join(dir, '_work_a_b.json')), true, 'the check moved nothing');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
