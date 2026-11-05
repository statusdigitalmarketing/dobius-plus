// The first launch after an update puts back windows the old shutdown dropped, using the backup written just before
// the install. Real shape from this Mac, 2026-11-05: the 2.2.0 shutdown left only a deleted folder in the list.
// Run: node ./electron/__tests__/update-window-recovery.test.mjs
import assert from 'node:assert/strict';
import { recoverWindowLists } from '../update-window-recovery.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const exists = (p) => p !== '/gone';
const run = (config, { runningVersion = '2.2.2', justUpdated = true, backups = {} } = {}) => {
  if (!justUpdated) config.windowListsCheckedFor = runningVersion;
  return recoverWindowLists(config, { runningVersion, exists, now: NOW, read: (v) => backups[v] || null });
};
const backup = (lists, age = 0) => ({ lists, mtimeMs: NOW - age });

let c = { lastOpenProjects: ['/gone'] };
let r = run(c, { backups: { '2.2.2': backup({ lastOpenProjects: ['/a', '/b', '/gone'] }) } });
assert.deepEqual(c.lastOpenProjects, ['/gone', '/a', '/b']);
assert.equal(r.added, 2);
assert.equal(r.changed, true);
console.log('PASS  an update that lost the windows gets them back');

c.lastOpenProjects = ['/a'];
assert.equal(run(c, { justUpdated: false, backups: { '2.2.2': backup({ lastOpenProjects: ['/a', '/b'] }) } }).added, 0);
assert.deepEqual(c.lastOpenProjects, ['/a']);
c = { lastOpenProjects: ['/a'] };
run(c, { backups: { '2.2.2': backup({ lastOpenProjects: ['/stale'] }, 15 * DAY) } });
assert.deepEqual(c.lastOpenProjects, ['/a']);
console.log('PASS  it checks once per version, and not against an old backup');

c = { lastOpenProjects: ['/a', '/b'], oldUpdateWindowsRecovered: true };
r = run(c, { justUpdated: false, backups: { '2.2.2': backup({ lastOpenProjects: ['/a', '/b', '/closed-on-purpose'] }) } });
assert.deepEqual(c.lastOpenProjects, ['/a', '/b']);
assert.equal(r.changed, false);
console.log('PASS  an ordinary launch never reopens a window closed on purpose');

c = { lastOpenProjects: ['/z'], oldUpdateWindowsRecovered: true };
run(c, { backups: {} });
assert.deepEqual(c.lastOpenProjects, ['/z']);
console.log('PASS  no backup changes nothing');

const hitBackup = { lastOpenProjects: ['/a', '/b', '/gone'] };
c = { lastOpenProjects: ['/gone', '/b'] };
r = run(c, { justUpdated: false, backups: { '2.2.1': backup(hitBackup, DAY) } });
assert.deepEqual(c.lastOpenProjects, ['/gone', '/b', '/a']);
assert.equal(c.oldUpdateWindowsRecovered, true);
const again = run(c, { justUpdated: false, backups: { '2.2.1': backup({ lastOpenProjects: ['/later'] }, DAY) } });
assert.equal(again.changed, false);
assert.deepEqual(c.lastOpenProjects, ['/gone', '/b', '/a']);
console.log('PASS  someone already hit on 2.2.1 is repaired once and only once');

c = { lastOpenProjects: ['/b'] };
r = run(c, { justUpdated: false, backups: { '2.2.1': backup({ lastOpenProjects: ['/a', '/b'] }, DAY) } });
assert.deepEqual(c.lastOpenProjects, ['/b']);
assert.equal(r.added, 0);
console.log('PASS  a backup with no leftovers means they were never hit: their closed windows stay closed');

c = { lastOpenProjects: ['/b'] };
run(c, { justUpdated: false, backups: { '2.2.1': backup(hitBackup, 15 * DAY) } });
assert.deepEqual(c.lastOpenProjects, ['/b']);
console.log('PASS  a backup too old to trust is ignored');

c = { lastOpenProjects: ['/b'] };
r = run(c, { runningVersion: '2.2.1', justUpdated: false, backups: { '2.2.1': backup(hitBackup, DAY) } });
assert.equal(c.oldUpdateWindowsRecovered, undefined);
assert.equal(r.changed, false);
console.log('PASS  2.2.1 itself leaves the once-only repair for a later version');

