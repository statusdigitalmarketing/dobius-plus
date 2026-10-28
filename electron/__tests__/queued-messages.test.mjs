// Mid-turn sends: queue-operation enqueue entries surface as queued user
// messages, and dedupe drops them once the real user message lands.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/queued-messages.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DOBIUS_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-qtest-'));
const { entryToMessage, dedupeQueuedMessages } = await import('../data-service.js');

// 1. enqueue -> queued user message.
assert.deepEqual(
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'fix the bug please' }),
  { role: 'user', content: 'fix the bug please', queued: true },
);

// 2. remove/dequeue -> non-rendered markers; unknown ops and junk -> null.
assert.deepEqual(
  entryToMessage({ type: 'queue-operation', operation: 'dequeue', content: 'x' }),
  { role: 'user', content: 'x', queueRemove: true },
);
// Unknown/whole-queue ops (popAll, future ones) -> clear-all markers.
assert.deepEqual(
  entryToMessage({ type: 'queue-operation', operation: 'popAll', content: 'x' }),
  { role: 'user', content: 'x', queueClearAll: true },
);
assert.equal(entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: '' }), null);
assert.equal(entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: '   ' }), null);
assert.equal(entryToMessage({ type: 'queue-operation', operation: 'enqueue' }), null);

// 3. Normal user/assistant entries unaffected.
assert.deepEqual(
  entryToMessage({ message: { role: 'user', content: 'hi' } }),
  { role: 'user', content: 'hi' },
);

// 4. Dedup: queued message followed LATER by the real user message -> queued row dropped.
const flushed = dedupeQueuedMessages([
  { role: 'assistant', content: 'working on it' },
  { role: 'user', content: 'also do X', queued: true },
  { role: 'assistant', content: 'done with the first thing' },
  { role: 'user', content: 'also do X' },
]);
assert.deepEqual(flushed.map((m) => [m.role, !!m.queued]), [
  ['assistant', false], ['assistant', false], ['user', false],
]);

// 5. Still-queued message (no real user message after) -> kept, flagged.
const pending = dedupeQueuedMessages([
  { role: 'user', content: 'first ask' },
  { role: 'assistant', content: 'thinking' },
  { role: 'user', content: 'queued follow-up', queued: true },
]);
assert.equal(pending.length, 3);
assert.equal(pending[2].queued, true);

// 6. An EARLIER identical user message does not eat a queued one (only later
// messages prove the queue flushed).
const earlier = dedupeQueuedMessages([
  { role: 'user', content: 'same text' },
  { role: 'user', content: 'same text', queued: true },
]);
assert.equal(earlier.length, 2);

// 7. Whitespace-insensitive match.
const trimmed = dedupeQueuedMessages([
  { role: 'user', content: ' padded ', queued: true },
  { role: 'user', content: 'padded' },
]);
assert.equal(trimmed.length, 1);
assert.equal(trimmed[0].queued, undefined);

// 8. Codex P2 repro: enqueue then REMOVE of the same text, no later user turn
// -> nothing renders (the user deleted it from the TUI queue).
const removed = dedupeQueuedMessages([
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'what is espanso for' }),
  { role: 'assistant', content: 'still working' },
  entryToMessage({ type: 'queue-operation', operation: 'remove', content: 'what is espanso for' }),
]);
assert.deepEqual(removed.map((m) => m.role), ['assistant']);

// 9. remove marker rows never render even with no matching enqueue.
const strayRemove = dedupeQueuedMessages([
  entryToMessage({ type: 'queue-operation', operation: 'remove', content: 'never enqueued' }),
  { role: 'assistant', content: 'hi' },
]);
assert.deepEqual(strayRemove.map((m) => m.role), ['assistant']);

// 10. Two identical enqueues + one remove clears only the OLDEST; the other
// stays queued.
const twoQueued = dedupeQueuedMessages([
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'same' }),
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'same' }),
  entryToMessage({ type: 'queue-operation', operation: 'remove', content: 'same' }),
]);
assert.equal(twoQueued.length, 1);
assert.equal(twoQueued[0].queued, true);

// 11. dequeue followed by the real user message: no duplicate (dequeue clears
// the pending row; the real message renders once).
const dequeued = dedupeQueuedMessages([
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'run tests' }),
  entryToMessage({ type: 'queue-operation', operation: 'dequeue', content: 'run tests' }),
  { role: 'user', content: 'run tests' },
]);
assert.deepEqual(dequeued.map((m) => [m.role, !!m.queued]), [['user', false]]);

