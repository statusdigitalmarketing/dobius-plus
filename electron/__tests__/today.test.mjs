// The Today list. The failure that matters most: something important hidden while the list looks finished.
// Run: node --import ./electron/__tests__/register.mjs --test electron/__tests__/today.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { planToday, noticedFrom, readNoticed, readToday, SUGGESTED } from '../today.js';

const TODAY = '2026-11-05';
const NOW = Date.parse('2026-11-05T15:00:00Z');
const DAY = 86_400_000;
const card = (id, over = {}) => ({ id, priority: 'medium', due: null, since: null, ...over });
const ids = (r) => r.suggested.map((c) => c.id);
const plan = (cards, limit) => planToday(cards, { today: TODAY, nowMs: NOW, limit });

test('a high priority card is never aged out or crowded out by routine work', () => {
  const routine = Array.from({ length: 40 }, (_, i) => card(`r${i}`, { due: TODAY }));
  const r = plan([...routine, card('old-urgent', { priority: 'high', due: '2025-01-01' }), card('undated-urgent', { priority: 'high' })]);
  assert.equal(r.suggested.length, SUGGESTED);
  assert.ok(ids(r).includes('old-urgent'));
  assert.ok(ids(r).includes('undated-urgent'));
});

test('everything is counted: what is not suggested is reported, never lost', () => {
  const r = plan([card('a', { due: TODAY }), card('b', { due: '2020-01-01' }), card('c')]);
  assert.deepEqual(ids(r), ['a']);
  assert.equal(r.total, 3);
  assert.equal(r.otherCount, 2);
  const many = plan(Array.from({ length: 20 }, (_, i) => card(`m${i}`, { due: TODAY })), 15);
  assert.equal(many.withinReach, 20, 'the list says when more qualified than it shows');
  assert.equal(many.otherCount, 5);
});

test('order: urgent, due today, recently overdue, recently waiting', () => {
  const r = plan([
    card('waiting', { since: new Date(NOW - DAY).toISOString() }),
    card('overdue-3', { due: '2026-11-02' }),
    card('today', { due: TODAY }),
    card('urgent', { priority: 'high' }),
    card('overdue-1', { due: '2026-11-04' }),
  ]);
  assert.deepEqual(ids(r), ['urgent', 'today', 'overdue-1', 'overdue-3', 'waiting']);
});

test('within urgent work: today, then overdue newest first, then undated, then not due yet', () => {
  const high = (id, due) => card(id, { priority: 'high', due });
  const r = plan([high('later', '2026-11-20'), high('soon', '2026-11-06'), high('undated'), high('old', '2026-10-01'), high('recent', '2026-11-04'), high('today', TODAY)]);
  assert.deepEqual(ids(r), ['today', 'recent', 'old', 'undated', 'soon', 'later']);
});

test('the edges of the windows, and bad data, never throw', () => {
  const r = plan([
    card('seven', { due: '2026-10-29' }),
    card('eight', { due: '2026-10-28' }),
    card('future', { due: '2026-11-20' }),
    card('waited-long', { since: new Date(NOW - 4 * DAY).toISOString() }),
    card('bad-since', { since: 'not a date' }),
  ]);
  assert.deepEqual(ids(r), ['seven']);
  assert.equal(r.otherCount, 4);
});

test('the same cards always give the same list', () => {
  const cards = Array.from({ length: 30 }, (_, i) => card(`c${i}`, { due: TODAY }));
  assert.deepEqual(ids(plan(cards)), ids(plan([...cards].reverse())));
});

test('noticed: only near-term or high priority, only my promises, and capped', () => {
  const near = NOW + DAY;
  const n = noticedFrom([
    { id: 1, status: 'pending', priority: 'high', title: 'High, undated' },
    { id: 2, status: 'pending', priority: 'low', title: 'Soon', dueDate: near },
    { id: 3, status: 'pending', priority: 'low', title: 'Far away', dueDate: NOW + 60 * DAY },
    { id: 4, status: 'completed', priority: 'high', title: 'Done already' },
    { id: 5, status: 'pending', priority: 'high', title: '' },
    null, 7,
  ], [
    { id: 8, status: 'pending', direction: 'outgoing', commitment: 'I promised', dueDate: near },
    { id: 9, status: 'pending', direction: 'incoming', commitment: 'They owe me', dueDate: near },
  ], { nowMs: NOW });
  assert.deepEqual(n.items.map((i) => i.key).sort(), ['action:1', 'action:2', 'followup:8']);
  assert.equal(n.found, 3);
  const lots = noticedFrom(Array.from({ length: 12 }, (_, i) => ({ id: i, status: 'pending', priority: 'high', title: `t${i}` })), [], { nowMs: NOW });
  assert.equal(lots.items.length, 5);
  assert.equal(lots.found, 12, 'it says when it found more than it shows');
  assert.deepEqual(Object.keys(lots.items[0]).sort(), ['at', 'due', 'key', 'kind', 'title', 'who'], 'display fields only: no descriptions or message bodies');
});

