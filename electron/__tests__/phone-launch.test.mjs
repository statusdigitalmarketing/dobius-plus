// The phone launch (docs/phone-mode-design.md, "The runner runs inside the tab"), run for real in zsh and bash with
// stand-ins for Dobius's binary and claude: the resume runs only after the gate exits 0, `done` runs whatever happened,
// and nothing a hook or a hostile folder name does can change the values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loginShellSpawn, isPhoneLaunch, isNewTabWrapperCommand } from '../../shared/new-tab.js';

const SID = '01234567-89ab-cdef-0123-456789abcdef';
const RUN = 'b'.repeat(32);

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phone-launch-')));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "CLAUDE $* IN $(pwd -P)"\n', { mode: 0o755 });
  const appDir = path.join(dir, "Dobius+ App $(touch PWNED)");
  fs.mkdirSync(appDir);
  const exe = path.join(appDir, 'Dobius+');
  // Stand-in for Dobius's binary: $1 is the runner path, $2 the subcommand. Gate exits with $GATE_EXIT.
  fs.writeFileSync(exe, '#!/bin/sh\nr="$1"; shift; echo "EXE[$ELECTRON_RUN_AS_NODE] $(basename "$r") $*"; [ "$1" = gate ] && exit "${GATE_EXIT:-0}"; exit 0\n', { mode: 0o755 });
  const runner = path.join(appDir, 'phone-runner.mjs');
  const cwd = path.join(dir, "proj 'x $(touch PWNED2)");
  fs.mkdirSync(cwd);
  const ticket = path.join(dir, 'run', `phone-${'a'.repeat(32)}.ticket`);
  const base = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, ZDOTDIR: dir, BASH_SILENCE_DEPRECATION_WARNING: '1' };
  return { dir, bin, exe, runner, cwd, ticket, base, phone: { sessionId: SID, cwd, ticket, runId: RUN, exe, runner } };
}

const SHELLS = ['/bin/zsh', '/bin/bash'].filter((s) => fs.existsSync(s));
const lines = (r) => r.stdout.trim().split('\n').filter(Boolean);

