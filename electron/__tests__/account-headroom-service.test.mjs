// The panel figures, the move refusals and the history file
// (electron/account-headroom-service.js) against fake system deps, plus the tab
// pin at the spawn choke point and record pruning.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/account-headroom-service.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHeadroomService, draftOnScreen, writePrivateFileSync } from '../account-headroom-service.js';
import { keychainServiceFor } from '../account-identity.js';
import { resolveClaudeAccountPin } from '../spawn-account-env.js';
import { readUsageRecords } from '../claude-usage.js';

let pass = 0;
const check = async (label, fn) => { await fn(); pass += 1; console.log(`PASS  ${label}`); };

const TAB = 'term-/proj-1';
const HOMEC = path.join(os.homedir(), '.claude');
const DIR_A = '/profiles/a';
const DIR_B = '/profiles/b';
const KEY_A = keychainServiceFor(DIR_A);
const KEY_B = keychainServiceFor(DIR_B);
const T0 = 1_800_000_000_000;
const R5 = T0 / 1000 + 3 * 3600;
const R7 = T0 / 1000 + 4 * 86400;
const five = (p) => ({ five_hour: { usedPercentage: p, resetsAt: R5 } });
const acct = (id, dir, name = id.toUpperCase()) => ({ id, type: 'claude', name, claudeJsonPath: `${dir}/.claude.json` });

function world(over = {}) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-headroom-'));
  const w = {
    ud,
    now: T0,
    accounts: [acct('a', DIR_A), acct('b', DIR_B)],
    records: [
      { key: KEY_A, sessionId: 's-a', receivedAt: T0 - 30_000, windows: five(90) },
      { key: KEY_B, sessionId: 's-b', receivedAt: T0 - 60_000, windows: five(20) },
    ],
    emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', [HOMEC]: 'd@x.com' },
    logins: {},
    links: {}, // path -> where it really is
    missing: new Set(),
    unshared: new Set(),
    tabs: [{ id: TAB, claudeConfigDir: DIR_A }],
    claude: { pid: 100, sessionId: null, startedAt: T0 - 3600_000, soleChild: true },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }],
    presence: { sessionId: 'sess-now', status: 'idle' },
    resolved: null,
    box: '',
    inputSeq: 5,
    activity: null,
    held: false,
    ...over,
  };
  w.svc = createHeadroomService({
    userDataDir: ud,
    now: () => w.now,
    getAccounts: () => w.accounts,
    defaultDir: () => w.defaultDir || HOMEC,
    defaultEnvUnset: () => w.defaultEnvUnset ?? true,
    cliDefaultDir: () => HOMEC,
    keyFor: (dir) => keychainServiceFor(dir),
    login: async (dir) => w.logins[dir] || 'in',
    metadata: async (dir, opts) => {
      const e = w.metaByCall ? w.metaByCall(dir, opts) : w.emails[path.normalize(dir).replace(/\/$/, '')];
      return e === 'UNREADABLE' ? { state: 'unreadable', email: null } : (e ? { state: 'address', email: e } : { state: 'none', email: null });
    },
    realpath: async (p) => {
      if (w.links[p]) return w.links[p];
      const r = path.resolve(p);
      if (w.links[r]) return w.links[r];
      if (p.endsWith('.credentials.json')) {
        if (w.creds === 'none') throw new Error('ENOENT');
        return path.join(path.dirname(r), '.credentials.json');
      }
      if (w.missing.has(r)) throw new Error('ENOENT');
      return r;
    },
    sharesHistory: async (dir) => !w.unshared.has(dir),
    authOverride: () => w.authOverride || null,
    readRecords: async () => w.records,
    scan: async () => { if (w.scanThrows) throw new Error('scan'); return { groups: w.groups, unresolved: w.unresolved || [] }; },
    tabs: () => w.tabs,
    activity: () => w.activity,
    claudeInfo: async () => w.claude,
    presence: async () => w.presence,
    resolveSession: async () => w.resolved,
    process: async () => w.proc || null,
    processCwd: async () => '/proj/worktree',
    inputSeq: () => w.inputSeq,
    inputHeld: () => w.held,
    screen: async () => (w.noScreen ? null : { lines: [], modes: {} }),
    promptBox: () => w.box,
  });
  return w;
}
const target = (r, label) => r.targets.find((t) => t.label === label);

