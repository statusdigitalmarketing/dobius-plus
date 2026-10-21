import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketSessions, liveStatusBySession, DISK_WORKING_MS } from '../../src/lib/session-shelves.js';

const NOW = 1_000_000_000;
const s = (id, status = 'done', ageMs = 1000) => ({ sessionId: id, status, timestamp: NOW - ageMs });
const ids = (arr) => arr.map((x) => x.sessionId);
const live = (sessionId, status, tabId = 't') => ({ tabId, sessionId, status });

test('needs comes only from main\'s live answer', () => {
  const b = bucketSessions({ now: NOW, sessions: [s('a'), s('b')], liveSessions: [live('a', 'needs')] });
  assert.deepEqual(ids(b.needs), ['a']);
  assert.deepEqual(ids(b.recent), ['b']);
});

test('disk "needs" is ignored, disk "working" is trusted', () => {
  const b = bucketSessions({ now: NOW, sessions: [s('n', 'needs'), s('w', 'working')] });
  assert.deepEqual(ids(b.needs), []);
  assert.deepEqual(ids(b.working), ['w']);
  assert.deepEqual(ids(b.recent), ['n']);
});

test('live status beats disk status', () => {
  const b = bucketSessions({ now: NOW, sessions: [s('a', 'working')], liveSessions: [live('a', 'needs')] });
  assert.deepEqual(ids(b.needs), ['a']);
  assert.deepEqual(ids(b.working), []);
});

test('unknown live statuses and missing ids are ignored', () => {
  const m = liveStatusBySession([live('a', 'idle'), live('', 'needs'), null, live('b', 'queued')]);
  assert.equal(m.size, 0);
});

test('one session reported by two tabs: needs wins regardless of order', () => {
  assert.equal(liveStatusBySession([live('a', 'needs', 't1'), live('a', 'working', 't2')]).get('a'), 'needs');
  assert.equal(liveStatusBySession([live('a', 'working', 't2'), live('a', 'needs', 't1')]).get('a'), 'needs');
});

test('precedence: needs beats pinned, pinned beats working', () => {
  const b = bucketSessions({
    now: NOW,
    sessions: [s('np'), s('wp', 'working')], pinnedIds: ['np', 'wp'], liveSessions: [live('np', 'needs')],
  });
  assert.deepEqual(ids(b.needs), ['np']);
  assert.deepEqual(ids(b.pinned), ['wp']);
  assert.deepEqual(ids(b.working), []);
});

test('recent limit spills the rest to earlier, order preserved', () => {
  const b = bucketSessions({ now: NOW, sessions: ['a', 'b', 'c', 'd'].map((x) => s(x)), recentLimit: 2 });
  assert.deepEqual(ids(b.recent), ['a', 'b']);
  assert.deepEqual(ids(b.earlier), ['c', 'd']);
});

test('working and needs do not consume recent slots', () => {
  const b = bucketSessions({ now: NOW, sessions: [s('w', 'working'), s('a'), s('b')], recentLimit: 2 });
  assert.deepEqual(ids(b.recent), ['a', 'b']);
  assert.deepEqual(ids(b.earlier), []);
});

test("disk working expires once the transcript is older than the window", () => {
  const b = bucketSessions({ now: NOW, sessions: [s("fresh", "working", 5000), s("stale", "working", DISK_WORKING_MS + 1)] });
  assert.deepEqual(ids(b.working), ["fresh"]);
  assert.deepEqual(ids(b.recent), ["stale"]);
});

test("a future disk timestamp (clock moved back) is not working", () => {
  const b = bucketSessions({ now: NOW, sessions: [s("future", "working", -3600 * 1000), s("skew", "working", -30 * 1000)] });
  assert.deepEqual(ids(b.working), ["skew"]);
  assert.deepEqual(ids(b.recent), ["future"]);
});