test('gate exits 0: the resume runs in the folder, then done', () => {
  const t = setup();
  try {
    for (const shell of SHELLS) {
      const spawn = loginShellSpawn(shell, null, null, null, null, t.phone);
      assert.equal(spawn.env.DOBIUS_NEW_TAB_TOOL, 'phone');
      assert.equal(isNewTabWrapperCommand([shell, ...spawn.args].join(' ')), true, `${shell}: argv scans skip it`);
      const script = spawn.args[3].replace(/exec '[^']*' -l$/, 'exit 0');
      const r = spawnSync(shell, ['-c', script], { cwd: t.dir, env: { ...t.base, ...spawn.env }, encoding: 'utf8', timeout: 10000, input: '' });
      assert.deepEqual(lines(r), [
        `EXE[1] phone-runner.mjs gate ${t.ticket} ${SID}`,
        `CLAUDE --resume ${SID} IN ${t.cwd}`,
        `EXE[1] phone-runner.mjs done ${t.ticket} ${RUN}`,
      ], shell);
    }
    assert.equal(fs.existsSync(path.join(t.dir, 'PWNED')), false);
    assert.equal(fs.existsSync(path.join(t.dir, 'PWNED2')), false);
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('gate refuses: no resume, done still runs', () => {
  const t = setup();
  try {
    for (const shell of SHELLS) {
      const spawn = loginShellSpawn(shell, null, null, null, null, t.phone);
      const script = spawn.args[3].replace(/exec '[^']*' -l$/, 'exit 0');
      const r = spawnSync(shell, ['-c', script], { cwd: t.dir, env: { ...t.base, GATE_EXIT: '3', ...spawn.env }, encoding: 'utf8', timeout: 10000, input: '' });
      assert.deepEqual(lines(r), [
        `EXE[1] phone-runner.mjs gate ${t.ticket} ${SID}`,
        `EXE[1] phone-runner.mjs done ${t.ticket} ${RUN}`,
      ], shell);
    }
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('the folder is gone: neither the gate nor the resume, done still runs', () => {
  const t = setup();
  try {
    const phone = { ...t.phone, cwd: path.join(t.dir, 'missing') };
    for (const shell of SHELLS) {
      const spawn = loginShellSpawn(shell, null, null, null, null, phone);
      const script = spawn.args[3].replace(/exec '[^']*' -l$/, 'exit 0');
      const r = spawnSync(shell, ['-c', script], { cwd: t.dir, env: { ...t.base, ...spawn.env }, encoding: 'utf8', timeout: 10000, input: '' });
      assert.deepEqual(lines(r), [`EXE[1] phone-runner.mjs done ${t.ticket} ${RUN}`], shell);
    }
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('prompt hooks cannot change the values', () => {
  const t = setup();
  try {
    const assigns = 'DOBIUS_NEW_TAB_TOOL_ID=evil; DOBIUS_NEW_TAB_TOOL_EXE=/bin/echo; export DOBIUS_NEW_TAB_TOOL_ID DOBIUS_NEW_TAB_TOOL_EXE; set -- phone evil /tmp evil evil /bin/echo evil';
    for (const [shell, prelude, env] of [['/bin/zsh', `_evil() { ${assigns}; }; precmd_functions=(_evil); `, {}], ['/bin/bash', '', { PROMPT_COMMAND: assigns }]]) {
      if (!fs.existsSync(shell)) continue;
      const spawn = loginShellSpawn(shell, null, null, null, null, t.phone);
      const script = prelude + spawn.args[3].replace(/exec '[^']*' -l$/, 'exit 0');
      const r = spawnSync(shell, ['-c', script], { cwd: t.dir, env: { ...t.base, ...env, ...spawn.env }, encoding: 'utf8', timeout: 10000, input: '' });
      assert.equal(lines(r)[0], `EXE[1] phone-runner.mjs gate ${t.ticket} ${SID}`, shell);
      assert.equal(lines(r)[1], `CLAUDE --resume ${SID} IN ${t.cwd}`, shell);
    }
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('anything off-shape is no phone launch at all', () => {
  const p = { sessionId: SID, cwd: '/tmp', ticket: `/x/run/phone-${'a'.repeat(32)}.ticket`, runId: RUN, exe: '/A/Dobius+', runner: '/A/phone-runner.mjs' };
  assert.equal(isPhoneLaunch(p), true);
  for (const bad of [
    { sessionId: 'x; rm -rf ~' }, { sessionId: '' }, { cwd: 'relative' }, { cwd: '/tmp/a\nb' },
    { ticket: '/x/run/other.ticket' }, { ticket: `/x/run/phone-${'A'.repeat(32)}.ticket` }, { ticket: `x/phone-${'a'.repeat(32)}.ticket` },
    { runId: 'b'.repeat(31) }, { exe: 'Dobius+' }, { runner: '/A/evil.mjs' }, { runner: '/A/phone-runner.mjs\u0007' },
  ]) {
    const q = { ...p, ...bad };
    assert.equal(isPhoneLaunch(q), false, JSON.stringify(bad));
    assert.deepEqual(loginShellSpawn('/bin/zsh', null, null, null, null, q), { args: ['-l'], env: {} }, JSON.stringify(bad));
  }
  assert.equal(isPhoneLaunch(null), false);
  // PowerShell never gets a phone launch.
  assert.equal(loginShellSpawn('pwsh.exe', null, null, null, null, p).env.DOBIUS_NEW_TAB_TOOL, undefined);
  // A phone launch wins over a resume or run script given alongside it.
  assert.equal(loginShellSpawn('/bin/zsh', 'claude', { sessionId: 'abc', cwd: '/tmp' }, null, null, p).env.DOBIUS_NEW_TAB_TOOL, 'phone');
});

test('the resume gets back the mode and model the TUI was stopped with', () => {
  const t = setup();
  try {
    for (const shell of SHELLS) {
      for (const [carry, flags] of [
        [{ permissionMode: 'default', model: 'opus[1m]' }, ' --permission-mode default --model opus[1m]'],
        [{ permissionMode: 'plan' }, ' --permission-mode plan'],
        [{ model: 'claude-sonnet-5-5' }, ' --model claude-sonnet-5-5'],
        [{ permissionMode: '', model: '' }, ''],
      ]) {
        const spawn = loginShellSpawn(shell, null, null, null, null, { ...t.phone, ...carry });
        assert.equal(isNewTabWrapperCommand([shell, ...spawn.args].join(' ')), true);
        const script = spawn.args[3].replace(/exec '[^']*' -l$/, 'exit 0');
        const r = spawnSync(shell, ['-c', script], { cwd: t.dir, env: { ...t.base, ...spawn.env }, encoding: 'utf8', timeout: 10000, input: '' });
        assert.equal(lines(r)[1], `CLAUDE --resume ${SID}${flags} IN ${t.cwd}`, `${shell} ${JSON.stringify(carry)}`);
      }
    }
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('a mode or model that is not one of the fixed shapes never reaches claude', () => {
  const t = setup();
  try {
    for (const bad of [{ permissionMode: 'yolo' }, { permissionMode: '--dangerously-skip-permissions' }, { model: '--dangerously-skip-permissions' }, { model: 'a b' }, { model: 'x'.repeat(80) }]) {
      assert.equal(isPhoneLaunch({ ...t.phone, ...bad }), false, JSON.stringify(bad));
    }
    // The values are read again in the shell after the rc files: one an rc exported is checked there too.
    for (const shell of SHELLS) {
      const spawn = loginShellSpawn(shell, null, null, null, null, { ...t.phone, permissionMode: 'plan', model: 'opus' });
      const script = spawn.args[3].replace(/exec '[^']*' -l$/, 'exit 0');
      for (const [perm, model] of [['yolo', '--dangerously-skip-permissions'], ['plan x', 'a b'], ['', 'x'.repeat(80)], ['bypass', 'opus[2m]']]) {
        const env = { ...t.base, ...spawn.env, DOBIUS_NEW_TAB_TOOL_PERM: perm, DOBIUS_NEW_TAB_TOOL_MODEL: model };
        const r = spawnSync(shell, ['-c', script], { cwd: t.dir, env, encoding: 'utf8', timeout: 10000, input: '' });
        assert.equal(lines(r)[1], `CLAUDE --resume ${SID} IN ${t.cwd}`, `${shell} ${perm} ${model}`);
      }
    }
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('the launch allows exactly the modes the runner carries over', async () => {
  const { CARRY_MODES } = await import('../phone-runner-core.mjs');
  const { PHONE_RESUME_MODES } = await import('../../shared/new-tab.js');
  assert.deepEqual([...PHONE_RESUME_MODES].sort(), [...CARRY_MODES].sort());
});

test('a cd hook cannot change the resume flags (Codex r27)', () => {
  const t = setup();
  try {
    // Every way a hook run by `cd` could reach the flags: a function named cd (bash and zsh) and zsh's chpwd.
    const evil = '__dobius_a=--dangerously-skip-permissions; __dobius_re=.; export __dobius_a; set -- phone x x x x x x bypassPermissions evil';
    for (const [shell, prelude] of [
      ['/bin/bash', `cd() { builtin cd "$@"; ${evil}; }; `],
      ['/bin/zsh', `cd() { builtin cd "$@"; ${evil}; }; `],
      ['/bin/zsh', `chpwd() { ${evil}; }; `],
    ]) {
      if (!fs.existsSync(shell)) continue;
      const spawn = loginShellSpawn(shell, null, null, null, null, { ...t.phone, permissionMode: 'plan', model: 'opus' });
      const script = prelude + spawn.args[3].replace(/exec '[^']*' -l$/, 'exit 0');
      const r = spawnSync(shell, ['-c', script], { cwd: t.dir, env: { ...t.base, ...spawn.env }, encoding: 'utf8', timeout: 10000, input: '' });
      assert.equal(lines(r)[1], `CLAUDE --resume ${SID} --permission-mode plan --model opus IN ${t.cwd}`, `${shell} ${prelude}`);
    }
  } finally { fs.rmSync(t.dir, { recursive: true, force: true }); }
});
