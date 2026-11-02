import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueLabel, localDay, sortOpenTasks, matchesQuery } from '../task-due.js';

test('dueLabel names the day relative to today', () => {
  const t = '2026-11-02';
  assert.deepEqual(dueLabel('2026-10-28', t), { text: '5d overdue', tone: 'overdue' });
  assert.deepEqual(dueLabel('2026-11-01', t), { text: 'yesterday', tone: 'overdue' });
  assert.deepEqual(dueLabel('2026-11-02', t), { text: 'today', tone: 'today' });
  assert.deepEqual(dueLabel('2026-11-03', t), { text: 'tomorrow', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-11-06', t), { text: 'in 4d', tone: 'soon' });
  assert.deepEqual(dueLabel('2026-12-25', t), { text: 'Dec 25', tone: 'later' });
  assert.equal(dueLabel(null, t), null);
  assert.equal(dueLabel('soon', t), null);
});

test('dueLabel counts days across a DST change and a month end', () => {
  assert.deepEqual(dueLabel('2026-11-08', '2026-10-31'), { text: 'Nov 8', tone: 'later' });
  assert.deepEqual(dueLabel('2026-11-03', '2026-10-31'), { text: 'in 3d', tone: 'soon' });
});

test('localDay formats the local calendar day', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('sortOpenTasks puts dated first, earliest first, undated last by age', () => {
  const tasks = [
    { id: 'undated-new', createdAt: 3 },
    { id: 'late', dueOn: '2026-12-01', createdAt: 1 },
    { id: 'undated-old', createdAt: 1 },
    { id: 'soon', dueOn: '2026-11-03', createdAt: 9 },
  ];
  assert.deepEqual(sortOpenTasks(tasks).map((t) => t.id), ['soon', 'late', 'undated-old', 'undated-new']);
  assert.equal(tasks[0].id, 'undated-new', 'input untouched');
});

test('matchesQuery needs every word, in any field, any case', () => {
  assert.equal(matchesQuery('', 'x'), true);
  assert.equal(matchesQuery('fix LOGIN', 'Fix the login bug'), true);
  assert.equal(matchesQuery('fix kim', 'Fix the login bug', 'From Kim'), true);
  assert.equal(matchesQuery('fix bob', 'Fix the login bug', 'From Kim'), false);
  assert.equal(matchesQuery('kim', null, undefined, 'kim'), true);
});
