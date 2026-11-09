// The panel figures, the move refusals and the history file
// (electron/account-headroom-service.js) against fake system deps, plus the tab
// pin at the spawn choke point and record pruning.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/account-headroom-service.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHeadroomService, draftOnScreen, writePrivateFileSync } from '../account-headroom-service.js';
import { limitMenuOn } from '../account-headroom.js';
import { keychainServiceFor } from '../account-identity.js';
import { resolveClaudeAccountPin } from '../spawn-account-env.js';
import { readUsageRecords, pruneUsageRecords } from '../claude-usage.js';
import { processEnvironment } from '../claude-process-scan.js';
import { spawn as spawnChild } from 'node:child_process';
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
    userDataDir: w.ud,
    now: () => w.now,
    getAccounts: () => w.accounts,
    defaultDir: () => w.defaultDir || HOMEC,
    defaultEnvUnset: () => w.defaultEnvUnset ?? true,
    cliDefaultDir: () => HOMEC,
    keyFor: (dir) => keychainServiceFor(dir),
    login: async (dir) => { w.onLogin?.(); return w.logins[dir] || 'in'; },
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
    readRecords: async () => { if (w.readGate) await w.readGate; return w.records; },
    scan: async () => { w.onScan?.(); if (w.scanThrows) throw new Error('scan'); return { groups: w.groups, unresolved: w.unresolved || [], ...(w.discoveryFailed ? { discoveryFailed: true } : {}) }; },
    tabs: () => w.tabs,
    activity: () => w.activity,
    claudeInfo: async (id) => (w.infoCalls = (w.infoCalls || 0) + 1, w.claudeByTab ? w.claudeByTab[id] ?? null : w.claude),
    presence: async (info) => (w.presenceByPid ? w.presenceByPid[info.pid] ?? null : w.presence),
    stop: (pid) => { w.events.push(`stop ${pid}`); w.onStop?.(); if (w.stopThrows) throw w.stopThrows; },
    alive: () => w.stillAlive === true,
    claim: async (sid) => { w.events.push(`claim ${sid}`); return w.claimOk !== false; },
    release: (sid) => { w.events.push(`release ${sid}`); },
    hasTranscript: async () => w.transcript !== false,
    nlink: async (p) => w.nlinks?.[p] ?? 1,
    pruneRecords: async (age) => { w.pruned = (w.pruned || 0) + 1; w.prunedAge = age; return 0; },
    sleep: async (ms) => { w.now += ms; w.onSleep?.(); },
    processAuthOverride: async (pid) => w.overrideFor?.[pid] || w.override || null,
    isDir: (p) => p !== w.goneDir,
    process: async () => w.proc || null,
    processCwd: async () => w.cwd === undefined ? '/proj/worktree' : w.cwd,
    inputSeq: () => w.inputSeq,
    inputAgeMs: () => w.inputAge ?? Infinity,
    inputHeld: () => w.held,
    screen: async (id) => { w.onScreen?.(id); return w.noScreen || (w.noScreenFor && w.noScreenFor === id) ? null : { lines: w.lines || [], modes: {} }; },
    promptBox: () => w.box,
    autoMoveOn: () => w.autoOn === true,
    restarterFor: (id) => (w.noWindow ? null : (w.restarter ? w.restarter(id) : moveOpts(w))),
    notify: (id, p) => { w.notices.push({ id, ...p }); },
  });
  w.notices = [];
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
    w.lastResume = resume;
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
  assert.deepEqual(w.events, ['stop 100', 'claim sess-now', `restart ${TAB} /proj {"id":"b"} sess-now /proj/worktree`, 'release sess-now']);
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
  w.onLogin = () => { w.held = true; };
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
  assert.match((await moveB(w, { allowBusy: true })).error, /unsent text/);
  assert.equal(w.events.length, 0);
  const o = { ...moveOpts(w), allowDraft: true };
  assert.equal((await w.svc.move(TAB, 'b', o)).ok, true);
});

await check('a tab on Claude\'s real limit menu is neither busy nor a draft, so Move all takes it', async () => {
  const raw = fs.readFileSync(new URL('./fixtures/limit-menu-2.1.316-raw.bin', import.meta.url));
  const lines = await renderScreenLines(new Uint8Array(raw), { cols: 120 });
  // The same menu right after a resume, with the effort badge on its top edge.
  const resumed = fs.readFileSync(new URL('./fixtures/limit-menu-resumed-2.1.316-raw.bin', import.meta.url));
  assert.equal(limitMenuOn(await renderScreenLines(new Uint8Array(resumed), { cols: 140 })), true);
  const w = world({ lines, presence: { sessionId: 'sess-now', status: 'waiting' }, box: null, activity: { status: 'working', lastActivityAt: T0 } });
  const [c] = await w.svc.moveCandidates([TAB], 'b');
  assert.equal(c.busy, false);
  assert.equal(c.draft, false);
  assert.equal(c.block, null);
  assert.equal((await moveB(w)).ok, true);
  // The menu on screen with Claude's record not on a dialog, or a permission
  // prompt from the hook: the words cannot clear either.
  for (const over of [{ presence: { sessionId: 'sess-now', status: 'busy' } }, { presence: { sessionId: 'sess-now', status: 'idle' } }, { presence: { sessionId: 'sess-now', status: 'waiting' }, activity: { status: 'needs', lastActivityAt: T0 } }]) {
    const y = world({ lines, box: 'half a thought', ...over });
    const [e] = await y.svc.moveCandidates([TAB], 'b');
    assert.equal(e.draft, true, JSON.stringify(over));
    assert.match(e.block, /middle of a turn|question|unsent/, JSON.stringify(over));
  }
  // Without the menu, the same record is a dialog and a box that cannot be read.
  const x = world({ presence: { sessionId: 'sess-now', status: 'waiting' }, box: null });
  const [d] = await x.svc.moveCandidates([TAB], 'b');
  assert.equal(d.busy, true);
  assert.equal(d.draft, true);
});

