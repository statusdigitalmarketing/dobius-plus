import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  normalizeNewTabTool, newTabCommand, buildPickerProjects, countHiddenProjects,
  toggleHiddenProject, pickerShortcutIndex,
  launchCommandFor, loginShellSpawn, isNewTabWrapperCommand,
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

test('loginShellSpawn starts only a bare tool, under zsh or bash, via env', () => {
  assert.deepEqual(loginShellSpawn('/bin/zsh', null), { args: ['-l'], env: {} });
  const z = loginShellSpawn('/bin/zsh', 'claude');
  assert.deepEqual(z.env, { DOBIUS_NEW_TAB_TOOL: 'claude' });
  assert.deepEqual(z.args.slice(0, 3), ['-l', '-i', '-c']);
  const read = 'set -- "$DOBIUS_NEW_TAB_TOOL"; unset DOBIUS_NEW_TAB_TOOL;';
  const launch = '[[ $1 == claude ]] && claude; [[ $1 == codex ]] && codex;';
  // The tool is read BEFORE the hooks, which could change the env.
  assert.ok(z.args[3].startsWith(`trap : INT; setopt no_nounset no_err_exit 2>/dev/null; ${read} `));
  assert.ok(z.args[3].indexOf(read) < z.args[3].indexOf('precmd_functions'));
  assert.ok(z.args[3].includes(`pre=(\${(k)jobstates}); ${launch} i=0;`));
  assert.match(z.args[3], /:\|pre.*fg %\$s\[1\].*; exec '\/bin\/zsh' -l$/);
  const bsh = loginShellSpawn('/bin/bash', 'claude').args[3];
  assert.ok(bsh.startsWith(`trap : INT; set +eu; ${read} __dobius_hooks() { for c in "\${PROMPT_COMMAND[@]}"; do eval "$c"; done; }; __dobius_hooks;`));
  assert.ok(bsh.includes(`"; ${launch} j=$(jobs -sl `));
  assert.match(bsh, /\[\[ \$n == \\\[\* \]\] \|\| continue/);
  assert.equal(bsh.split('[ -n "$j" ] && fg %$j').length - 1, 25);
  // The tool value is never evaluated as code: only fixed case branches run.
  for (const sc of [z.args[3], bsh]) assert.ok(!/eval "\$1"|eval "\$t"|eval "\$__/.test(sc));
  assert.ok(z.args[3].includes('DOBIUS_NEW_TAB_TOOL'), 'argv carries the marker argv scans skip');
  assert.match(loginShellSpawn('/usr/local/bin/bash', 'codex').args[3], /PROMPT_COMMAND.*exec '\/usr\/local\/bin\/bash' -l$/);
  assert.match(loginShellSpawn("/o'dd/zsh", 'codex').args[3], /exec '\/o'\\''dd\/zsh' -l$/);
  assert.deepEqual(loginShellSpawn('/opt/homebrew/bin/fish', 'claude'), { args: ['-l'], env: {} });
  assert.deepEqual(loginShellSpawn('/bin/zsh', 'claude; rm -rf ~'), { args: ['-l'], env: {} });
  assert.deepEqual(loginShellSpawn('/bin/zsh', 'Claude'), { args: ['-l'], env: {} });
  assert.deepEqual(loginShellSpawn('/bin/zsh', 'shell'), { args: ['-l'], env: {} });
});

test('isNewTabWrapperCommand spots the wrapper shell, not a Claude that mentions it', () => {
  for (const sh of ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/bash']) {
    const argv = [sh, ...loginShellSpawn(sh, 'claude').args].join(' ');
    assert.equal(isNewTabWrapperCommand(`123 ${argv}`), true, sh);
  }
  assert.equal(isNewTabWrapperCommand('456 claude -p Explain DOBIUS_NEW_TAB_TOOL'), false);
  assert.equal(isNewTabWrapperCommand('456 node /opt/claude/cli.js set -- "$DOBIUS_NEW_TAB_TOOL"'), false);
  assert.equal(isNewTabWrapperCommand('789 /bin/zsh -l'), false);
});

// The real shells: a hostile prompt hook (a direnv .env import, say) rewrites
// every name it can reach to a command. Only the allowlisted tool may run.
test('a prompt hook rewriting the tool runs nothing but the allowlisted tool', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-newtab-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho TOOL-RAN\n', { mode: 0o755 });
    const evil = `touch ${dir}/PWNED; echo pwned`;
    const assigns = `__dobius_tool='${evil}'; t='${evil}'; DOBIUS_NEW_TAB_TOOL='${evil}'; export DOBIUS_NEW_TAB_TOOL; set -- '${evil}'`;
    const base = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ZDOTDIR: dir, BASH_SILENCE_DEPRECATION_WARNING: '1' };
    const runs = [
      ['/bin/zsh', `_evil() { ${assigns}; }; precmd_functions=(_evil); `, {}],
      ['/bin/bash', '', { PROMPT_COMMAND: assigns }],
    ];
    for (const [shell, prelude, env] of runs) {
      if (!fs.existsSync(shell)) continue;
      const spawn = loginShellSpawn(shell, 'claude');
      // Drop the final exec into a login shell; everything before it runs as shipped.
      const script = prelude + spawn.args[3].replace(/exec '[^']*' -l$/, 'exit 0');
      const r = spawnSync(shell, ['-c', script], { env: { ...base, ...env, ...spawn.env }, encoding: 'utf8', timeout: 10000, input: '' });
      assert.match(r.stdout, /TOOL-RAN/, `${shell} launched the tool`);
      assert.doesNotMatch(r.stdout, /pwned/, `${shell} ran nothing a hook assigned`);
      assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false, `${shell} ran nothing a hook assigned`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
