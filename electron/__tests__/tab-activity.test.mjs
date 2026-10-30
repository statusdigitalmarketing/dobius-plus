// Tabs sidebar status labels: Working / Input / Waiting / Done (Brett, Asana
// 1220055135705774). Covers the pure label rules, main's turn timing in
// terminal-status, and the Claude presence-file reader behind "Waiting".
// Run: node --test ./electron/__tests__/tab-activity.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tabActivityLabel, formatDuration, WORKING_MIN_MS } from '../../src/lib/tab-activity.js';
import * as ts from '../terminal-status.js';
import { backgroundFromPresence, createPresenceReader, reconcileWithProcess, cachedPerTab, boundedIds, createTabActivity, coalescePerTab, judgePresence } from '../claude-presence.js';
import { classifyClaudeProcess } from '../claude-argv.js';
import { isProvenClaudeCommand, claudeChildVerdict } from '../claude-process-scan.js';

const NOW = 10_000_000;
const base = { live: true, status: 'idle', hookOwned: false, since: null, lastTurnMs: 0, background: null, unread: false, now: NOW };
const label = (over) => tabActivityLabel({ ...base, ...over });

test('formatDuration', () => {
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(4 * 60_000 + 5_000), '4m');
  assert.equal(formatDuration(65 * 60_000), '1h 5m');
  assert.equal(formatDuration(2 * 3600_000), '2h');
  assert.equal(formatDuration(3 * 86400_000), '3d');
  assert.equal(formatDuration(-1), '');
  assert.equal(formatDuration(NaN), '');
});

test('a closed tab never gets a live label, whatever its stale fields say', () => {
  assert.equal(label({ live: false, status: 'needs', unread: true, background: 'shells' }), null);
});

test('needs -> Input', () => {
  assert.deepEqual([label({ status: 'needs' }).kind, label({ status: 'needs' }).text], ['input', 'Input']);
});

test('hook working -> Working with the elapsed stretch', () => {
  const l = label({ status: 'working', hookOwned: true, since: NOW - 4 * 60_000 });
  assert.equal(l.kind, 'working');
  assert.equal(l.text, 'Working 4m');
});

test('hook working without a known start says Working, no made-up time', () => {
  assert.equal(label({ status: 'working', hookOwned: true, since: null }).text, 'Working');
  // A start in the future (clock moved) is not trusted either.
  assert.equal(label({ status: 'working', hookOwned: true, since: NOW + 5000 }).text, 'Working');
});

test('plain output must flow WORKING_MIN_MS before it counts as Working', () => {
  assert.equal(label({ status: 'working', since: NOW - (WORKING_MIN_MS - 1) }), null);
  assert.equal(label({ status: 'working', since: NOW - WORKING_MIN_MS }).text, 'Working 3s');
});

test('Working beats Waiting and Done', () => {
  const l = label({ status: 'working', hookOwned: true, since: NOW - 1000, unread: true, background: 'agents' });
  assert.equal(l.kind, 'working');
});

test('turn over with background work -> Waiting (shells and agents)', () => {
  assert.equal(label({ status: 'done', background: 'shells' }).kind, 'waiting');
  assert.match(label({ status: 'done', background: 'shells' }).title, /shell/);
  assert.match(label({ status: 'idle', background: 'agents' }).title, /agent/);
  // Waiting outranks an unread Done: work is still happening.
  assert.equal(label({ status: 'done', background: 'agents', unread: true }).kind, 'waiting');
  assert.equal(label({ status: 'done', background: 'bogus' }), null);
  // Typing at the prompt (brief plain output) does not hide it.
  assert.equal(label({ status: 'working', since: NOW - 500, background: 'shells' }).kind, 'waiting');
});

test('unread -> Done with how long the turn worked', () => {
  const l = label({ status: 'done', unread: true, lastTurnMs: 12 * 60_000 });
  assert.equal(l.kind, 'done');
  assert.equal(l.text, 'Done 12m');
  assert.equal(label({ status: 'idle', unread: true }).text, 'Done');
});

test('viewed (not unread) and nothing running -> plain age', () => {
  assert.equal(label({ status: 'done', lastTurnMs: 60_000 }), null);
});

// --- main's turn timing ------------------------------------------------------
const mk = (s) => `\x1b]777;dobius;${s}\x07`;
const ID = 'term-/Users/sam/Projects (Code)/demo-1';

test('a hook turn: start, needs inside the turn, done records its length', () => {
  ts._reset();
  ts.ingest(ID, 'prompt typed\r\n', 1000);
  ts.ingest(ID, mk('working'), 5000);
  assert.equal(ts.activityFor(ID).since, 5000);
  ts.ingest(ID, mk('working'), 9000); // PreToolUse: same turn
  assert.equal(ts.activityFor(ID).since, 5000);
  ts.ingest(ID, mk('needs'), 20_000);
  assert.equal(ts.activityFor(ID).since, 5000, 'a permission prompt keeps the turn start');
  ts.ingest(ID, mk('working'), 30_000);
  assert.equal(ts.activityFor(ID).since, 5000);
  ts.ingest(ID, mk('done'), 65_000);
  const a = ts.activityFor(ID);
  assert.equal(a.status, 'done');
  assert.equal(a.since, null);
  assert.equal(a.lastTurnMs, 60_000);
  assert.equal(a.turnEndedAt, 65_000);
});

test('the next turn starts fresh; a repeated done keeps the real length', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 1000);
  ts.ingest(ID, mk('done'), 4000);
  ts.ingest(ID, mk('done'), 70_000); // idle_prompt re-send
  assert.equal(ts.activityFor(ID).lastTurnMs, 3000);
  ts.ingest(ID, mk('working'), 80_000);
  assert.equal(ts.activityFor(ID).since, 80_000);
});

test('plain output stretch: since is when output started, no turn recorded', () => {
  ts._reset();
  ts.ingest(ID, 'x', 1000);
  ts.settle(4000);
  assert.equal(ts.activityFor(ID).status, 'idle');
  ts.ingest(ID, 'build line 1\r\n', 10_000);
  ts.ingest(ID, 'build line 2\r\n', 11_000);
  const a = ts.activityFor(ID);
  assert.equal(a.since, 10_000);
  assert.equal(a.turnEndedAt, 0, 'no hook, so Waiting can never be asked for');
});

// --- presence file -----------------------------------------------------------
const LSTART = 'Tue Oct 27 13:39:54 2026';
const proc = { pid: 4242, startedAt: Date.parse(LSTART) };
const END = Date.parse(LSTART) + 60_000; // the hook ended a turn a minute in
// statusUpdatedAt: the CLI wrote this state when the turn started, before it ended.
// The reader returns this process's record; judge it the way main does after
// an ended turn, which is what these tests assert on.
const bg = async (read, id, end, expected = proc) => judgePresence(
  await read(id, `e:${end}`), { status: 'done', hookOwned: false, turnEndedAt: end }, expected,
).background;
const rec = (over) => ({ pid: 4242, procStart: LSTART, status: 'idle', statusUpdatedAt: Date.parse(LSTART) + 500, ...over });

