import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeNewTabTool, newTabCommand, buildPickerProjects, countHiddenProjects,
  toggleHiddenProject, pickerShortcutIndex,
  launchCommandFor, loginShellArgs,
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

test('loginShellArgs runs only a bare tool, then becomes a login shell', () => {
  assert.deepEqual(loginShellArgs('/bin/zsh', null), ['-l']);
  assert.deepEqual(loginShellArgs('/bin/zsh', 'claude'), ['-l', '-i', '-c', "trap : INT; claude; exec '/bin/zsh' -l"]);
  assert.deepEqual(loginShellArgs("/o'dd/sh", 'codex'), ['-l', '-i', '-c', "trap : INT; codex; exec '/o'\\''dd/sh' -l"]);
  assert.deepEqual(loginShellArgs('/bin/zsh', 'claude; rm -rf ~'), ['-l']);
  assert.deepEqual(loginShellArgs('/bin/zsh', 'Claude'), ['-l']);
});
