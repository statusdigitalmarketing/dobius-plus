// A bare `claude` links to its session through its own record,
// <configDir>/sessions/<pid>.json, rather than start time against transcript
// birth. New Tab auto-starts Claude, so several in one project are normal, and
// timing declines whenever two unlinked ones coexist. HOME points at a
// throwaway dir before importing, same trick as fresh-session.test.mjs.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/presence-session.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A zone away from UTC: Claude writes procStart in UTC, ps answers in local time.
process.env.TZ = 'America/New_York';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-presence-home-'));
process.env.HOME = home;
process.env.DOBIUS_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-presence-ud-'));
const { resolveFreshSessionsForTabs, provenanceChanged } = await import('../data-service.js');
const { presenceSessionId } = await import('../claude-presence.js');

let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };

const PROJ = '/tmp/presence-test-project';
const projDir = path.join(home, '.claude', 'projects', PROJ.replace(/\//g, '-'));
fs.mkdirSync(projDir, { recursive: true });
const defaultDir = path.join(home, '.claude');
fs.mkdirSync(path.join(defaultDir, 'sessions'), { recursive: true });

const sid = (n) => `${String(n).repeat(8)}-1111-1111-1111-111111111111`;
const [S1, S2, S3, S4] = [1, 2, 3, 4].map(sid);
const transcript = (id) => fs.writeFileSync(path.join(projDir, `${id}.jsonl`), '{"type":"user"}\n');

// `ps lstart` text under TZ=UTC, as Claude writes it. Whole seconds, as ps
// reports them. Shape from a real record: "Tue Oct 27 12:49:51 2026".
const NOW = Math.floor(Date.now() / 1000) * 1000;
const lstart = (ms) => {
  const [w, d, mon, y, time] = new Date(ms).toUTCString().replace(',', '').split(' ');
  return `${w} ${mon} ${String(Number(d)).padStart(2, ' ')} ${time} ${y}`;
};
const record = (pid, startedAt, sessionId, over = {}, dir = defaultDir) => {
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, procStart: lstart(startedAt), status: 'idle', ...over }));
};
const clean = () => {
  for (const f of fs.readdirSync(projDir)) fs.rmSync(path.join(projDir, f));
  for (const f of fs.readdirSync(path.join(defaultDir, 'sessions'))) fs.rmSync(path.join(defaultDir, 'sessions', f));
};

// tabs: { id: { pid, startedAt, configDir, argv } }
async function resolve(tabs, { map = {}, claimed } = {}) {
  const liveTabs = [];
  const info = new Map();
  const cwd = new Map();
  for (const [id, t] of Object.entries(tabs)) {
    liveTabs.push({ id, cwd: PROJ, claudeConfigDir: t.configDir ?? null });
    info.set(id, { sessionId: t.argv || null, startedAt: t.startedAt, pid: t.pid });
    if (!t.argv) cwd.set(id, PROJ);
  }
  const tabToSession = new Map(Object.entries(map));
  const claimedIds = new Set(claimed || Object.values(map));
  const proven = new Set();
  const out = await resolveFreshSessionsForTabs(liveTabs, info, cwd, tabToSession, claimedIds, undefined, proven);
  return { out: Object.fromEntries(out), proven: [...proven].sort(), claimedIds };
}

const earlier = NOW - 60_000;
const later = NOW - 30_000;

// Two bare claudes, each with its own record: each links to its own session,
// whichever started first and whichever transcript was born first. Timing alone
// would decline (both started before both births).
{
  clean();
  transcript(S1); transcript(S2);
  record(101, earlier, S2);
  record(102, later, S1);
  const r = await resolve({ A: { pid: 101, startedAt: earlier }, B: { pid: 102, startedAt: later } });
  assert.deepEqual(r.out, { A: S2, B: S1 });
  assert.deepEqual(r.proven, ['A', 'B']);
  ok('two bare claudes in one project: each links to its own session');
}

// The real shape on a Mac in New York: the record's text reads four hours (or
// five) ahead of ps, and it is still the same process.
{
  const proc = Date.parse('Tue Oct 27 08:49:51 2026'); // ps, local
  assert.equal(new Date(proc).getTimezoneOffset(), 240, 'the test really runs away from UTC');
  clean();
  transcript(S1);
  fs.writeFileSync(path.join(defaultDir, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: S1, procStart: 'Tue Oct 27 12:49:51 2026' }));
  assert.equal(await presenceSessionId({ pid: 101, startedAt: proc }), S1);
  fs.writeFileSync(path.join(defaultDir, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: S1, procStart: 'Tue Oct 27 08:49:51 2026' }));
  assert.equal(await presenceSessionId({ pid: 101, startedAt: proc }), null, 'the same wall clock in the wrong zone is another process');
  ok('the record\'s start time is UTC, ps is local');
}