test('presence: shell -> shells, busy -> agents, else nothing', () => {
  assert.equal(backgroundFromPresence(rec({ status: 'shell' }), proc), 'shells');
  assert.equal(backgroundFromPresence(rec({ status: 'busy' }), proc), 'agents');
  assert.equal(backgroundFromPresence(rec({ status: 'idle' }), proc), null);
  assert.equal(backgroundFromPresence(rec({ status: 'waiting' }), proc), null);
});

test('presence: a file for another process is never trusted', () => {
  assert.equal(backgroundFromPresence(rec({ status: 'shell', pid: 1 }), proc), null);
  assert.equal(backgroundFromPresence(rec({ status: 'shell', procStart: 'Tue Oct 27 13:39:55 2026' }), proc), null);
  assert.equal(backgroundFromPresence(rec({ status: 'shell', procStart: undefined }), proc), null);
  assert.equal(backgroundFromPresence(rec({ status: 'shell' }), { pid: 4242, startedAt: null }), null);
  assert.equal(backgroundFromPresence(null, proc), null);
  assert.equal(backgroundFromPresence([rec({ status: 'shell' })], proc), null);
});

test('presence reader: resolves dir once per process, caches briefly, never throws', async () => {
  let t = 0;
  let dirCalls = 0;
  const files = { '/cfg/sessions/4242.json': JSON.stringify(rec({ status: 'shell' })) };
  const read = createPresenceReader({
    claudeInfo: async (tabId) => (tabId === 'a' ? proc : null),
    configDirOf: async () => { dirCalls += 1; return '/cfg'; },
    readFile: async (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; },
    now: () => t,
  });
  assert.equal(await bg(read, 'a', END), 'shells');
  assert.equal(await read('b', END), null, 'no claude in the tab');
  files['/cfg/sessions/4242.json'] = JSON.stringify(rec({ status: 'idle' }));
  assert.equal(await bg(read, 'a', END), 'shells', 'cached inside the window');
  t = 5000;
  assert.equal(await bg(read, 'a', END), null, 're-read after the cache window');
  assert.equal(dirCalls, 1);
  files['/cfg/sessions/4242.json'] = '{not json';
  t = 10_000;
  assert.equal(await bg(read, 'a', END), null, 'a half-written file is no claim');
});

test('presence reader: an unprovable binding answers null and is retried', async () => {
  let dirCalls = 0;
  let t = 0;
  const read = createPresenceReader({
    claudeInfo: async () => proc,
    configDirOf: async () => { dirCalls += 1; return null; },
    readFile: async () => JSON.stringify(rec({ status: 'shell' })),
    now: () => t,
  });
  assert.equal(await bg(read, 'a', END), null);
  t = 5000;
  assert.equal(await bg(read, 'a', END), null);
  assert.equal(dirCalls, 2);
});

test('presence reader: a claude started AFTER the turn ended never inherits it', async () => {
  const read = createPresenceReader({
    claudeInfo: async () => proc,
    configDirOf: async () => '/cfg',
    readFile: async () => JSON.stringify(rec({ status: 'shell' })),
    now: () => 0,
  });
  // Process A's turn ended a minute BEFORE this process (B) started.
  assert.equal(await bg(read, 'a', proc.startedAt - 60_000), null);
  // Same cached lookup, a turn this process was alive for.
  assert.equal(await bg(read, 'a', proc.startedAt + 1000), 'shells');
});

test('presence reader: the real file reader refuses non-files and oversize files', async () => {
  const fsMod = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'presence-'));
  fsMod.mkdirSync(pathMod.join(dir, 'sessions'));
  const file = pathMod.join(dir, 'sessions', '4242.json');
  const reader = () => createPresenceReader({ claudeInfo: async () => proc, configDirOf: async () => dir, now: () => 0 });
  try {
    fsMod.writeFileSync(file, JSON.stringify(rec({ status: 'shell' })));
    assert.equal(await bg(reader(), 'a', END), 'shells', 'a normal file reads');
    fsMod.writeFileSync(file, JSON.stringify(rec({ status: 'shell', pad: 'x'.repeat(70 * 1024) })));
    assert.equal(await bg(reader(), 'a', END), null, 'oversize is refused');
    fsMod.rmSync(file);
    const target = pathMod.join(dir, 'real.json');
    fsMod.writeFileSync(target, JSON.stringify(rec({ status: 'shell' })));
    fsMod.symlinkSync(target, file);
    assert.equal(await bg(reader(), 'a', END), null, 'a symlink is not followed');
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
});

test('coalesced markers: one chunk ending a turn and starting the next', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 1000);
  ts.ingest(ID, mk('done') + 'prompt' + mk('working'), 121_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 120_000);
  assert.equal(ts.activityFor(ID).since, 121_000, 'the new turn starts at the chunk, not at 1000');
  ts.ingest(ID, mk('done'), 151_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 30_000);
});

test('forget: a respawned PTY does not inherit the old turn', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 1000);
  ts.forget(ID);
  ts.ingest(ID, mk('working'), 131_000);
  ts.ingest(ID, mk('done'), 161_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 30_000);
});

test('presence reader: a claude started in the same second the turn ended is not proof', async () => {
  const read = createPresenceReader({
    claudeInfo: async () => proc,
    configDirOf: async () => '/cfg',
    readFile: async () => JSON.stringify(rec({ status: 'shell' })),
    now: () => 0,
  });
  assert.equal(await bg(read, 'a', proc.startedAt + 900), null);
  assert.equal(await bg(read, 'a', proc.startedAt + 1000), 'shells');
});

test('presence reader: concurrent asks share one lookup', async () => {
  let infoCalls = 0;
  const read = createPresenceReader({
    claudeInfo: async () => { infoCalls += 1; await new Promise((r) => setTimeout(r, 20)); return proc; },
    configDirOf: async () => '/cfg',
    readFile: async () => JSON.stringify(rec({ status: 'shell' })),
    now: () => 0,
  });
  const out = await Promise.all(Array.from({ length: 50 }, () => bg(read, 'a', END)));
  assert.equal(infoCalls, 1);
  assert.ok(out.every((v) => v === 'shells'));
});

test('presence reader: an answer cached for one turn is never served for the next', async () => {
  let status = 'busy'; // read while a NEW turn was running
  const read = createPresenceReader({
    claudeInfo: async () => proc,
    configDirOf: async () => '/cfg',
    readFile: async () => JSON.stringify(rec({ status })),
    now: () => 0, // inside the cache window throughout
  });
  assert.equal(await bg(read, 'a', END), 'agents');
  status = 'idle'; // that turn ended with nothing in the background
  assert.equal(await bg(read, 'a', END + 30_000), null);
});

