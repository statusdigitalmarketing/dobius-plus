// Phone mode's main-side rules: when it is on, which account a restarted tab keeps, the pressure reading, and which
// session ids count as the tab's own Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phoneModeOn, pinForBinding, pressureLevel, tuiSessionIdsOf, accountProblem, createPhoneMain } from '../phone-main.js';

test('on only on macOS with the setting exactly true', () => {
  assert.equal(phoneModeOn({ phoneMode: true }, 'darwin'), true);
  assert.equal(phoneModeOn({ phoneMode: true }, 'win32'), false);
  assert.equal(phoneModeOn({ phoneMode: 'true' }, 'darwin'), false);
  assert.equal(phoneModeOn({}, 'darwin'), false);
  assert.equal(phoneModeOn(null, 'darwin'), false);
});

test('a restarted tab keeps its account: default, the one exact match, or refused', () => {
  const envFor = (a) => ({ CLAUDE_CONFIG_DIR: a.dir });
  const accounts = [
    { type: 'claude', id: 'a', dir: '/p/acct-a' },
    { type: 'claude', id: 'b', dir: '/p/acct-b/' },
    { type: 'codex', id: 'c', dir: '/p/acct-a' },
    { type: 'claude', id: 'd1', dir: '/p/twin' },
    { type: 'claude', id: 'd2', dir: '/p/twin' },
    { type: 'claude', id: '', dir: '/p/noid' },
  ];
  assert.deepEqual(pinForBinding(null, accounts, envFor), { id: null });
  assert.deepEqual(pinForBinding(undefined, accounts, envFor), { id: null });
  assert.equal(pinForBinding('', accounts, envFor), undefined, 'an empty folder is not the default login');
  assert.deepEqual(pinForBinding('/p/acct-a', accounts, envFor), { id: 'a' }, 'codex rows never match');
  assert.deepEqual(pinForBinding('/p/acct-b/', accounts, envFor), { id: 'b' });
  assert.equal(pinForBinding('/p/acct-b', accounts, envFor), undefined, 'another spelling is another Keychain login (Codex impl r15)');
  assert.equal(pinForBinding('/p/acct-a/', accounts, envFor), undefined);
  assert.equal(pinForBinding('/p/twin', accounts, envFor), undefined, 'two accounts on one folder: refused');
  assert.equal(pinForBinding('/p/noid', accounts, envFor), undefined, 'an account without an id is not usable');
  assert.equal(pinForBinding('/p/elsewhere', accounts, envFor), undefined);
  assert.equal(pinForBinding('/p/acct-a', [{ type: 'claude', id: 'x' }], () => { throw new Error('bad'); }), undefined);
});

test('pressure level parses sysctl output and nothing else', () => {
  assert.equal(pressureLevel('1\n'), 1);
  assert.equal(pressureLevel(' 4 '), 4);
  assert.equal(pressureLevel(''), null);
  assert.equal(pressureLevel('abc'), null);
  assert.equal(pressureLevel(undefined), null);
});

test("the tab's own Claude: its record's session first, then the argv's, no blanks or repeats", () => {
  const S = '0b5c2a6e-1111-4222-8333-444455556666';
  const T = '1b5c2a6e-1111-4222-8333-444455556666';
  assert.deepEqual(tuiSessionIdsOf({ sessionId: S }, { sessionId: T }), [T, S]);
  assert.deepEqual(tuiSessionIdsOf({ sessionId: S }, { sessionId: S }), [S]);
  assert.deepEqual(tuiSessionIdsOf({ sessionId: null }, null), []);
  assert.deepEqual(tuiSessionIdsOf({ sessionId: S }, { sessionId: '' }), [S]);
});

