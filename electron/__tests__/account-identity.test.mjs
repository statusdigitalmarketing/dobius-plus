// Account identity (v1.0.67). Asana 1218250019314695 "Switch doesnt actually
// siwtch": switching worked, but the list showed only a typed name, so two
// entries over ONE Claude login looked like a Switch that did nothing, and an
// account with no credential looked identical to a working one.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/account-identity.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  keychainServiceFor,
  claudeJsonCandidates,
  accountEmail,
  accountIdentities,
  loginState,
  defaultClaudeDir,
  effectiveDefaultDir,
  DEFAULT_LABEL,
} from '../account-identity.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-ident-'));
let pass = 0;
const results = [];
const check = async (label, fn) => { await fn(); pass += 1; results.push(label); console.log(`PASS  ${label}`); };

const mkProfile = (name, json) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (json !== undefined) {
    fs.writeFileSync(path.join(dir, '.claude.json'), typeof json === 'string' ? json : JSON.stringify(json));
  }
  return dir;
};

const acct = (id, name, dir, type = 'claude') => ({
  id, name, type, claudeJsonPath: path.join(dir, '.claude.json'),
});

const rowFor = (out, id) => out.accounts.filter(Boolean).find((r) => r.id === id);

// --- Where the metadata lives ------------------------------------------------

await check('.config.json outranks .claude.json, which is what Claude reads', () => {
  const dir = path.join(tmp, 'cand-a');
  assert.deepEqual(claudeJsonCandidates(dir), [
    path.join(dir, '.config.json'),
    path.join(dir, '.claude.json'),
  ]);
});

await check('a newer .config.json address wins over a stale .claude.json one', async () => {
  const dir = mkProfile('prec-a', { oauthAccount: { emailAddress: 'stale@example.com' } });
  fs.writeFileSync(path.join(dir, '.config.json'), JSON.stringify({ oauthAccount: { emailAddress: 'current@example.com' } }));
  assert.equal(await accountEmail(dir), 'current@example.com');
});

await check('an existing .config.json with no address means NO address', async () => {
  // Claude picks the metadata file by existence and reads only that one.
  // Falling through would surface an address out of a file Claude ignores, and
  // then group two rows as the same login on the strength of it.
  const dir = mkProfile('prec-b', { oauthAccount: { emailAddress: 'ignored@example.com' } });
  fs.writeFileSync(path.join(dir, '.config.json'), JSON.stringify({ somethingElse: 1 }));
  assert.equal(await accountEmail(dir), null);
});

await check('an unparseable .config.json does not fall back to .claude.json', async () => {
  const dir = mkProfile('prec-c', { oauthAccount: { emailAddress: 'ignored2@example.com' } });
  fs.writeFileSync(path.join(dir, '.config.json'), 'not json');
  assert.equal(await accountEmail(dir), null);
});

await check('an UNREADABLE .config.json does not fall through either', async () => {
  // stat succeeds, readFile throws EACCES. Advancing there leaked the stale
  // .claude.json address and invented a "same login as" grouping from it.
  const dir = mkProfile('prec-eacces', { oauthAccount: { emailAddress: 'leaked@example.com' } });
  const blocked = path.join(dir, '.config.json');
  fs.writeFileSync(blocked, JSON.stringify({ oauthAccount: { emailAddress: 'secret@example.com' } }));
  fs.chmodSync(blocked, 0o000);
  const got = await accountEmail(dir);
  fs.chmodSync(blocked, 0o600);
  assert.equal(got, null);
});

await check('a missing .config.json still falls through to .claude.json', async () => {
  const dir = mkProfile('prec-d', { oauthAccount: { emailAddress: 'used@example.com' } });
  assert.equal(await accountEmail(dir), 'used@example.com');
});

await check('with CLAUDE_CONFIG_DIR UNSET the home ~/.claude.json is consulted', () => {
  const cands = claudeJsonCandidates(defaultClaudeDir(), { envUnset: true });
  assert.ok(cands.includes(path.join(os.homedir(), '.claude.json')));
  assert.ok(cands.indexOf(path.join(os.homedir(), '.claude.json'))
    < cands.indexOf(path.join(defaultClaudeDir(), '.claude.json')));
});

await check('with CLAUDE_CONFIG_DIR SET to ~/.claude the home file is NOT used', () => {
  // Explicitly pointing at ~/.claude is an ordinary config dir, so Claude reads
  // ~/.claude/.claude.json. Keying this off the path alone read the wrong file.
  const cands = claudeJsonCandidates(defaultClaudeDir(), { envUnset: false });
  assert.ok(!cands.includes(path.join(os.homedir(), '.claude.json')));
  assert.deepEqual(cands, [
    path.join(defaultClaudeDir(), '.config.json'),
    path.join(defaultClaudeDir(), '.claude.json'),
  ]);
});

