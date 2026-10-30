// Tabs sidebar status labels: Working / Input / Waiting / Done (Brett, Asana
// 1220055135705774). The pure label rules, main's working-stretch timing in
// terminal-status, and the presence-file reader behind "Waiting".
// Run: node --test ./electron/__tests__/tab-activity.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tabActivityLabel, formatDuration } from '../../src/lib/tab-activity.js';
import * as ts from '../terminal-status.js';
import { waitingFrom, createWaitingReader, boundedIds, activityRow, GRACE_MS } from '../claude-presence.js';

const NOW = 10_000_000;
const label = (over) => tabActivityLabel({ live: true, status: 'idle', now: NOW, ...over });

test('formatDuration', () => {
  assert.equal(formatDuration(42_000), '42s');
  assert.equal(formatDuration(4 * 60_000 + 5_000), '4m');
  assert.equal(formatDuration(65 * 60_000), '1h 5m');
  assert.equal(formatDuration(3 * 86400_000), '3d');
  assert.equal(formatDuration(NaN), '');
});

test('labels: priority and text', () => {
  assert.equal(label({ live: false, status: 'needs', unread: true }), null, 'a closed tab only shows its age');
  assert.equal(label({ status: 'needs' }).text, 'Input');
  assert.equal(label({ status: 'working', hookOwned: true, since: NOW - 4 * 60_000 }).text, 'Working 4m');
  assert.equal(label({ status: 'working', hookOwned: true, since: null }).text, 'Working');
  assert.equal(label({ status: 'working', since: NOW - 1000 }).text, 'Working 1s', 'plain output counts, like the dot');
  assert.equal(label({ status: 'working', hookOwned: true, since: NOW - 1000, unread: true, background: 'agents' }).kind, 'working');
  assert.equal(label({ status: 'done', background: 'shells', unread: true }).kind, 'waiting');
  assert.equal(label({ status: 'done', unread: true, lastWorkMs: 12 * 60_000 }).text, 'Done 12m');
  assert.equal(label({ status: 'done', unread: true }).text, 'Done');
  assert.equal(label({ status: 'done', lastWorkMs: 60_000 }), null, 'viewed: the age');
});

// --- working stretch timing (terminal-status) -------------------------------
const mk = (s) => `\x1b]777;dobius;${s}\x07`;
const ID = 'term-/Users/sam/Projects (Code)/demo-1';

test('a stretch: working starts it, needs keeps it, done records its length', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 5_000);
  assert.equal(ts.activityFor(ID).since, 5_000);
  ts.ingest(ID, mk('needs'), 20_000);
  assert.equal(ts.activityFor(ID).since, 5_000);
  ts.ingest(ID, mk('working'), 30_000);
  ts.ingest(ID, mk('done'), 65_000);
  const a = ts.activityFor(ID);
  assert.deepEqual([a.status, a.since, a.lastWorkMs, a.doneAt], ['done', null, 60_000, 65_000]);
});

test('a new stretch after done resets; an idle-prompt done re-send keeps the length', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 1_000);
  ts.ingest(ID, mk('done'), 4_000);
  ts.ingest(ID, mk('done'), 70_000);
  assert.equal(ts.activityFor(ID).lastWorkMs, 3_000);
  ts.ingest(ID, mk('working'), 80_000);
  assert.equal(ts.activityFor(ID).since, 80_000);
});

test('a needs from outside a stretch does not reuse an ended start', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 1_000);
  ts.ingest(ID, mk('done'), 4_000);
  ts.ingest(ID, mk('needs'), 70_000);
  assert.equal(ts.activityFor(ID).since, null, 'not the ended stretch');
  ts.ingest(ID, mk('working'), 80_000);
  assert.equal(ts.activityFor(ID).since, 80_000, 'the timer starts at working');
  ts.ingest(ID, mk('done'), 90_000);
  assert.equal(ts.activityFor(ID).lastWorkMs, 10_000);
  ts.ingest(ID, mk('needs'), 100_000); // a dialog then done, no working at all
  ts.ingest(ID, mk('done'), 110_000);
  assert.equal(ts.activityFor(ID).lastWorkMs, 0, 'no stale length');
});