await check('a Claude with no transcript starts plain on the target, unclaimed, by account alone', async () => {
  const w = world({ transcript: false, presenceAfter: { sessionId: 'a-new-id', status: 'idle' } });
  const r = await moveB(w);
  assert.deepEqual(r, { ok: true, pin: { id: 'b' } });
  assert.deepEqual(w.events, ['stop 100', `restart ${TAB} /proj {"id":"b"} null /proj/worktree`]);
  const x = world({ transcript: false, presenceAfter: { sessionId: 'a-new-id', status: 'idle' }, groupsAfter: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [200] }] });
  assert.match((await moveB(x)).error, /resumed on A/);
});

await check('the real trust prompt on the target ends the wait at once and says what to do', async () => {
  const raw = fs.readFileSync(new URL('./fixtures/trust-prompt-2.1.316-raw.bin', import.meta.url));
  const lines = await renderScreenLines(new Uint8Array(raw), { cols: 120 });
  const w = world();
  const o = moveOpts(w);
  const restart = o.restart;
  o.restart = (...a) => { w.lines = lines; return restart(...a); };
  const t0 = w.now;
  const r = await w.svc.move(TAB, 'b', o);
  assert.match(r.error, /asking whether to trust this folder/);
  assert.deepEqual(r.pin, { id: 'b' });
  assert.equal(w.now - t0 < 2000, true, 'no long wait');
  // A token decides the login even behind the prompt: never just "answer it".
  const w2 = world();
  const o2 = moveOpts(w2);
  const restart2 = o2.restart;
  o2.restart = (...a) => { w2.lines = lines; w2.override = 'CLAUDE_CODE_OAUTH_TOKEN'; return restart2(...a); };
  const r2 = await w2.svc.move(TAB, 'b', o2);
  assert.match(r2.error, /CLAUDE_CODE_OAUTH_TOKEN is set/);
  assert.doesNotMatch(r2.error, /trust this folder/);
});

await check('Claude exiting right after it started is reported at once', async () => {
  const w = world();
  const o = moveOpts(w);
  const restart = o.restart;
  o.restart = (...a) => { const ok = restart(...a); w.presence = null; w.onSleep = () => { w.claude = null; }; return ok; };
  const t0 = w.now;
  const r = await w.svc.move(TAB, 'b', o);
  assert.match(r.error, /started on B and exited.*claude --resume sess-now/);
  assert.equal(w.now - t0 < 5000, true, 'no long wait');
});

await check('every abort after the claim gives it back', async () => {
  let w = world();
  w.onStop = () => { w.inputSeq += 1; };
  await moveB(w);
  assert.deepEqual(w.events, ['stop 100', 'claim sess-now', 'release sess-now']);
  w = world({ restartOk: false });
  await moveB(w);
  assert.equal(w.events.at(-1), 'release sess-now');
  w = world({ restartThrows: true });
  await moveB(w);
  assert.equal(w.events.at(-1), 'release sess-now');
});

await check('a hard-linked credential or metadata file makes the login unknown', async () => {
  for (const name of ['.credentials.json', '.claude.json', '.config.json']) {
    const w = world({ nlinks: { [`${DIR_B}/${name}`]: 2 } });
    assert.match(target(await w.svc.moveTargets(TAB), 'B').refusal, /which login that account is/, name);
  }
});

await check('a verified move gives back the claim, or the conversation stays locked after /exit', async () => {
  const w = world();
  const r = await moveB(w);
  assert.equal(r.ok, true);
  assert.deepEqual(w.events.filter((e) => /claim|release/.test(e)), ['claim sess-now', 'release sess-now']);
});

await check('after the restart: a wrong account outranks a trust prompt, an exit gives back the claim, a link made meanwhile fails', async () => {
  const raw = fs.readFileSync(new URL('./fixtures/trust-prompt-2.1.316-raw.bin', import.meta.url));
  const lines = await renderScreenLines(new Uint8Array(raw), { cols: 120 });
  let w = world({ groupsAfter: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [200] }] });
  let o = moveOpts(w);
  const r1 = o.restart;
  o.restart = (...a) => { w.lines = lines; return r1(...a); };
  let r = await w.svc.move(TAB, 'b', o);
  assert.match(r.error, /resumed on A/);
  assert.deepEqual(r.pin, { id: 'a' });
  // The wrong-folder answer must still name a token that decides the login.
  w = world({ groupsAfter: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [200] }] });
  o = moveOpts(w);
  const r5 = o.restart;
  o.restart = (...a) => { w.override = 'CLAUDE_CODE_OAUTH_TOKEN'; return r5(...a); };
  const tok = await w.svc.move(TAB, 'b', o);
  assert.match(tok.error, /resumed on A/);
  assert.match(tok.error, /CLAUDE_CODE_OAUTH_TOKEN is set too/);
  w = world();
  o = moveOpts(w);
  const r2 = o.restart;
  o.restart = (...a) => { const ok = r2(...a); w.presence = null; w.onSleep = () => { w.claude = null; }; return ok; };
  await w.svc.move(TAB, 'b', o);
  // Kept: what came and went may have been another claude a startup file ran,
  // with the resume still queued (the claim is this tab's, so a retry here works).
  assert.equal(w.events.includes('release sess-now'), false);
  // No transcript: nothing was at risk, so never a resume command with no id.
  w = world({ transcript: false });
  o = moveOpts(w);
  const r4 = o.restart;
  o.restart = (...a) => { const ok = r4(...a); w.presence = null; w.onSleep = () => { w.claude = null; }; return ok; };
  r = await w.svc.move(TAB, 'b', o);
  assert.match(r.error, /no conversation to lose/);
  assert.doesNotMatch(r.error, /--resume/);
  // A slow shell can still run the queued resume: the claim must hold.
  w = world({ neverStarts: true });
  r = await moveB(w);
  assert.equal(w.events.includes('release sess-now'), false);
  assert.match(r.error, /has not started/);
  assert.doesNotMatch(r.error, /--resume/);
  w = world();
  o = moveOpts(w);
  const r3 = o.restart;
  o.restart = (...a) => { w.links[`${DIR_B}/.credentials.json`] = `${DIR_A}/.credentials.json`; return r3(...a); };
  r = await w.svc.move(TAB, 'b', o);
  assert.equal(r.ok, false);
  assert.match(r.error, /no login that can be confirmed/);
});