// One idle (a record, no transcript until its first message): it links to
// nothing, in either start order, and stops nobody else linking.
for (const [idleStart, busyStart] of [[earlier, later], [later, earlier]]) {
  clean();
  transcript(S2);
  record(101, idleStart, S1);
  record(102, busyStart, S2);
  const r = await resolve({ IDLE: { pid: 101, startedAt: idleStart }, BUSY: { pid: 102, startedAt: busyStart } });
  assert.deepEqual(r.out, { BUSY: S2 });
  assert.deepEqual(r.proven, ['BUSY']);
}
ok('an idle claude does not stop another tab linking, in either start order');

// The idle tab is settled by its record, so it never picks up a transcript by
// timing, and is no rival for a tab that has no record (an older Claude).
{
  clean();
  record(101, earlier, S1);
  transcript(S2);
  const r = await resolve({ IDLE: { pid: 101, startedAt: earlier }, OLD: { pid: 102, startedAt: earlier } });
  assert.deepEqual(r.out, { OLD: S2 }, 'the old claude resolves by timing, the idle one takes nothing');
  assert.deepEqual(r.proven, []);
  ok('a record with no transcript yet links nothing and is no rival');
}

// A tab with no record cannot take by timing an id another tab's record names.
{
  clean();
  transcript(S1);
  record(101, earlier, S1, {}, defaultDir);
  const r = await resolve({ REC: { pid: 101, startedAt: earlier }, OLD: { pid: 102, startedAt: earlier } });
  assert.deepEqual(r.out, { REC: S1 });
  // Nor keep it through a stale link of its own.
  const stale = await resolve({ REC: { pid: 101, startedAt: earlier }, OLD: { pid: 102, startedAt: earlier } }, { map: { OLD: S1 } });
  assert.equal(stale.out.OLD, undefined, 'stale own link is not re-exposed');
  ok('timing cannot take an id another tab\'s record names');
}

// A record that is not this process: ignored, and timing decides as before.
for (const [what, over] of [
  ['another pid', { pid: 999 }],
  ['another start time', { procStart: lstart(earlier - 5000) }],
  ['no start time', { procStart: undefined }],
]) {
  clean();
  transcript(S1);
  record(101, earlier, S2, over);
  const r = await resolve({ A: { pid: 101, startedAt: earlier } });
  assert.deepEqual(r.out, { A: S1 }, what);
  assert.deepEqual(r.proven, [], what);
}
ok('a record for another pid or start time is ignored, timing decides');

// An id that is not a session id never reaches a path, whatever is on disk.
for (const bad of ['../../../etc/passwd', 'not-a-uuid', '', 42, null, `${S1}/../${S2}`]) {
  clean();
  transcript(S1);
  record(101, earlier, bad);
  const r = await resolve({ A: { pid: 101, startedAt: earlier } });
  assert.deepEqual(r.proven, [], String(bad));
  assert.deepEqual(r.out, { A: S1 }, String(bad));
}
ok('a malformed session id is ignored');

// No record at all, or an unreadable one: exactly the old behaviour.
{
  clean();
  transcript(S1);
  assert.deepEqual((await resolve({ A: { pid: 101, startedAt: earlier } })).out, { A: S1 }, 'one claude: timing links it');
  const both = await resolve({ A: { pid: 101, startedAt: earlier }, B: { pid: 102, startedAt: later } });
  assert.deepEqual(both.out, {}, 'two unlinked claudes with no record: ambiguity guard still declines');
  fs.writeFileSync(path.join(defaultDir, 'sessions', '101.json'), '{ half a rewri');
  assert.deepEqual((await resolve({ A: { pid: 101, startedAt: earlier } })).proven, [], 'unreadable JSON');
  // No pid known (older probe shape).
  assert.deepEqual((await resolve({ A: { startedAt: earlier } })).out, { A: S1 });
  ok('a missing or unreadable record falls back to timing');
}

// One session, one tab: a valid record never steals another tab's link, and
// never falls through to timing, which could then hand this tab a wrong one.
{
  clean();
  transcript(S1); transcript(S2);
  record(101, earlier, S1);
  const linked = await resolve({ A: { pid: 101, startedAt: earlier } }, { map: { OTHER: S1 } });
  assert.deepEqual(linked.out, {}, 'linked to another tab');
  const argv = await resolve({ A: { pid: 101, startedAt: earlier }, B: { pid: 102, startedAt: later, argv: S1 } });
  assert.deepEqual(argv.out, {}, 'named in another tab\'s argv');
  const stale = await resolve({ A: { pid: 101, startedAt: earlier }, B: { pid: 102, startedAt: later, argv: S1 } }, { map: { A: S1 } });
  assert.deepEqual(stale.out, {}, 'own stale link, another tab\'s argv names it');
  const own = await resolve({ A: { pid: 101, startedAt: earlier } }, { map: { A: S1 } });
  assert.deepEqual(own.out, { A: S1 }, 'its own link still passes');
  // Two records naming one session: the tab already linked keeps it, else the
  // earliest started takes it. Never both.
  record(102, later, S1);
  const twoMapped = await resolve({ A: { pid: 101, startedAt: earlier }, B: { pid: 102, startedAt: later } }, { map: { B: S1 } });
  assert.deepEqual(twoMapped.out, { B: S1 });
  const twoFree = await resolve({ A: { pid: 101, startedAt: earlier }, B: { pid: 102, startedAt: later } });
  assert.deepEqual(twoFree.out, { A: S1 });
  ok('one session links to one tab');
}

