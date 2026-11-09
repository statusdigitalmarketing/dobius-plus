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
const { legacyListWaiting, syncAsanaTasks } = await import('../tasks-service.js');
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