test('reconcile: a hook turn with no claude left in the tab is not Working', () => {
  const a = { status: 'working', hookOwned: true, since: 1000, lastTurnMs: 0, turnEndedAt: 0 };
  const r = reconcileWithProcess(a, null);
  assert.deepEqual([r.status, r.hookOwned, r.since], ['idle', false, null]);
  assert.equal(label({ ...r, live: true }), null);
  // A finished turn keeps its length when claude has since exited (Done 12m stays right).
  const done = { status: 'done', hookOwned: false, since: null, lastTurnMs: 720_000, turnEndedAt: 2_000_000 };
  assert.deepEqual(reconcileWithProcess(done, null), done);
});

test('reconcile: a turn older than the claude now running loses its times', () => {
  const info = { pid: 1, startedAt: 100_000 };
  const working = reconcileWithProcess({ status: 'working', hookOwned: true, since: 50_000, lastTurnMs: 0, turnEndedAt: 0 }, info);
  assert.equal(working.since, null);
  assert.equal(working.status, 'working', 'still Working, just without a made-up time');
  const done = reconcileWithProcess({ status: 'done', hookOwned: false, since: null, lastTurnMs: 90_000, turnEndedAt: 130_000 }, info);
  assert.equal(done.lastTurnMs, 0);
  const ok = reconcileWithProcess({ status: 'done', hookOwned: false, since: null, lastTurnMs: 20_000, turnEndedAt: 130_000 }, info);
  assert.equal(ok.lastTurnMs, 20_000);
});

test('cachedPerTab shares a pending call and expires', async () => {
  let t = 0;
  let calls = 0;
  const f = cachedPerTab(async (id) => { calls += 1; return id; }, 2500, () => t);
  await Promise.all([f('a'), f('a'), f('a')]);
  assert.equal(calls, 1);
  t = 3000;
  assert.equal(await f('a'), 'a');
  assert.equal(calls, 2);
  const g = cachedPerTab(async () => { throw new Error('x'); }, 2500, () => 0);
  assert.equal(await g('a'), null, 'a failed lookup is no answer, never a throw');
});

test('presence reader: busy written AFTER the turn ended is a new foreground turn, not Waiting', async () => {
  let written = Date.parse(LSTART) + 500;
  const read = createPresenceReader({
    claudeInfo: async () => proc,
    configDirOf: async () => '/cfg',
    readFile: async () => JSON.stringify(rec({ status: 'busy', statusUpdatedAt: written })),
    now: () => 0,
  });
  assert.equal(await bg(read, 'a', END), 'agents');
  written = END + 5000;
  assert.equal(await bg(read, 'a', END + 1), null);
  // Missing timestamp: cannot prove it, so no claim.
  const r2 = createPresenceReader({
    claudeInfo: async () => proc, configDirOf: async () => '/cfg', now: () => 0,
    readFile: async () => JSON.stringify(rec({ status: 'busy', statusUpdatedAt: undefined })),
  });
  assert.equal(await bg(r2, 'a', END), null);
  // A background shell is written at the turn's end or later, so no such rule.
  const r3 = createPresenceReader({
    claudeInfo: async () => proc, configDirOf: async () => '/cfg', now: () => 0,
    readFile: async () => JSON.stringify(rec({ status: 'shell', statusUpdatedAt: END + 200 })),
  });
  assert.equal(await bg(r3, 'a', END), 'shells');
});

test('reconcile: hook state left by a claude that died is not the new claude\'s', () => {
  const info = { pid: 2, startedAt: 100_000 };
  // A's permission prompt at 50s, A died, B (hooks off) started at 100s.
  const stale = reconcileWithProcess({ status: 'needs', hookOwned: true, since: 40_000, lastTurnMs: 0, turnEndedAt: 0, lastMarkerAt: 50_000 }, info);
  assert.deepEqual([stale.status, stale.hookOwned], ['idle', false]);
  // B (hooks on) sent its own working marker at 110s: still Working, A's start dropped.
  const own = reconcileWithProcess({ status: 'working', hookOwned: true, since: 40_000, lastTurnMs: 0, turnEndedAt: 0, lastMarkerAt: 110_000 }, info);
  assert.deepEqual([own.status, own.hookOwned, own.since], ['working', true, null]);
});

test('an idle-prompt re-send does not move the turn end', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 40_000);
  ts.ingest(ID, mk('done'), 100_000);
  const a = ts.activityFor(ID);
  assert.deepEqual([a.lastTurnMs, a.turnEndedAt, a.lastMarkerAt], [30_000, 40_000, 100_000]);
});

test('a slow lookup is shared past its ttl, never run twice at once', async () => {
  let t = 0;
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = cachedPerTab(async () => { calls += 1; await gate; return 'x'; }, 2500, () => t);
  const p1 = f('a');
  t = 8000; // far past the ttl, first call still running
  const p2 = f('a');
  release();
  assert.deepEqual(await Promise.all([p1, p2]), ['x', 'x']);
  assert.equal(calls, 1);
});

test('a disproved turn length stays gone after the claude that disproved it exits', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000); // claude A, killed later without Stop
  ts.ingest(ID, mk('working'), 45_000); // claude B (started at 40s) begins its turn
  const B = { pid: 9, startedAt: 40_000 };
  // main's check while B runs: the turn start predates B.
  let raw = ts.activityFor(ID);
  let a = reconcileWithProcess(raw, B);
  assert.equal(a.since, null);
  if (raw.since && !a.since && a.status === raw.status) ts.distrustTurnStart(ID, raw.since);
  ts.ingest(ID, mk('done'), 65_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 0, 'B finished; the 55s span over A and B is not a length');
  // Without the earlier check, the length is still caught and remembered.
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 65_000);
  raw = ts.activityFor(ID);
  a = reconcileWithProcess(raw, B);
  if (raw.lastTurnMs && !a.lastTurnMs) ts.distrustLastTurn(ID, raw.turnEndedAt);
  // B exits: no claude left to prove anything with.
  assert.equal(reconcileWithProcess(ts.activityFor(ID), null).lastTurnMs, 0);
});

