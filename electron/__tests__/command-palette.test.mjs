import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filterGroups, flattenItems, reduceSearchState, initialSearchState,
  formatShortcut, isLightColor, normalizeSearch,
} from '../../src/lib/command-palette.js';

const item = (id, ...terms) => ({ id, searchTerms: terms });

const groups = [
  { id: 'actions', label: 'Actions', items: [
    item('new-tab', 'New terminal tab', 'create', 'open tab'),
    item('theme', 'Change theme', 'color scheme', 'appearance'),
    item('sidebar', 'Toggle sidebar', 'hide', 'show'),
  ] },
  { id: 'tabs', label: 'Tabs', items: [item('t1', 'Fix login bug', '/repo/theme-work')] },
  { id: 'dashboard', label: 'Dashboard', searchOnly: true, items: [item('costs', 'Open Costs', 'spend', 'money')] },
  { id: 'empty', label: 'Empty', items: [] },
];

const ids = (gs) => gs.flatMap((g) => g.items.map((i) => i.id));

test('empty query hides searchOnly and empty groups', () => {
  const out = filterGroups(groups, '');
  assert.deepEqual(out.map((g) => g.id), ['actions', 'tabs']);
});

test('synonyms match', () => {
  assert.deepEqual(ids(filterGroups(groups, 'appearance')), ['theme']);
  assert.deepEqual(ids(filterGroups(groups, 'spend')), ['costs']);
});

test('every token must match, in any order across terms', () => {
  assert.deepEqual(ids(filterGroups(groups, 'tab new')), ['new-tab']);
  assert.deepEqual(ids(filterGroups(groups, 'new zebra')), []);
});

test('title hit ranks above a synonym hit within a group', () => {
  const g = [{ id: 'actions', label: 'A', items: [
    item('a', 'Open folder', 'show sidebar'),
    item('b', 'Show hidden files'),
  ] }];
  assert.deepEqual(ids(filterGroups(g, 'show')), ['b', 'a']);
});

test('">" restricts to actions', () => {
  assert.deepEqual(ids(filterGroups(groups, '>theme')), ['theme']);
  assert.deepEqual(filterGroups(groups, '>').map((g) => g.id), ['actions']);
});

test('flattenItems skips disabled', () => {
  const g = [{ id: 'x', items: [{ id: 1 }, { id: 2, disabled: true }, { id: 3 }] }];
  assert.deepEqual(flattenItems(g).map((i) => i.id), [1, 3]);
});

test('submenu push clears query and back restores the parent query', () => {
  let s = initialSearchState();
  s = reduceSearchState(s, { type: 'query', query: 'them' });
  s = reduceSearchState(s, { type: 'push', view: { id: 'themes' } });
  assert.equal(s.query, '');
  assert.equal(s.views.length, 1);
  s = reduceSearchState(s, { type: 'query', query: 'ember' });
  s = reduceSearchState(s, { type: 'back' });
  assert.equal(s.query, 'them');
  assert.equal(s.views.length, 0);
  assert.equal(reduceSearchState(s, { type: 'back' }), s);
});

test('formatShortcut', () => {
  assert.deepEqual(formatShortcut('mod+shift+t'), ['⌘', '⇧', 'T']);
  assert.deepEqual(formatShortcut('mod+1'), ['⌘', '1']);
  assert.deepEqual(formatShortcut(''), []);
});

test('isLightColor', () => {
  assert.equal(isLightColor('#0D1117'), false);
  assert.equal(isLightColor('#FAFAFA'), true);
  assert.equal(isLightColor('nope'), false);
});

test('normalizeSearch collapses whitespace and case', () => {
  assert.equal(normalizeSearch('  New   TAB '), 'new tab');
});
