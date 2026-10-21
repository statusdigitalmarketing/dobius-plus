import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onScreenTabIds, becomesUnread, clearSeen } from '../../src/lib/tab-unread.js';
import { compactTokens } from '../../src/lib/compact-tokens.js';

const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
const ids = (set) => [...set].sort();
const base = { activeView: 'terminal', activeTabId: 'a', splitTabId: null, gridSlots: null, terminalTabs: tabs };

test('single view: only the active tab is on screen', () => {
  assert.deepEqual(ids(onScreenTabIds(base)), ['a']);
});

test('dashboard: nothing is on screen', () => {
  assert.deepEqual(ids(onScreenTabIds({ ...base, activeView: 'dashboard' })), []);
});

test('grid: exactly the cells, active or not', () => {
  assert.deepEqual(ids(onScreenTabIds({ ...base, gridSlots: ['b', 'c'] })), ['b', 'c']);
});

test('split: split pane plus primary; primary falls back when active IS the split pane', () => {
  assert.deepEqual(ids(onScreenTabIds({ ...base, activeTabId: 'b', splitTabId: 'd' })), ['b', 'd']);
  assert.deepEqual(ids(onScreenTabIds({ ...base, activeTabId: 'd', splitTabId: 'd' })), ['a', 'd']);
});

test('grid wins over a stale split pointer, as in paneStyleFor', () => {
  assert.deepEqual(ids(onScreenTabIds({ ...base, splitTabId: 'd', gridSlots: ['b'] })), ['b']);
});

test('only an unseen turn the hook finished is unread', () => {
  // becomesUnread(next, seen, hookOwned, fromHook)
  assert.equal(becomesUnread('done', false, true, true), true);
  assert.equal(becomesUnread('done', true, true, true), false); // you watched it
  assert.equal(becomesUnread('needs', false, true, true), false); // red pulse already says it
  assert.equal(becomesUnread('working', false, true, true), false);
  // Idle-prompt re-send: the hook's previous 'done' released ownership.
  assert.equal(becomesUnread('done', false, false, true), false);
  assert.equal(becomesUnread('done', false, undefined, true), false);
  // Auto-resume's 'done' for a skipped session that is still mid-turn.
  assert.equal(becomesUnread('done', false, true, false), false);
  assert.equal(becomesUnread('done', false, true, undefined), false);
});

test('clearSeen removes seen ids and keeps identity when nothing changes', () => {
  const unread = { a: true, c: true };
  assert.deepEqual(clearSeen(unread, new Set(['a', 'b'])), { c: true });
  assert.equal(clearSeen(unread, new Set(['b'])), unread);
  assert.deepEqual(unread, { a: true, c: true }); // not mutated
});

test('compactTokens', () => {
  assert.equal(compactTokens(152118), '152k');
  assert.equal(compactTokens(1_000_000), '1M');
  assert.equal(compactTokens(1_500_000), '1.5M');
  assert.equal(compactTokens(200_000), '200k');
  assert.equal(compactTokens(999), '999');
  assert.equal(compactTokens(NaN), '?');
});