test('reconcile: within the second a claude started counts as before it', () => {
  const info = { pid: 2, startedAt: 100_000 }; // real start anywhere in 100.0-100.999s
  // A's needs at 100.1s, then A died and B started at 100.8s (ps says 100s).
  const stale = reconcileWithProcess({ status: 'needs', hookOwned: true, since: 90_000, lastTurnMs: 0, turnEndedAt: 0, lastMarkerAt: 100_100 }, info);
  assert.deepEqual([stale.status, stale.hookOwned], ['idle', false]);
  const since = reconcileWithProcess({ status: 'working', hookOwned: true, since: 100_200, lastTurnMs: 0, turnEndedAt: 0, lastMarkerAt: 105_000 }, info);
  assert.deepEqual([since.status, since.since], ['working', null]);
  const own = reconcileWithProcess({ status: 'working', hookOwned: true, since: 101_000, lastTurnMs: 0, turnEndedAt: 0, lastMarkerAt: 105_000 }, info);
  assert.equal(own.since, 101_000, 'a turn from the next second on is this claude\'s');
});

test('boundedIds cuts before it walks (a sparse huge array is cheap)', () => {
  const huge = [];
  huge.length = 0xffffffff;
  huge[0] = 'a';
  const t0 = Date.now();
  assert.deepEqual(boundedIds(huge, 1000), ['a']);
  assert.ok(Date.now() - t0 < 500);
  assert.deepEqual(boundedIds(['a', 1, null, 'x'.repeat(5000), 'b'], 1000), ['a', 'b']);
  assert.deepEqual(boundedIds('nope', 10), []);
});

test('the unique claude lookup relies on: a command that only names the CLI is not claude', () => {
  assert.notEqual(classifyClaudeProcess('node /tmp/watcher.js /opt/homebrew/bin/claude').kind, 'claude');
  assert.notEqual(classifyClaudeProcess("node -e setInterval(()=>{},1000) /opt/homebrew/bin/claude").kind, 'claude');
  assert.equal(classifyClaudeProcess('/Users/a/.local/bin/claude --resume abc').kind, 'claude');
});

test('a hook turn main cannot see a claude for shows the age, not an older Done', () => {
  // A 2m turn finished unseen; a new turn's working marker came, but claude
  // runs behind a wrapper (bash -c 'claude; :') so no claude is visible.
  const r = reconcileWithProcess({ status: 'working', hookOwned: true, since: 500_000, lastTurnMs: 120_000, turnEndedAt: 400_000, lastMarkerAt: 500_000 }, null);
  assert.equal(r.uncertain, true);
  assert.equal(label({ ...r, live: true, unread: true }), null);
  // Without the doubt flag the unread fallback would have said Done 2m.
  assert.equal(label({ ...r, uncertain: false, live: true, unread: true }).text, 'Done 2m');
});

const makeActivity = (over = {}) => createTabActivity({
  status: ts,
  claudeInfo: async () => null,
  presenceForTab: async () => ({ pid: 1, startedAt: 100_000, status: 'busy', statusUpdatedAt: 900_000 }),
  unreadAnywhere: () => false,
  now: () => 1_000_000,
  ...over,
});

test('tab activity: no claude left means no Waiting, whatever a cached presence says', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 900_000);
  ts.ingest(ID, mk('done'), 950_000);
  const { tabActivity } = makeActivity({ claudeInfo: async () => null });
  assert.equal((await tabActivity(ID)).activity.background, null);
  const withClaude = makeActivity({ claudeInfo: async () => ({ pid: 1, startedAt: 100_000 }) });
  assert.equal((await withClaude.tabActivity(ID)).activity.background, 'agents');
});

test('tab activity: a turn that ends while the process check runs loses the disproved length', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000); // claude A, died without Stop
  ts.ingest(ID, mk('working'), 45_000); // claude B (started 40s)
  const { tabActivity } = makeActivity({
    claudeInfo: async () => { ts.ingest(ID, mk('done'), 65_000); return { pid: 2, startedAt: 40_000 }; },
    now: () => 66_000,
  });
  await tabActivity(ID);
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
});

test('tab activity: the turn-end check catches a merged length with no sidebar open', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  const before = ts.turnEndedAtFor(ID);
  ts.ingest(ID, mk('done'), 65_000);
  assert.notEqual(ts.turnEndedAtFor(ID), before);
  const { checkTurnAgainstProcess } = makeActivity({ claudeInfo: async () => ({ pid: 2, startedAt: 40_000 }) });
  await checkTurnAgainstProcess(ID, ts.activityFor(ID));
  // Later, with B gone, nothing can re-prove it, and nothing brings it back.
  assert.equal(reconcileWithProcess(ts.activityFor(ID), null).lastTurnMs, 0);
});

test('reconcile: stale hook state under a new claude is uncertain (it may work without hooks)', () => {
  const r = reconcileWithProcess({ status: 'working', hookOwned: true, since: 50_000, lastTurnMs: 30_000, turnEndedAt: 40_000, lastMarkerAt: 50_000 }, { pid: 3, startedAt: 100_000 });
  assert.equal(r.uncertain, true);
  assert.equal(label({ ...r, live: true, unread: true }), null);
});

test('the unique lookup needs a PROVEN claude: a path token that is a directory is not one', async () => {
  const fsMod = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'proven-'));
  try {
    fsMod.mkdirSync(pathMod.join(dir, 'claude'));           // `/tmp/x/claude tools/...` reads as /tmp/x/claude
    assert.equal(await isProvenClaudeCommand(`node ${dir}/claude tools/sleep.js`), false);
    fsMod.writeFileSync(pathMod.join(dir, 'bin-claude'), '');
    fsMod.mkdirSync(pathMod.join(dir, 'bin'));
    fsMod.renameSync(pathMod.join(dir, 'bin-claude'), pathMod.join(dir, 'bin', 'claude'));
    assert.equal(await isProvenClaudeCommand(`${dir}/bin/claude --resume abc`), false, 'not executable');
    fsMod.chmodSync(pathMod.join(dir, 'bin', 'claude'), 0o755);
    assert.equal(await isProvenClaudeCommand(`${dir}/bin/claude --resume abc`), true);
    assert.equal(await isProvenClaudeCommand('claude'), true, 'a bare name cannot be checked');
    assert.equal(await isProvenClaudeCommand(`node /tmp/watcher.js ${dir}/bin/claude`), false);
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
});

test('tab activity: an ended turn with no length still gets its Waiting', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 900_000);
  ts.ingest(ID, mk('done'), 950_000);
  ts.distrustLastTurn(ID, 950_000); // its length was disproved earlier
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 100_000 }),
    presenceForTab: async () => ({ pid: 1, startedAt: 100_000, status: 'shell', statusUpdatedAt: 950_000 }),
  });
  assert.equal((await tabActivity(ID)).activity.background, 'shells');
});

test('presence reader: a cached answer is dropped for a different claude than the caller sees', async () => {
  const read = createPresenceReader({
    claudeInfo: async () => proc,
    configDirOf: async () => '/cfg',
    readFile: async () => JSON.stringify(rec({ status: 'shell' })),
    now: () => 0,
  });
  assert.equal(await bg(read, 'a', END, proc), 'shells');
  assert.equal(await bg(read, 'a', END, { pid: 777, startedAt: proc.startedAt + 20_000 }), null);
});

