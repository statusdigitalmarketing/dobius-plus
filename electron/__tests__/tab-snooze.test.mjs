import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './tmp.mjs';
import { snoozePicks, snoozeTimeLabel } from '../../shared/snooze-times.js';
import { createSnoozeStore, cleanEntry, dueIds, nextDelay, MAX_SNOOZED } from '../tab-snooze.js';

const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('picks: tonight 9 PM while it is ahead, tomorrow night after it', () => {
  const tue = local(2026, 11, 10, 11, 47); // a Tuesday
  const p = snoozePicks(tue);
  assert.deepEqual(p.map((x) => x.id), ['tonight', 'morning', '24h', '2d', 'week', 'manual']);
  assert.equal(p[0].at, local(2026, 11, 10, 21));
  assert.equal(p[1].at, local(2026, 11, 11, 9));
  assert.equal(p[2].at, tue + 24 * 3600e3);
  assert.equal(p[3].at, tue + 48 * 3600e3);
  assert.equal(p[4].at, local(2026, 11, 16, 9)); // next Monday
  assert.equal(p[5].at, null);
  const late = snoozePicks(local(2026, 11, 10, 21, 0));
  assert.equal(late[0].id, 'tomorrow-night');
  assert.equal(late[0].at, local(2026, 11, 11, 21));
});

test('picks: next week from a Monday is the Monday after, from a Sunday is the next day', () => {
  assert.equal(snoozePicks(local(2026, 11, 16, 8)).find((x) => x.id === 'week').at, local(2026, 11, 23, 9));
  assert.equal(snoozePicks(local(2026, 11, 15, 8)).find((x) => x.id === 'week').at, local(2026, 11, 16, 9));
});

test('time label: same day is the time alone, within the week has the weekday', () => {
  const now = local(2026, 11, 10, 11, 47);
  assert.match(snoozeTimeLabel(local(2026, 11, 10, 21), now), /^9:00\s?PM$/);
  assert.match(snoozeTimeLabel(local(2026, 11, 12, 11, 47), now), /^Thu 11:47\s?AM$/);
  assert.equal(snoozeTimeLabel(null, now), 'until you bring it back');
});

test('cleanEntry keeps only safe fields', () => {
  const e = cleanEntry({
    id: '0123456789abcdef', projectPath: '/p/app', label: 'x'.repeat(300), kind: 'terminal',
    sessionId: 'abc-123', cwd: '/p/app', until: 5, url: 'javascript:alert(1)', viewMode: 'nope', extra: 1,
  });
  assert.equal(e.label.length, 100);
  assert.equal(e.sessionId, 'abc-123');
  assert.equal(e.url, undefined);
  assert.equal(e.viewMode, undefined);
  assert.equal(e.extra, undefined);
  assert.equal(cleanEntry({ id: 'bad', projectPath: '/p' }), null);
  assert.equal(cleanEntry({ id: '0123456789abcdef', projectPath: 'relative' }), null);
  // A session id that could break the shell line is dropped, cwd with it.
  const bad = cleanEntry({ id: '0123456789abcdef', projectPath: '/p', sessionId: 'a; rm -rf', cwd: '/p' });
  assert.equal(bad.sessionId, undefined);
  assert.equal(bad.cwd, undefined);
});

test('due and next delay', () => {
  const list = [
    { id: 'a', until: 100, ready: false },
    { id: 'b', until: 50, ready: true },
    { id: 'c', until: null, ready: false },
    { id: 'd', until: 300, ready: false },
  ];
  assert.deepEqual(dueIds(list, 100), ['a']);
  assert.equal(nextDelay(list, 90), 10);
  assert.equal(nextDelay(list, 500), 0);
  assert.equal(nextDelay([{ id: 'x', until: 1e15, ready: false }], 0), 6 * 3600e3);
  assert.equal(nextDelay([{ id: 'c', until: null, ready: false }], 0), null);
});