// 12. THE REAL SHAPE (Codex round 2, pocket-cologne 530/531): remove/dequeue
// markers usually carry NO content; a contentless marker clears the OLDEST
// pending row (FIFO).
const contentless = dedupeQueuedMessages([
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'can we have it so when the iphone taps' }),
  entryToMessage({ type: 'queue-operation', operation: 'remove' }),
  { role: 'assistant', content: 'next turn' },
]);
assert.deepEqual(contentless.map((m) => m.role), ['assistant']);

// 13. Contentless marker with an empty queue no-ops (marker still hidden).
const emptyQueue = dedupeQueuedMessages([
  entryToMessage({ type: 'queue-operation', operation: 'dequeue' }),
  { role: 'user', content: 'normal message' },
]);
assert.deepEqual(emptyQueue.map((m) => [m.role, !!m.queued]), [['user', false]]);

// 14. FIFO: two pending, one contentless remove clears the FIRST enqueued.
const fifo = dedupeQueuedMessages([
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'older' }),
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'newer' }),
  entryToMessage({ type: 'queue-operation', operation: 'remove' }),
]);
assert.deepEqual(fifo.map((m) => m.content), ['newer']);

// 15. popAll flushes the WHOLE queue (Codex round 3, pocket-cologne
// 28520/28521): nothing stays pending.
const popped = dedupeQueuedMessages([
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'keep ripping' }),
  entryToMessage({ type: 'queue-operation', operation: 'popAll', content: 'keep ripping' }),
  { role: 'assistant', content: 'on it' },
]);
assert.deepEqual(popped.map((m) => m.role), ['assistant']);

// 16. The round-3 misalignment chain: enqueue A, popAll (A flushed), enqueue
// B, contentless dequeue: B is cleared by the dequeue, NOT left stale.
const chain = dedupeQueuedMessages([
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'A keep ripping' }),
  entryToMessage({ type: 'queue-operation', operation: 'popAll' }),
  entryToMessage({ type: 'queue-operation', operation: 'enqueue', content: 'B /loop morning-scrub' }),
  entryToMessage({ type: 'queue-operation', operation: 'dequeue' }),
  { role: 'user', content: 'B /loop morning-scrub' },
]);
assert.deepEqual(chain.map((m) => [m.role, !!m.queued]), [['user', false]]);

// 17. Slash-command turn (REAL shape from a live transcript, 2026-08-07):
// raw <command-*> tags collapse to the one-liner the user typed.
const cmd = entryToMessage({ type: 'user', message: { role: 'user', content:
  '<command-name>/permissions</command-name>\n            <command-message>permissions</command-message>\n            <command-args></command-args>' } });
assert.deepEqual(cmd, { role: 'user', content: '/permissions', command: true });
const cmdArgs = entryToMessage({ type: 'user', message: { role: 'user', content:
  '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>fable</command-args>' } });
assert.equal(cmdArgs.content, '/model fable');

// 18. Skill invocation turn: the ENTIRE skill markdown used to render as a
// giant user bubble on mobile (Sam's report). Collapses to "/name (skill)".
const skill = entryToMessage({ type: 'user', message: { role: 'user', content:
  'Base directory for this skill: /Users/x/.claude/skills/review-audit\n\n# review-audit\n\nTwo independent reviewers catch what one misses.\n'.repeat(50) } });
assert.equal(skill.content, '/review-audit (skill)');
assert.equal(skill.command, true);
// ...but the body stays available as a collapsed preview (Sam, 10/28: "still
// have the skills preview"), without the "Base directory" plumbing line.
assert.ok(skill.detail.startsWith('# review-audit\n\nTwo independent reviewers'));
// A runaway skill body is capped like any message.
const huge = entryToMessage({ type: 'user', message: { role: 'user', content:
  'Base directory for this skill: /s/big\n\n' + 'x'.repeat(300000) } });
assert.ok(huge.detail.length < 300000 && huge.detail.endsWith('chars]'));

// 19. local-command-stdout keeps only its inner text; blank stdout renders
// nothing at all. Assistant turns are never collapsed even if they quote tags.
const stdout = entryToMessage({ type: 'user', message: { role: 'user', content:
  '<local-command-stdout>Set model to fable</local-command-stdout>' } });
assert.equal(stdout.content, 'Set model to fable');
assert.equal(entryToMessage({ type: 'user', message: { role: 'user', content:
  '<local-command-stdout></local-command-stdout>' } }), null);
const quoted = entryToMessage({ type: 'assistant', message: { role: 'assistant', content:
  'the transcript records <command-name>/model</command-name> turns' } });
