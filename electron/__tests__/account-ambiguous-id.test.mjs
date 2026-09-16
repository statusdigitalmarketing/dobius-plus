// Ambiguous account ids must never be acted on (v1.0.74).
// Run: DOBIUS_TEST_USERDATA=<dir> node --import ./electron/__tests__/register.mjs ./electron/__tests__/account-ambiguous-id.test.mjs
//
// config.json is hand-editable, so two rows CAN end up sharing an id. Every
// operation that resolves an account by id used to take the FIRST match:
// saveAccount would overwrite the wrong row, deleteAccount would remove BOTH,
// and activate would switch to a different account than the row clicked while
// the UI named the user's. They all refuse instead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-ambigid-'));
process.env.DOBIUS_TEST_USERDATA = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  accounts: [
    { id: 'dup', name: 'A', type: 'claude', claudeJsonPath: `${os.homedir()}/.claude-profiles/dup/.claude.json` },
    { id: 'dup', name: 'B', type: 'claude', claudeJsonPath: `${os.homedir()}/.claude-profiles/dup2/.claude.json` },
    { id: 'solo', name: 'C', type: 'claude', claudeJsonPath: `${os.homedir()}/.claude-profiles/solo/.claude.json` },
  ],
  activeClaudeAccountId: null,
}));

const cm = await import('../config-manager.js');

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

check('the seeded config loads', () => {
  assert.equal((cm.getAccounts() || []).length, 3);
});

check('deleteAccount REFUSES an ambiguous id and removes nothing', () => {
  const res = cm.deleteAccount('dup');
  assert.equal(res.ok, false);
  assert.match(res.error, /share the id/);
  assert.equal((cm.getAccounts() || []).filter((a) => a.id === 'dup').length, 2);
});

check('deleteAccount reports a missing id rather than silently succeeding', () => {
  assert.deepEqual(cm.deleteAccount('nope'), { ok: false, error: 'Account not found' });
});

check('saveAccount REFUSES an ambiguous id and writes nothing', () => {
  assert.equal(cm.saveAccount({ id: 'dup', name: 'HACK', type: 'claude' }), null);
  const names = (cm.getAccounts() || []).filter((a) => a.id === 'dup').map((a) => a.name).sort();
  assert.deepEqual(names, ['A', 'B'], 'neither duplicate row was overwritten');
});

check('a unique id still saves', () => {
  const saved = cm.saveAccount({ id: 'solo', name: 'C2', type: 'claude' });
  assert.ok(saved);
  assert.equal(saved.name, 'C2');
});

check('a unique id still deletes, and reports its side effects', () => {
  const res = cm.deleteAccount('solo');
  assert.equal(res.ok, true);
  assert.equal(res.name, 'C2');
  assert.equal(res.wasActive, false);
  assert.deepEqual(res.unassignedProjects, []);
  assert.equal((cm.getAccounts() || []).some((a) => a.id === 'solo'), false);
});

check('deleting the ACTIVE account reports wasActive and clears the pointer', () => {
  cm.saveAccount({ id: 'act', name: 'Active', type: 'claude' });
  const cfg = cm.loadConfig();
  cfg.activeClaudeAccountId = 'act';
  cm.saveConfig(cfg);
  const res = cm.deleteAccount('act');
  assert.equal(res.ok, true);
  assert.equal(res.wasActive, true);
  assert.equal(cm.loadConfig().activeClaudeAccountId, null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nALL PASS  (${pass} passed)`);
