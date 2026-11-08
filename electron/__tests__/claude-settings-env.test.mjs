// Shared keys from Claude's settings.json env (claude-settings-env.js).
// Run: node ./electron/__tests__/claude-settings-env.test.mjs
import assert from 'node:assert/strict';
import { setClaudeSettingsReader, claudeSettingsEnv, sharedKeyEnv, sharedKeyStatus, sharedKeyError, asanaToken, asanaTokenWithSource } from '../claude-settings-env.js';

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

check('before main registers a reader: unreadable (null), not "no keys"', () => {
  assert.equal(claudeSettingsEnv('ASANA_PAT'), null);
  assert.equal(sharedKeyEnv(), null);
});

let settings = { env: { ASANA_PAT: '  2/abc123456  ', FIREFLIES_API_KEY: '', OTHER: 'x' } };
setClaudeSettingsReader(() => settings);

check('reads and trims a set key; empty counts as unset', () => {
  assert.equal(claudeSettingsEnv('ASANA_PAT'), '2/abc123456');
  assert.equal(claudeSettingsEnv('FIREFLIES_API_KEY'), null);
});
check('only the two shared keys, never anything else in env', () => {
  assert.equal(claudeSettingsEnv('OTHER'), null);
  assert.deepEqual(sharedKeyEnv(), { ASANA_PAT: '2/abc123456' });
});
check('status carries only set and the last four', () => {
  assert.deepEqual(sharedKeyStatus('ASANA_PAT'), { set: true, hint: '3456' });
  assert.deepEqual(sharedKeyStatus('FIREFLIES_API_KEY'), { set: false, hint: null });
});
check('absent file or no env block: readable, no keys ({}), so inherited copies are dropped', () => {
  settings = {};
  assert.deepEqual(sharedKeyEnv(), {});
  settings = { env: { ASANA_PAT: 12345 } };
  assert.deepEqual(sharedKeyEnv(), {});
});
check('unparseable settings or a throwing reader: unreadable (null), inherited copies stay', () => {
  settings = null;
  assert.equal(sharedKeyEnv(), null);
  setClaudeSettingsReader(() => { throw new Error('boom'); });
  assert.equal(sharedKeyEnv(), null);
  assert.equal(claudeSettingsEnv('ASANA_PAT'), null);
});
check('Asana token: the shared spot decides while readable, else the old order', () => {
  const before = process.env.ASANA_PAT;
  process.env.ASANA_PAT = 'from-launch-env';
  try {
    setClaudeSettingsReader(() => ({ env: { ASANA_PAT: 'shared-pat-123' } }));
    assert.equal(asanaToken('legacy-pat'), 'shared-pat-123');
    setClaudeSettingsReader(() => ({ env: {} }));
    assert.equal(asanaToken('legacy-pat'), 'legacy-pat', 'an older Dobius-only PAT still counts');
    assert.equal(asanaToken(''), null, 'readable and removed: the launch env does not sneak back');
    setClaudeSettingsReader(() => null);
    assert.equal(asanaToken('legacy-pat'), 'legacy-pat', 'unreadable: the saved Dobius PAT before the launch env, as Tasks sync did');
    assert.equal(asanaToken(''), 'from-launch-env', 'unreadable and nothing saved: the launch env');
  } finally {
    if (before === undefined) delete process.env.ASANA_PAT; else process.env.ASANA_PAT = before;
  }
});
check('save validation: allowlisted names, empty removes, no whitespace or quotes', () => {
  assert.equal(sharedKeyError('PATH', 'abcdefghij'), 'Unknown key.');
  assert.equal(sharedKeyError('ASANA_PAT', ''), '');
  assert.equal(sharedKeyError('ASANA_PAT', '   '), '');
  assert.equal(sharedKeyError('FIREFLIES_API_KEY', 'short'), 'That does not look like a valid key.');
  assert.equal(sharedKeyError('FIREFLIES_API_KEY', 'has space 123456'), 'That does not look like a valid key.');
  assert.equal(sharedKeyError('FIREFLIES_API_KEY', 'quote"1234567'), 'That does not look like a valid key.');
  assert.equal(sharedKeyError('FIREFLIES_API_KEY', ' ff_good_key_12345 '), '');
  assert.equal(sharedKeyError('ASANA_PAT', 42), 'Not a key.');
});

check('the Asana key says where it came from (so a refused one can be named)', () => {
  const before = process.env.ASANA_PAT;
  process.env.ASANA_PAT = 'from-launch-env';
  try {
    setClaudeSettingsReader(() => ({ env: { ASANA_PAT: 'shared-pat-123' } }));
    assert.deepEqual(asanaTokenWithSource('legacy-pat'), { token: 'shared-pat-123', source: 'settings' });
    setClaudeSettingsReader(() => ({ env: {} }));
    assert.deepEqual(asanaTokenWithSource('legacy-pat'), { token: 'legacy-pat', source: 'dobius' });
    assert.deepEqual(asanaTokenWithSource(''), { token: null, source: null });
    setClaudeSettingsReader(() => null);
    assert.deepEqual(asanaTokenWithSource(''), { token: 'from-launch-env', source: 'env' });
  } finally {
    if (before === undefined) delete process.env.ASANA_PAT; else process.env.ASANA_PAT = before;
  }
});

console.log(`\nALL PASS  (${pass} passed)`);
