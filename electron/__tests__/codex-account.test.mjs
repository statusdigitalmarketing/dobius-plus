// Codex login accounts (v1.0.72): env resolution + identity + share safety.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/codex-account.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexEnvForAccount, codexHomeForAccount, SHARED_CODEX_ENTRIES, NEVER_SHARE_CODEX, shareCodexProfile } from '../codex-account-env.js';
import { codexIdentityFor } from '../codex-account-identity.js';

let pass = 0;
const check = async (label, fn) => { await fn(); pass += 1; console.log(`PASS  ${label}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-codex-'));

await check('a chatgpt account resolves CODEX_HOME and signals OPENAI_API_KEY deletion', () => {
  const env = codexEnvForAccount({ type: 'codex', authMode: 'chatgpt', codexHome: '/x/.codex-profiles/acct-1' });
  assert.equal(env.CODEX_HOME, '/x/.codex-profiles/acct-1');
  // undefined value = deletion signal to createTerminal, so an inherited key
  // cannot override the ChatGPT login.
  assert.ok('OPENAI_API_KEY' in env);
  assert.equal(env.OPENAI_API_KEY, undefined);
});
await check('an apikey account resolves OPENAI_API_KEY and no CODEX_HOME', () => {
  const env = codexEnvForAccount({ type: 'codex', authMode: 'apikey', apiKey: 'sk-xxx' });
  assert.deepEqual(env, { OPENAI_API_KEY: 'sk-xxx' });
});
await check('a legacy codex account (apiKey, no authMode) still gets OPENAI_API_KEY', () => {
  assert.deepEqual(codexEnvForAccount({ type: 'codex', apiKey: 'sk-legacy' }), { OPENAI_API_KEY: 'sk-legacy' });
});
await check('a claude account contributes no codex env', () => {
  assert.deepEqual(codexEnvForAccount({ type: 'claude', claudeJsonPath: '/x' }), {});
  assert.deepEqual(codexEnvForAccount(null), {});
});
await check('a chatgpt account with no home yields no env (not a broken CODEX_HOME)', () => {
  assert.deepEqual(codexEnvForAccount({ type: 'codex', authMode: 'chatgpt' }), {});
  assert.equal(codexHomeForAccount({ type: 'codex', authMode: 'chatgpt', codexHome: '  ' }), null);
});
await check('a tilde codexHome is expanded', () => {
  const env = codexEnvForAccount({ type: 'codex', authMode: 'chatgpt', codexHome: '~/.codex-profiles/a' });
  assert.equal(env.CODEX_HOME, path.join(os.homedir(), '.codex-profiles', 'a'));
});

await check('auth.json is NEVER in the shared entries (it is the login)', () => {
  assert.ok(NEVER_SHARE_CODEX.has('auth.json'));
  assert.ok(!SHARED_CODEX_ENTRIES.includes('auth.json'));
});
await check('no sqlite DB is shared (WAL anchors to the target dir)', () => {
  assert.ok(!SHARED_CODEX_ENTRIES.some((e) => e.includes('.sqlite')));
  assert.ok(!SHARED_CODEX_ENTRIES.includes('installation_id'));
});
await check('sessions + config + history ARE shared (the point of sharing)', () => {
  for (const e of ['sessions', 'config.toml', 'history.jsonl', 'session_index.jsonl']) assert.ok(SHARED_CODEX_ENTRIES.includes(e));
});

await check('shareCodexProfile symlinks shared entries and leaves auth.json alone', () => {
  const home = path.join(tmp, '.codex'); const prof = path.join(tmp, '.codex-profiles', 'acct-1');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, 'history.jsonl'), 'h');
  fs.writeFileSync(path.join(home, 'config.toml'), 'c');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'auth.json'), '{"tokens":{}}'); // the profile's own login
  shareCodexProfile(prof, { defaultDir: home, profilesRoot: path.join(tmp, '.codex-profiles') });
  assert.equal(fs.readlinkSync(path.join(prof, 'sessions')), path.join(home, 'sessions'));
  assert.equal(fs.readlinkSync(path.join(prof, 'config.toml')), path.join(home, 'config.toml'));
  assert.ok(!fs.lstatSync(path.join(prof, 'auth.json')).isSymbolicLink(), 'auth.json stays the profile\'s own file');
  assert.equal(fs.readFileSync(path.join(prof, 'auth.json'), 'utf8'), '{"tokens":{}}');
});

await check('codexIdentityFor reads email+plan from an id_token, login=in', async () => {
  const home = path.join(tmp, 'idhome'); fs.mkdirSync(home, { recursive: true });
  const payload = Buffer.from(JSON.stringify({ email: 'x@y.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'max' } })).toString('base64url');
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }));
  const id = await codexIdentityFor(home);
  assert.equal(id.email, 'x@y.com'); assert.equal(id.plan, 'max'); assert.equal(id.login, 'in');
});
await check('codexIdentityFor: no auth.json = logged out, unreadable = unknown', async () => {
  assert.equal((await codexIdentityFor(path.join(tmp, 'nope'))).login, 'out');
  const bad = path.join(tmp, 'bad'); fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'auth.json'), 'not json');
  assert.equal((await codexIdentityFor(bad)).login, 'unknown');
});
await check('codexIdentityFor: apikey-only auth.json counts as logged in', async () => {
  const home = path.join(tmp, 'apik'); fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));
  assert.equal((await codexIdentityFor(home)).login, 'in');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nALL PASS  (${pass} passed)`);