await check('every tab asked about is answered, however many', async () => {
  const w = world();
  const ids = Array.from({ length: 70 }, (_, i) => `term-/proj-${i + 1}`);
  w.tabs = ids.map((id) => ({ id, cwd: '/proj', claudeConfigDir: DIR_A }));
  assert.equal((await w.svc.moveCandidates(ids, 'b')).length, 70);
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
  assert.match(w.events.findLast((e) => e.startsWith('restart')), / \/proj\/worktree \{"id":"b"\} sess-now \/proj\/worktree$/);
  w = world({ restartThrows: true });
  r = await moveB(w);
  assert.match(r.error, /could not restart on B: no ptys.*claude --resume/);
});

await check('nothing confirmed within the bound fails visibly, and says how to get the conversation back', async () => {
  let w = world({ neverStarts: true });
  let r = await moveB(w);
  assert.equal(r.ok, false);
  assert.match(r.error, /has not started.*give it a moment/);
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

await check('records past the age limit are deleted hourly, and stray temp files, nothing else', async () => {
  const w = world();
  await w.svc.tick();
  await w.svc.tick();
  assert.equal(w.pruned, 1);
  assert.equal(w.prunedAge, 8 * 86400_000);
  w.now += 3600_001;
  await w.svc.tick();
  assert.equal(w.pruned, 2);
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-prune-'));
  const dir = path.join(ud, 'usage');
  fs.mkdirSync(dir);
  const old = (Date.now() - 10 * 86400_000) / 1000;
  const OLD = '11111111-2222-4333-8444-555555555555.json';
  const FRESH = '66666666-7777-4888-8999-aaaaaaaaaaaa.json';
  // auth.json and .credentials.json are what a swapped folder would expose.
  const notOurs = ['auth.json', '.credentials.json', 'settings.json', 'keep.txt'];
  for (const n of [OLD, FRESH, '.tmp.s1.123', ...notOurs]) fs.writeFileSync(path.join(dir, n), 'x');
  for (const n of [OLD, '.tmp.s1.123', ...notOurs]) fs.utimesSync(path.join(dir, n), old, old);
  assert.equal(await pruneUsageRecords(ud, 8 * 86400_000), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), [FRESH, ...notOurs].sort());
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-prunereal-'));
  fs.writeFileSync(path.join(real, 'x.json'), 'x');
  fs.utimesSync(path.join(real, 'x.json'), old, old);
  const ud2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-prunelink-'));
  fs.symlinkSync(real, path.join(ud2, 'usage'));
  assert.equal(await pruneUsageRecords(ud2, 8 * 86400_000), 0, 'a linked folder is left alone');
});

await check('2,000 records never open 2,000 files at once', async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-many-'));
  const dir = path.join(ud, 'usage');
  fs.mkdirSync(dir);
  for (let i = 0; i < 2000; i += 1) fs.writeFileSync(path.join(dir, `s${i}.json`), `DOBIUS1 1\n/d\n${JSON.stringify({ session_id: `s${i}` })}`);
  const fsp = (await import('node:fs/promises')).default;
  const open = fsp.open;
  let now = 0; let peak = 0;
  fsp.open = async (...a) => { now += 1; peak = Math.max(peak, now); const h = await open(...a); const close = h.close.bind(h); h.close = () => { now -= 1; return close(); }; return h; };
  try { assert.equal((await readUsageRecords(ud)).length, 2000); } finally { fsp.open = open; }
  assert.equal(peak <= 16, true, `peak ${peak}`);
});

