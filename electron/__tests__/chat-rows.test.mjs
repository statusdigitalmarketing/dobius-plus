// shared/chat-rows.js: what both chat views render from a transcript row.
// A malformed row must degrade to its plain text, never throw.
// Run: node ./electron/__tests__/chat-rows.test.mjs
import assert from 'node:assert/strict';
import { normalizeBlocks, rowText, rowKeys, createImageCache } from '../../shared/chat-rows.js';

// 1. Junk blocks are dropped field by field; nothing usable means null.
assert.equal(normalizeBlocks(undefined), null);
assert.equal(normalizeBlocks('text'), null);
assert.equal(normalizeBlocks([]), null);
assert.equal(normalizeBlocks([null, 7, { type: 'tool' }, { type: 'text', text: 5 }, { type: 'image' }]), null);
assert.deepEqual(
  normalizeBlocks([
    { type: 'text', text: 'hi' },
    { type: 'tool', name: 'Edit', id: 3, summary: 'a.js', diff: { old: 'x' }, result: 42, isError: 'yes', extra: {} },
    { type: 'thinking', text: '' },
  ]),
  [{ type: 'text', text: 'hi' }, { type: 'tool', name: 'Edit', summary: 'a.js', diff: { old: 'x', new: '' } }],
);
assert.deepEqual(normalizeBlocks([{ type: 'tool', name: 'Bash', result: '', isError: true }]), [{ type: 'tool', name: 'Bash', result: '', isError: true }]);
console.log('PASS  malformed blocks normalize or fall back');

// 2. Copy text: the text blocks in full for a blocks row, else content.
assert.equal(rowText('capped copy', [{ type: 'text', text: 'one' }, { type: 'tool', name: 'Bash' }, { type: 'text', text: 'two' }]), 'one\n\ntwo');
assert.equal(rowText('plain', null), 'plain');
assert.equal(rowText(undefined, null), '');
console.log('PASS  copy text comes from the text blocks');

// 3. Keys follow record ids, fall back to index, and never repeat.
assert.deepEqual(rowKeys([{ id: 'a' }, {}, { id: 'a' }, { id: '' }, null]), ['id:a', 'i:1', 'id:a#2', 'i:3', 'i:4']);
const before = rowKeys([{ id: 'x' }, { id: 'y' }]);
const after = rowKeys([{ id: 'y' }, { id: 'z' }]); // window slid by one
assert.equal(before[1], after[0]);
console.log('PASS  row keys survive a sliding window');