test('a distrusted plain stretch does not hide the next one', () => {
  ts._reset();
  ts.ingest(ID, 'out', 42_000);
  ts.distrustTurnStart(ID, 42_000);
  assert.equal(ts.activityFor(ID).since, null);
  ts.settle(50_000);
  ts.ingest(ID, 'build', 60_000);
  assert.equal(ts.activityFor(ID).since, 60_000);
});

test('reconcile: a claude started after the last turn ended makes its Done uncertain', () => {
  const r = reconcileWithProcess({ status: 'idle', hookOwned: false, since: null, lastTurnMs: 30_000, turnEndedAt: 40_000, lastMarkerAt: 40_000 }, { pid: 5, startedAt: 100_000 });
  assert.equal(r.uncertain, true);
  assert.equal(label({ ...r, live: true, unread: true }), null);
  // The claude that ran the turn is still there: Done stands.
  const same = reconcileWithProcess({ status: 'done', hookOwned: false, since: null, lastTurnMs: 30_000, turnEndedAt: 40_000, lastMarkerAt: 40_000 }, { pid: 5, startedAt: 1_000 });
  assert.equal(label({ ...same, live: true, unread: true }).text, 'Done 30s');
});

test('turn-end check reads the process fresh, not the cache', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 102_000);
  const { checkTurnAgainstProcess } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 1_000 }),        // cached: dead claude A
    claudeInfoFresh: async () => ({ pid: 2, startedAt: 100_000 }), // now: claude B
  });
  await checkTurnAgainstProcess(ID, ts.activityFor(ID), { fresh: true });
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
});

test('a start disproved together with a stale state is still remembered', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000); // A, dies without Stop
  const { checkTurnAgainstProcess } = makeActivity({ claudeInfo: async () => ({ pid: 2, startedAt: 40_000 }) });
  await checkTurnAgainstProcess(ID, ts.activityFor(ID)); // finds the state stale (idle)
  ts.ingest(ID, mk('working'), 60_000); // B, same turn record
  ts.ingest(ID, mk('done'), 65_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
});

test('cache eviction never drops a pending lookup', async () => {
  let calls = 0;
  const gates = [];
  const f = cachedPerTab((id) => { calls += 1; return new Promise((r) => gates.push(() => r(id))); }, 2500, () => 0);
  for (let i = 0; i < 520; i += 1) f(`t${i}`);
  f('t0');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 520, 't0 is still pending, so it is shared, not started again');
  gates.forEach((g) => g());
});

test('turn-end checks: 50 rapid triggers for one tab cause at most 2 lookups', async () => {
  let t = 0;
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const timers = [];
  const check = coalescePerTab(async () => {
    calls += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight -= 1;
  }, 1000, { now: () => t, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  for (let i = 0; i < 50; i += 1) check('tab-a');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1, 'one runs now');
  assert.equal(timers.length, 1, 'the other 49 collapse into ONE trailing check');
  assert.equal(timers[0].ms, 1000, 'a second after the first started');
  t = 1000;
  timers[0].fn();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2);
  assert.equal(maxInFlight, 1);
  // Another tab is independent.
  check('tab-b');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 3);
});

test('turn-end checks: a failure reaches onError, nothing is thrown', async () => {
  const errors = [];
  const check = coalescePerTab(async () => { throw new Error('ps failed'); }, 1000, { onError: (id, e) => errors.push(`${id}:${e.message}`) });
  check('tab-a');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(errors, ['tab-a:ps failed']);
});

test('turn-end checks: a lookup slower than the interval still never overlaps', async () => {
  let t = 0;
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const check = coalescePerTab(async () => {
    calls += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
    if (calls === 1) await new Promise((r) => { release = r; });
    inFlight -= 1;
  }, 1000, { now: () => t, setTimer: (fn) => { fn(); return 1; } });
  check('tab-a');
  await new Promise((r) => setTimeout(r, 10));
  t = 5000; // the interval has long passed, the first scan is still running
  for (let i = 0; i < 10; i += 1) check('tab-a');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2, 'one trailing run');
  assert.equal(maxInFlight, 1);
});

test('judgePresence: a newer turn the hook never reported makes the row uncertain', () => {
  const found = (over) => ({ pid: 1, startedAt: 100_000, status: 'busy', statusUpdatedAt: 50_000 + 100_000, ...over });
  const a = { status: 'done', hookOwned: false, turnEndedAt: 140_000 };
  const info = { pid: 1, startedAt: 100_000 };
  assert.deepEqual(judgePresence(found(), a, info), { background: null, uncertain: true });
  assert.deepEqual(judgePresence(found({ statusUpdatedAt: 120_000 }), a, info), { background: 'agents', uncertain: false });
  assert.deepEqual(judgePresence(found({ status: 'waiting', statusUpdatedAt: 145_000 }), a, info), { background: null, uncertain: true });
  assert.deepEqual(judgePresence(found({ status: 'idle', statusUpdatedAt: 145_000 }), a, info), { background: null, uncertain: false });
});

test('judgePresence: a hook Working whose turn went idle without Stop is uncertain', () => {
  const info = { pid: 1, startedAt: 100_000 };
  const a = { status: 'working', hookOwned: true, turnEndedAt: 0, lastMarkerAt: 200_000 };
  assert.equal(judgePresence({ pid: 1, startedAt: 100_000, status: 'idle', statusUpdatedAt: 230_000 }, a, info).uncertain, true);
  assert.equal(judgePresence({ pid: 1, startedAt: 100_000, status: 'busy', statusUpdatedAt: 150_000 }, a, info).uncertain, false, 'a long quiet tool call stays Working');
  assert.equal(judgePresence({ pid: 1, startedAt: 100_000, status: 'idle', statusUpdatedAt: 190_000 }, a, info).uncertain, false, 'idle from before the marker is the old turn');
});

test('tab activity: a quiet hook Working that presence shows idle shows the age', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 900_000);
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 100_000 }),
    presenceForTab: async () => ({ pid: 1, startedAt: 100_000, status: 'idle', statusUpdatedAt: 950_000 }),
  });
  const r = await tabActivity(ID);
  assert.equal(r.activity.uncertain, true);
  assert.equal(label({ ...r.activity, live: true }), null);
});

test('tab activity: no claude after a normal exit keeps the finished turn length', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  // A snapshot taken while working, then the turn ends and claude exits.
  const { checkTurnAgainstProcess } = makeActivity({ claudeInfo: async () => { ts.ingest(ID, mk('done'), 70_000); return null; } });
  await checkTurnAgainstProcess(ID, ts.activityFor(ID));
  assert.equal(ts.activityFor(ID).lastTurnMs, 60_000);
});