await check('a saved profile never consults the home file', () => {
  const dir = path.join(tmp, 'cand-profile');
  assert.deepEqual(claudeJsonCandidates(dir), [
    path.join(dir, '.config.json'),
    path.join(dir, '.claude.json'),
  ]);
});

// --- Keychain service naming -------------------------------------------------

await check('the default ~/.claude uses the bare service name', async () => {
  assert.equal(await keychainServiceFor(defaultClaudeDir()), 'Claude Code-credentials');
});

await check('a profile dir hashes the CONFIGURED path, not its realpath', async () => {
  // These differ for any temp dir on macOS, where /var is a symlink to
  // /private/var, which is precisely the case that separates the two rules.
  const dir = mkProfile('svc-a', { oauthAccount: { emailAddress: 'a@x.com' } });
  const configured = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
  assert.equal(keychainServiceFor(dir), `Claude Code-credentials-${configured}`);
  assert.notEqual(dir, fs.realpathSync(dir), 'this test is only meaningful when the two differ');
});

await check('a symlinked profile hashes the LINK path, which is what Claude reads', async () => {
  // Probing the target as well looked safer but reports a credential Claude
  // cannot use, because Claude only ever hashes the spelling it was given.
  const real = mkProfile('svc-real', { oauthAccount: { emailAddress: 'b@x.com' } });
  const link = path.join(tmp, 'svc-link');
  fs.symlinkSync(real, link);
  assert.notEqual(keychainServiceFor(link), keychainServiceFor(real));
});

await check('the service name is hashed from the NFC form of the path', async () => {
  // macOS hands back decomposed names; Claude normalises before hashing.
  const decomposed = path.join(tmp, 'cafe\u0301-dir');
  const composed = decomposed.normalize('NFC');
  assert.notEqual(decomposed, composed, 'this test needs the two forms to differ');
  assert.equal(keychainServiceFor(decomposed), keychainServiceFor(composed));
});

// --- Reading the login off a profile ----------------------------------------

await check('the login address is read from oauthAccount', async () => {
  const dir = mkProfile('read-ok', { oauthAccount: { emailAddress: 'sam@example.com' }, other: 1 });
  assert.equal(await accountEmail(dir), 'sam@example.com');
});

await check('a profile that was never logged into reads as null, not a crash', async () => {
  assert.equal(await accountEmail(mkProfile('read-nofile')), null);
});

await check('a .claude.json with no oauthAccount reads as null', async () => {
  assert.equal(await accountEmail(mkProfile('read-noacct', { projects: {} })), null);
});

await check('an unparseable .claude.json reads as null instead of throwing', async () => {
  assert.equal(await accountEmail(mkProfile('read-bad', '{not json')), null);
});

await check('a blank address is treated as no login', async () => {
  assert.equal(await accountEmail(mkProfile('read-blank', { oauthAccount: { emailAddress: '   ' } })), null);
});

await check('a FIFO at .claude.json returns rather than blocking forever', async () => {
  // A FIFO reports size 0, so it sails past a size check and then blocks the
  // read with no error to catch. The isFile() guard is what stops it.
  const dir = path.join(tmp, 'fifo-a');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('mkfifo', [path.join(dir, '.claude.json')]);
  const raced = await Promise.race([
    accountEmail(dir),
    new Promise((r) => setTimeout(() => r('TIMED_OUT'), 3000)),
  ]);
  assert.equal(raced, null, 'a FIFO must not hang the identity read');
});

// --- Credential presence -----------------------------------------------------

await check('a profile with no credential at all reports logged out', async () => {
  assert.equal(await loginState(mkProfile('kc-none', { oauthAccount: { emailAddress: 'c@x.com' } })), 'out');
});

await check('a .credentials.json holding a Claude login counts as logged IN', async () => {
  const dir = mkProfile('kc-file', { oauthAccount: { emailAddress: 'd@x.com' } });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
  assert.equal(await loginState(dir), 'in');
});

await check('a .credentials.json holding only MCP material does NOT count', async () => {
  // The same file carries MCP OAuth. Treating that as a Claude login
  // suppressed the warning on an account the CLI reports as logged out.
  const dir = mkProfile('kc-mcp', { oauthAccount: { emailAddress: 'e@x.com' } });
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ mcpOAuth: { some: 'token' } }));
  assert.equal(await loginState(dir), 'out');
});