assert.ok(quoted.content.includes('<command-name>'));
// A USER message that quotes command tags mid-prose (pasted transcript
// excerpt) is NOT collapsed: genuine command turns start with the tags
// (Codex corpus check: 3,295 real command turns, zero with leading prose).
const pasted = entryToMessage({ type: 'user', message: { role: 'user', content:
  'Here is the excerpt:\n<command-name>/model</command-name>\n<command-args>fable</command-args>\nWhat happened?' } });
assert.ok(pasted.content.startsWith('Here is the excerpt:'));
assert.equal(pasted.command, undefined);
// Paste starting at byte 0 with the tags but carrying trailing prose is ALSO
// left alone (Codex round 3); a genuine skill invocation (tags + skill body)
// still collapses to the command one-liner.
const pastedAtZero = entryToMessage({ type: 'user', message: { role: 'user', content:
  '<command-name>/model</command-name>\n<command-args>fable</command-args>\nWhat happened?' } });
assert.ok(pastedAtZero.content.endsWith('What happened?'));
const skillCombined = entryToMessage({ type: 'user', message: { role: 'user', content:
  '<command-message>machine</command-message>\n<command-name>/machine</command-name>\nBase directory for this skill: /Users/x/.claude/skills/machine\n\n# machine\n\nbody\n' } });
assert.deepEqual(skillCombined, { role: 'user', content: '/machine', command: true, detail: '# machine\n\nbody' });
// A bare "Base directory" line with no body has nothing to preview.
assert.equal(entryToMessage({ type: 'user', message: { role: 'user', content:
  'Base directory for this skill: /s/empty' } }).detail, undefined);


// --- v1.0.62 chat-noise batch (Sam's mobile bug list, 8/14) -----------------
const ESC = String.fromCharCode(27);
// A `!` composer command: transcript wraps it as <bash-input>; the chat must
// show the composer form (which also lets the mobile echo pruner match it and
// clear "sending…").
assert.deepEqual(entryToMessage({ type: 'user', message: { role: 'user', content: '<bash-input>cd /tmp && ls</bash-input>' } }),
  { role: 'user', content: '! cd /tmp && ls', command: true });
// Its output rows render as the output itself, ANSI stripped, stderr kept.
assert.deepEqual(entryToMessage({ type: 'user', message: { role: 'user', content: `<bash-stdout>ok ${ESC}[32mgreen${ESC}[39m</bash-stdout><bash-stderr>warn</bash-stderr>` } }),
  { role: 'user', content: 'ok green\nwarn', command: true });
// local-command-stdout carries bold/reset escapes in real transcripts
// ("Set model to \x1b[1mFable 5\x1b[22m..."); bubbles are not terminals.
assert.deepEqual(entryToMessage({ type: 'user', message: { role: 'user', content: `<local-command-stdout>Set model to ${ESC}[1mFable 5${ESC}[22m and saved</local-command-stdout>` } }),
  { role: 'user', content: 'Set model to Fable 5 and saved', command: true });
// System-injected reminder blocks are hidden outright: the human never typed
// them and the terminal never shows them ("breakdowns of things I
// traditionally wouldn't see").
assert.equal(entryToMessage({ type: 'user', message: { role: 'user', content: '<system-reminder>skill listing wall of text</system-reminder>' } }), null);
// Prose that merely MENTIONS the tags stays untouched.
assert.ok(entryToMessage({ type: 'user', message: { role: 'user', content: 'the <bash-input> tag is neat' } }).content.includes('tag is neat'));