// 4. The new-messages mark: counts rows below it, flags a grown live turn,
// and says "unknown" when the window slid past it.
{
  const { unseenSince, markLatest } = await import('../../shared/chat-rows.js');
  const rows = [{ id: 'a', content: 'hi' }, { id: 'b', content: 'Working', blocks: [{ type: 'tool', name: 'Bash' }] }];
  const keys = rowKeys(rows);
  const mark = markLatest(rows, keys);
  assert.equal(unseenSince(rows, keys, mark), 0);
  const grown = [rows[0], { ...rows[1], blocks: [{ type: 'tool', name: 'Bash', result: 'ok' }] }];
  assert.equal(unseenSince(grown, rowKeys(grown), mark), -1, 'a tool result landing in the live turn is news');
  const more = [...rows, { id: 'c', content: 'x' }, { id: 'd', content: 'y' }];
  assert.equal(unseenSince(more, rowKeys(more), mark), 2);
  const slid = [{ id: 'z', content: 'q' }];
  assert.equal(unseenSince(slid, rowKeys(slid), mark), -1);
  assert.equal(unseenSince(rows, keys, null), 0);
  assert.equal(markLatest([], []), null);
  // Rows without ids are keyed by index: a different row of the same size at
  // the marked index is still news.
  const anon = [{ role: 'user', content: 'yes' }, { role: 'assistant', content: 'ok' }];
  const anonMark = markLatest(anon, rowKeys(anon));
  const shifted = [anon[1], { role: 'assistant', content: 'no' }];
  assert.equal(unseenSince(shifted, rowKeys(shifted), anonMark), -1, 'same size, different text');
  const same = [{ role: 'assistant', content: 'OK', timestamp: 't1' }];
  const sameMark = markLatest(same, rowKeys(same));
  const again = [{ role: 'assistant', content: 'OK', timestamp: 't3' }];
  assert.equal(unseenSince(again, rowKeys(again), sameMark), -1, 'same text, later record');
  assert.equal(unseenSince(same, rowKeys(same), sameMark), 0, 'an unchanged row is not news');
  // A tool result landing in the live turn ABOVE a queued message is news.
  const live = [{ id: 'a', role: 'assistant', content: 'x', blocks: [{ type: 'tool', name: 'Bash' }] }, { id: 'q', role: 'user', content: 'next', queued: true }];
  const liveMark = markLatest(live, rowKeys(live));
  const done = [{ ...live[0], blocks: [{ type: 'tool', name: 'Bash', result: 'ok' }] }, live[1]];
  assert.equal(unseenSince(done, rowKeys(done), liveMark), -1, 'a result above a queued row');
  const q3 = [live[0], ...['one', 'two', 'three'].map((t, i) => ({ id: `q${i}`, role: 'user', content: t, queued: true }))];
  const q3Mark = markLatest(q3, rowKeys(q3));
  const q3done = [done[0], ...q3.slice(1)];
  assert.equal(unseenSince(q3done, rowKeys(q3done), q3Mark), -1, 'a result above three queued rows');
  assert.equal(unseenSince(q3, rowKeys(q3), q3Mark), 0, 'unchanged queue is not news');
  const q21 = [live[0], ...Array.from({ length: 21 }, (_, i) => ({ id: `w${i}`, role: 'user', content: `m${i}`, queued: true }))];
  const q21Mark = markLatest(q21, rowKeys(q21));
  const q21done = [done[0], ...q21.slice(1)];
  assert.equal(unseenSince(q21done, rowKeys(q21done), q21Mark), -1, 'a result above 21 queued rows');
  const inter = [live[0], { id: 'i1', role: 'user', content: 'q1', queued: true }, { id: 'b2', role: 'assistant', content: 'y', blocks: [{ type: 'tool', name: 'Bash' }] }, { id: 'i2', role: 'user', content: 'q2', queued: true }];
  const interMark = markLatest(inter, rowKeys(inter));
  const interDone = [done[0], ...inter.slice(1)];
  assert.equal(unseenSince(interDone, rowKeys(interDone), interMark), -1, 'a result two live turns up');
  console.log('PASS  new-messages mark');
}

// 5. Selector card keys: same words, different hidden context (two edit
// prompts asking the same question about different diffs) must not share a
// key; a refreshed token for the same prompt keeps it.
{
  const { selectorKey, tokenFingerprint } = await import('../../shared/chat-rows.js');
  const card = (token) => ({ prompt: 'Do you want to make this edit to main.js?', options: [{ num: 1, label: 'Yes' }, { num: 2, label: 'No' }], token, fp: tokenFingerprint(token) });
  assert.notEqual(selectorKey(card('1:2:3|aaa')), selectorKey(card('1:2:9|bbb')), 'different context remounts');
  assert.equal(selectorKey(card('1:2:3|aaa')), selectorKey(card('1:4:7|aaa')), 'a refreshed token keeps the card');
  assert.equal(tokenFingerprint(null), '');
  assert.equal(tokenFingerprint('nofp'), '');
  assert.equal(selectorKey(null), 'none');
  console.log('PASS  selector card keys');
}

