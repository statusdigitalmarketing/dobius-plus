import test from 'node:test';
import assert from 'node:assert/strict';
import { notesFromSubjects } from '../../scripts/release-notes.mjs';

test('keeps real changes, drops the version bump and LESSONS/NOTES', () => {
  const out = notesFromSubjects([
    '2.2.17',
    'Team messages held by a busy orchestrator tab are no longer silent',
    'LESSONS: Asana writes go through Sam\'s PAT',
    'NOTES: harness gotcha',
    'v2.2.16',
    '',
  ]);
  assert.equal(out, '- Team messages held by a busy orchestrator tab are no longer silent\n');
});

test('a release with nothing but bookkeeping still gets a body', () => {
  assert.equal(notesFromSubjects(['2.2.18', 'LESSONS: x']), 'Maintenance release.\n');
});

test('duplicates collapse and a long list is capped with a count', () => {
  const many = Array.from({ length: 65 }, (_, i) => `Change ${i}`);
  const out = notesFromSubjects(['Same', 'Same', ...many]).trimEnd().split('\n');
  assert.equal(out.length, 61);
  assert.equal(out[0], '- Same');
  assert.equal(out[60], '- and 6 more');
});
