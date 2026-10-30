// Tabs sidebar status labels: Working / Input / Waiting / Done (Brett, Asana
// 1220055135705774). Covers the pure label rules, main's turn timing in
// terminal-status, and the Claude presence-file reader behind "Waiting".
// Run: node --test ./electron/__tests__/tab-activity.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tabActivityLabel, formatDuration, WORKING_MIN_MS } from '../../src/lib/tab-activity.js';
import * as ts from '../terminal-status.js';
import { backgroundFromPresence, createPresenceReader } from '../claude-presence.js';

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
  assert.equal(await read('a'), 'shells');
  assert.equal(await read('b'), null, 'no claude in the tab');
  files['/cfg/sessions/4242.json'] = JSON.stringify(rec({ status: 'idle' }));
  assert.equal(await read('a'), 'shells', 'cached inside the window');
  t = 5000;
  assert.equal(await read('a'), null, 're-read after the cache window');
  assert.equal(dirCalls, 1);
  files['/cfg/sessions/4242.json'] = '{not json';
  t = 10_000;
  assert.equal(await read('a'), null, 'a half-written file is no claim');
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
  assert.equal(await read('a'), null);
  t = 5000;
  assert.equal(await read('a'), null);
  assert.equal(dirCalls, 2);
});