await check('the panel: live figures, stale ones, and Unknown (never 0%) for an account with no report', async () => {
  const w = world({ accounts: [acct('a', DIR_A), acct('b', DIR_B), acct('c', '/profiles/c')], emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', '/profiles/c': 'c@x.com' } });
  const r = await w.svc.usage();
  assert.equal(r.ok, true);
  const row = (l) => r.accounts.find((x) => x.label === l);
  assert.equal(row('A').usage.windows.five_hour.used, 90);
  assert.equal(row('A').sessionsRunning, 1);
  assert.equal(row('A').stale, false);
  assert.equal(row('B').stale, true, 'no session is refreshing it');
  assert.equal(row('C').usage.known, false);
  assert.equal(row('C').usage.windows.five_hour, undefined);
  assert.equal(row('C').usage.headroom, null);
});

await check('a failed process scan never reads as idle', async () => {
  const w = world({ scanThrows: true });
  const r = await w.svc.usage();
  assert.equal(r.scanFailed, true);
  assert.equal(r.accounts.find((x) => x.label === 'B').stale, false);
  assert.equal(r.accounts.find((x) => x.label === 'B').sessionsRunning, null);
});

await check('figures from an unlisted folder are not kept', async () => {
  const w = world();
  w.records = [...w.records, { key: keychainServiceFor('/elsewhere'), sessionId: 'x', receivedAt: T0, windows: five(5) }];
  await w.svc.tick();
  w.svc.flushSync();
  const saved = JSON.parse(fs.readFileSync(path.join(w.ud, 'usage-history.json'), 'utf8'));
  assert.equal(keychainServiceFor('/elsewhere') in saved.keys, false);
  assert.equal(KEY_A in saved.keys, true);
});

await check('a re-logged folder drops the old figures, and a running session republishing them is ignored', async () => {
  const w = world();
  await w.svc.usage();
  w.emails[DIR_B] = 'new@x.com';
  w.now += 60_000;
  w.records = [w.records[0], { ...w.records[1], receivedAt: w.now }]; // same figure, fresh file time
  let r = await w.svc.usage();
  assert.equal(r.accounts.find((x) => x.label === 'B').usage.known, false);
  w.records = [w.records[0], { ...w.records[1], receivedAt: w.now + 1000, windows: five(3) }];
  w.now += 2000;
  r = await w.svc.usage();
  assert.equal(r.accounts.find((x) => x.label === 'B').usage.windows.five_hour.used, 3);
});

await check('the dialog ranks by headroom and refuses the tab\'s own account, a same login and a logged-out one', async () => {
  const w = world({
    accounts: [acct('a', DIR_A), acct('b', DIR_B), acct('twin', '/profiles/twin', 'Twin'), acct('out', '/profiles/out', 'Out')],
    emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', [HOMEC]: 'd@x.com', '/profiles/twin': 'A@x.com', '/profiles/out': 'o@x.com' },
    logins: { '/profiles/out': 'out' },
  });
  const r = await w.svc.moveTargets(TAB);
  assert.equal(r.ok, true);
  assert.deepEqual(r.source, { label: 'A', email: 'a@x.com' });
  assert.equal(r.tab.session.sessionId, 'sess-now');
  assert.equal(r.tab.session.project, '/proj/worktree');
  assert.equal('key' in r.targets[0], false, 'no credential key leaves main');
  assert.equal(target(r, 'B').refusal, null);
  assert.match(target(r, 'A').refusal, /already on/);
  assert.match(target(r, 'Twin').refusal, /same login/);
  assert.match(target(r, 'Out').refusal, /not logged in/);
  assert.equal(target(r, 'Out').allRefusal, 'not logged in');
  assert.equal(target(r, 'B').allRefusal, null);
  assert.equal(target(r, 'A').allRefusal, null, 'Move all can consolidate onto the dialog tab\'s own account');
});

// Same folder, other spellings: Keychain hashes the spelling, the metadata
// belongs to the folder, so none of these can vouch for who the credential is.
for (const alias of ['/profiles/b/.', '/profiles/b/', '/profiles/./b', '/profiles/x/../b']) {
  await check(`an alias of a listed folder (${alias}) is refused both ways, whatever its address says`, async () => {
    const w = world({ accounts: [acct('a', DIR_A), acct('b', DIR_B), { id: 'alias', type: 'claude', name: 'Alias', claudeJsonPath: `${alias}${alias.endsWith('/') ? '' : '/'}.claude.json` }] });
    const r = await w.svc.moveTargets(TAB);
    // path.dirname drops a trailing slash, so that spelling is the same key and
    // the same row: nothing to tell apart.
    if (keychainServiceFor(path.dirname(`${alias}${alias.endsWith('/') ? '' : '/'}.claude.json`)) === KEY_B) {
      assert.equal(target(r, 'Alias').email, 'b@x.com');
      return;
    }
    assert.equal(target(r, 'Alias').email, null);
    assert.equal(target(r, 'B').email, null, 'the canonical spelling cannot vouch either, its metadata is shared');
    assert.match(target(r, 'Alias').refusal, /which login that account is/);
    assert.match(target(r, 'B').refusal, /which login that account is/);
    assert.match(target(r, 'Alias').allRefusal, /could not be told/);
  });
}

for (const alias of ['/profiles/b/.', '/profiles/b/', '/profiles/x/../b']) {
  await check(`Default spelled through an alias (CLAUDE_CONFIG_DIR=${alias}) is unknown even with nothing else listed`, async () => {
    const w = world({ accounts: [acct('a', DIR_A)], defaultDir: alias, defaultEnvUnset: false });
    const r = await w.svc.moveTargets(TAB);
    assert.equal(target(r, 'Default').email, null);
    assert.match(target(r, 'Default').refusal, /which login that account is/);
  });
}

await check('a tab running through an alias of the target has no nameable login, so the move is refused', async () => {
  const w = world({ groups: [{ key: keychainServiceFor('/profiles/b/.'), configDir: '/profiles/b/.', envUnset: false, pids: [100] }] });
  const r = await w.svc.moveTargets(TAB);
  assert.equal(r.source.email, null);
  assert.match(target(r, 'B').refusal, /which login this tab is on/);
});

await check('a symlinked profile folder, or a credential file linked out of it, is unknown', async () => {
  let w = world({ links: { [DIR_B]: '/profiles/real-b' } });
  assert.match(target(await w.svc.moveTargets(TAB), 'B').refusal, /which login that account is/);
  w = world({ links: { [`${DIR_B}/.credentials.json`]: '/profiles/a/.credentials.json' } });
  assert.match(target(await w.svc.moveTargets(TAB), 'B').refusal, /which login that account is/);
});

await check('the two default metadata files disagreeing, or one unreadable, makes Default unknown', async () => {
  const meta = (inner) => (dir, opts) => (dir === HOMEC ? (opts.envUnset ? 'd@x.com' : inner) : { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com' }[dir]);
  let w = world({ metaByCall: meta('other@x.com') });
  assert.equal(target(await w.svc.moveTargets(TAB), 'Default').email, null);
  w = world({ metaByCall: meta('UNREADABLE') });
  assert.equal(target(await w.svc.moveTargets(TAB), 'Default').email, null);
  w = world({ metaByCall: meta('D@x.com') });
  assert.equal(target(await w.svc.moveTargets(TAB), 'Default').refusal, null);
});

await check('figures are not kept while a login is unknown, and are cleared when it becomes so', async () => {
  const w = world();
  await w.svc.usage();
  w.links[DIR_B] = '/profiles/real-b';
  w.now += 1000;
  w.records = [w.records[0], { ...w.records[1], receivedAt: w.now, windows: five(40) }];
  const r = await w.svc.usage();
  assert.equal(r.accounts.find((x) => x.label === 'B').usage.known, false);
});

await check('a tab on a folder that is not a listed account has no nameable source', async () => {
  const w = world({ groups: [{ key: keychainServiceFor('/elsewhere'), configDir: '/elsewhere', envUnset: false, pids: [100] }] });
  const r = await w.svc.moveTargets(TAB);
  assert.equal(r.source.email, null);
  assert.match(target(r, 'B').refusal, /which login this tab is on/);
});

await check('a Claude the process scan cannot place has no nameable source', async () => {
  const w = world({ groups: [] });
  const r = await w.svc.moveTargets(TAB);
  assert.equal(r.source.email, null);
  assert.match(target(r, 'B').refusal, /which login this tab is on/);
});

await check('a target whose conversations are not the shared store, or an auth override, is refused', async () => {
  let w = world({ unshared: new Set([DIR_B]) });
  assert.match(target(await w.svc.moveTargets(TAB), 'B').refusal, /not linked/);
  w = world({ authOverride: 'ANTHROPIC_API_KEY' });
  const r = await w.svc.moveTargets(TAB);
  assert.match(target(r, 'B').refusal, /ANTHROPIC_API_KEY is set/);
  assert.match(target(r, 'B').allRefusal, /ANTHROPIC_API_KEY is set/);
});

await check('one login under two folders shows one set of figures', async () => {
  const w = world({
    accounts: [acct('a', DIR_A), acct('b', DIR_B), acct('twin', '/profiles/twin', 'Twin')],
    emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', '/profiles/twin': 'b@x.com' },
    records: [
      { key: keychainServiceFor('/profiles/twin'), sessionId: 't', receivedAt: T0 - 1000, windows: five(77) },
      { key: KEY_B, sessionId: 's-b', receivedAt: T0 - 60_000, windows: five(20) },
    ],
  });
  const r = await w.svc.usage();
  const row = r.accounts.find((x) => x.label === 'B');
  assert.equal(row.usage.windows.five_hour.used, 77);
  assert.deepEqual(row.sameAs, ['Twin']);
});

await check('Move all judges each tab: busy, draft, another program, no Claude', async () => {
  const w = world();
  const one = async (over) => {
    Object.assign(w, { activity: null, box: '', claude: { pid: 100, sessionId: null, startedAt: T0, soleChild: true }, presence: { sessionId: 'sess-now', status: 'idle' }, held: false, proc: null }, over);
    const [c] = await w.svc.moveCandidates([TAB], 'b');
    return c;
  };
  let c = await one({});
  assert.equal(c.busy, false);
  assert.equal(c.draft, false);
  assert.equal(c.running, 'claude');
  assert.equal(c.session.sessionId, 'sess-now');
  assert.equal(c.inputSeq, 5);
  assert.equal(c.refusal, null);
  assert.equal(c.pid, undefined, 'no pid leaves main');
  assert.equal((await one({ presence: { sessionId: 'sess-now', status: 'busy' } })).busy, true);
  assert.equal((await one({ activity: { status: 'needs', lastActivityAt: 0 } })).busy, true);
  assert.equal((await one({ box: 'half a thought' })).draft, true);
  assert.equal((await one({ box: null })).draft, true, 'a box that cannot be read might hold text');
  assert.equal((await one({ held: true })).draft, true);
  assert.equal((await one({ claude: { pid: 100, sessionId: null, startedAt: T0, soleChild: false } })).running, 'other');
  c = await one({ claude: null, proc: 'vim' });
  assert.equal(c.running, 'other');
  c = await one({ claude: null, proc: null });
  assert.equal(c.running, 'shell');
  assert.equal(c.draft, false);
  assert.match((await w.svc.moveCandidates([TAB], 'gone'))[0].refusal, /no longer exists/);
});

await check('the conversation comes from Claude\'s own record first, then the resolver', async () => {
  const w = world({ presence: { sessionId: 'on-now', status: 'idle' }, resolved: { sessionId: 'stale-argv', sessionProject: '/p' } });
  assert.equal((await w.svc.moveCandidates([TAB], 'b'))[0].session.sessionId, 'on-now');
  w.presence = null;
  assert.equal((await w.svc.moveCandidates([TAB], 'b'))[0].session.sessionId, 'stale-argv');
  w.resolved = null;
  assert.equal((await w.svc.moveCandidates([TAB], 'b'))[0].session, null);
});

await check('draftOnScreen: only an empty readable box is no draft', async () => {
  assert.equal(draftOnScreen(''), false);
  assert.equal(draftOnScreen('  '), false);
  assert.equal(draftOnScreen('x'), true);
  assert.equal(draftOnScreen(null), true);
});

// ---- the history file ----

await check('a symlink planted at the temp path is not written through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-hist-'));
  const cred = path.join(dir, 'credential');
  fs.writeFileSync(cred, 'SECRET');
  const final = path.join(dir, 'h.json');
  fs.symlinkSync(cred, `${final}.tmp.${process.pid}.fixed`);
  assert.throws(() => writePrivateFileSync(final, '{}', 'fixed'), /EEXIST|ELOOP/);
  assert.equal(fs.readFileSync(cred, 'utf8'), 'SECRET');
  assert.equal(fs.existsSync(final), false);
});

await check('a symlink at the final path is replaced, never followed, and the file is 0600', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-hist-'));
  const cred = path.join(dir, 'credential');
  fs.writeFileSync(cred, 'SECRET');
  const final = path.join(dir, 'h.json');
  fs.symlinkSync(cred, final);
  writePrivateFileSync(final, '{"v":1}');
  assert.equal(fs.readFileSync(cred, 'utf8'), 'SECRET');
  assert.equal(fs.lstatSync(final).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(final, 'utf8'), '{"v":1}');
  assert.equal(fs.lstatSync(final).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp.')), [], 'no temp left behind');
});

await check('a folder that is a link is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-hist-'));
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(dir, 'linked'));
  assert.throws(() => writePrivateFileSync(path.join(dir, 'linked', 'h.json'), '{}'), /link/);
  assert.deepEqual(fs.readdirSync(real), []);
});

