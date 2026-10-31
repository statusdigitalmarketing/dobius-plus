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
import { renderScreenLines } from '../screen-render.js';
import { promptBoxText } from '../bridge-open-tab.js';

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
    tabs: [{ id: TAB, cwd: '/proj', claudeConfigDir: DIR_A }],
    events: [],
    claude: { pid: 100, sessionId: null, startedAt: T0 - 3600_000, soleChild: true },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }],
    presence: { sessionId: 'sess-now', status: 'idle' },
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
      if (/\/\.(credentials|config|claude)\.json$/.test(p)) return r;
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
    stop: (pid) => { w.events.push(`stop ${pid}`); w.onStop?.(); if (w.stopThrows) throw w.stopThrows; },
    alive: () => w.stillAlive === true,
    claim: async (sid) => { w.events.push(`claim ${sid}`); return w.claimOk !== false; },
    sleep: async (ms) => { w.now += ms; w.onSleep?.(); },
    processAuthOverride: async () => w.override || null,
    isDir: (p) => p !== w.goneDir,
    process: async () => w.proc || null,
    processCwd: async () => w.cwd === undefined ? '/proj/worktree' : w.cwd,
    inputSeq: () => w.inputSeq,
    inputHeld: () => w.held,
    screen: async () => { w.onScreen?.(); return w.noScreen ? null : { lines: [], modes: {} }; },
    promptBox: () => w.box,
  });
  return w;
}
const target = (r, label) => r.targets.find((t) => t.label === label);

// First sight of a folder sets its boundary, so a world's records count once
// they are refreshed after that.
const settled = async (w) => {
  await w.svc.tick();
  w.now += 1000;
  w.records = w.records.map((r) => ({ ...r, receivedAt: r.receivedAt + 60_000 + 1000 }));
};

await check('records already on disk when a folder is first seen count only once refreshed', async () => {
  const w = world();
  assert.equal((await w.svc.usage()).accounts.find((x) => x.label === 'A').usage.known, false);
  await settled(w);
  assert.equal((await w.svc.usage()).accounts.find((x) => x.label === 'A').usage.windows.five_hour.used, 90);
});