function harness() {
  let config = {};
  let clock = 1000;
  let changes = 0;
  const dir = path.join(tmpDir('dobius-snooze-'), 'snoozed');
  const store = createSnoozeStore({
    load: () => config, save: (c) => { config = c; }, dir,
    onChange: () => { changes += 1; }, now: () => clock,
  });
  return { store, dir, get config() { return config; }, set clock(v) { clock = v; }, get changes() { return changes; } };
}

test('add, take once, scrollback file goes with the entry', () => {
  const h = harness();
  const id = h.store.add({ projectPath: '/p/app', label: 'Fix', sessionId: 's1', cwd: '/p/app', until: 5000 }, ['one', 'two']);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(fs.existsSync(path.join(h.dir, `${id}.json`)), true);
  assert.equal(h.store.list()[0].ready, false);
  const got = h.store.take(id);
  assert.deepEqual(got.scrollback, ['one', 'two']);
  assert.equal(got.entry.sessionId, 's1');
  assert.equal(h.store.take(id), null); // a second window asking gets nothing
  assert.equal(fs.existsSync(path.join(h.dir, `${id}.json`)), false);
  assert.deepEqual(h.config.snoozedTabs, []);
  h.store.stop();
});

test('checkDue turns due entries ready and tells the windows', () => {
  const h = harness();
  const a = h.store.add({ projectPath: '/p', until: 2000 });
  const b = h.store.add({ projectPath: '/p', until: null });
  const before = h.changes;
  h.clock = 2000;
  h.store.checkDue();
  const byId = Object.fromEntries(h.store.list().map((e) => [e.id, e]));
  assert.equal(byId[a].ready, true);
  assert.equal(byId[b].ready, false);
  assert.equal(h.changes, before + 1);
  h.store.checkDue(); // nothing new: no broadcast
  assert.equal(h.changes, before + 1);
  h.store.stop();
});

test('setTime: now makes it ready, later or manual does not; discard removes', () => {
  const h = harness();
  const id = h.store.add({ projectPath: '/p', until: 9000 });
  h.store.setTime(id, 1000);
  assert.equal(h.store.list()[0].ready, true);
  h.store.setTime(id, null);
  assert.equal(h.store.list()[0].ready, false);
  assert.equal(h.store.setTime('ffffffffffffffff', 1), false);
  assert.equal(h.store.discard(id), true);
  assert.deepEqual(h.store.list(), []);
  h.store.stop();
});

test('the list is capped and orphan scrollback files are swept', () => {
  const h = harness();
  for (let i = 0; i < MAX_SNOOZED; i++) assert.ok(h.store.add({ projectPath: '/p' }));
  assert.equal(h.store.add({ projectPath: '/p' }), null);
  fs.mkdirSync(h.dir, { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'aaaaaaaaaaaaaaaa.json'), '[]');
  fs.writeFileSync(path.join(h.dir, 'unrelated.txt'), 'x');
  h.store.sweepOrphans();
  assert.equal(fs.existsSync(path.join(h.dir, 'aaaaaaaaaaaaaaaa.json')), false);
  assert.equal(fs.existsSync(path.join(h.dir, 'unrelated.txt')), true);
  h.store.stop();
});

test('take onlyReady: a window returning due tabs never takes one snoozed again meanwhile', () => {
  const h = harness();
  const id = h.store.add({ projectPath: '/p', until: 500 }); // already due: ready at once
  assert.equal(h.store.list()[0].ready, true);
  h.store.setTime(id, 99999); // snoozed again from another window
  assert.equal(h.store.take(id, { onlyReady: true }), null);
  assert.equal(h.store.list().length, 1);
  assert.equal(h.store.take(id).entry.id, id); // Bring back now takes it whatever its state
  h.store.stop();
});

test('a pinned tab comes back pinned; anything but true is dropped', () => {
  assert.equal(cleanEntry({ id: '0123456789abcdef', projectPath: '/p', pinned: true }).pinned, true);
  assert.equal(cleanEntry({ id: '0123456789abcdef', projectPath: '/p', pinned: 'yes' }).pinned, undefined);
});
