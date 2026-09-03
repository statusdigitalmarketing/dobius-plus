// Mobile board ordering. Sized against the real app: a live read found 39 tabs
// with only 10 running Claude and 32 idle, so ordering by project alone buries
// the few that matter.
// Run: node ./electron/__tests__/board-order.test.mjs
import assert from 'node:assert/strict';
import {
  statusRank, isActive, sortTermsByAttention, groupSummary, summaryLabel, isGroupCollapsed,
} from '../../mobile/board-order.js';

let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };
const T = (id, status, at = 0) => ({ id, status, lastActivityAt: at });

// 1. Attention order: needs, working, done, idle.
assert.ok(statusRank('needs') < statusRank('working'));
assert.ok(statusRank('working') < statusRank('done'));
assert.ok(statusRank('done') < statusRank('idle'));
// An unknown/missing status must sort as idle, never ahead of real work.
assert.equal(statusRank(undefined), statusRank('idle'));
assert.equal(statusRank('bogus'), statusRank('idle'));
ok('status ranking puts attention first, unknown last');

// 2. Sorting a realistic mixed group.
const mixed = [
  T('a', 'idle', 100), T('b', 'working', 50), T('c', 'needs', 10),
  T('d', 'idle', 900), T('e', 'done', 5),
];
assert.deepEqual(sortTermsByAttention(mixed).map((t) => t.id), ['c', 'b', 'e', 'd', 'a']);
ok('needs first, then working, then done, idle last by recency');

// 3. Recency breaks ties WITHIN a status, so the tab you just touched leads.
const sameStatus = [T('old', 'working', 10), T('new', 'working', 999), T('mid', 'working', 500)];
assert.deepEqual(sortTermsByAttention(sameStatus).map((t) => t.id), ['new', 'mid', 'old']);
ok('recency breaks ties within a status');

// 4. Stable for fully-equal entries, and never mutates the caller's array.
const equal = [T('x', 'idle'), T('y', 'idle'), T('z', 'idle')];
const snapshot = [...equal];
assert.deepEqual(sortTermsByAttention(equal).map((t) => t.id), ['x', 'y', 'z']);
assert.deepEqual(equal, snapshot, 'input array untouched');
ok('stable and non-mutating');

// 5. Defensive input.
assert.deepEqual(sortTermsByAttention(undefined), []);
assert.deepEqual(sortTermsByAttention([]), []);
assert.equal(isActive(undefined), false);
ok('empty and undefined input are safe');

// 6. Summary counts drive the header of a collapsed group.
const s = groupSummary([T('a', 'needs'), T('b', 'working'), T('c', 'idle'), T('d', 'idle')]);
assert.deepEqual(s, { total: 4, needs: 1, working: 1, done: 0, active: 2, idle: 2 });
ok('group summary counts');

// 6b. EVERY status must appear in the label. The first version omitted `done`,
// so a group whose tabs had all just finished rendered an EMPTY header count
// and the global chip called them idle (Codex, Medium).
assert.equal(summaryLabel(groupSummary([T('a', 'done')])), '1 done');
assert.equal(summaryLabel(groupSummary([T('a', 'needs'), T('b', 'working'), T('c', 'done'), T('d', 'idle')])),
  '1 needs you · 1 working · 1 done · 1 idle');
assert.equal(summaryLabel(groupSummary([])), '');
// A done-only group is ACTIVE, so it must not auto-collapse either.
assert.equal(isGroupCollapsed('/p', [T('a', 'done')]), false);
ok('done tabs are counted, labelled, and keep their group open');

// 7. v1.0.65: groups are EXPANDED by default so every tab shows; an all-idle
// group no longer auto-hides (Sam: "for all the tabs only some").
const dormant = [T('a', 'idle'), T('b', 'idle')];
const busy = [T('a', 'idle'), T('b', 'working')];
assert.equal(isGroupCollapsed('/p', dormant), false);
assert.equal(isGroupCollapsed('/p', busy), false);
ok('all groups show by default, idle included');

// 8. Only an EXPLICIT collapse hides a group; collapse wins if both recorded.
assert.equal(isGroupCollapsed('/p', dormant, { collapsed: ['/p'] }), true);
assert.equal(isGroupCollapsed('/p', busy, { expanded: ['/p'] }), false);
assert.equal(isGroupCollapsed('/p', busy, { collapsed: ['/p'], expanded: ['/p'] }), true);
ok('explicit collapse hides; collapse wins over expand');

console.log(`board-order: ${pass} groups pass`);