test('one chunk carrying done and the next working is two stretches', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 1_000);
  ts.ingest(ID, mk('done') + 'prompt' + mk('working'), 121_000);
  assert.equal(ts.activityFor(ID).lastWorkMs, 120_000);
  assert.equal(ts.activityFor(ID).since, 121_000);
});

test('plain output: a stretch from its first byte after settling to idle', () => {
  ts._reset();
  ts.ingest(ID, 'x', 1_000);
  ts.settle(4_000);
  assert.equal(ts.activityFor(ID).status, 'idle');
  ts.ingest(ID, 'build 1', 10_000);
  ts.ingest(ID, 'build 2', 11_000);
  assert.equal(ts.activityFor(ID).since, 10_000);
});

test('forget: a respawned PTY starts with nothing', () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 1_000);
  ts.forget(ID);
  assert.equal(ts.activityFor(ID), null);
});

// --- Waiting (presence file) -------------------------------------------------
const LSTART = 'Tue Oct 27 13:39:54 2026';
const START = Date.parse(LSTART);
const proc = { pid: 4242, startedAt: START };
const DONE = START + 120_000;
const AFTER = DONE + GRACE_MS;
const rec = (over) => ({ pid: 4242, procStart: LSTART, status: 'idle', statusUpdatedAt: START + 10_000, ...over });

test('waitingFrom: shell and an early busy are background work', () => {
  assert.equal(waitingFrom(rec({ status: 'shell' }), proc, DONE, AFTER), 'shells');
  assert.equal(waitingFrom(rec({ status: 'busy' }), proc, DONE, AFTER), 'agents');
  assert.equal(waitingFrom(rec({ status: 'idle' }), proc, DONE, AFTER), null);
  assert.equal(waitingFrom(rec({ status: 'waiting' }), proc, DONE, AFTER), null);
});

test('waitingFrom fails closed', () => {
  assert.equal(waitingFrom(rec({ status: 'shell' }), proc, DONE, DONE + 100), null, 'inside the grace');
  assert.equal(waitingFrom(rec({ status: 'shell', pid: 1 }), proc, DONE, AFTER), null, 'another pid');
  assert.equal(waitingFrom(rec({ status: 'shell', procStart: 'Tue Oct 27 13:39:55 2026' }), proc, DONE, AFTER), null, 'pid reused');
  assert.equal(waitingFrom(rec({ status: 'shell' }), { pid: 4242, startedAt: null }, DONE, AFTER), null);
  assert.equal(waitingFrom(rec({ status: 'shell' }), proc, START + 500, START + 500 + GRACE_MS), null, 'claude started after the turn ended');
  assert.equal(waitingFrom(rec({ status: 'busy', statusUpdatedAt: DONE - 1000 }), proc, DONE, AFTER), null, 'busy written as the turn ended');
  assert.equal(waitingFrom(rec({ status: 'busy', statusUpdatedAt: DONE + 5000 }), proc, DONE, AFTER), null, 'a newer turn');
  assert.equal(waitingFrom(rec({ status: 'busy', statusUpdatedAt: undefined }), proc, DONE, AFTER), null);
  assert.equal(waitingFrom(null, proc, DONE, AFTER), null);
  assert.equal(waitingFrom([rec({ status: 'shell' })], proc, DONE, AFTER), null);
});