await check('the service never follows a link at the history path, reading or quitting', async () => {
  const w = world();
  const cred = path.join(w.ud, 'credential');
  fs.writeFileSync(cred, JSON.stringify({ v: 1, keys: { [KEY_A]: { email: 'a@x.com', windows: { five_hour: { r: R7, seenAt: T0, samples: [{ t: T0, p: 99 }] } } } } }));
  const before = fs.readFileSync(cred, 'utf8');
  const hp = path.join(w.ud, 'usage-history.json');
  fs.symlinkSync(cred, hp);
  w.records = [];
  const r = await w.svc.usage();
  assert.equal(r.accounts.find((x) => x.label === 'A').usage.known, false, 'its contents were not loaded');
  w.svc.flushSync();
  assert.equal(fs.readFileSync(cred, 'utf8'), before);
  assert.equal(fs.lstatSync(hp).isSymbolicLink(), false);
});

await check('history survives a restart', async () => {
  const w = world();
  await w.svc.usage();
  w.svc.flushSync();
  const w2 = world({ records: [] });
  fs.copyFileSync(path.join(w.ud, 'usage-history.json'), path.join(w2.ud, 'usage-history.json'));
  const r = await w2.svc.usage();
  assert.equal(r.accounts.find((x) => x.label === 'A').usage.windows.five_hour.used, 90);
});