// 6. The press guard: a click answers only the card its press began on.
{
  const { createPressGuard } = await import('../../shared/chat-rows.js');
  const A = { token: 'n:1:2:3|fp' };
  const B = { token: 'n:1:3:5|fp' }; // same fingerprint, new token
  const A2 = { token: A.token }; // a re-read of A: new object, same token
  const pd = (id = 1, button = 0) => ({ pointerId: id, button });
  const click = { detail: 1 };
  const kclick = { detail: 0 };
  const kd = (k, repeat = false) => ({ key: k, repeat });
  let pending = [];
  let clock = 0;
  const make = () => { pending = []; clock = 0; return createPressGuard({ defer: (fn) => pending.push(fn), now: () => clock }); };
  const settle = () => { const fns = pending; pending = []; fns.forEach((f) => f()); };
  let g = make();
  // A mouse press on A that ends after B arrived is refused; a re-read lands.
  g.pointerDown(pd(), A); g.pointerUp(pd());
  assert.equal(g.take(click, B), false, 'mouse press on A, B arrived: refused');
  assert.equal(g.take(click, A2), true, 'a re-read of the same prompt still lands');
  settle();
  assert.equal(g.take(click, A), false, 'a pointer click with no press is refused');
  // Shift during a mouse hold does not move the press (round 14).
  g = make();
  g.pointerDown(pd(), A); g.keyDown(kd('Shift'), B); g.pointerUp(pd());
  assert.equal(g.take(click, B), false, 'Shift did not move the press to B');
  // A synthetic click during a mouse hold neither answers A's press nor clears it.
  g = make();
  g.pointerDown(pd(), A);
  assert.equal(g.take(kclick, B), true, 'a press-less click answers what it shows');
  g.pointerUp(pd());
  assert.equal(g.take(click, B), false, 'the held mouse press is still bound to A');
  // A second pointer on B while the first is held poisons the slot (round 15).
  g = make();
  g.pointerDown(pd(1), A); g.pointerDown(pd(2), B); g.pointerUp(pd(2)); g.pointerUp(pd(1));
  assert.equal(g.take(click, B), false, 'a second pointer did not move the press to B');
  settle();
  g.pointerDown(pd(3), B); g.pointerUp(pd(3));
  assert.equal(g.take(click, B), true, 'after release, a fresh press works');
  // Held Space: repeats do not re-record; a rejected synthetic click does not
  // clear the record, so the release click is refused too (round 15).
  g = make();
  g.keyDown(kd(' '), A); g.keyDown(kd(' ', true), B);
  assert.equal(g.take(kclick, B), false, 'a synthetic click on B while Space is held on A');
  g.keyUp(kd(' '));
  assert.equal(g.take(kclick, B), false, 'releasing Space still answers nothing on B');
  settle();
  assert.equal(g.take(kclick, B), true, 'after release, assistive tech answers what it shows');
  // Enter while Space is held on another card poisons the key slot.
  g = make();
  g.keyDown(kd(' '), A); g.keyDown(kd('Enter'), B);
  assert.equal(g.take(kclick, B), false);
  // A fresh press right after a release (before the clear) starts anew.
  g = make();
  g.pointerDown(pd(1), A); g.pointerUp(pd(1));
  g.pointerDown(pd(1), B); g.pointerUp(pd(1));
  assert.equal(g.take(click, B), true, 'a new gesture is not blocked by the last one');
  settle();
  // An older Mac (no tokens): the very card object must match.
  const O1 = { token: null }; const O2 = { token: null };
  g = make();
  g.pointerDown(pd(), O1); g.pointerUp(pd());
  assert.equal(g.take(click, O2), false, 'no tokens: a different read is refused');
  assert.equal(g.take(click, O1), true);
  // A secondary button does not record; blur forgets held keys.
  g = make();
  g.pointerDown(pd(1, 2), A);
  assert.equal(g.take(click, A), false);
  g.reset();
  assert.equal(g.take(kclick, B), true, 'a blur with nothing held forgets');
  // Space held through a window switch, released after B arrived (round 16).
  g = make();
  g.keyDown(kd(' '), A); g.reset();
  g.keyDown(kd(' ', true), B); g.keyUp(kd(' '));
  assert.equal(g.take(kclick, B), false, 'a press held through a blur answers nothing');
  settle();
  assert.equal(g.take(kclick, B), true, 'its release clears the poison');
  g = make();
  g.keyDown(kd(' '), A); g.reset(); g.keyDown(kd('Enter'), B);
  assert.equal(g.take(kclick, B), false, 'Enter while Space may still be held is poisoned');
  g = make();
  g.keyDown(kd(' '), A); g.reset(); g.keyDown(kd(' '), B);
  assert.equal(g.take(kclick, B), true, 'a fresh press of the orphaned key starts anew');
  g = make();
  g.keyDown(kd(' '), A); g.reset(); g.reset();
  g.keyUp(kd(' '));
  assert.equal(g.take(kclick, B), false, 'two blurs while held still answer nothing');
  // An older release's timer must not clear a newer poison (round 18).
  g = make();
  g.keyDown(kd(' '), A); g.reset(); g.keyUp(kd(' ')); // timer 1 scheduled
  g.keyDown(kd(' '), A); g.reset(); // held again, poisoned again
  settle(); // timer 1 fires
  g.keyUp(kd(' '));
  assert.equal(g.take(kclick, B), false, 'the newer poison survives the older timer');
  // An unrelated key's release does not clear a held key's poison (round 19).
  g = make();
  g.keyDown(kd(' '), A); g.reset(); g.keyUp(kd('Enter')); settle();
  g.keyUp(kd(' '));
  assert.equal(g.take(kclick, B), false, 'Enter released elsewhere did not unpoison Space');
  // A release lost in another window does not wedge assistive tech forever.
  g = make();
  g.keyDown(kd(' '), A); g.reset();
  assert.equal(g.take(kclick, B), false, 'poisoned while the orphan may be held');
  clock += 10000;
  assert.equal(g.take(kclick, B), true, 'the orphan expired: assistive tech works again');
  console.log('PASS  press guard');
}