test('judgePresence: any state after the marker other than the hook one ends it', () => {
  const info = { pid: 1, startedAt: 100_000 };
  const working = { status: 'working', hookOwned: true, turnEndedAt: 0, lastMarkerAt: 200_000 };
  const f = (status, at) => ({ pid: 1, startedAt: 100_000, status, statusUpdatedAt: at });
  assert.equal(judgePresence(f('shell', 230_000), working, info).uncertain, true, 'turn ended with a background shell');
  assert.equal(judgePresence(f('busy', 230_000), working, info).uncertain, false);
  const needs = { ...working, status: 'needs' };
  assert.equal(judgePresence(f('idle', 230_000), needs, info).uncertain, true, 'dialog answered, turn over');
  assert.equal(judgePresence(f('waiting', 230_000), needs, info).uncertain, false, 'the dialog is still open');
  const approved = judgePresence(f('busy', 230_000), needs, info);
  assert.deepEqual([approved.uncertain, approved.over, approved.showAs], [false, undefined, 'working'], 'approved: the turn goes on');
  assert.equal(judgePresence(f('waiting', 230_000), working, info).showAs, 'needs', 'a dialog the hook has not reported yet');
});

test('tab activity: an Input whose dialog went away without a marker shows the age', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 800_000);
  ts.ingest(ID, mk('needs'), 900_000);
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 100_000 }),
    presenceForTab: async () => ({ pid: 1, startedAt: 100_000, status: 'idle', statusUpdatedAt: 950_000 }),
  });
  assert.equal((await tabActivity(ID)).activity.uncertain, true);
});

test('no claude while a turn runs: its start is distrusted, so the next claude cannot inherit it', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000); // A dies without Stop
  const { checkTurnAgainstProcess } = makeActivity({ claudeInfo: async () => null });
  await checkTurnAgainstProcess(ID, ts.activityFor(ID)); // a poll at 30s finds no claude
  ts.ingest(ID, mk('working'), 45_000); // B
  ts.ingest(ID, mk('done'), 65_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
});

test('turn-end limiter: a full map never forgets a recent start', async () => {
  let t = 0;
  let calls = 0;
  const check = coalescePerTab(async () => { calls += 1; }, 1000, { now: () => t, setTimer: () => 1 });
  for (let i = 0; i < 1100; i += 1) check(`old-${i}`);
  await new Promise((r) => setTimeout(r, 30));
  t = 5000; // the old entries are past their interval and may go
  check('busy-tab');
  await new Promise((r) => setTimeout(r, 10));
  const before = calls;
  for (let i = 0; i < 10; i += 1) { check('busy-tab'); await new Promise((r) => setTimeout(r, 2)); }
  assert.equal(calls, before, 'within its interval: queued behind a timer, not run again');
});

test('a turn presence proved over is ended in the record, so a later turn starts fresh', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  let presence = { pid: 1, startedAt: 1_000, status: 'idle', statusUpdatedAt: 20_000 };
  let t = 25_000;
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 1_000 }),
    presenceForTab: async () => presence,
    now: () => t,
  });
  assert.equal((await tabActivity(ID)).activity.uncertain, true);
  assert.deepEqual([ts.activityFor(ID).status, ts.activityFor(ID).hookOwned], ['idle', false]);
  // A hookless turn later: busy, no marker. Not Working with the old clock.
  presence = { ...presence, status: 'busy', statusUpdatedAt: 130_000 };
  t = 134_000;
  const r = await tabActivity(ID);
  assert.equal(label({ ...r.activity, live: true, now: t }), null);
  // Hooks back on mid-way: the first marker cannot be that turn's start.
  ts.ingest(ID, mk('working'), 140_000);
  ts.ingest(ID, mk('done'), 190_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
  // The turn after starts at its own marker.
  ts.ingest(ID, mk('working'), 200_000);
  ts.ingest(ID, mk('done'), 260_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 60_000);
});

test('a cached "no claude" is re-read fresh before it distrusts a running turn', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 101_500);
  const { checkTurnAgainstProcess } = makeActivity({
    claudeInfo: async () => null,                                // cached from before B started
    claudeInfoFresh: async () => ({ pid: 2, startedAt: 100_000 }), // B, the turn's own claude
  });
  await checkTurnAgainstProcess(ID, ts.activityFor(ID));
  ts.ingest(ID, mk('done'), 161_500);
  assert.equal(ts.activityFor(ID).lastTurnMs, 60_000);
});

test('approving a permission keeps the turn and its clock', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('needs'), 20_000);
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 1_000 }),
    presenceForTab: async () => ({ pid: 1, startedAt: 1_000, status: 'busy', statusUpdatedAt: 30_000 }),
    now: () => 34_000,
  });
  const r = await tabActivity(ID);
  assert.equal(label({ ...r.activity, live: true, now: 34_000 }).text, 'Working 24s');
  assert.deepEqual([ts.activityFor(ID).status, ts.activityFor(ID).hookOwned], ['working', true], 'the record follows, the turn goes on');
  ts.ingest(ID, mk('working'), 40_000);
  ts.ingest(ID, mk('done'), 70_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 60_000);
});

test('an abandoned turn leaves no old length for a later done', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 70_000);
  ts.ingest(ID, mk('working'), 100_000);
  ts.abandonTurn(ID, 100_000);
  ts.ingest(ID, mk('done'), 190_000); // idle-prompt re-send
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
});

test('fresh lookups: many asks while one is in flight share it', async () => {
  let calls = 0;
  let release;
  const fresh = cachedPerTab(() => { calls += 1; return new Promise((r) => { release = r; }); }, 0);
  const all = Array.from({ length: 50 }, () => fresh('a'));
  await new Promise((r) => setImmediate(r));
  release({ pid: 1 });
  await Promise.all(all);
  assert.equal(calls, 1);
  const again = fresh('a');
  await new Promise((r) => setImmediate(r));
  release({ pid: 1 });
  await again;
  assert.equal(calls, 2, 'a settled answer is never reused');
});

test('an approved dialog stays Working when the presence signal is lost', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('needs'), 20_000);
  let presence = { pid: 1, startedAt: 1_000, status: 'busy', statusUpdatedAt: 30_000 };
  let t = 34_000;
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 1_000 }),
    presenceForTab: async () => presence,
    now: () => t,
  });
  await tabActivity(ID);
  presence = null; // the file went away
  t = 40_000;
  const r = await tabActivity(ID);
  assert.equal(label({ ...r.activity, live: true, now: t }).kind, 'working');
});