await check('the panel: live figures, stale ones, and Unknown (never 0%) for an account with no report', async () => {
  const w = world({ accounts: [acct('a', DIR_A), acct('b', DIR_B), acct('c', '/profiles/c')], emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', '/profiles/c': 'c@x.com' } });
  await settled(w);
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
  await settled(w);
  const r = await w.svc.usage();
  assert.equal(r.scanFailed, true);
  assert.equal(r.accounts.find((x) => x.label === 'B').stale, false);
  assert.equal(r.accounts.find((x) => x.label === 'B').sessionsRunning, null);
});

await check('a real idle 2.1.314 frame: the dim placeholder is no draft once dim text is dropped', async () => {
  const raw = fs.readFileSync(new URL('./fixtures/opentab-idle-2.1.314-raw.bin', import.meta.url));
  const lines = await renderScreenLines(new Uint8Array(raw));
  assert.match(promptBoxText(lines, lines.modes), /^Try "/, 'as drawn, it reads as text');
  const clean = lines.map((l, i) => (lines.dimFrom[i] >= 0 ? l.slice(0, lines.dimFrom[i]) : l));
  assert.equal(promptBoxText(clean, lines.modes), '');
  assert.equal(draftOnScreen(promptBoxText(clean, lines.modes)), false);
  // Typed text is not dim: nothing is dropped from it.
  const typed = await renderScreenLines(`\x1b[?2004h${'─'.repeat(40)}\r\n❯\u00a0half a thought\r\n${'─'.repeat(40)}\x1b[1A\r\x1b[16C`);
  assert.equal(typed.dimFrom.every((c) => c === -1), true);
});

await check('figures from an unlisted folder are not kept', async () => {
  const w = world();
  await settled(w);
  w.records = [...w.records, { key: keychainServiceFor('/elsewhere'), sessionId: 'x', receivedAt: w.now, windows: five(5) }];
  await w.svc.tick();
  w.svc.flushSync();
  const saved = JSON.parse(fs.readFileSync(path.join(w.ud, 'usage-history.json'), 'utf8'));
  assert.equal(keychainServiceFor('/elsewhere') in saved.keys, false);
  assert.equal(KEY_A in saved.keys, true);
});

await check('a re-logged folder drops the old figures, and a running session republishing them is ignored', async () => {
  const w = world();
  await settled(w);
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

await check('a metadata file linked out of its folder is unknown too', async () => {
  for (const name of ['.claude.json', '.config.json']) {
    const w = world({ links: { [`${DIR_B}/${name}`]: `/profiles/c/${name}` } });
    assert.match(target(await w.svc.moveTargets(TAB), 'B').refusal, /which login that account is/);
  }
});

await check('the dialog names the account of a shell replaced by Claude (exec), from its own pid', async () => {
  const w = world({ claude: null, proc: 'claude', tabs: [{ id: TAB, pid: 55, claudeConfigDir: DIR_A }], groups: [{ key: KEY_B, configDir: DIR_B, envUnset: false, pids: [55] }] });
  const r = await w.svc.moveTargets(TAB);
  assert.deepEqual(r.source, { label: 'B', email: 'b@x.com' });
  assert.match(r.tab.hardBlock, /other than one Claude/);
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
  await settled(w);
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
  assert.equal(c.block, null);
  assert.equal(c.hardBlock, null);
  assert.equal((await one({ presence: { sessionId: 'sess-now', status: 'busy' } })).busy, true);
  assert.equal((await one({ activity: { status: 'needs', lastActivityAt: 0 } })).busy, true);
  assert.equal((await one({ box: 'half a thought' })).draft, true);
  assert.match((await one({ box: 'half a thought' })).block, /unsent/);
  assert.equal((await one({ box: 'half a thought' })).hardBlock, null);
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

await check('the conversation comes from Claude\'s own record, and only that', async () => {
  const w = world({ presence: { sessionId: 'on-now', status: 'idle' } });
  assert.equal((await w.svc.moveCandidates([TAB], 'b'))[0].session.sessionId, 'on-now');
  w.presence = null;
  const [c] = await w.svc.moveCandidates([TAB], 'b');
  assert.equal(c.session, null);
  assert.match(c.hardBlock, /could not be identified/);
});

// ---- the move ----

// What restarting does in this fake: a new process under the new shell.
const moveOpts = (w, { allowBusy = false, group = (t) => t } = {}) => ({
  allowBusy,
  cannotRestart: () => w.cannotRestart || null,
  restart: (id, cwd, pin, resume) => {
    w.events.push(`restart ${id} ${cwd} ${JSON.stringify(pin)} ${resume.sessionId} ${resume.cwd}`);
    if (w.restartThrows) throw new Error('no ptys');
    if (w.restartOk === false) return false;
    if (w.neverStarts) w.claude = null;
    else {
      w.claude = { pid: 200, sessionId: resume.sessionId, startedAt: T0, soleChild: true };
      w.groups = w.groupsAfter || [{ key: KEY_B, configDir: DIR_B, envUnset: false, pids: [200] }];
      if (w.presenceAfter !== undefined) w.presence = w.presenceAfter;
    }
    return true;
  },
});
const moveB = (w, o) => w.svc.move(TAB, 'b', moveOpts(w, o));
const untouched = (w) => assert.deepEqual(w.events, [], 'nothing was stopped or restarted');

await check('a normal move stops Claude, claims, restarts in its folder, verifies and pins the target', async () => {
  const w = world();
  const r = await moveB(w);
  assert.deepEqual(r, { ok: true, pin: { id: 'b' } });
  assert.deepEqual(w.events, ['stop 100', 'claim sess-now', `restart ${TAB} /proj {"id":"b"} sess-now /proj/worktree`]);
});

await check('refused with the tab untouched: no Claude, exec claude, another program, no conversation, no folder', async () => {
  for (const [over, re] of [
    [{ claude: null, proc: null }, /no Claude/],
    [{ claude: null, proc: '2.1.314' }, /other than one Claude/], // exec claude: the shell itself
    [{ claude: { pid: 100, sessionId: null, startedAt: T0, soleChild: false } }, /other than one Claude/],
    [{ presence: null }, /could not be identified/],
    [{ cwd: null }, /folder/],
    [{ goneDir: '/proj/worktree' }, /folder/],
  ]) {
    const w = world(over);
    const r = await moveB(w, { allowBusy: true });
    assert.equal(r.ok, false);
    assert.match(r.error, re);
    assert.equal('pin' in r, false);
    untouched(w);
  }
});

await check('a target logged out while the tab is being judged is refused, untouched', async () => {
  const w = world();
  w.onScreen = () => { w.logins[DIR_B] = 'out'; };
  const r = await moveB(w);
  assert.match(r.error, /not logged in/);
  untouched(w);
});

await check('same login, unknown identity, a draft and typing are all refused before anything stops', async () => {
  let w = world({ emails: { [DIR_A]: 'same@x.com', [DIR_B]: 'SAME@x.com', [HOMEC]: 'd@x.com' } });
  assert.match((await moveB(w)).error, /same login/);
  untouched(w);
  w = world({ emails: { [DIR_A]: 'a@x.com', [HOMEC]: 'd@x.com' } });
  assert.match((await moveB(w)).error, /which login that account is/);
  untouched(w);
  w = world({ box: 'half a thought' });
  assert.match((await moveB(w)).error, /unsent text/);
  untouched(w);
  w = world();
  w.onScreen = () => { w.inputSeq += 1; };
  assert.match((await moveB(w)).error, /typed/);
  untouched(w);
  w = world({ held: false });
  const held = moveOpts(w);
  w.onScreen = () => { w.held = true; };
  assert.match((await w.svc.move(TAB, 'b', { ...held, allowBusy: true })).error, /typed/);
  untouched(w);
  w = world({ cannotRestart: 'that account is gone, or two accounts share its id' });
  assert.match((await moveB(w)).error, /two accounts share/);
  untouched(w);
  w = world({ override: 'CLAUDE_CODE_OAUTH_TOKEN' });
  assert.match((await moveB(w, { allowBusy: true })).error, /CLAUDE_CODE_OAUTH_TOKEN is set in its environment/);
  untouched(w);
  w = world({ override: 'unreadable' });
  assert.match((await moveB(w, { allowBusy: true })).error, /could not be read/);
  untouched(w);
  w = world({ unshared: new Set([DIR_A]) });
  assert.match((await moveB(w, { allowBusy: true })).error, /private copy/);
  untouched(w);
});

await check('a warned person can move a tab with a draft, Move all cannot', async () => {
  const w = world({ box: 'half a thought' });
  assert.equal((await moveB(w, { allowBusy: true })).ok, true);
});

await check('.zshrc putting Claude back on its old folder is a failure naming it, and the pin says so', async () => {
  const w = world({ groupsAfter: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [200] }] });
  const r = await moveB(w);
  assert.equal(r.ok, false);
  assert.match(r.error, /resumed on A \(a@x\.com\), not B/);
  assert.deepEqual(r.pin, { id: 'a' });
});

await check('landing on a folder that is no listed account clears the pin and names the folder', async () => {
  const w = world({ groupsAfter: [{ key: keychainServiceFor('/elsewhere'), configDir: '/elsewhere', envUnset: false, pids: [200] }] });
  const r = await moveB(w);
  assert.match(r.error, /resumed on \/elsewhere/);
  assert.equal(r.pin, null);
});

await check('another conversation running is a failure, and a token in the shell is named, by name only', async () => {
  let w = world({ presenceAfter: { sessionId: 'other-one', status: 'idle' } });
  let r = await moveB(w);
  assert.equal(r.ok, false);
  assert.match(r.error, /other-one/);
  // Set by the replacement's shell only, as a .zshrc would.
  const tokenAfter = (value) => {
    const x = world();
    const o = moveOpts(x);
    const restart = o.restart;
    o.restart = (...a) => { x.override = value; return restart(...a); };
    return x.svc.move(TAB, 'b', o);
  };
  r = await tokenAfter('CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(r.ok, false);
  assert.match(r.error, /CLAUDE_CODE_OAUTH_TOKEN is set/);
  r = await tokenAfter('unreadable');
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be read/);
});

await check('a Claude that ignored the resume is still read: wrong account, wrong conversation', async () => {
  let w = world({ groupsAfter: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [200] }] });
  const o = moveOpts(w);
  const restart = o.restart;
  o.restart = (...a) => { const ok = restart(...a); w.claude = { ...w.claude, sessionId: null }; return ok; };
  assert.match((await w.svc.move(TAB, 'b', o)).error, /resumed on A/);
});

await check('the target folder re-logged during the move is a failure, not a success', async () => {
  const w = world();
  const o = moveOpts(w);
  const restart = o.restart;
  o.restart = (...a) => { w.emails[DIR_B] = 'a@x.com'; return restart(...a); };
  const r = await w.svc.move(TAB, 'b', o);
  assert.equal(r.ok, false);
  assert.match(r.error, /now names a@x\.com/);
});

await check('input after Claude stopped is not restarted over; a deleted shell folder falls back to the conversation\'s', async () => {
  let w = world();
  w.onStop = () => { w.inputSeq += 1; };
  let r = await moveB(w);
  assert.match(r.error, /something was typed.*claude --resume/);
  assert.equal(w.events.some((e) => e.startsWith('restart')), false);
  w = world({ goneDir: '/proj' });
  assert.equal((await moveB(w)).ok, true);
  assert.match(w.events.at(-1), / \/proj\/worktree \{"id":"b"\} sess-now \/proj\/worktree$/);
  w = world({ restartThrows: true });
  r = await moveB(w);
  assert.match(r.error, /could not restart on B: no ptys.*claude --resume/);
});

await check('nothing confirmed within the bound fails visibly, and says how to get the conversation back', async () => {
  let w = world({ neverStarts: true });
  let r = await moveB(w);
  assert.equal(r.ok, false);
  assert.match(r.error, /did not start.*claude --resume sess-now in \/proj\/worktree/);
  assert.deepEqual(r.pin, { id: 'b' }, 'the shell did start on B');
  w = world({ presenceAfter: null });
  r = await moveB(w);
  assert.equal(r.ok, false);
  assert.match(r.error, /could not be confirmed/);
});

await check('a slow start inside the bound still ends in success', async () => {
  const w = world();
  const o = moveOpts(w);
  const restart = o.restart;
  let started;
  o.restart = (...a) => {
    const ok = restart(...a);
    started = w.claude;
    w.claude = null;
    const at = w.now + 5000;
    w.onSleep = () => { if (w.now >= at) w.claude = started; };
    return ok;
  };
  assert.equal((await w.svc.move(TAB, 'b', o)).ok, true);
});

await check('Claude not stopping changes nothing else; a conversation claimed elsewhere is not restarted', async () => {
  let w = world({ stillAlive: true });
  let r = await moveB(w);
  assert.match(r.error, /did not stop/);
  assert.deepEqual(w.events, ['stop 100']);
  assert.equal('pin' in r, false);
  w = world({ claimOk: false });
  r = await moveB(w);
  assert.match(r.error, /something else is resuming.*claude --resume sess-now/);
  assert.deepEqual(w.events, ['stop 100', 'claim sess-now']);
  assert.equal('pin' in r, false);
  w = world({ restartOk: false });
  r = await moveB(w);
  assert.match(r.error, /could not restart/);
  assert.equal('pin' in r, false);
  const gone = Object.assign(new Error('gone'), { code: 'ESRCH' });
  w = world({ stopThrows: gone });
  assert.equal((await moveB(w)).ok, true, 'already gone is fine');
  w = world({ stopThrows: new Error('EPERM') });
  r = await moveB(w);
  assert.match(r.error, /could not be stopped/);
  assert.equal(w.events.length, 1);
});

await check('one move at a time: a second is refused untouched, and the lock frees afterwards, also after a throw', async () => {
  const w = world();
  const [first, second] = await Promise.all([w.svc.move(TAB, 'b', moveOpts(w)), w.svc.move(TAB, 'b', moveOpts(w))]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.error, /another account move/);
  assert.equal(w.events.filter((e) => e.startsWith('stop')).length, 1);
  const w2 = world();
  w2.tabs = null;
  await assert.rejects(w2.svc.move(TAB, 'b', moveOpts(w2)));
  w2.tabs = [{ id: TAB, cwd: '/proj', claudeConfigDir: DIR_A }];
  assert.equal((await w2.svc.move(TAB, 'b', moveOpts(w2))).ok, true);
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
  await settled(w);
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