c = { lastOpenProjects: ['/a'], lastTearOffs: [{ tabId: 't1', projectPath: '/a' }], lastPrimaryWindows: [{ windowKey: 'k1', projectPath: '/a' }] };
r = run(c, { backups: { '2.2.2': backup({
  lastOpenProjects: ['/a', null, 7], lastTearOffs: [{ tabId: 't1', projectPath: '/a', label: 'keep mine' }, { tabId: 't2', projectPath: '/a' }, {}],
  lastPrimaryWindows: [{ windowKey: 'k1' }, { windowKey: 'k2', projectPath: '/a' }, null],
}) } });
assert.deepEqual(c.lastOpenProjects, ['/a']);
assert.deepEqual(c.lastTearOffs.map((t) => t.tabId), ['t1', 't2']);
assert.equal(c.lastTearOffs[0].label, undefined);
assert.deepEqual(c.lastPrimaryWindows.map((e) => e.windowKey), ['k1', 'k2']);
console.log('PASS  tear-offs and extra windows too, no duplicates, and junk entries are skipped');

// Loading the config drops the tabs of a window missing from the lists, before this runs.
c = { lastOpenProjects: ['/gone'], tearOffWindows: { mine: { tabs: ['mine'] } } };
run(c, { backups: { '2.2.2': { mtimeMs: NOW, lists: {
  lastTearOffs: [{ tabId: 'T', projectPath: '/a' }, { tabId: 'mine', projectPath: '/a' }, { tabId: '__proto__', projectPath: '/a' }],
  lastPrimaryWindows: [{ windowKey: 'K', projectPath: '/a' }, { windowKey: 'nothing-saved', projectPath: '/a' }],
}, windowState: {
  tearOffWindows: { T: { tabs: ['saved-t', 'saved-u'] }, mine: { tabs: ['stale'] }, ['__proto__']: { tabs: ['bad'] } },
  primaryWindows: { K: { tabs: ['saved-e', 'saved-f'] } },
} } } });
assert.deepEqual(c.tearOffWindows.T.tabs, ['saved-t', 'saved-u']);
assert.deepEqual(c.tearOffWindows.mine.tabs, ['mine'], 'a window already there keeps its own tabs');
assert.deepEqual(c.primaryWindows.K.tabs, ['saved-e', 'saved-f']);
assert.equal(Object.hasOwn(c.primaryWindows, 'nothing-saved'), false);
assert.equal({}.tabs, undefined, 'no prototype pollution');
console.log('PASS  a window put back gets its saved tabs from the backup');

// The old backup can be days old: a tear-off from it may hold a tab that moved to another window.
c = { lastOpenProjects: ['/gone'], lastTearOffs: [], lastPrimaryWindows: [{ windowKey: 'K', projectPath: '/a' }], primaryWindows: { K: { tabs: [{ id: 'T' }] } } };
run(c, { justUpdated: false, backups: { '2.2.1': { mtimeMs: NOW - DAY, lists: {
  lastOpenProjects: ['/a', '/gone'], lastTearOffs: [{ tabId: 'T', projectPath: '/a' }], lastPrimaryWindows: [{ windowKey: 'old', projectPath: '/a' }],
}, windowState: { tearOffWindows: { T: { tabs: [{ id: 'T' }] } }, primaryWindows: { old: { tabs: [] } } } } } });
assert.deepEqual(c.lastOpenProjects, ['/gone', '/a']);
assert.deepEqual(c.lastTearOffs, []);
assert.deepEqual(c.lastPrimaryWindows.map((e) => e.windowKey), ['K']);
assert.equal(c.tearOffWindows, undefined);
console.log('PASS  the old backup only brings back project windows, never a tab that moved');

