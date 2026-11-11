import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Its own userData (config-manager reads the path at import), removed after.
process.env.DOBIUS_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-sched-'));
const { shouldFire, deferDaily, updateScheduledTask, startScheduledTasks, stopScheduledTasks, listScheduledTasks } = await import('../scheduled-tasks.js');
process.on('exit', () => fs.rmSync(process.env.DOBIUS_TEST_USERDATA, { recursive: true, force: true }));

startScheduledTasks(); // seeds the default tasks into this test's config
stopScheduledTasks();
const away = (new Date().getHours() + 3) % 24; // well outside its minute
const stored = (id) => listScheduledTasks().find((t) => t.id === id);

test('a daily run that could not be delivered stays due on later ticks', () => {
  assert.equal(updateScheduledTask('morning-brief', { enabled: true, schedule: { type: 'daily', hour: away, minute: 0 } }).ok, true);
  const task = stored('morning-brief');
  assert.equal(shouldFire(task), false);
  deferDaily(task);
  assert.equal(shouldFire(task), true);
});

test('editing a task drops a run held from before the edit, and a late refusal does not hold it again', () => {
  const before = stored('morning-brief'); // the copy a firing took
  deferDaily(before);
  assert.equal(updateScheduledTask('morning-brief', { schedule: { type: 'daily', hour: away, minute: 30 } }).ok, true);
  assert.equal(shouldFire(stored('morning-brief')), false);
  deferDaily(before); // its send refused after the edit
  assert.equal(shouldFire(stored('morning-brief')), false);
});
