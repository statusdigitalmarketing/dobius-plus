import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeNewTabTool, newTabCommand, buildPickerProjects, countHiddenProjects,
  toggleHiddenProject, pickerShortcutIndex,
  armLaunch, launchCommandFor,
} from '../../shared/new-tab.js';
import { setPendingLaunch, takePendingLaunch, clearPendingLaunches } from '../../src/lib/pending-launch.js';

const P = (decodedPath, displayName) => ({ decodedPath, displayName });
const projects = [P('/u/a/alpha', 'alpha'), P('/u/a/beta-api', 'beta-api'), P('/u/a/gamma', 'gamma')];

test('normalizeNewTabTool defaults to claude and keeps known tools', () => {
  assert.equal(normalizeNewTabTool(undefined), 'claude');
  assert.equal(normalizeNewTabTool('vim'), 'claude');
  assert.equal(normalizeNewTabTool('codex'), 'codex');
  assert.equal(normalizeNewTabTool('shell'), 'shell');
});

test('newTabCommand types the bare tool, nothing for a shell', () => {
  assert.equal(newTabCommand('claude'), 'claude');
  assert.equal(newTabCommand('codex'), 'codex');
  assert.equal(newTabCommand('shell'), null);
  assert.equal(newTabCommand('rm -rf /'), null);
});

test('launchCommandFor maps a request to a fixed command, never to input text', () => {
  assert.equal(launchCommandFor('default', undefined), 'claude');
  assert.equal(launchCommandFor('default', 'codex'), 'codex');
  assert.equal(launchCommandFor('default', 'shell'), null);
  assert.equal(launchCommandFor('codex', 'claude'), 'codex');
  assert.equal(launchCommandFor('claude; rm -rf ~', 'claude'), null);
  assert.equal(launchCommandFor({ toString: () => 'claude' }, 'claude'), null);
});

test('picker puts the current project first, once, then the launcher order', () => {
  const rows = buildPickerProjects({ currentPath: '/u/a/beta-api', projects });
  assert.deepEqual(rows.map((r) => r.path), ['/u/a/beta-api', '/u/a/alpha', '/u/a/gamma']);
  assert.equal(rows[0].isCurrent, true);
  assert.equal(rows[1].isCurrent, false);
});

test('picker lists a current project the scan folder does not know', () => {
  const rows = buildPickerProjects({ currentPath: '/elsewhere/proj', projects });
  assert.equal(rows[0].path, '/elsewhere/proj');
  assert.equal(rows[0].name, 'proj');
  assert.equal(rows.length, 4);
});

test('hidden projects drop out unless shown, the current one never does', () => {
  const hidden = ['/u/a/gamma', '/u/a/beta-api'];
  const rows = buildPickerProjects({ currentPath: '/u/a/beta-api', projects, hidden });
  assert.deepEqual(rows.map((r) => r.path), ['/u/a/beta-api', '/u/a/alpha']);
  const all = buildPickerProjects({ currentPath: '/u/a/beta-api', projects, hidden, showHidden: true });
  assert.deepEqual(all.map((r) => [r.path, r.hidden]), [['/u/a/beta-api', false], ['/u/a/alpha', false], ['/u/a/gamma', true]]);
  assert.equal(countHiddenProjects(projects, hidden, '/u/a/beta-api'), 1);
});

test('search needs every token in the name or path', () => {
  const rows = buildPickerProjects({ currentPath: '/u/a/alpha', projects, query: 'beta api' });
  assert.deepEqual(rows.map((r) => r.path), ['/u/a/beta-api']);
  assert.equal(buildPickerProjects({ projects, query: 'zzz' }).length, 0);
});

test('relative or malformed project paths are never listed', () => {
  const rows = buildPickerProjects({ projects: [P('relative/x', 'x'), null, { displayName: 'y' }, P('/ok', 'ok')] });
  assert.deepEqual(rows.map((r) => r.path), ['/ok']);
});

test('toggleHiddenProject adds then removes', () => {
  assert.deepEqual(toggleHiddenProject([], '/a'), ['/a']);
  assert.deepEqual(toggleHiddenProject(['/a', '/b'], '/a'), ['/b']);
  assert.deepEqual(toggleHiddenProject(undefined, '/a'), ['/a']);
});

test('Cmd+1..9 picks a row, other chords do not', () => {
  assert.equal(pickerShortcutIndex({ metaKey: true, key: '1' }), 0);
  assert.equal(pickerShortcutIndex({ metaKey: true, key: '9' }), 8);
  assert.equal(pickerShortcutIndex({ metaKey: true, key: '0' }), -1);
  assert.equal(pickerShortcutIndex({ metaKey: true, shiftKey: true, key: '1' }), -1);
  assert.equal(pickerShortcutIndex({ ctrlKey: true, key: '1' }), -1);
  assert.equal(pickerShortcutIndex({ key: '1' }), -1);
});

test('a pending launch is taken once, and restore clears them all', () => {
  setPendingLaunch('t1', 'default');
  assert.equal(takePendingLaunch('t1'), 'default');
  assert.equal(takePendingLaunch('t1'), undefined);
  setPendingLaunch('t2', 'codex');
  clearPendingLaunches();
  assert.equal(takePendingLaunch('t2'), undefined);
});

// Fake timers: run(ms) advances the clock and fires due callbacks in order.
function clock() {
  let now = 0; let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    run(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
      }
      now = end;
    },
  };
}
const arm = (command, extra = {}) => {
  const c = clock(); const writes = []; let done = 0;
  const l = armLaunch(command, { write: (d) => writes.push(d), onDone: () => { done += 1; }, setTimer: c.setTimer, clearTimer: c.clearTimer, ...extra });
  return { c, l, writes, done: () => done };
};

test('launch types the command once the shell output settles', () => {
  const { c, l, writes, done } = arm('claude');
  l.onOutput(); c.run(200); l.onOutput(); c.run(200);
  assert.deepEqual(writes, [], 'still printing, not settled yet');
  c.run(150);
  assert.deepEqual(writes, ['claude\r']);
  l.onOutput(); c.run(20000);
  assert.deepEqual(writes, ['claude\r'], 'typed exactly once');
  assert.equal(done(), 1);
});

test('a shell that prints nothing gets the command at the fallback', () => {
  const { c, writes } = arm('codex');
  c.run(3999);
  assert.deepEqual(writes, []);
  c.run(1);
  assert.deepEqual(writes, ['codex\r']);
});

test('a shell still printing past the fallback is not typed into mid-output', () => {
  const { c, l, writes } = arm('claude');
  for (let t = 0; t < 6000; t += 100) { l.onOutput(); c.run(100); }
  assert.deepEqual(writes, [], 'fallback must not fire while output streams');
  c.run(300);
  assert.deepEqual(writes, ['claude\r']);
});

test('a shell that never goes quiet gets nothing', () => {
  const { c, l, writes, done } = arm('claude');
  for (let t = 0; t < 16000; t += 100) { l.onOutput(); c.run(100); }
  c.run(1000);
  assert.deepEqual(writes, []);
  assert.equal(done(), 1);
});

test('anything typed first (canWrite false), no command or dispose types nothing', () => {
  const a = arm('claude', { canWrite: () => false });
  a.l.onOutput(); a.c.run(10000);
  assert.deepEqual(a.writes, []);
  assert.equal(a.done(), 1);
  const b = arm(null);
  b.l.onOutput(); b.c.run(10000);
  assert.deepEqual(b.writes, []);
  const d = arm('claude');
  d.l.onOutput(); d.l.dispose(); d.c.run(10000);
  assert.deepEqual(d.writes, []);
});