await check('a process environment leaves out its argv, so a prompt naming a key is not a key', async () => {
  // Not a system binary: macOS hides the environment of those from ps.
  const sh = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', 'ANTHROPIC_API_KEY=example'], { env: { PATH: '/bin', HOME: '/h' } });
  await new Promise((r) => setTimeout(r, 300));
  const e1 = await processEnvironment(sh.pid);
  sh.kill();
  assert.equal(typeof e1, 'string');
  assert.match(e1, /HOME=\/h/);
  assert.equal(e1.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(await processEnvironment(999999), null);
});

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

// ---- auto-move on limit ----

const LIMIT_LINES = await renderScreenLines(new Uint8Array(fs.readFileSync(new URL('./fixtures/limit-menu-2.1.316-raw.bin', import.meta.url))), { cols: 120 });
const limitedWorld = (over = {}) => world({ lines: LIMIT_LINES, presence: { sessionId: 'sess-now', status: 'waiting' }, box: null, activity: { status: 'working', lastActivityAt: T0 }, autoOn: true, ...over });
const kinds = (w) => w.notices.map((n) => n.kind);

await check('auto-move: off does nothing; on, a tab on its limit menu moves to the account with room, resumes with a carry-on, and its window gets the pin', async () => {
  const w = limitedWorld({ autoOn: false });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.equal(w.infoCalls ?? 0, 0, 'off, no tab is even looked at');
  assert.deepEqual(w.notices, []);
  w.autoOn = true;
  await w.svc.autoTick();
  assert.deepEqual(w.events, ['stop 100', 'claim sess-now', `restart ${TAB} /proj {"id":"b"} sess-now /proj/worktree`, 'release sess-now']);
  assert.equal(w.lastResume.carryOn, true);
  assert.equal(w.notices.length, 1);
  const n = w.notices[0];
  assert.equal(n.id, TAB);
  assert.equal(n.kind, 'moved');
  assert.deepEqual(n.from, { label: 'A', email: 'a@x.com' });
  assert.deepEqual(n.to, { label: 'B', email: 'b@x.com' });
  assert.deepEqual(n.pin, { id: 'b' });
});

await check('auto-move: never the same tab twice within the cooldown, said once, and the account it left is held', async () => {
  const w = limitedWorld();
  await settled(w);
  await w.svc.autoTick();
  assert.equal(w.events.filter((e) => e.startsWith('stop')).length, 1);
  // Now on B, and B's limit menu is up too.
  w.now += 60_000;
  await w.svc.autoTick();
  await w.svc.autoTick();
  assert.equal(w.events.filter((e) => e.startsWith('stop')).length, 1, 'not moved again');
  assert.deepEqual(kinds(w), ['moved', 'cooldown'], 'the cooldown is said once');
  assert.deepEqual(w.notices[1].from, { label: 'B', email: 'b@x.com' });
  // Past the cooldown: A has 10% left and was seen on its limit, so nowhere qualifies.
  w.now += 15 * 60_000;
  await w.svc.autoTick();
  assert.equal(w.events.filter((e) => e.startsWith('stop')).length, 1);
  assert.deepEqual(kinds(w), ['moved', 'cooldown', 'stuck']);
});

await check('a manual move never carries the auto-move prompt', async () => {
  const w = world();
  assert.equal((await moveB(w)).ok, true);
  assert.equal(w.lastResume.carryOn, undefined);
});

await check('auto-move leaves alone a tab that is not on its limit menu by every test', async () => {
  for (const over of [
    { presence: { sessionId: 'sess-now', status: 'idle' } },
    { presence: { sessionId: 'sess-now', status: 'busy' } },
    { lines: [] },
    { activity: { status: 'needs', lastActivityAt: T0 } },
    { claude: null },
    { noWindow: true },
  ]) {
    const w = limitedWorld(over);
    await settled(w);
    let judged = false;
    w.onLogin = () => { judged = true; };
    await w.svc.autoTick();
    untouched(w);
    assert.deepEqual(w.notices, [], JSON.stringify(over));
    assert.equal(judged, false, `not even judged: ${JSON.stringify(over)}`);
  }
});

await check('auto-move with nowhere to go: under 20% left, or usage unknown, stays put and says so once', async () => {
  for (const records of [
    [{ key: KEY_A, sessionId: 's-a', receivedAt: T0 - 30_000, windows: five(100) }, { key: KEY_B, sessionId: 's-b', receivedAt: T0 - 60_000, windows: five(85) }],
    [{ key: KEY_A, sessionId: 's-a', receivedAt: T0 - 30_000, windows: five(100) }],
  ]) {
    const w = limitedWorld({ records });
    await settled(w);
    await w.svc.autoTick();
    await w.svc.autoTick();
    untouched(w);
    assert.deepEqual(kinds(w), ['stuck']);
    assert.deepEqual(w.notices[0].from, { label: 'A', email: 'a@x.com' });
  }
});

await check('auto-move checks again right before stopping Claude: off its limit menu, or a target that filled up, is not moved', async () => {
  // The menu is gone by the move's own look (the person picked an option).
  let w = limitedWorld();
  await settled(w);
  let looks = 0;
  // The first look (the tick's) reads the record before the screen, so this lands on the move's own look.
  // Idle with an empty box: nothing else would stop a manual move now, only the automatic check.
  w.onScreen = () => { looks += 1; if (looks === 1) { w.presence = { sessionId: 'sess-now', status: 'idle' }; w.activity = null; w.box = ''; } };
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(kinds(w), ['failed']);
  assert.match(w.notices[0].error, /no longer on its limit menu/);
  // A failed attempt still starts the cooldown: back on the menu, it is not retried.
  w.presence = { sessionId: 'sess-now', status: 'waiting' };
  w.box = null;
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(kinds(w), ['failed', 'cooldown']);
  // B fills up between the pick and the move.
  w = limitedWorld();
  await settled(w);
  // Login checks run after the tick has ranked the targets and before the move
  // samples again, so the move's own reading is the first to see B at 95%.
  const base = w.records;
  w.onLogin = () => { w.records = [...base.filter((r) => r.key !== KEY_B), { key: KEY_B, sessionId: 's-b', receivedAt: w.now, windows: five(95) }]; };
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(kinds(w), ['failed']);
  assert.match(w.notices[0].error, /B no longer qualifies/);
});

for (const order of ['Y first', 'X first']) await check(`auto-move: a login seen on its limit is no target for another tab, whichever is looked at first (${order})`, async () => {
  const DIR_C = '/profiles/c';
  const KEY_C = keychainServiceFor(DIR_C);
  const X = 'term-/proj-2';
  const Y = 'term-/proj-3';
  const dirOf = { b: DIR_B, c: DIR_C };
  const keyOf = { [DIR_A]: KEY_A, [DIR_B]: KEY_B, [DIR_C]: KEY_C };
  const w = limitedWorld({
    accounts: [acct('a', DIR_A), acct('b', DIR_B), acct('c', DIR_C)],
    emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', [DIR_C]: 'c@x.com', [HOMEC]: 'd@x.com' },
    records: [
      { key: KEY_A, sessionId: 's-a', receivedAt: T0 - 30_000, windows: five(90) },
      { key: KEY_B, sessionId: 's-b', receivedAt: T0 - 30_000, windows: five(20) },
      { key: KEY_C, sessionId: 's-c', receivedAt: T0 - 30_000, windows: five(10) },
    ],
    // Y runs on B and is first; X runs on A.
    tabs: order === 'Y first'
      ? [{ id: Y, cwd: '/proj', claudeConfigDir: DIR_B }, { id: X, cwd: '/proj', claudeConfigDir: DIR_A }]
      : [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: DIR_B }],
    claudeByTab: { [X]: { pid: 100, soleChild: true }, [Y]: { pid: 101, soleChild: true } },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }, { key: KEY_B, configDir: DIR_B, envUnset: false, pids: [101] }],
    presenceByPid: { 100: { sessionId: 'sess-now', status: 'waiting' }, 101: { sessionId: 'sess-now', status: 'waiting' } },
  });
  let next = 300;
  w.restarter = () => ({
    cannotRestart: () => null,
    restart: (id, cwd, pin) => {
      w.events.push(`restart ${id} ${pin.id}`);
      const pid = (next += 1);
      w.claudeByTab[id] = { pid, soleChild: true };
      w.presenceByPid[pid] = { sessionId: 'sess-now', status: 'idle' };
      w.groups = [...w.groups.filter((g) => !g.pids.includes(id === X ? 100 : 101)), { key: keyOf[dirOf[pin.id]], configDir: dirOf[pin.id], envUnset: false, pids: [pid] }];
      return true;
    },
  });
  await settled(w);
  await w.svc.autoTick();
  // One attempt a tick: a target can hit its own limit as the moved tab
  // resumes, and only the next look sees that.
  assert.equal(w.events.filter((e) => e.startsWith('restart')).length, 1);
  await w.svc.autoTick();
  // Y (on B) goes to C (A has 10% left). X (on A) would pick B (80% left, more
  // than C's 90% less 15 reserved for the other move), but B is on its limit
  // menu in Y, so X goes to C as well, even when X is looked at first.
  assert.deepEqual(w.events.filter((e) => e.startsWith('restart')).sort(), [`restart ${X} c`, `restart ${Y} c`]);
  assert.deepEqual(kinds(w), ['moved', 'moved']);
});