test('noticed keeps urgent items, and says what it found against what is pending', () => {
  const n = noticedFrom([{ id: 1, status: 'pending', priority: 'urgent', title: 'Urgent, undated' }], [], { nowMs: NOW });
  assert.deepEqual(n.items.map((i) => i.key), ['action:1']);
});

// Stands in for http.request: one body per path, sent in the given chunk.
function fakeSamKnows(bodies, { headers = {} } = {}) {
  return (opts, onRes) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = headers;
      onRes(res);
      for (const chunk of bodies(opts.path)) res.emit('data', chunk);
      res.emit('end');
    });
    return req;
  };
}
const good = (path) => [Buffer.from(JSON.stringify(path.startsWith('/action-items')
  ? { counts: { pending: 1 }, items: [{ id: 1, status: 'pending', priority: 'high', title: 'T' }] }
  : { counts: { pending: 0 }, items: [] }))];

test('SamKnows is only read from this user\'s own listener', async () => {
  let called = 0;
  const request = (o, cb) => { called += 1; return fakeSamKnows(good)(o, cb); };
  const refused = await readNoticed({ request, port: 9150, listenerIsMine: async () => false });
  assert.deepEqual(refused, { state: 'unavailable' });
  assert.equal(called, 0, 'nothing is read from a port another account could hold');
  const ok = await readNoticed({ request, port: 9150, listenerIsMine: async () => true });
  assert.equal(ok.state, 'ok');
  assert.equal(ok.items.length, 1);
});

test('an oversized SamKnows answer is dropped, not held in memory', async () => {
  const big = () => Array.from({ length: 3 }, () => Buffer.alloc(8 * 1024 * 1024, 32));
  assert.deepEqual(await readNoticed({ request: fakeSamKnows(big), port: 9150, listenerIsMine: async () => true }), { state: 'unavailable' });
  const declared = { headers: { 'content-length': String(1024 * 1024 * 1024) } };
  assert.deepEqual(await readNoticed({ request: fakeSamKnows(good, declared), port: 9150, listenerIsMine: async () => true }), { state: 'unavailable' });
});

test('noticed refuses unusable ids and odd numbers', () => {
  const n = noticedFrom([
    { id: { x: 1 }, status: 'pending', priority: 'high', title: 'object id' },
    { id: 'y'.repeat(101), status: 'pending', priority: 'high', title: 'long id' },
    { id: 3, status: 'pending', priority: 'high', title: 'keep', dueDate: 'soon', extractedAt: 'x' },
  ], [], { nowMs: NOW });
  assert.deepEqual(n.items.map((i) => i.key), ['action:3']);
  assert.equal(n.items[0].due, null);
  assert.equal(n.items[0].at, 0);
});

test('a source that is down is reported, not shown as a clear day', async () => {
  const down = await readToday({ today: TODAY, nowMs: NOW, readBoard: async () => ({ ok: false, reason: 'not-running', url: 'u' }), readNoticed: async () => ({ state: 'unavailable' }) });
  assert.equal(down.board.state, 'not-running');
  assert.equal(down.board.suggested, undefined);
  assert.equal(down.noticed.state, 'unavailable');
  const up = await readToday({ today: TODAY, nowMs: NOW, readBoard: async (o) => { assert.equal(o.maxCards, Infinity, 'all cards, not the first 300'); return { ok: true, url: 'u', cards: [card('a', { due: TODAY })], overdue: 0 }; }, readNoticed: async () => ({ state: 'unavailable' }) });
  assert.equal(up.board.state, 'ok');
  assert.deepEqual(up.board.suggested.map((c) => c.id), ['a']);
});