test("the account check: the running Claude's binding must be the tab's, spelled the same (Codex impl r15)", () => {
  const envFor = (a) => ({ CLAUDE_CONFIG_DIR: a.dir });
  const accounts = [{ type: 'claude', id: 'a', dir: '/p/a' }, { type: 'claude', id: 'b', dir: '/p/b' }];
  assert.equal(accountProblem({ pid: 9, dir: '/p/a' }, 9, '/p/a', accounts, envFor), null);
  assert.equal(accountProblem({ pid: 9, dir: null }, 9, null, accounts, envFor), null, 'the default login');
  assert.match(accountProblem({ pid: 9, dir: '/p/b' }, 9, '/p/a', accounts, envFor), /another account/);
  assert.match(accountProblem({ pid: 9, dir: '/p/a/' }, 9, '/p/a', accounts, envFor), /another account/);
  assert.match(accountProblem({ pid: 9, dir: null }, 9, '/p/a', accounts, envFor), /another account/);
  assert.match(accountProblem({ pid: 8, dir: '/p/a' }, 9, '/p/a', accounts, envFor), /could not be read/, 'seen on another pid');
  assert.match(accountProblem(undefined, 9, '/p/a', accounts, envFor), /could not be read/);
  assert.match(accountProblem({ pid: 9, dir: '/p/a' }, 9, undefined, accounts, envFor), /another account/, 'the tab is gone');
  assert.match(accountProblem({ pid: 9, dir: '/p/c' }, 9, '/p/c', accounts, envFor), /matched/);
});

test('take refuses a Claude started by hand on another account, before stopping anything (Codex impl r15)', async () => {
  const base = Buffer.byteLength(os.tmpdir()) > 40 ? '/tmp' : os.tmpdir();
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(base, 'pmm-')));
  const S = '0b5c2a6e-1111-4222-8333-444455556666';
  const calls = { stop: 0, spawn: 0 };
  const accounts = [{ type: 'claude', id: 'a', dir: '/p/a' }, { type: 'claude', id: 'b', dir: '/p/b' }];
  const make = (scanDir) => createPhoneMain({
    userData, exe: '/x/Dobius+', runnerPath: '/x/phone-runner.mjs', log: () => {},
    settings: () => ({ phoneMode: true }), accounts: () => accounts, envFor: (a) => ({ CLAUDE_CONFIG_DIR: a.dir }),
    tabs: () => [{ id: 'T1', pid: process.ppid, cwd: userData, claudeConfigDir: '/p/a' }],
    inputSeq: () => 1, inputHeld: () => false, activity: () => ({ status: 'done' }),
    screen: async () => ({ lines: [], modes: {} }), promptBox: () => '',
    // The test process stands in for the tab's Claude: a real pid with a real start time.
    claudeInfo: async () => ({ pid: process.pid, soleChild: true }),
    scan: async () => ({ groups: [{ configDir: scanDir, envUnset: false, pids: [process.pid] }] }),
    presence: async () => ({ sessionId: S, status: 'idle' }), hasTranscript: async () => true,
    processCwd: async () => userData, isDir: () => true,
    stop: () => { calls.stop += 1; }, alive: () => false, sleep: async () => {},
    ownerOf: () => ({ id: 1 }), movable: () => null,
    spawn: (_t, _c, _s, pin) => { calls.spawn += 1; calls.pin = pin; return true; }, notify: () => {},
  });
  const pm = make('/p/b');
  try {
    await pm.init();
    const r = await pm.take('T1', { sessionId: S, gen: pm.gen('T1') });
    assert.equal(r.code, 'cannot', JSON.stringify(r));
    assert.match(r.error, /another account/);
    assert.deepEqual(calls, { stop: 0, spawn: 0 });
  } finally { await pm.close(); }
  // The same account, spelled the same: moved, and restarted on that account.
  const ok = make('/p/a');
  try {
    await ok.init();
    const r = await ok.take('T1', { sessionId: S, gen: ok.gen('T1') });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(calls, { stop: 1, spawn: 1, pin: { id: 'a' } });
  } finally {
    await ok.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