await check('auto-move refuses a tab whose Claude is not on the folder its tab was started with, or typed into since the tick looked', async () => {
  // A shell setting points Claude at B although the tab was started on A: the
  // carry-on would go out on whatever that setting picks after the restart.
  let w = limitedWorld({ groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }], tabs: [{ id: TAB, cwd: '/proj', claudeConfigDir: '/profiles/other' }] });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(kinds(w), ['failed']);
  assert.match(w.notices[0].error, /started with/);
  // Esc on the menu right after the tick looked.
  w = limitedWorld();
  await settled(w);
  let looks = 0;
  w.onScreen = () => { looks += 1; if (looks === 1) w.inputSeq += 1; };
  await w.svc.autoTick();
  untouched(w);
  assert.match(w.notices[0].error, /typed/);
});

await check('auto-move that finds a manual move holding the lock tries again next time, with no cooldown', async () => {
  const w = limitedWorld();
  await settled(w);
  // A manual move starts while the tick is looking at the tab, and holds the
  // lock until its own read of the records is let through.
  let manual = null;
  w.onLogin = () => {
    if (manual) return;
    let open;
    w.readGate = new Promise((r) => { open = r; });
    manual = w.svc.move(TAB, 'nope', moveOpts(w));
    setTimeout(() => { w.readGate = null; open(); }, 0);
  };
  await w.svc.autoTick();
  assert.deepEqual(w.notices, [], 'nothing tried, nothing said');
  untouched(w);
  assert.match((await manual).error, /no longer exists/);
  w.onLogin = null;
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved'], 'no cooldown was started by the tick that stood aside');
});

await check('auto-move: a failed attempt still counts against its target, since its resume may yet start there', async () => {
  const DIR_C = '/profiles/c';
  const X = 'term-/proj-2';
  const Y = 'term-/proj-3';
  const w = limitedWorld({
    accounts: [acct('a', DIR_A), acct('b', DIR_B), acct('c', DIR_C)],
    emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', [DIR_C]: 'c@x.com', [HOMEC]: 'd@x.com' },
    records: [
      { key: KEY_A, sessionId: 's-a', receivedAt: T0 - 30_000, windows: five(90) },
      { key: KEY_B, sessionId: 's-b', receivedAt: T0 - 30_000, windows: five(70) },
      { key: keychainServiceFor(DIR_C), sessionId: 's-c', receivedAt: T0 - 30_000, windows: five(75) },
    ],
    tabs: [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: DIR_A }],
    claudeByTab: { [X]: { pid: 100, soleChild: true }, [Y]: { pid: 101, soleChild: true } },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100, 101] }],
  });
  // X's restart is refused after every check (as when the resume is left
  // waiting on a slow shell): nothing verified, but B may still get it.
  w.restarter = (id) => ({ ...moveOpts(w), cannotRestart: () => (id === X ? 'the tab is moving to another window' : null) });
  await settled(w);
  await w.svc.autoTick();
  assert.equal(w.notices[0].id, X);
  assert.equal(w.notices[0].kind, 'failed');
  assert.deepEqual(w.notices[0].to, { label: 'B', email: 'b@x.com' });
  await w.svc.autoTick();
  // B had 30% left, 15 of it now reserved: under 20%. C, with 25%, is the one.
  const second = w.notices.find((n) => n.id === Y);
  assert.deepEqual(second.to, { label: 'C', email: 'c@x.com' });
});

await check('auto-move reads the processes again for a Claude started after the tick looked, and moves nothing when its login still cannot be named', async () => {
  // Not in the first read; there in the next one.
  let w = limitedWorld({ groups: [] });
  await settled(w);
  let reads = 0;
  w.onScan = () => { reads += 1; if (reads === 2) w.groups = [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }]; };
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved']);
  // There, on a folder no account lists: its login cannot be named either.
  w = limitedWorld({ groups: [{ key: keychainServiceFor('/profiles/z'), configDir: '/profiles/z', envUnset: false, pids: [100] }], tabs: [{ id: TAB, cwd: '/proj', claudeConfigDir: '/profiles/z' }] });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
  // Never there: its limit cannot be held, so no tab moves this time.
  w = limitedWorld({ groups: [] });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
});