// A tab id must never be restored by two windows: the second terminal is rejected and stays dead.
const state = (tearOffWindows, primaryWindows = {}) => ({ tearOffWindows, primaryWindows });
c = { lastOpenProjects: ['/a'], lastPrimaryWindows: [{ windowKey: 'K', projectPath: '/a' }], primaryWindows: { K: { tabs: [{ id: 'T' }] } }, projects: { '/a': { tabs: [{ id: 'U' }, { id: 'Z' }] } } };
run(c, { backups: { '2.2.2': { mtimeMs: NOW, lists: { lastTearOffs: [{ tabId: 'T', projectPath: '/a' }, { tabId: 'V', projectPath: '/a' }, { tabId: 'W', projectPath: '/a' }] }, windowState: state({
  T: { tabs: [{ id: 'T' }, { id: 'X' }] },
  V: { tabs: [{ id: 'V' }, { id: 'U' }] },
  W: { tabs: [{ id: 'Z' }] },
}) } } });
assert.deepEqual(c.lastTearOffs.map((t) => t.tabId), ['T', 'V'], 'a tear-off with nothing left stays closed');
assert.deepEqual(c.tearOffWindows.T.tabs.map((t) => t.id), ['X'], 'one whose own tab moved keeps the tabs that did not');
assert.deepEqual(c.tearOffWindows.V.tabs.map((t) => t.id), ['V'], 'a tab that moved is left where it is');
assert.equal(c.tearOffWindows.W, undefined);
c = { lastOpenProjects: ['/a'], projects: { '/a': { tabs: [{ id: 'T' }, { id: 'Y' }] } } };
run(c, { backups: { '2.2.2': { mtimeMs: NOW, lists: { lastTearOffs: [{ tabId: 'T', projectPath: '/a' }] }, windowState: state({ T: { tabs: [{ id: 'T' }, { id: 'U' }] } }) } } });
assert.deepEqual(c.tearOffWindows.T.tabs.map((t) => t.id), ['T', 'U'], 'its own tab in the project list is the case startup already strips');
// Docked tear-off: its own id lives elsewhere by design, the rest of its tabs still belong to it.
c = { lastOpenProjects: ['/p'], lastPrimaryWindows: [{ windowKey: 'K', projectPath: '/p' }], primaryWindows: { K: { tabs: [{ id: 'one' }] } } };
run(c, { backups: { '2.2.2': { mtimeMs: NOW, lists: { lastTearOffs: [{ tabId: 'one', projectPath: '/p', docked: true }] }, windowState: state({ one: { tabs: [{ id: 'two' }] } }) } } });
assert.deepEqual(c.tearOffWindows.one.tabs.map((t) => t.id), ['two']);
// A tear-off with no saved tabs recreates its own: it must not collide with a tab another window claimed.
c = { lastOpenProjects: ['/p'] };
run(c, { backups: { '2.2.2': { mtimeMs: NOW, lists: { lastTearOffs: [{ tabId: 'one', projectPath: '/p' }, { tabId: 'two', projectPath: '/p' }] }, windowState: state({ one: { tabs: [{ id: 'one' }, { id: 'two' }] } }) } } });
const owners = (id) => [...c.lastTearOffs.filter((t) => t.tabId === id && !c.tearOffWindows[t.tabId]), ...Object.values(c.tearOffWindows).filter((w) => w.tabs.some((t) => t.id === id))].length;
assert.equal(owners('one'), 1);
assert.equal(owners('two'), 1, 'one window restores it, not two');
// A listed tear-off with no saved tabs owns its id against a recovered extra window.
c = { lastOpenProjects: ['/a'], lastTearOffs: [{ tabId: 'x1', projectPath: '/a' }] };
run(c, { backups: { '2.2.2': { mtimeMs: NOW, lists: { lastPrimaryWindows: [{ windowKey: 'K', projectPath: '/a' }] }, windowState: state({}, { K: { tabs: [{ id: 'x1' }, { id: 'x2' }] } }) } } });
assert.deepEqual(c.primaryWindows.K.tabs.map((t) => t.id), ['x2']);
console.log('PASS  a tab id is never restored by two windows');

c = { lastOpenProjects: ['/a'], projects: { '/a': { tabs: [{ id: 'T' }] } } };
const junk = run(c, { backups: { '2.2.2': { mtimeMs: NOW, lists: { lastTearOffs: [{ tabId: 'T' }, { tabId: { toString: null }, projectPath: '/a' }], lastPrimaryWindows: [{ windowKey: 'K', projectPath: '/a' }] }, windowState: state({}, { K: { tabs: [{ id: 'E' }] } }) } } });
assert.equal(c.lastTearOffs, undefined, 'incomplete or malformed entries are skipped');
assert.deepEqual(c.primaryWindows.K.tabs.map((t) => t.id), ['E'], 'and the good entry after them still comes back');
assert.equal(junk.added, 1);
console.log('PASS  junk in a backup cannot stop the rest of the recovery');
