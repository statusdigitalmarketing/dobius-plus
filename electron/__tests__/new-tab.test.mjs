import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeNewTabTool, newTabCommand, buildPickerProjects, countHiddenProjects,
  toggleHiddenProject, pickerShortcutIndex,
} from '../../src/lib/new-tab.js';
import { setPendingLaunch, takePendingLaunch, armLaunch } from '../../src/lib/pending-launch.js';

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

test('a pending launch is taken once', () => {
  setPendingLaunch('t1', 'claude');
  assert.equal(takePendingLaunch('t1'), 'claude');
  assert.equal(takePendingLaunch('t1'), undefined);
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
const flush = () => new Promise((r) => setImmediate(r));

test('launch types the command after the shell prompt settles', async () => {
  const c = clock(); const writes = [];
  const l = armLaunch('claude', { write: (d) => writes.push(d), setTimer: c.setTimer, clearTimer: c.clearTimer });
  await flush();
  assert.deepEqual(writes, []);
  l.onOutput(); c.run(200); l.onOutput(); c.run(200);
  assert.deepEqual(writes, [], 'still printing, not settled yet');
  c.run(150);
  assert.deepEqual(writes, ['claude\r']);
  l.onOutput(); c.run(5000);
  assert.deepEqual(writes, ['claude\r'], 'typed exactly once');
});

test('launch falls back when the shell prints nothing', async () => {
  const c = clock(); const writes = [];
  armLaunch(Promise.resolve('codex'), { write: (d) => writes.push(d), setTimer: c.setTimer, clearTimer: c.clearTimer });
  await flush();
  c.run(3999);
  assert.deepEqual(writes, []);
  c.run(1);
  assert.deepEqual(writes, ['codex\r']);
});

test('launch waits for a setting that resolves after the prompt', async () => {
  const c = clock(); const writes = [];
  let resolve;
  armLaunch(new Promise((r) => { resolve = r; }), { write: (d) => writes.push(d), setTimer: c.setTimer, clearTimer: c.clearTimer }).onOutput();
  c.run(1000);
  assert.deepEqual(writes, []);
  resolve('claude'); await flush();
  assert.deepEqual(writes, ['claude\r']);
});

test('user input, a plain shell, a failed read or dispose type nothing', async () => {
  for (const [tool, act] of [
    [() => 'claude', (l) => l.onUserInput()],
    [() => 'shell', () => {}],
    [() => Promise.reject(new Error('ipc')), () => {}],
    [() => 'claude', (l) => l.dispose()],
  ]) {
    const c = clock(); const writes = [];
    const l = armLaunch(tool(), { write: (d) => writes.push(d), setTimer: c.setTimer, clearTimer: c.clearTimer });
    act(l);
    await flush();
    l.onOutput(); c.run(10000);
    assert.deepEqual(writes, []);
  }
});