test('waiting reader: one lookup per tab, cached per done, never throws', async () => {
  let t = AFTER;
  let infoCalls = 0;
  let body = JSON.stringify(rec({ status: 'shell' }));
  const read = createWaitingReader({
    claudeInfo: async () => { infoCalls += 1; return proc; },
    configDirFor: () => '/cfg',
    readFile: async (f) => { assert.equal(f, '/cfg/sessions/4242.json'); return body; },
    now: () => t,
  });
  const all = await Promise.all(Array.from({ length: 20 }, () => read('a', DONE)));
  assert.ok(all.every((v) => v === 'shells'));
  assert.equal(infoCalls, 1);
  body = JSON.stringify(rec({ status: 'idle' }));
  assert.equal(await read('a', DONE), 'shells', 'cached');
  t = AFTER + 5000;
  assert.equal(await read('a', DONE), null, 're-read after the cache window');
  body = '{not json';
  t += 5000;
  assert.equal(await read('a', DONE), null);
  const none = createWaitingReader({ claudeInfo: async () => null, configDirFor: () => null, now: () => AFTER });
  assert.equal(await none('b', DONE), null, 'no single claude: no Waiting');
  const boom = createWaitingReader({ claudeInfo: async () => { throw new Error('ps'); }, configDirFor: () => null, now: () => AFTER });
  assert.equal(await boom('c', DONE), null);
});

test('waiting reader: the real file read refuses symlinks and oversize files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-'));
  fs.mkdirSync(path.join(dir, 'sessions'));
  const file = path.join(dir, 'sessions', '4242.json');
  const reader = () => createWaitingReader({ claudeInfo: async () => proc, configDirFor: () => dir, now: () => AFTER });
  try {
    fs.writeFileSync(file, JSON.stringify(rec({ status: 'shell' })));
    assert.equal(await reader()('a', DONE), 'shells');
    fs.writeFileSync(file, JSON.stringify(rec({ status: 'shell', pad: 'x'.repeat(70 * 1024) })));
    assert.equal(await reader()('a', DONE), null);
    fs.rmSync(file);
    fs.writeFileSync(path.join(dir, 'real.json'), JSON.stringify(rec({ status: 'shell' })));
    fs.symlinkSync(path.join(dir, 'real.json'), file);
    assert.equal(await reader()('a', DONE), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('boundedIds: cut before walking, prototype slice, strings only', () => {
  const huge = [];
  huge.length = 0xffffffff;
  huge[0] = 'a';
  assert.deepEqual(boundedIds(huge, 1000), ['a']);
  assert.deepEqual(boundedIds(Object.assign(['a', 'b'], { slice: 0 }), 10), ['a', 'b']);
  assert.deepEqual(boundedIds(Object.assign(['a', 'b'], { constructor: 0, filter: 0 }), 10), ['a', 'b']);
  assert.deepEqual(boundedIds(['a', 1, null, 'x'.repeat(5000)], 10), ['a']);
  assert.deepEqual(boundedIds('nope', 10), []);
});

test('activityRow: a new turn during the Waiting lookup wins', async () => {
  ts._reset();
  ts.ingest(ID, mk('working'), 1_000);
  ts.ingest(ID, mk('done'), 10_000);
  const row = await activityRow(ID, {
    activityFor: ts.activityFor,
    waitingForTab: async () => { ts.ingest(ID, mk('working'), 14_000); return 'agents'; },
    unreadAnywhere: () => true,
  });
  assert.deepEqual([row.activity.status, row.activity.background, row.unread], ['working', null, true]);
  const kept = await activityRow(ID, {
    activityFor: () => ({ status: 'done', doneAt: 5, hookOwned: false, since: null, lastWorkMs: 0 }),
    waitingForTab: async () => 'shells',
    unreadAnywhere: () => false,
  });
  assert.equal(kept.activity.background, 'shells');
});

test('waiting reader: never samples inside the grace', async () => {
  let reads = 0;
  const read = createWaitingReader({
    claudeInfo: async () => proc,
    configDirFor: () => '/cfg',
    readFile: async () => { reads += 1; return JSON.stringify(rec({ status: 'busy' })); },
    now: () => DONE + 100,
  });
  assert.equal(await read('a', DONE), null);
  assert.equal(reads, 0);
});
