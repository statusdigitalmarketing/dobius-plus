// Phone mode's main-side rules: when it is on, which account a restarted tab keeps, the pressure reading, and which
// session ids count as the tab's own Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneModeOn, pinForBinding, pressureLevel, tuiSessionIdsOf } from '../phone-main.js';

test('on only on macOS with the setting exactly true', () => {
  assert.equal(phoneModeOn({ phoneMode: true }, 'darwin'), true);
  assert.equal(phoneModeOn({ phoneMode: true }, 'win32'), false);
  assert.equal(phoneModeOn({ phoneMode: 'true' }, 'darwin'), false);
  assert.equal(phoneModeOn({}, 'darwin'), false);
  assert.equal(phoneModeOn(null, 'darwin'), false);
});

test('a restarted tab keeps its account: default, the one match, or refused', () => {
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
  assert.deepEqual(pinForBinding('', accounts, envFor), { id: null });
  assert.deepEqual(pinForBinding('/p/acct-a', accounts, envFor), { id: 'a' }, 'codex rows never match');
  assert.deepEqual(pinForBinding('/p/acct-b', accounts, envFor), { id: 'b' }, 'a trailing slash is the same folder');
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