await check('an unparseable .credentials.json does not count as a login', async () => {
  const dir = mkProfile('kc-bad', { oauthAccount: { emailAddress: 'f@x.com' } });
  fs.writeFileSync(path.join(dir, '.credentials.json'), 'not json');
  assert.equal(await loginState(dir), 'out');
});

await check('a .credentials.json DIRECTORY is not mistaken for a credential', async () => {
  const dir = mkProfile('kc-dir');
  fs.mkdirSync(path.join(dir, '.credentials.json'));
  assert.equal(await loginState(dir), 'out');
});

await check('loginState only ever returns one of the three documented states', async () => {
  assert.ok(['in', 'out', 'unknown'].includes(await loginState(mkProfile('kc-states'))));
});

// --- The case that made Switch look broken ----------------------------------

await check('two accounts on ONE login each name the other', async () => {
  const a = mkProfile('dup-a', { oauthAccount: { emailAddress: 'rich@example.com' } });
  const b = mkProfile('dup-b', { oauthAccount: { emailAddress: 'rich@example.com' } });
  const out = await accountIdentities([acct('id-a', 'Bryan', a), acct('id-b', 'Rich Wiggles', b)]);
  assert.deepEqual(rowFor(out, 'id-a').sameAs, ['Rich Wiggles']);
  assert.deepEqual(rowFor(out, 'id-b').sameAs, ['Bryan']);
  assert.equal(rowFor(out, 'id-a').email, 'rich@example.com');
});

await check('the same login in different case is still the same login', async () => {
  const a = mkProfile('case-a', { oauthAccount: { emailAddress: 'Rich@Example.com' } });
  const b = mkProfile('case-b', { oauthAccount: { emailAddress: 'rich@example.com' } });
  const out = await accountIdentities([acct('c-a', 'One', a), acct('c-b', 'Two', b)]);
  assert.deepEqual(rowFor(out, 'c-a').sameAs, ['Two']);
});

await check('distinct logins are never reported as duplicates', async () => {
  const a = mkProfile('sep-a', { oauthAccount: { emailAddress: 'one@example.com' } });
  const b = mkProfile('sep-b', { oauthAccount: { emailAddress: 'two@example.com' } });
  const out = await accountIdentities([acct('s-a', 'One', a), acct('s-b', 'Two', b)]);
  assert.deepEqual(rowFor(out, 's-a').sameAs, []);
  assert.deepEqual(rowFor(out, 's-b').sameAs, []);
});

await check('accounts with no login are not grouped together as duplicates', async () => {
  const out = await accountIdentities([acct('n-a', 'A', mkProfile('null-a')), acct('n-b', 'B', mkProfile('null-b'))]);
  assert.equal(rowFor(out, 'n-a').email, null);
  assert.deepEqual(rowFor(out, 'n-a').sameAs, []);
  assert.deepEqual(rowFor(out, 'n-b').sameAs, []);
});

await check('three entries on one login each name the other two', async () => {
  const dirs = ['tri-a', 'tri-b', 'tri-c'].map((n) => mkProfile(n, { oauthAccount: { emailAddress: 'tri@example.com' } }));
  const out = await accountIdentities(dirs.map((d, i) => acct(`t-${i}`, `T${i}`, d)));
  assert.deepEqual(rowFor(out, 't-0').sameAs.sort(), ['T1', 'T2']);
  assert.deepEqual(rowFor(out, 't-1').sameAs.sort(), ['T0', 'T2']);
});

await check('a nameless account falls back to its id rather than showing undefined', async () => {
  const a = mkProfile('anon-a', { oauthAccount: { emailAddress: 'anon@example.com' } });
  const b = mkProfile('anon-b', { oauthAccount: { emailAddress: 'anon@example.com' } });
  const out = await accountIdentities([acct('anon-1', '   ', a), acct('anon-2', 'Named', b)]);
  assert.deepEqual(rowFor(out, 'anon-2').sameAs, ['anon-1']);
});

// --- Ids are user-influenced -------------------------------------------------

await check('an account id of __proto__ produces a real row, not a mutated prototype', async () => {
  const d = mkProfile('proto-a', { oauthAccount: { emailAddress: 'proto@example.com' } });
  const out = await accountIdentities([acct('__proto__', 'Sneaky', d)]);
  const row = rowFor(out, '__proto__');
  assert.ok(row, 'the row must exist');
  assert.equal(row.email, 'proto@example.com');
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'result prototype must be untouched');
});

await check('an account id of __default__ cannot overwrite the default entry', async () => {
  const d = mkProfile('defkey-a', { oauthAccount: { emailAddress: 'notdefault@example.com' } });
  const out = await accountIdentities([acct('__default__', 'Impostor', d)]);
  assert.equal(out.default.label, DEFAULT_LABEL);
  assert.notEqual(out.default.email, 'notdefault@example.com');
  assert.equal(rowFor(out, '__default__').email, 'notdefault@example.com');
});

