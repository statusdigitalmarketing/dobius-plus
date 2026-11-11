// Tasks > Team filters and threads (src/lib/team-threads.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpen, needsPerson, isArchived, visibleThreads, hiddenCount } from '../../src/lib/team-threads.js';

const A = 'peerA'; const B = 'peerB';
const m = (dir, peer, id, state, extra = {}) => ({ dir, peer, peerName: peer === A ? 'MacBook-Air' : 'Muzikmaker', id, state, at: extra.at ?? 0, text: extra.text ?? id, ...extra });

test('open: needs a person, still on its way, or went wrong over there; handled and archived rows are not', () => {
  assert.equal(isOpen(m('in', A, '1', 'held')), true);
  assert.equal(isOpen(m('in', A, '2', 'waiting')), true);
  assert.equal(isOpen(m('out', A, '3', 'sending')), true);
  assert.equal(isOpen(m('out', A, '4', 'delivered')), false);
  assert.equal(isOpen(m('out', A, '5', 'delivered', { stage: 'done' })), false);
  assert.equal(isOpen(m('out', A, '6', 'delivered', { stage: 'failed' })), true);
  assert.equal(isOpen(m('in', A, '7', 'routed')), false);
  assert.equal(isOpen(m('in', A, '8', 'dismissed')), false);
  assert.equal(isOpen(m('in', A, '9', 'dismissed', { archived: true, archivedState: 'dismissed' })), false);
  assert.equal(needsPerson(m('out', A, 'a', 'unconfirmed')), true);
  assert.equal(needsPerson(m('out', A, 'b', 'delivered')), false);
});

test('a reply sits under the message it answers, found across directions and per teammate', () => {
  const list = [
    m('out', A, 'q1', 'delivered', { at: 1 }),
    m('in', A, 'r1', 'held', { at: 5, kind: 'reply', replyTo: 'q1' }),
    m('out', A, 'r2', 'delivered', { at: 7, kind: 'reply', replyTo: 'r1' }),
    // Same id as q1 but from the other teammate: not part of A's thread.
    m('in', B, 'r9', 'held', { at: 3, kind: 'reply', replyTo: 'q1' }),
  ];
  const th = visibleThreads(list, { filter: 'all' });
  assert.equal(th.length, 2);
  assert.equal(th[0].root.id, 'q1', 'newest activity first');
  assert.deepEqual(th[0].replies.map((x) => x.id), ['r1', 'r2']);
  assert.equal(th[1].root.id, 'r9', 'its parent is not in the list, so it is its own root');
});

test('default Open hides handled threads but keeps a whole thread when one row in it is open', () => {
  const list = [
    m('out', A, 'q1', 'delivered', { at: 1 }),
    m('in', A, 'r1', 'held', { at: 5, kind: 'reply', replyTo: 'q1' }),
    m('out', B, 'q2', 'delivered', { at: 2 }),
    m('in', B, 'x', 'routed', { at: 3 }),
  ];
  const th = visibleThreads(list);
  assert.equal(th.length, 1);
  assert.equal(th[0].root.id, 'q1');
  assert.deepEqual(th[0].replies.map((x) => x.id), ['r1']);
  assert.equal(hiddenCount(list), 2);
});

test('filter by teammate, by needs-you, by done, and by text', () => {
  const list = [
    m('in', A, '1', 'held', { at: 1, text: 'pocket drafts' }),
    m('in', B, '2', 'held', { at: 2, text: 'phone report' }),
    m('in', B, '3', 'waiting', { at: 3 }),
    m('in', B, '4', 'routed', { at: 4, archived: true, archivedState: 'routed' }),
  ];
  assert.deepEqual(visibleThreads(list, { peer: B }).map((t) => t.root.id), ['3', '2']);
  assert.deepEqual(visibleThreads(list, { filter: 'attention' }).map((t) => t.root.id), ['2', '1']);
  assert.deepEqual(visibleThreads(list, { filter: 'archived' }).map((t) => t.root.id), ['4']);
  assert.deepEqual(visibleThreads(list, { filter: 'all' }).map((t) => t.root.id), ['3', '2', '1'], 'done rows stay out of All');
  assert.deepEqual(visibleThreads(list, { filter: 'all', query: 'POCKET' }).map((t) => t.root.id), ['1']);
});

test('a reply cycle does not hang and every row still shows once', () => {
  const list = [
    m('in', A, 'a', 'held', { at: 1, replyTo: 'b' }),
    m('out', A, 'b', 'delivered', { at: 2, replyTo: 'a' }),
  ];
  const th = visibleThreads(list, { filter: 'all' });
  const ids = th.flatMap((t) => [t.root.id, ...t.replies.map((x) => x.id)]).sort();
  assert.deepEqual(ids, ['a', 'b']);
});

test('a row marked done while its delivery was running comes back, badge and list together, when that delivery fails (Codex)', () => {
  const done = m('in', A, 'z', 'routing', { archived: true, archivedState: 'routing' });
  assert.equal(isArchived(done), true);
  assert.equal(isOpen(done), false);
  const failed = { ...done, state: 'held' };
  assert.equal(isArchived(failed), false);
  assert.equal(needsPerson(failed), true, 'the Tasks badge counts it');
  assert.deepEqual(visibleThreads([failed], { filter: 'attention' }).map((t) => t.root.id), ['z'], 'and Needs you shows it');
  assert.deepEqual(visibleThreads([failed], { filter: 'archived' }), []);
});

test('a sent message marked done comes back when the teammate\'s Mac later reports a problem with it (Codex round 2)', () => {
  const done = m('out', A, 'y', 'delivered', { archived: true, archivedState: 'delivered', archivedStage: null });
  assert.equal(isArchived(done), true);
  const reported = { ...done, stage: 'held' };
  assert.equal(isArchived(reported), false);
  assert.equal(isOpen(reported), true);
});