await check('auto-move: a tab on its limit menu whose login a token decides stops every move that tick', async () => {
  const X = 'term-/proj-2';
  const Y = 'term-/proj-3';
  const w = limitedWorld({
    tabs: [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: DIR_A }],
    claudeByTab: { [X]: { pid: 100, soleChild: true }, [Y]: { pid: 101, soleChild: true } },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100, 101] }],
  });
  await settled(w);
  // Y's Claude signs in with a token: its limit is some other login's, maybe B's.
  w.overrideFor = { 101: 'CLAUDE_CODE_OAUTH_TOKEN' };
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
});

await check('auto-move charges the login its own read found, not only the one it picked', async () => {
  const DIR_C = '/profiles/c';
  const KEY_C = keychainServiceFor(DIR_C);
  const X = 'term-/proj-2';
  const Y = 'term-/proj-3';
  const w = limitedWorld({
    accounts: [acct('a', DIR_A), acct('b', DIR_B), acct('c', DIR_C)],
    emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', [DIR_C]: 'c@x.com', [HOMEC]: 'd@x.com' },
    records: [
      { key: KEY_A, sessionId: 's-a', receivedAt: T0 - 30_000, windows: five(90) },
      { key: KEY_B, sessionId: 's-b', receivedAt: T0 - 30_000, windows: five(20) },
      { key: KEY_C, sessionId: 's-c', receivedAt: T0 - 30_000, windows: five(70) },
    ],
    tabs: [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: DIR_A }],
    claudeByTab: { [X]: { pid: 100, soleChild: true }, [Y]: { pid: 101, soleChild: true } },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100, 101] }],
  });
  await settled(w);
  // B's folder is logged in to C's login between the pick and the move's read.
  // The tick looks at X and Y; the third look is the move's own.
  let looks = 0;
  w.onScreen = () => { looks += 1; if (looks === 3) w.emails[DIR_B] = 'c@x.com'; };
  w.restarter = (id) => ({ ...moveOpts(w), cannotRestart: () => (id === X ? 'the tab is moving to another window' : null) });
  await w.svc.autoTick();
  assert.equal(w.notices[0].kind, 'failed');
  // Named by what the move read, not by the pick.
  assert.deepEqual(w.notices[0].to, { label: 'B', email: 'c@x.com' });
  w.onScreen = null;
  await w.svc.autoTick();
  // C's login has 30% left, 15 of it charged by X's attempt: under 20%.
  const second = w.notices.find((n) => n.id === Y);
  assert.equal(second.kind, 'stuck', JSON.stringify(w.notices));
});

await check('auto-move: another tab whose Claude the process list cannot find stops every move, even with no record where its tab started', async () => {
  // Y's Claude runs on some other folder (a shell setting) the scan cannot
  // resolve; its record is not in the folder its tab was started with. It may
  // be on its limit, on the very login X would move to.
  const X = 'term-/proj-2';
  const Y = 'term-/proj-3';
  const w = limitedWorld({
    tabs: [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: '/profiles/d' }],
    claudeByTab: { [X]: { pid: 100, soleChild: true }, [Y]: { pid: 101, soleChild: true } },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }],
    presenceByPid: { 100: { sessionId: 'sess-now', status: 'waiting' } },
  });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
});

await check('auto-move: a tab whose shell became Claude (exec claude), or whose Claude was replaced while it was looked at, stops every move that tick', async () => {
  const X = 'term-/proj-2';
  const Y = 'term-/proj-3';
  // Y: no child Claude, but its shell's own pid is a Claude in the scan.
  let w = limitedWorld({
    tabs: [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: DIR_A, pid: 555 }],
    claudeByTab: { [X]: { pid: 100, soleChild: true } },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }, { key: KEY_B, configDir: DIR_B, envUnset: false, pids: [555] }],
  });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
  // The same Y as a plain shell (its pid no Claude): X is restarted on B.
  w.groups = [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }];
  await w.svc.autoTick();
  assert.equal(w.events.some((e) => e.startsWith(`restart ${X} /proj {"id":"b"}`)), true, w.events.join(' | '));
  // Y's shell is a Claude the scan could not resolve: the same.
  w = limitedWorld({
    tabs: [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: DIR_A, pid: 555 }],
    claudeByTab: { [X]: { pid: 100, soleChild: true } },
    unresolved: [{ pid: 555, reason: 'binding unreadable' }],
  });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
  // Replaced between the first look and the full one.
  w = limitedWorld();
  await settled(w);
  let calls = 0;
  const first = w.claude;
  w.claudeByTab = new Proxy({}, { get: () => { calls += 1; return calls === 1 ? first : { ...first, pid: 777 }; } });
  w.groups = [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100, 777] }];
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
});

await check('auto-move: a tab closed with its window keeps its cooldown when the project reopens it', async () => {
  const w = limitedWorld();
  await settled(w);
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved']);
  const tabs = w.tabs;
  w.tabs = [];
  await w.svc.autoTick();
  w.now += 60_000;
  // Reopened under the same id, on its limit menu again.
  w.tabs = tabs;
  w.events = [];
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(kinds(w), ['moved', 'cooldown']);
});

await check('auto-move: a record that could not be read does not bring back a notice already shown', async () => {
  const w = limitedWorld({ autoOn: true, records: [{ key: KEY_A, sessionId: 's-a', receivedAt: T0 - 30_000, windows: five(90) }, { key: KEY_B, sessionId: 's-b', receivedAt: T0 - 30_000, windows: five(95) }] });
  await settled(w);
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['stuck']);
  const rec = w.presence;
  w.presence = null; // the read failed
  await w.svc.autoTick();
  w.presence = rec;
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['stuck'], 'said once');
  // A Claude lookup that failed for a tick says nothing either.
  const claude = w.claude;
  w.claude = null;
  await w.svc.autoTick();
  w.claude = claude;
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['stuck'], 'still once');
  // A new Claude in the tab on its own limit: said for it.
  w.claude = { ...claude, pid: 101 };
  w.groups = [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [101] }];
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['stuck', 'stuck']);
  w.claude = claude;
  w.groups = [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }];
  await w.svc.autoTick();
  w.notices = [w.notices[0]];
  // A real reading off the menu, then back on it: said again.
  w.presence = { sessionId: 'sess-now', status: 'idle' };
  await w.svc.autoTick();
  w.presence = rec;
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['stuck', 'stuck']);
});