// --- Shape -------------------------------------------------------------------

await check('an inherited CLAUDE_CONFIG_DIR is what the Default row describes', async () => {
  // Default means "no per-account env", so the terminal inherits Dobius's own
  // CLAUDE_CONFIG_DIR. The row must describe that, not ~/.claude.
  const inherited = mkProfile('inherit-a', { oauthAccount: { emailAddress: 'inherited@example.com' } });
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = inherited;
  try {
    assert.equal(effectiveDefaultDir(), inherited);
    const out = await accountIdentities([]);
    assert.equal(out.default.email, 'inherited@example.com');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

await check('with no inherited env the default is the Mac\'s own ~/.claude', () => {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.equal(effectiveDefaultDir(), defaultClaudeDir());
  } finally {
    if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

await check('the default is always present so its login is visible too', async () => {
  const out = await accountIdentities([]);
  assert.ok(out.default);
  assert.equal(out.default.label, DEFAULT_LABEL);
  assert.ok(['in', 'out', 'unknown'].includes(out.default.login));
  assert.ok(Array.isArray(out.default.sameAs));
});

await check('codex accounts are skipped: they have no Claude login to report', async () => {
  const d = mkProfile('codex-a', { oauthAccount: { emailAddress: 'x@example.com' } });
  const out = await accountIdentities([acct('cx', 'Codex', d, 'codex')]);
  assert.equal(out.accounts[0], null);
});

await check('an account with no claudeJsonPath is skipped, not crashed on', async () => {
  const out = await accountIdentities([{ id: 'bare', name: 'Bare', type: 'claude' }]);
  assert.equal(out.accounts[0], null);
});

await check('a non-string claudeJsonPath cannot blank everyone else', async () => {
  // claudeJsonPath: 123 threw ERR_INVALID_ARG_TYPE inside path.dirname, which
  // rejected the whole call and wiped the default's identity too.
  const good = mkProfile('resil-a', { oauthAccount: { emailAddress: 'good@example.com' } });
  const out = await accountIdentities([
    { id: 'broken', name: 'Broken', type: 'claude', claudeJsonPath: 123 },
    acct('ok', 'Good', good),
  ]);
  assert.equal(out.accounts[0], null);
  assert.equal(rowFor(out, 'ok').email, 'good@example.com');
  assert.ok(out.default, 'the default must survive a malformed sibling');
});

await check('two rows sharing an id each keep their OWN login', async () => {
  // Deduping the id hid the second account; position keeps both truthful.
  const a = mkProfile('dupid-a', { oauthAccount: { emailAddress: 'alpha@example.com' } });
  const b = mkProfile('dupid-b', { oauthAccount: { emailAddress: 'beta@example.com' } });
  const out = await accountIdentities([acct('same-id', 'Alpha', a), acct('same-id', 'Beta', b)]);
  assert.equal(out.accounts.length, 2);
  assert.equal(out.accounts[0].email, 'alpha@example.com');
  assert.equal(out.accounts[1].email, 'beta@example.com');
});

await check('rows line up 1:1 with the input list, with null for skipped entries', async () => {
  const claudeDir = mkProfile('align-a', { oauthAccount: { emailAddress: 'align@example.com' } });
  const codexDir = mkProfile('align-b', { oauthAccount: { emailAddress: 'nope@example.com' } });
  const out = await accountIdentities([
    acct('cx', 'Codex', codexDir, 'codex'),
    acct('cl', 'Claude', claudeDir),
    { id: 'broken', name: 'Broken', type: 'claude', claudeJsonPath: 123 },
  ]);
  assert.equal(out.accounts.length, 3, 'one slot per input row');
  assert.equal(out.accounts[0], null, 'codex slot is null');
  assert.equal(out.accounts[1].email, 'align@example.com');
  assert.equal(out.accounts[2], null, 'unusable slot is null');
});

await check('a null accounts list yields just the default', async () => {
  const out = await accountIdentities(null);
  assert.deepEqual(out.accounts, []);
  assert.ok(out.default);
});

await check('every row carries all fields so the view never reads undefined', async () => {
  const d = mkProfile('shape-a', { oauthAccount: { emailAddress: 'shape@example.com' } });
  const out = await accountIdentities([acct('sh', 'Shape', d)]);
  for (const row of [out.default, ...out.accounts.filter(Boolean)]) {
    assert.ok('email' in row && 'login' in row && 'label' in row && Array.isArray(row.sameAs));
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nALL PASS  (${pass} passed)`);
