// addTask's Inbox and preview fields. Runs against a throwaway HOME so the
// real ~/.claude/project-tasks is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-inbox-home-'));
const realHome = process.env.HOME;
let svc;

before(async () => {
  process.env.HOME = home;
  assert.equal(os.homedir(), home);
  svc = await import('../tasks-service.js');
});

after(() => {
  process.env.HOME = realHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const project = '/tmp/some-project-for-tasks-inbox-test';

test('an Inbox card keeps its notes, https link and card id', () => {
  const r = svc.addTask(project, { title: 'Reply to Kim', source: 'inbox', inboxId: 'gmail:1', notes: 'From Kim', url: 'https://mail.google.com/x', dueOn: '2026-11-03' });
  assert.equal(r.ok, true);
  assert.equal(r.task.source, 'inbox');
  assert.equal(r.task.inboxId, 'gmail:1');
  assert.equal(r.task.notes, 'From Kim');
  assert.equal(r.task.url, 'https://mail.google.com/x');
  assert.equal(r.task.dueOn, '2026-11-03');
  assert.ok(fs.readFileSync(fs.readdirSync(path.join(home, '.claude', 'project-tasks')).map((f) => path.join(home, '.claude', 'project-tasks', f))[0], 'utf8').includes('gmail:1'));
});

test('the same open card is not added twice', () => {
  const r = svc.addTask(project, { title: 'Reply to Kim again', source: 'inbox', inboxId: 'gmail:1' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'already on this list');
});

test('a done card is not added again (reopen it instead)', () => {
  const first = svc.listTasks(project).find((t) => t.inboxId === 'gmail:1');
  assert.equal(svc.completeTaskByRef(project, first.id).ok, true);
  assert.equal(svc.addTask(project, { title: 'Kim wrote back', source: 'inbox', inboxId: 'gmail:1' }).ok, false);
  assert.equal(svc.listTasks(project).filter((t) => t.inboxId === 'gmail:1').length, 1);
});

test('links that are not https and unknown sources are dropped', () => {
  const r = svc.addTask(project, { title: 'x', source: 'evil', url: 'javascript:alert(1)', notes: '   ' });
  assert.equal(r.ok, true);
  assert.equal(r.task.source, 'manual');
  assert.equal(r.task.url, null);
  assert.equal(r.task.notes, null);
});
