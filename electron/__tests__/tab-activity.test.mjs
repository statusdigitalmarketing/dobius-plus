// Tabs sidebar status labels: Working / Input / Waiting / Done (Brett, Asana
// 1220055135705774). Covers the pure label rules, main's turn timing in
// terminal-status, and the Claude presence-file reader behind "Waiting".
// Run: node --test ./electron/__tests__/tab-activity.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tabActivityLabel, formatDuration, WORKING_MIN_MS } from '../../src/lib/tab-activity.js';
import * as ts from '../terminal-status.js';
import { backgroundFromPresence, createPresenceReader, reconcileWithProcess, cachedPerTab } from '../claude-presence.js';

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
const rec = (over) => ({ pid: 4242, procStart: LSTART, status: 'idle', ...over });

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
  assert.equal(await read('a', END), 'shells');
  assert.equal(await read('b', END), null, 'no claude in the tab');
  files['/cfg/sessions/4242.json'] = JSON.stringify(rec({ status: 'idle' }));
  assert.equal(await read('a', END), 'shells', 'cached inside the window');
  t = 5000;
  assert.equal(await read('a', END), null, 're-read after the cache window');
  assert.equal(dirCalls, 1);
  files['/cfg/sessions/4242.json'] = '{not json';
  t = 10_000;
  assert.equal(await read('a', END), null, 'a half-written file is no claim');
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
  assert.equal(await read('a', END), null);
  t = 5000;
  assert.equal(await read('a', END), null);
  assert.equal(dirCalls, 2);
});

test('presence reader: a claude started AFTER the turn ended never inherits it', async () => {
  const read = createPresenceReader({
    claudeInfo: async () => proc,
    configDirOf: async () => '/cfg',
    readFile: async () => JSON.stringify(rec({ status: 'busy' })),
    now: () => 0,
  });
  // Process A's turn ended a minute BEFORE this process (B) started.
  assert.equal(await read('a', proc.startedAt - 60_000), null);
  // Same cached lookup, a turn this process was alive for.
  assert.equal(await read('a', proc.startedAt + 1000), 'agents');
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
    assert.equal(await reader()('a', END), 'shells', 'a normal file reads');
    fsMod.writeFileSync(file, JSON.stringify(rec({ status: 'shell', pad: 'x'.repeat(70 * 1024) })));
    assert.equal(await reader()('a', END), null, 'oversize is refused');
    fsMod.rmSync(file);
    const target = pathMod.join(dir, 'real.json');
    fsMod.writeFileSync(target, JSON.stringify(rec({ status: 'shell' })));
    fsMod.symlinkSync(target, file);
    assert.equal(await reader()('a', END), null, 'a symlink is not followed');
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
    readFile: async () => JSON.stringify(rec({ status: 'busy' })),
    now: () => 0,
  });
  assert.equal(await read('a', proc.startedAt + 900), null);
  assert.equal(await read('a', proc.startedAt + 1000), 'agents');
});

test('presence reader: concurrent asks share one lookup', async () => {
  let infoCalls = 0;
  const read = createPresenceReader({
    claudeInfo: async () => { infoCalls += 1; await new Promise((r) => setTimeout(r, 20)); return proc; },
    configDirOf: async () => '/cfg',
    readFile: async () => JSON.stringify(rec({ status: 'shell' })),
    now: () => 0,
  });
  const out = await Promise.all(Array.from({ length: 50 }, () => read('a', END)));
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
  assert.equal(await read('a', END), 'agents');
  status = 'idle'; // that turn ended with nothing in the background
  assert.equal(await read('a', END + 30_000), null);
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
