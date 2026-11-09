// The sidebar Tabs list order setting (src/lib/sidebar-order.js), Brett's Asana card 1220332151377656.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSidebarTabs, normalizeSidebarOrder, statusRank } from '../../src/lib/sidebar-order.js';

// Saved order (the project's tab bar): Watchlist, Hallandale Request, Other, Closed.
const TABS = [
  { id: 'w', label: 'Watchlist', live: true, lastActiveAt: 100 },
  { id: 'h', label: 'Hallandale Request', live: true, lastActiveAt: 300 },
  { id: 'o', label: 'Other', live: true, lastActiveAt: 200 },
  { id: 'c', label: 'Closed', live: false, lastActiveAt: 900 },
];
const ids = (rows) => rows.map((t) => t.id).join(',');
const KIND = { w: 'done', h: 'working', o: 'waiting', c: null };
const BAR = { w: 0, h: 1, o: 2 };
const opts = { barIndex: (t) => BAR[t.id] ?? -1, kind: (t) => KIND[t.id] };

test('default (most recent first): live tabs first, the most recently active on top', () => {
  assert.equal(ids(orderSidebarTabs(TABS, 'activity', opts)), 'h,o,w,c');
  assert.equal(ids(orderSidebarTabs(TABS, undefined, opts)), 'h,o,w,c');
  assert.equal(ids(orderSidebarTabs(TABS, 'nonsense', opts)), 'h,o,w,c');
});

test('tab bar order: the same order as the tabs up top, whatever is working', () => {
  assert.equal(ids(orderSidebarTabs(TABS, 'tabs', opts)), 'w,h,o,c');
});

test('tab bar order follows a reordered bar in this window, then the rest in saved order', () => {
  const bar = { o: 0, w: 1 }; // h is in another window
  assert.equal(ids(orderSidebarTabs(TABS, 'tabs', { ...opts, barIndex: (t) => bar[t.id] ?? -1 })), 'o,w,h,c');
});

test('tab bar order for another window: main hands rows over by recency, savedIndex restores the bar (Codex P2)', () => {
  // Another window's bar is [A, B]; main sorted its rows by lastActiveAt, so B arrives first.
  const fromMain = [
    { id: 'B', savedIndex: 1, lastActiveAt: 200 },
    { id: 'A', savedIndex: 0, lastActiveAt: 100 },
  ];
  const none = { barIndex: () => -1, kind: () => null };
  assert.equal(ids(orderSidebarTabs(fromMain, 'tabs', none)), 'A,B');
  // A becomes the most recent: main now sends it first, and the sidebar must not move.
  const later = [{ ...fromMain[1], lastActiveAt: 300 }, fromMain[0]];
  assert.equal(ids(orderSidebarTabs(later, 'tabs', none)), 'A,B');
  // Status order breaks ties by the bar too.
  assert.equal(ids(orderSidebarTabs(fromMain, 'status', none)), 'A,B');
});

test('by status: working, input, waiting, done, then the rest, tab bar order within each', () => {
  assert.equal(ids(orderSidebarTabs(TABS, 'status', opts)), 'h,o,w,c');
  const kinds = { w: 'working', h: 'input', o: 'working', c: 'done' };
  assert.equal(ids(orderSidebarTabs(TABS, 'status', { ...opts, kind: (t) => kinds[t.id] })), 'w,o,h,c');
});

test('the input array is never mutated', () => {
  const copy = TABS.slice();
  orderSidebarTabs(TABS, 'tabs', opts);
  orderSidebarTabs(TABS, 'status', opts);
  assert.deepEqual(TABS, copy);
});

test('names and ranks', () => {
  assert.equal(normalizeSidebarOrder('tabs'), 'tabs');
  assert.equal(normalizeSidebarOrder(null), 'activity');
  assert.deepEqual(['working', 'input', 'waiting', 'done', null].map(statusRank), [0, 1, 2, 3, 4]);
});