fs.rmSync(process.env.DOBIUS_TEST_USERDATA, { recursive: true, force: true });
// 21. api-request-blob records (API request snapshots, role user/assistant)
// are never conversation: both JSONL readers drop them, in either key order.
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { parseJsonl, streamJsonl } = await import('../data-utils.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'real question' } }),
    JSON.stringify({ type: 'api-request-blob', hash: 'h', sessionId: 's', message: { role: 'assistant', content: 'old turn' } }),
    JSON.stringify({ hash: 'h2', type: 'api-request-blob', message: { role: 'user', content: 'Tool loaded.' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'real answer' } }),
  ].join('\n') + '\n');
  const types = (list) => list.map((e) => e.type);
  assert.deepEqual(types(await parseJsonl(f)), ['user', 'assistant']);
  assert.deepEqual(types(await parseJsonl(f, 10)), ['user', 'assistant']);
  const streamed = [];
  await streamJsonl(f, (e) => streamed.push(e));
  assert.deepEqual(types(streamed), ['user', 'assistant']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 22. Typed blocks (opt-in). One assistant turn written as Claude Code
// writes it: text, then a tool call, its result in a USER record, more text.
{
  const { mergeTurns } = await import('../data-service.js');
  const A = (content) => ({ type: 'assistant', message: { role: 'assistant', content } });
  const U = (content) => ({ type: 'user', message: { role: 'user', content } });
  const thinkText = A([{ type: 'thinking', thinking: 'weighing it' }, { type: 'text', text: 'Let me look.' }]);
  // Legacy callers (the App Store iOS UI) get exactly the old row.
  assert.deepEqual(entryToMessage(thinkText), { role: 'assistant', content: 'weighing it\nLet me look.' });
  assert.equal(entryToMessage(U([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])), null);
  // Blocks mode: thinking is its own block, never in the reply text.
  const b1 = entryToMessage(thinkText, { blocks: true });
  assert.deepEqual(b1, { role: 'assistant', content: 'Let me look.', blocks: [{ type: 'thinking', text: 'weighing it' }, { type: 'text', text: 'Let me look.' }] });
  // Redacted thinking (empty text, signature only: 94% of real blocks) is dropped.
  assert.deepEqual(entryToMessage(A([{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'hi' }]), { blocks: true }), { role: 'assistant', content: 'hi' });
  const edit = entryToMessage(A([{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/r/a.js', old_string: 'a = 1', new_string: 'a = 2' } }]), { blocks: true });
  assert.deepEqual(edit.blocks, [{ type: 'tool', id: 't1', name: 'Edit', summary: '/r/a.js', diff: { old: 'a = 1', new: 'a = 2' } }]);
  assert.equal(edit.content, '');
  const bash = entryToMessage(A([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test\nnpm run build', description: 'x' } }]), { blocks: true });
  assert.deepEqual(bash.blocks[0], { type: 'tool', id: 't2', name: 'Bash', summary: 'npm test ...', input: 'npm test\nnpm run build' });
  const res = entryToMessage(U([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'edited' }] }, { type: 'tool_result', tool_use_id: 't2', content: `${String.fromCharCode(27)}[31mfail${String.fromCharCode(27)}[0m`, is_error: true }]), { blocks: true });
  assert.deepEqual(res, { role: 'user', content: '', toolResults: [{ id: 't1', text: 'edited', isError: false }, { id: 't2', text: 'fail', isError: true }] });
  const done = entryToMessage(A([{ type: 'text', text: 'Fixed.' }]), { blocks: true });
  const ask = { role: 'user', content: 'thanks, now deploy' };
  const merged = mergeTurns([{ role: 'user', content: 'fix a' }, b1, edit, bash, res, done, ask, { ...done }]);
  assert.equal(merged.length, 4, 'one row per turn, the result marker dropped');
  assert.equal(merged[1].content, 'Let me look.\n\nFixed.');
  assert.deepEqual(merged[1].blocks.map((b) => b.type), ['thinking', 'text', 'tool', 'tool', 'text']);
  assert.equal(merged[1].blocks[2].result, 'edited');
  assert.equal(merged[1].blocks[3].isError, true);
  assert.equal(merged[1].blocks[3].result, 'fail');
  // A user message ends the turn; a plain text-only reply keeps the old shape.
  assert.deepEqual(merged[3], { role: 'assistant', content: 'Fixed.' });
  // Inputs are never mutated (the tail cache holds them).
  assert.equal(edit.blocks[0].result, undefined);
  // A result whose tool fell outside the window is simply dropped.
  assert.equal(mergeTurns([res]).length, 0);
  // Write shows the new file as an all-added diff.
  const write = entryToMessage(A([{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: '/r/b.md', content: '# hi' } }]), { blocks: true });
  assert.deepEqual(write.blocks[0].diff, { old: '', new: '# hi' });
  // A huge result is capped.
  const big = entryToMessage(U([{ type: 'tool_result', tool_use_id: 't9', content: 'y'.repeat(50000) }]), { blocks: true });
  assert.ok(big.toolResults[0].text.length < 1300 && big.toolResults[0].text.endsWith('chars]'));
}

// 23. A context-compaction summary is a chip with the summary behind it, in
// both modes (it was a 20KB "You" bubble nobody typed).
{
  const summary = entryToMessage({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation.\n\nSummary: ...' } });
  assert.equal(summary.content, 'Conversation compacted');
  assert.equal(summary.command, true);
  assert.equal(summary.detailLabel, 'summary');
  assert.ok(summary.detail.startsWith('This session is being continued'));
}

console.log('queued-messages: 23 groups pass');