// --- stepSummary: a run of steps as one line ---
{
  const { stepSummary } = await import('../../shared/chat-rows.js');
  const t = (name, extra = {}) => ({ type: 'tool', name, ...extra });
  assert.deepEqual(stepSummary([t('Write', { diff: { old: '', new: 'a\nb\nc' } }), t('Bash')]), { text: 'Created a file, ran a command', added: 3, removed: 0 });
  assert.deepEqual(stepSummary([t('Bash'), t('Bash'), t('Bash')]).text, 'Ran 3 commands');
  assert.deepEqual(stepSummary([t('Edit', { diff: { old: 'x\ny', new: 'z' } })]), { text: 'Edited a file', added: 1, removed: 2 });
  assert.deepEqual(stepSummary([t('Read'), t('Grep'), t('Bash'), t('Bash')]).text, 'Used 4 tools');
  assert.deepEqual(stepSummary([t('mcp__x__y')]).text, 'Used mcp__x__y');
  assert.deepEqual(stepSummary([{ type: 'thinking', text: 'hm' }]).text, 'Thought');
  assert.deepEqual(stepSummary([t('Edit'), t('MultiEdit')]).text, 'Edited 2 files');
  console.log('PASS  step summaries');
}

// The image cache never evicts a request still in flight: a page with more
// thumbnails than its size would otherwise re-request every one on each poll.
{
  const calls = [];
  const fetchOne = (ref) => new Promise((resolve) => calls.push({ ref, resolve }));
  const get = createImageCache(fetchOne, 2);
  const ps = ['a', 'b', 'c', 'd'].map((r) => get(r));
  await new Promise((r) => setTimeout(r, 0));
  ['a', 'b', 'c', 'd'].forEach((r) => assert.equal(get(r), ps[['a', 'b', 'c', 'd'].indexOf(r)], `pending ${r} is reused`));
  assert.equal(calls.length, 4, 'each image fetched once while pending');
  calls.forEach((c) => c.resolve({ mime: 'image/png', data: 'QUJD' }));
  await Promise.all(ps);
  get('e'); await new Promise((r) => setTimeout(r, 0));
  get('a'); await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.filter((c) => c.ref === 'a').length, 2, 'settled entries past the cap are evicted');
  console.log('PASS  image cache keeps pending requests');
}