test('judgePresence: an unknown status never ends a turn', () => {
  const info = { pid: 1, startedAt: 100_000 };
  const working = { status: 'working', hookOwned: true, turnEndedAt: 0, lastMarkerAt: 200_000 };
  const r = judgePresence({ pid: 1, startedAt: 100_000, status: 'garbage', statusUpdatedAt: 220_000 }, working, info, 300_000);
  assert.equal(r.uncertain, false);
});

test('judgePresence: idle written just now waits for a Stop racing behind it', () => {
  const info = { pid: 1, startedAt: 100_000 };
  const working = { status: 'working', hookOwned: true, turnEndedAt: 0, lastMarkerAt: 10_000 };
  const f = { pid: 1, startedAt: 100_000, status: 'idle', statusUpdatedAt: 70_000 };
  assert.equal(judgePresence(f, working, info, 70_005).uncertain, false);
  assert.equal(judgePresence(f, working, info, 73_000).over, true);
});

test('unique lookup: a claude path with spaces makes the shell ambiguous, not skipped', async () => {
  assert.equal(await claudeChildVerdict('/Users/alice/CLI Tools/claude'), 'ambiguous');
  assert.equal(await claudeChildVerdict('node /tmp/watcher.js /opt/homebrew/bin/claude'), 'ambiguous');
  assert.equal(await claudeChildVerdict('sleep 25'), 'not-claude');
  assert.equal(await claudeChildVerdict('claude --resume abc'), 'claude');
  const r = reconcileWithProcess({ status: 'done', hookOwned: false, since: null, lastTurnMs: 60_000, turnEndedAt: 70_000 }, { ambiguous: true });
  assert.deepEqual([r.uncertain, r.lastTurnMs], [true, 60_000], 'ambiguous: no claim, nothing changed');
  assert.equal(label({ ...r, live: true, unread: true }), null);
});

test('a hookless turn after an ended one keeps the old Done hidden when presence is lost', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 70_000);
  let presence = { pid: 1, startedAt: 1_000, status: 'busy', statusUpdatedAt: 130_000 };
  let t = 134_000;
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 1_000 }),
    presenceForTab: async () => presence,
    now: () => t,
  });
  assert.equal((await tabActivity(ID)).activity.uncertain, true);
  presence = null;
  t = 140_000;
  assert.equal((await tabActivity(ID)).activity.uncertain, true);
  ts.ingest(ID, mk('working'), 150_000); // hooks back: a fresh state
  assert.equal(ts.activityFor(ID).hooklessTurn, false);
});

test('boundedIds ignores an own slice property (IPC can carry one)', () => {
  const evil = Object.assign(['a', 'b'], { slice: 0, filter: 0 });
  assert.deepEqual(boundedIds(evil, 10), ['a', 'b']);
});

test('judgePresence: a timestamp from the future is no evidence', () => {
  const info = { pid: 1, startedAt: 100_000 };
  const working = { status: 'working', hookOwned: true, turnEndedAt: 0, lastMarkerAt: 200_000 };
  const r = judgePresence({ pid: 1, startedAt: 100_000, status: 'waiting', statusUpdatedAt: 9007199254740991 }, working, info, 210_000);
  assert.equal(r.showAs, undefined);
});

test('tab activity: a marker arriving during the process lookup is answered from the new record', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 130_000);
  const { tabActivity } = makeActivity({
    claudeInfo: async () => { ts.ingest(ID, mk('working'), 130_100); return { pid: 1, startedAt: 1_000 }; },
    now: () => 130_300,
  });
  const r = await tabActivity(ID);
  assert.equal(r.activity.status, 'working');
  assert.equal(label({ ...r.activity, live: true, unread: true, now: 130_300 }).kind, 'working');
});

test('the Stop of a hookless turn ends it with an unknown length', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 70_000);
  ts.markHooklessTurn(ID, 70_000);
  ts.ingest(ID, mk('done'), 150_000); // B's Stop, no working marker before it
  const a = ts.activityFor(ID);
  assert.deepEqual([a.lastTurnMs, a.turnEndedAt, a.hooklessTurn], [0, 150_000, false]);
  // Without a hookless turn, an idle-prompt re-send still changes nothing.
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 70_000);
  ts.ingest(ID, mk('done'), 130_000);
  assert.deepEqual([ts.activityFor(ID).lastTurnMs, ts.activityFor(ID).turnEndedAt], [60_000, 70_000]);
});

test('settle after a moved record re-checks after its own process read', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  let calls = 0;
  const { tabActivity } = makeActivity({
    claudeInfo: async () => {
      calls += 1;
      if (calls === 1) ts.ingest(ID, mk('done'), 70_000);      // during the first read
      if (calls === 2) ts.ingest(ID, mk('working'), 70_060);   // during the settle's read
      return { pid: 1, startedAt: 1_000 };
    },
    now: () => 70_100,
  });
  const r = await tabActivity(ID);
  assert.equal(r.activity.status, 'working');
});

test('an abandoned turn records its end, so later checks still run', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.abandonTurn(ID, 10_000, 20_000);
  assert.equal(ts.activityFor(ID).turnEndedAt, 20_000);
});

test('ambiguity is kept until the next marker, so a later lone claude cannot claim it', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 30_000);
  let info = { ambiguous: true };
  const { tabActivity, checkTurnAgainstProcess } = makeActivity({
    claudeInfo: async () => info,
    claudeInfoFresh: async () => info,
    presenceForTab: async () => ({ pid: 2, startedAt: 2_000, status: 'busy', statusUpdatedAt: 20_000 }),
    now: (() => { let c = 40_000; return () => (c += 1); })(), // a clock that moves
  });
  assert.equal((await tabActivity(ID)).activity.uncertain, true);
  info = { pid: 2, startedAt: 2_000 }; // A exited, B alone
  const r = await tabActivity(ID);
  assert.deepEqual([r.activity.uncertain, r.activity.background], [true, null]);
  await checkTurnAgainstProcess(ID, ts.activityFor(ID), { fresh: true }); // a scan NOW sees one claude
  ts.ingest(ID, mk('working'), 50_000); // a turn starting after that
  assert.equal(ts.activityFor(ID).ambiguous, false);
  assert.equal(ts.activityFor(ID).since, null, 'that first turn may be a continuation: no clock');
});

test('moved() notices a since or length change made during the await', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 100_200);
  const { tabActivity } = makeActivity({
    claudeInfo: async () => { ts.distrustLastTurn(ID, 100_200); return { pid: 1, startedAt: 1_000 }; },
    now: () => 100_300,
  });
  const r = await tabActivity(ID);
  assert.equal(r.activity.lastTurnMs, 0);
});

test('a turn start seen while two claudes ran stays untrusted after one leaves', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000); // A
  ts.ingest(ID, mk('working'), 20_000); // B
  ts.markAmbiguous(ID);
  ts.ingest(ID, mk('working'), 30_000); // B alone now
  assert.equal(ts.activityFor(ID).since, null);
  ts.ingest(ID, mk('done'), 50_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
});

