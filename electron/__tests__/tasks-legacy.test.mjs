// legacyListWaiting (electron/tasks-service.js): read-only, and true while an old-style list another folder may share
// is waiting, so the phone never triggers the legacy move. Run: npm run test:taskslegacy
import { test, after } from 'node:test';
import https from 'node:https';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-legacy-'));
process.env.HOME = home;
const { legacyListWaiting, syncAsanaTasks, completeTaskById, addTask, listTasks } = await import('../tasks-service.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('an old-style list two folders can share is reported waiting, and the check moves nothing', () => {
  const dir = path.join(home, '.claude', 'project-tasks');
  fs.mkdirSync(dir, { recursive: true });
  try {
    assert.equal(legacyListWaiting('/work/a_b'), false, 'nothing at all');
    fs.writeFileSync(path.join(dir, '_work_a_b.json'), '[]');
    assert.equal(legacyListWaiting('/work/a/b'), true, 'a shared legacy name is waiting');
    assert.equal(legacyListWaiting('/work/a_b'), true);
    assert.equal(fs.existsSync(path.join(dir, '_work_a_b.json')), true, 'the check moved nothing');
  } finally { fs.rmSync(path.join(dir, '_work_a_b.json'), { force: true }); }
});

// The sync read comes after Asana answers. A project that already had its own list when the sync started must never
// take another folder's old-style list then, even if its own file was moved aside (as corrupt) while Asana answered.
test('a sync never moves another folder\'s old list in after its own file went away mid-sync', async () => {
  const dir = path.join(home, '.claude', 'project-tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ASANA_PAT: 'test-not-a-key' } }));
  const legacy = path.join(dir, '_work_a_b.json'); // /work/a_b's old list (the same legacy name as /work/a/b)
  fs.writeFileSync(legacy, JSON.stringify([{ id: 'other', title: 'Other folder task', done: false, source: 'manual' }]));
  const ownName = crypto.createHash('sha1').update('/work/a/b').digest('hex').slice(0, 8);
  const ownPath = path.join(dir, `_work_a_b.${ownName}.json`); // /work/a/b has its own list when the sync starts
  fs.writeFileSync(ownPath, '[]');
  assert.equal(legacyListWaiting('/work/a/b'), false, 'it has its own list');
  const realRequest = https.request;
  let calls = 0;
  https.request = (opts, onRes) => {
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      calls++;
      // While Asana answers the first call, the project's own file goes away (a read moving it aside as corrupt).
      if (calls === 1) fs.renameSync(ownPath, `${ownPath}.corrupt-1`);
      const body = calls === 1 ? { data: { gid: '1', workspaces: [{ gid: 'w' }] } } : { data: [{ gid: '9', name: 'From Asana', completed: false }] } // the review lane keeps only completed ones;
      const res = new EventEmitter();
      res.statusCode = 200;
      onRes(res);
      res.emit('data', Buffer.from(JSON.stringify(body)));
      res.emit('end');
    });
    req.destroy = () => {};
    return req;
  };
  try {
    const r = await syncAsanaTasks('/work/a/b');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.existsSync(legacy), true, 'the other folder\'s old list stays where it was');
    const mine = JSON.parse(fs.readFileSync(ownPath, 'utf8'));
    assert.deepEqual(mine.map((t) => t.title), ['From Asana'], 'only the Asana task, nothing of the other folder');
  } finally {
    https.request = realRequest;
  }
});

test('the phone\'s Done closes only the task with exactly that id (Codex round 6)', () => {
  const proj = path.join(home, 'exact-id-proj');
  const a = addTask(proj, { title: 'first' });
  const b = addTask(proj, { title: 'second' });
  assert.equal(a.ok && b.ok, true);
  assert.equal(completeTaskById(proj, ` ${a.task.id} `).ok, false, 'a padded id is not that task');
  assert.equal(completeTaskById(proj, 'second').ok, false, 'a title is not an id');
  assert.equal(listTasks(proj).filter((t) => t.done).length, 0, 'nothing was closed');
  assert.equal(completeTaskById(proj, b.task.id).ok, true);
  assert.deepEqual(listTasks(proj).filter((t) => t.done).map((t) => t.id), [b.task.id]);
});

test('a damaged entry in the list does not stop an Asana sync (Codex phone tasks round 10)', async () => {
  const dir = path.join(home, '.claude', 'project-tasks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ASANA_PAT: 'test-not-a-key' } }));
  const own = path.join(dir, `_work_damaged.${crypto.createHash('sha1').update('/work/damaged').digest('hex').slice(0, 8)}.json`);
  fs.writeFileSync(own, JSON.stringify([null, { id: 'k', title: 'Kept', done: false, source: 'manual' }]));
  const realRequest = https.request;
  let calls = 0;
  https.request = (opts, onRes) => {
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      calls++;
      const body = calls === 1 ? { data: { gid: '1', workspaces: [{ gid: 'w' }] } } : { data: [{ gid: '9', name: 'From Asana', completed: false }] };
      const res = new EventEmitter();
      res.statusCode = 200;
      onRes(res);
      res.emit('data', Buffer.from(JSON.stringify(body)));
      res.emit('end');
    });
    req.destroy = () => {};
    return req;
  };
  try {
    const r = await syncAsanaTasks('/work/damaged');
    assert.equal(r.ok, true, JSON.stringify(r));
    const titles = JSON.parse(fs.readFileSync(own, 'utf8')).filter((t) => t && typeof t === 'object').map((t) => t.title);
    assert.deepEqual(titles.sort(), ['From Asana', 'Kept']);
  } finally {
    https.request = realRequest;
  }
});