await check('a move says it is running from its first check to its end, so the Switch job can wait for it', async () => {
  const w = limitedWorld();
  await settled(w);
  const seen = [];
  w.onScreen = () => { seen.push(w.svc.isMoving()); };
  assert.equal(w.svc.isMoving(), false);
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved']);
  // The tick's own look is outside the move; the move's looks (its checks and
  // its verification) are inside it.
  assert.equal(seen[0], false);
  assert.equal(seen.length > 1 && seen.slice(1).every(Boolean), true, JSON.stringify(seen));
  assert.equal(w.svc.isMoving(), false);
});

await check('auto-move: a process list that could not list every Claude moves nothing', async () => {
  const w = limitedWorld({ discoveryFailed: true });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
  w.discoveryFailed = false;
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved']);
});

await check('auto-move: a relaunch keeps the cooldown and the hold on the account left', async () => {
  const w = limitedWorld();
  await settled(w);
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved']);
  // Relaunched a minute later; the restored tab is on B and B is on its limit.
  // A's figure now shows room, but A was seen on its limit and has not reset.
  const records = [
    { key: KEY_A, sessionId: 's-a', receivedAt: w.now, windows: five(50) },
    { key: KEY_B, sessionId: 's-b', receivedAt: w.now, windows: five(100) },
  ];
  const w2 = limitedWorld({ ud: w.ud, now: w.now + 60_000, records, tabs: [{ id: TAB, cwd: '/proj', claudeConfigDir: DIR_B }], groups: [{ key: KEY_B, configDir: DIR_B, envUnset: false, pids: [100] }] });
  await settled(w2);
  await w2.svc.autoTick();
  untouched(w2);
  assert.deepEqual(kinds(w2), ['cooldown']);
  w2.now += 15 * 60_000;
  w2.records = w2.records.map((r) => ({ ...r, receivedAt: w2.now }));
  await w2.svc.autoTick();
  untouched(w2);
  assert.deepEqual(kinds(w2), ['cooldown', 'stuck']);
  // A fresh userData remembers nothing: the same tab moves back to A.
  const w3 = limitedWorld({ now: w2.now, records: w2.records, tabs: w2.tabs, groups: w2.groups, groupsAfter: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [200] }] });
  await settled(w3);
  await w3.svc.autoTick();
  assert.deepEqual(kinds(w3), ['moved']);
  assert.deepEqual(w3.notices[0].to, { label: 'A', email: 'a@x.com' });
});

await check('auto-move: a clear reading of another dialog ends the notices for that limit', async () => {
  const w = limitedWorld({ records: [{ key: KEY_A, sessionId: 's-a', receivedAt: T0 - 30_000, windows: five(90) }, { key: KEY_B, sessionId: 's-b', receivedAt: T0 - 30_000, windows: five(95) }] });
  await settled(w);
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['stuck']);
  // A permission prompt: still waiting, but read clearly and not the limit.
  w.activity = { status: 'needs', lastActivityAt: w.now };
  await w.svc.autoTick();
  w.activity = { status: 'working', lastActivityAt: w.now };
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['stuck', 'stuck']);
  // A screen that could not be read says nothing new.
  w.noScreen = true;
  await w.svc.autoTick();
  w.noScreen = false;
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['stuck', 'stuck']);
});

await check('a move whose Claude never started keeps the Switch job waiting while the resume is still claimed', async () => {
  const w = world({ neverStarts: true });
  const r = await moveB(w);
  assert.match(r.error, /has not started/);
  assert.equal(w.svc.isMoving(), true);
  w.now += 9 * 60_000;
  assert.equal(w.svc.isMoving(), true);
  w.now += 2 * 60_000;
  assert.equal(w.svc.isMoving(), false);
  // One that started and was confirmed leaves nothing behind.
  const w2 = world();
  assert.equal((await moveB(w2)).ok, true);
  assert.equal(w2.svc.isMoving(), false);
});

await check('auto-move: the attempt is saved before the move, so a quit while it verifies keeps the cooldown, holds and reservation', async () => {
  const w = limitedWorld();
  await settled(w);
  let saved = null;
  w.restarter = () => {
    const o = moveOpts(w);
    const restart = o.restart;
    return { ...o, restart: (...a) => { saved = JSON.parse(fs.readFileSync(path.join(w.ud, 'auto-move.json'), 'utf8')); return restart(...a); } };
  };
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved']);
  assert.deepEqual(saved.tabs.map((t) => t.id), [TAB]);
  assert.deepEqual(saved.holds.map((h) => h.login), ['a@x.com']);
  assert.deepEqual(saved.placements.map((x) => x.login), ['b@x.com']);
});

await check('auto-move: the move refuses a different Claude than the one the tick judged, and a process list that failed on its own read', async () => {
  let w = limitedWorld();
  await settled(w);
  // A manual move (or a restart) put another Claude in the tab after the tick looked.
  let looks = 0;
  w.onScreen = () => { looks += 1; if (looks === 1) { w.claude = { ...w.claude, pid: 300 }; w.groups = [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [300] }]; } };
  await w.svc.autoTick();
  untouched(w);
  assert.equal(kinds(w)[0], 'failed');
  assert.match(w.notices[0].error, /restarted since/);
  // The move's own process read could not list every Claude.
  w = limitedWorld();
  await settled(w);
  let scans = 0;
  w.onScan = () => { scans += 1; if (scans === 2) w.discoveryFailed = true; };
  await w.svc.autoTick();
  untouched(w);
  assert.match(w.notices[0].error, /process list/);
});