test('moved() notices a hookless turn recorded during the await', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 70_000);
  const { tabActivity } = makeActivity({
    claudeInfo: async () => { ts.markHooklessTurn(ID, 70_000); return { pid: 1, startedAt: 1_000 }; },
    presenceForTab: async () => null,
    now: () => 83_000,
  });
  const r = await tabActivity(ID);
  assert.equal(label({ ...r.activity, live: true, unread: true, now: 83_000 }), null);
});

test('ambiguity seen after a Stop also drops that turn\'s length', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 30_000);
  ts.markAmbiguous(ID);
  ts.ingest(ID, mk('done'), 60_000); // the other claude's lone done
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
});

test('settleOnCurrent keeps what its check disproves', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 100_000); // A
  let calls = 0;
  const { tabActivity } = makeActivity({
    claudeInfo: async () => {
      calls += 1;
      if (calls === 1) {
        ts.ingest(ID, mk('working'), 107_000); // B's marker during the first read
        return { pid: 1, startedAt: 1_000 };    // that read still saw A
      }
      return { pid: 2, startedAt: 105_000 };   // B, started after A's turn began
    },
    now: () => 108_000,
  });
  await tabActivity(ID);
  ts.ingest(ID, mk('done'), 110_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
});

test('ambiguity survives the other claude\'s markers (Stop, idle re-send)', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000); // A
  ts.ingest(ID, mk('working'), 20_000); // B
  ts.markAmbiguous(ID);
  ts.ingest(ID, mk('done'), 30_000);    // B's Stop
  ts.ingest(ID, mk('done'), 90_000);    // B's idle re-send
  assert.equal(ts.activityFor(ID).ambiguous, true);
  ts.ingest(ID, mk('working'), 95_000); // a start, but no single claude seen yet
  assert.equal(ts.activityFor(ID).ambiguous, true);
});

test('a turn that starts with needs, or during a hookless turn, has no trusted clock', () => {
  ts._reset();
  ts.ingest(ID, mk('needs'), 10_000);
  ts.ingest(ID, mk('done'), 40_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.ingest(ID, mk('done'), 70_000);
  ts.markHooklessTurn(ID, 70_000);
  ts.ingest(ID, mk('needs'), 150_000);
  ts.ingest(ID, mk('done'), 190_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 0);
});

test('a cached singleton cannot vouch for one claude after a scan saw two', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.markAmbiguous(ID);
  const { checkTurnAgainstProcess } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 1_000 }),        // cached: A only
    claudeInfoFresh: async () => ({ pid: 1, startedAt: 1_000 }),
    now: () => 11_000,
  });
  await checkTurnAgainstProcess(ID, ts.activityFor(ID));          // cached read
  ts.ingest(ID, mk('done'), 12_000);
  ts.ingest(ID, mk('working'), 13_000);
  assert.equal(ts.activityFor(ID).ambiguous, true, 'no fresh scan vouched, still ambiguous');
  await checkTurnAgainstProcess(ID, ts.activityFor(ID), { fresh: true });
  ts.ingest(ID, mk('done'), 14_000);
  ts.ingest(ID, mk('working'), 15_000);
  assert.equal(ts.activityFor(ID).ambiguous, false);
});

test('an older scan still in flight cannot clear a newer ambiguity', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.markAmbiguous(ID, 101_000);           // a scan started at 101 saw two
  ts.noteUnique(ID, 100_000, 102_000);     // a scan started at 100 saw one
  ts.ingest(ID, mk('done'), 103_000);
  ts.ingest(ID, mk('working'), 103_500);
  assert.equal(ts.activityFor(ID).ambiguous, true);
  ts.noteUnique(ID, 104_000, 104_500);     // a scan started after it
  ts.ingest(ID, mk('done'), 105_000);
  ts.ingest(ID, mk('working'), 106_000);
  assert.equal(ts.activityFor(ID).ambiguous, false);
});

test('a shared scan is dated by its own start, not by the caller that joined it', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  ts.markAmbiguous(ID, 100_300);                          // a scan started at 100.3 saw two
  const { checkTurnAgainstProcess } = makeActivity({
    claudeInfoFresh: async () => ({ pid: 1, startedAt: 1_000, scanStartedAt: 100_000 }), // began at 100
    now: () => 101_400,                                   // the joining caller
  });
  await checkTurnAgainstProcess(ID, ts.activityFor(ID), { fresh: true });
  ts.ingest(ID, mk('done'), 102_000);
  ts.ingest(ID, mk('needs'), 103_000);
  assert.equal(ts.activityFor(ID).ambiguous, true);
});

test('judgePresence: a busy written just before the received Stop is no claim', () => {
  const info = { pid: 1, startedAt: 1_000 };
  const a = { status: 'done', hookOwned: false, turnEndedAt: 21_000 };
  const f = (at) => ({ pid: 1, startedAt: 1_000, status: 'busy', statusUpdatedAt: at });
  assert.deepEqual(judgePresence(f(20_500), a, info), { background: null, uncertain: true });
  assert.equal(judgePresence(f(17_000), a, info).background, 'agents');
});

test('a hook Working with a silent PTY for a minute is not claimed', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 1_000 }),
    presenceForTab: async () => null, // a CLI without presence files
    now: () => 70_000,
  });
  assert.equal((await tabActivity(ID)).activity.uncertain, true);
  ts.ingest(ID, 'spinner frame', 69_000); // the TUI is still painting
  const live = makeActivity({ claudeInfo: async () => ({ pid: 1, startedAt: 1_000 }), presenceForTab: async () => null, now: () => 70_000 });
  assert.notEqual((await live.tabActivity(ID)).activity.uncertain, true);
});

test('silence does not stop presence from ending the turn in the record', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000);
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 1, startedAt: 1_000 }),
    presenceForTab: async () => ({ pid: 1, startedAt: 1_000, status: 'idle', statusUpdatedAt: 20_000 }),
    now: () => 90_000,
  });
  assert.equal((await tabActivity(ID)).activity.uncertain, true);
  ts.ingest(ID, mk('working'), 100_000);
  ts.ingest(ID, mk('done'), 130_000);
  assert.equal(ts.activityFor(ID).lastTurnMs, 30_000);
});

test('the silence rule also applies on the settle path', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 10_000); // A
  ts.ingest(ID, mk('working'), 45_000); // B (started 40s), then silence
  const { tabActivity } = makeActivity({
    claudeInfo: async () => ({ pid: 2, startedAt: 40_000 }),
    presenceForTab: async () => null,
    now: () => 120_000,
  });
  const r = await tabActivity(ID);
  assert.equal(label({ ...r.activity, live: true, now: 120_000 }), null);
});