// Another child in the shell (a suspended claude, a second one): the link is
// exact for that process but only a name, so auto-resume never types it.
{
  clean();
  transcript(S1);
  record(101, earlier, S1);
  const liveTabs = [{ id: 'A', cwd: PROJ, claudeConfigDir: null }];
  const info = new Map([['A', { sessionId: null, startedAt: earlier, pid: 101, soleChild: false }]]);
  const proven = new Set();
  const out = await resolveFreshSessionsForTabs(liveTabs, info, new Map([['A', PROJ]]), new Map(), new Set(), undefined, proven);
  assert.equal(out.get('A'), S1);
  assert.deepEqual([...proven], []);
  info.get('A').soleChild = true;
  await resolveFreshSessionsForTabs(liveTabs, info, new Map([['A', PROJ]]), new Map(), new Set(), undefined, proven);
  assert.deepEqual([...proven], ['A']);
  ok('a claude that is not the shell\'s only child is named, not proven');
}

// What a tab's saved link is re-tagged to, on the tick and at quit alike.
{
  assert.equal(provenanceChanged('fresh', 'presence'), true, 'proven now');
  assert.equal(provenanceChanged('fresh', 'argv'), true);
  assert.equal(provenanceChanged('presence', 'fresh'), true, 'proof lapsed: auto-resume must stop typing it');
  assert.equal(provenanceChanged('argv', 'fresh'), false, 'argv is never lowered');
  assert.equal(provenanceChanged('presence', 'presence'), false);
  assert.equal(provenanceChanged('presence', 'argv'), false);
  assert.equal(provenanceChanged('fresh', 'fresh'), false);
  ok('a saved link is re-tagged when its proof changes');
}

// A valid record whose transcript is not in THIS project: no link, no timing.
{
  clean();
  transcript(S2);
  record(101, earlier, S3);
  assert.deepEqual((await resolve({ A: { pid: 101, startedAt: earlier } })).out, {});
  ok('no transcript in the project: no link');
}

// /clear: the record moves to the new session, whatever the tab's link says,
// and it does not need the new transcript to be the earliest born.
{
  clean();
  transcript(S1); transcript(S2);
  record(101, earlier, S2);
  const r = await resolve({ A: { pid: 101, startedAt: earlier } }, { map: { A: S1 } });
  assert.deepEqual(r.out, { A: S2 });
  assert.equal(r.claimedIds.has(S2), true);
  // Before the first message after /clear there is no transcript yet: nothing
  // to link, and the old session is not reported as still running.
  record(101, earlier, S4);
  assert.deepEqual((await resolve({ A: { pid: 101, startedAt: earlier } }, { map: { A: S1 } })).out, {});
  ok('a record follows /clear');
}

// The tab's own config dir is where the record lives; a relative one is refused.
{
  clean();
  transcript(S1); transcript(S2);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-presence-profile-'));
  record(101, earlier, S2, {}, profile);
  assert.deepEqual((await resolve({ A: { pid: 101, startedAt: earlier, configDir: profile } })).out, { A: S2 });
  assert.deepEqual((await resolve({ A: { pid: 101, startedAt: earlier } })).proven, [], 'not looked for in the default dir');
  assert.equal(await presenceSessionId({ pid: 101, startedAt: earlier }, 'relative/dir'), null);
  fs.rmSync(profile, { recursive: true, force: true });
  ok('the record is read from the tab\'s config dir');
}

// The reader's guards, through the real file: no symlinks, size capped.
{
  clean();
  const target = path.join(home, 'elsewhere.json');
  fs.writeFileSync(target, JSON.stringify({ pid: 101, sessionId: S1, procStart: lstart(earlier) }));
  fs.symlinkSync(target, path.join(defaultDir, 'sessions', '101.json'));
  assert.equal(await presenceSessionId({ pid: 101, startedAt: earlier }), null, 'symlink');
  fs.rmSync(path.join(defaultDir, 'sessions', '101.json'));
  record(101, earlier, S1, { pad: 'x'.repeat(70 * 1024) });
  assert.equal(await presenceSessionId({ pid: 101, startedAt: earlier }), null, 'oversized');
  record(101, earlier, S1);
  assert.equal(await presenceSessionId({ pid: 101, startedAt: earlier }), S1);
  assert.equal(await presenceSessionId({ pid: 101, startedAt: null }), null, 'no start time from ps');
  assert.equal(await presenceSessionId(null), null);
  ok('the reader refuses symlinks and oversized files');
}

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(process.env.DOBIUS_TEST_USERDATA, { recursive: true, force: true });
console.log(`\n${pass} passed`);
