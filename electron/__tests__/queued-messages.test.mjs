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
console.log('queued-messages: 20 groups pass');