// ---- pin at the spawn choke point ----

await check('a tab pin names exactly one Claude account, or Default, or nothing', async () => {
  const accts = [
    { id: 'a', type: 'claude', claudeJsonPath: '/p/a/.claude.json' },
    { id: 'dup', type: 'claude', claudeJsonPath: '/p/1/.claude.json' },
    { id: 'dup', type: 'claude', claudeJsonPath: '/p/2/.claude.json' },
    { id: 'c', type: 'codex' },
  ];
  assert.equal(resolveClaudeAccountPin({ id: 'a' }, accts).id, 'a');
  assert.equal(resolveClaudeAccountPin({ id: null }, accts), null);
  assert.equal(resolveClaudeAccountPin({ id: 'dup' }, accts), undefined);
  assert.equal(resolveClaudeAccountPin({ id: 'c' }, accts), undefined);
  assert.equal(resolveClaudeAccountPin({ id: '/etc' }, accts), undefined);
  assert.equal(resolveClaudeAccountPin(undefined, accts), undefined);
  assert.equal(resolveClaudeAccountPin({}, accts), undefined);
});

// ---- records ----

await check('records older than the longest window are not read', async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-records-'));
  const dir = path.join(ud, 'usage');
  fs.mkdirSync(dir);
  const old = (Date.now() - 10 * 86400_000) / 1000;
  for (const n of ['old', 'fresh']) fs.writeFileSync(path.join(dir, `${n}.json`), `DOBIUS1 1\n/d\n${JSON.stringify({ session_id: n })}`);
  fs.utimesSync(path.join(dir, 'old.json'), old, old);
  assert.deepEqual((await readUsageRecords(ud, 8 * 86400_000)).map((r) => r.sessionId), ['fresh']);
  assert.equal((await readUsageRecords(ud)).length, 2);
});

console.log(`\n${pass} passed`);