await check('auto-move: a refusal names the target as the move read it, even one the dialog would refuse too', async () => {
  const w = limitedWorld();
  await settled(w);
  // B's folder now names the source's own login: changed after the tick read
  // the accounts, during the move's own look.
  let looks = 0;
  w.onScreen = () => { looks += 1; if (looks === 2) w.emails[DIR_B] = 'a@x.com'; };
  await w.svc.autoTick();
  untouched(w);
  assert.equal(kinds(w)[0], 'failed');
  assert.deepEqual(w.notices[0].to, { label: 'B', email: 'a@x.com' });
});

await check('a resume not confirmed keeps the Switch job waiting even when some other Claude started and exited', async () => {
  const w = world();
  const o = moveOpts(w);
  const restart = o.restart;
  o.restart = (...a) => { const ok = restart(...a); w.presence = null; w.onSleep = () => { w.claude = null; }; return ok; };
  const r = await w.svc.move(TAB, 'b', o);
  assert.match(r.error, /exited/);
  assert.equal(w.svc.isMoving(), true);
  w.now += 11 * 60_000;
  assert.equal(w.svc.isMoving(), false);
});

await check('auto-move: a tab waiting on a dialog whose screen cannot be read stops every move that tick', async () => {
  const X = 'term-/proj-2';
  const Y = 'term-/proj-3';
  const w = limitedWorld({
    tabs: [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: DIR_B }],
    claudeByTab: { [X]: { pid: 100, soleChild: true }, [Y]: { pid: 101, soleChild: true } },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }, { key: KEY_B, configDir: DIR_B, envUnset: false, pids: [101] }],
    noScreenFor: Y,
  });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
  // Read: Y is on B's limit, so B is held and X does not go there.
  w.noScreenFor = null;
  await w.svc.autoTick();
  assert.equal(w.events.some((e) => e.includes('{"id":"b"}')), false, JSON.stringify(w.events));
});

await check('auto-move: the attempt\'s own reservation never refuses its own target', async () => {
  // B has 30% left: enough, and only this attempt is reserved on it.
  const w = limitedWorld({ records: [{ key: KEY_A, sessionId: 's-a', receivedAt: T0 - 30_000, windows: five(90) }, { key: KEY_B, sessionId: 's-b', receivedAt: T0 - 30_000, windows: five(70) }] });
  await settled(w);
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved'], JSON.stringify(w.notices));
});

await check('auto-move: another Claude whose own record cannot be read stops every move that tick', async () => {
  const X = 'term-/proj-2';
  const Y = 'term-/proj-3';
  const w = limitedWorld({
    tabs: [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: DIR_B }],
    claudeByTab: { [X]: { pid: 100, soleChild: true }, [Y]: { pid: 101, soleChild: true } },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100] }, { key: KEY_B, configDir: DIR_B, envUnset: false, pids: [101] }],
    presenceByPid: { 100: { sessionId: 'sess-now', status: 'waiting' } },
  });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
  w.presenceByPid[101] = { sessionId: 'sess-y', status: 'idle' };
  w.presenceByPid[200] = { sessionId: 'sess-now', status: 'idle' }; // the resumed one
  w.restarter = () => { const o = moveOpts(w); return { ...o, restart: (...a) => { const ok = o.restart(...a); w.claudeByTab[X] = w.claude; w.groups = [...w.groups, { key: KEY_B, configDir: DIR_B, envUnset: false, pids: [101, 200] }].slice(-1); return ok; } }; };
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved'], JSON.stringify(w.notices));
});

await check('auto-move: keys pressed in the last 30 seconds wait a tick, with no cooldown', async () => {
  const w = limitedWorld({ inputAge: 5000 });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
  w.inputAge = 31_000;
  await w.svc.autoTick();
  assert.deepEqual(kinds(w), ['moved']);
});

await check('auto-move: an attempt whose memory cannot be saved is not tried', async () => {
  const w = limitedWorld();
  await settled(w);
  fs.chmodSync(w.ud, 0o500);
  try { await w.svc.autoTick(); }
  finally { fs.chmodSync(w.ud, 0o700); }
  untouched(w);
  assert.equal(kinds(w)[0], 'failed');
  assert.match(w.notices[0].error, /could not be saved/);
});

await check('auto-move: a tab whose shell runs Claude next to another program stops every move that tick', async () => {
  const X = 'term-/proj-2';
  const Y = 'term-/proj-3';
  const w = limitedWorld({
    tabs: [{ id: X, cwd: '/proj', claudeConfigDir: DIR_A }, { id: Y, cwd: '/proj', claudeConfigDir: DIR_A }],
    claudeByTab: { [X]: { pid: 100, soleChild: true }, [Y]: { pid: 101, soleChild: false } },
    groups: [{ key: KEY_A, configDir: DIR_A, envUnset: false, pids: [100, 101] }],
    presenceByPid: { 100: { sessionId: 'sess-now', status: 'waiting' }, 101: { sessionId: 'sess-y', status: 'idle' } },
  });
  await settled(w);
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
});

await check('auto-move: memory on disk that cannot be read means no move until it can', async () => {
  const w = limitedWorld();
  await settled(w);
  const f = path.join(w.ud, 'auto-move.json');
  // It holds a cooldown for this very tab, from a minute ago.
  fs.writeFileSync(f, JSON.stringify({ tabs: [{ id: TAB, movedAt: w.now - 60_000 }] }), { mode: 0o600 });
  fs.chmodSync(f, 0o000);
  try { await w.svc.autoTick(); }
  finally { fs.chmodSync(f, 0o600); }
  untouched(w);
  assert.deepEqual(w.notices, []);
  // Readable again: read now, so the cooldown it holds counts.
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(kinds(w), ['cooldown']);
});

await check('auto-move: a second Claude joining the tab between the two looks stops every move that tick', async () => {
  const w = limitedWorld();
  await settled(w);
  let calls = 0;
  const first = w.claude;
  w.claudeByTab = new Proxy({}, { get: () => { calls += 1; return calls === 1 ? first : { ...first, soleChild: false }; } });
  await w.svc.autoTick();
  untouched(w);
  assert.deepEqual(w.notices, []);
});

console.log(`\n${pass} passed`);
