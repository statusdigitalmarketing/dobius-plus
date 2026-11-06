import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oscScanState, chunkMayDraw } from '../osc-only.js';

test('tab-status markers and titles never count as drawing', () => {
  const st = oscScanState();
  assert.equal(chunkMayDraw('\x1b]777;dobius;needs\x07', st), false);
  assert.equal(chunkMayDraw('\x1b]777;dobius;working\x07\x1b]777;dobius;needs\x07', st), false);
  assert.equal(chunkMayDraw('\x1b]0;Fix login bug\x1b\\', st), false);
});

test('anything else counts, including escape-only cursor moves', () => {
  assert.equal(chunkMayDraw('a', oscScanState()), true);
  assert.equal(chunkMayDraw('\x1b[2J\x1b[H', oscScanState()), true);
  assert.equal(chunkMayDraw('\x1b]0;t\x07\x1b[1A', oscScanState()), true);
  assert.equal(chunkMayDraw('\x1b', oscScanState()), true); // a lone ESC could start anything
});

test('an OSC split over chunks stays an OSC, and what follows it counts', () => {
  const st = oscScanState();
  assert.equal(chunkMayDraw('\x1b]777;dobius;ne', st), false);
  assert.equal(chunkMayDraw('eds\x1b', st), false);
  assert.equal(chunkMayDraw('\\', st), false); // ESC \ across the boundary ends it
  assert.equal(chunkMayDraw('x', st), true);
  const st2 = oscScanState();
  assert.equal(chunkMayDraw('\x1b]0;title', st2), false);
  assert.equal(chunkMayDraw('\x1b[2J', st2), true); // a cut-off OSC, then a real sequence
});

// Recorded 2026-11-05 from real Claude Code 2.1.319: two AskUserQuestion calls at once, the first
// on screen. Everything that arrived while it waited, unchanged on screen (Sam's bug).
test('the real queued-question recording: nothing after the card draws', () => {
  const st = oscScanState();
  for (const c of ['\x1b]777;dobius;needs\x07', '\x1b]777;dobius;working\x07', '\x1b]777;dobius;needs\x07', '\x1b]777;dobius;needs\x07', '\x1b]777;dobius;needs\x07']) {
    assert.equal(chunkMayDraw(c, st), false);
  }
});

test('only titles and status markers are inert: a palette change counts (Codex)', () => {
  assert.equal(chunkMayDraw('\x1b]4;1;#000000;2;#ffffff\x07', oscScanState()), true);
  assert.equal(chunkMayDraw('\x1b]8;;https://x\x07', oscScanState()), true);
  assert.equal(chunkMayDraw('\x1b]2;title\x07', oscScanState()), false);
  // Decided at the terminator, even when the kind arrived in an earlier chunk.
  const st = oscScanState();
  assert.equal(chunkMayDraw('\x1b]4;1;#00', st), false);
  assert.equal(chunkMayDraw('0000\x07', st), true);
});

test('C1 controls inside an OSC are never trusted, and what follows counts (Codex)', () => {
  const st = oscScanState();
  assert.equal(chunkMayDraw('\x1b]0;t\x9c\x9b2J\x9bH', st), true);
  assert.equal(st.mode, 'ground');
  assert.equal(chunkMayDraw('next prompt', st), true);
});

test('an OSC that never ends stops being trusted', () => {
  const st = oscScanState();
  assert.equal(chunkMayDraw(`\x1b]0;${'x'.repeat(5000)}`, st), true);
  assert.equal(chunkMayDraw('\x07', st), true); // its end counts too: it was never trusted
});

test('a non-inert OSC counts when its ESC arrives, before the backslash (Codex)', () => {
  const st = oscScanState();
  assert.equal(chunkMayDraw('\x1b]4;1;#000000;2;#ffffff\x1b', st), true);
  assert.equal(chunkMayDraw('\\', st), true);
  const st2 = oscScanState();
  assert.equal(chunkMayDraw('\x1b]777;dobius;needs\x1b', st2), false);
  assert.equal(chunkMayDraw('\\', st2), false);
});

test('a string opened earlier, by C1 or a split ESC, makes the next chunk count (Codex)', () => {
  const st = oscScanState();
  assert.equal(chunkMayDraw('\x9d4;1;#000000;2;#ffffff', st), true);
  assert.equal(chunkMayDraw('\x1b]0;t\x07', st), true);
  const st2 = oscScanState();
  assert.equal(chunkMayDraw('\x1b', st2), true);
  assert.equal(chunkMayDraw(']4;1;#000000;2;#ffffff', st2), true);
  assert.equal(chunkMayDraw('\x1b]0;t\x07', st2), true);
  // Back in ground state, a marker alone is inert again.
  const st3 = oscScanState();
  assert.equal(chunkMayDraw('\x1b[2J\x1b[H', st3), true);
  assert.equal(chunkMayDraw('\x1b]777;dobius;needs\x07', st3), false);
  // Left inside a CSI: count.
  const st4 = oscScanState();
  assert.equal(chunkMayDraw('\x1b[3', st4), true);
  assert.equal(chunkMayDraw('\x1b]0;t\x07', st4), true);
});

test('C1 introducers and NUL or DEL inside an escape keep the parser in step (Codex)', () => {
  const st = oscScanState();
  assert.equal(chunkMayDraw('\x1b]0;t\x9d11;#ffffff', st), true);
  assert.equal(chunkMayDraw('\x1b]0;t\x07', st), true);
  const st2 = oscScanState();
  assert.equal(chunkMayDraw('\x1b\x00]11;#ffffff', st2), true);
  assert.equal(chunkMayDraw('\x1b]0;t\x07', st2), true);
  const st3 = oscScanState();
  assert.equal(chunkMayDraw('\x1b\x7f]11;#ffffff', st3), true);
  assert.equal(chunkMayDraw('\x1b]0;t\x07', st3), true);
  // ESC ( B (a charset), then a marker: the charset finished, so the marker is inert.
  const st4 = oscScanState();
  assert.equal(chunkMayDraw('\x1b(B', st4), true);
  assert.equal(chunkMayDraw('\x1b]777;dobius;needs\x07', st4), false);
});

test('a byte order mark is dropped, as xterm drops it (Codex)', () => {
  const st = oscScanState();
  assert.equal(chunkMayDraw('\x1b﻿]11;#ffffff', st), true);
  assert.equal(chunkMayDraw('\x1b]0;t\x07', st), true);
});

test('a respawned PTY starts unknown: its first chunk counts, then markers are inert again (Codex)', () => {
  const st = { ...oscScanState(), mode: 'unknown' };
  assert.equal(chunkMayDraw('\x1b]0;t\x07', st), true);
  assert.equal(chunkMayDraw('\x1b]777;dobius;needs\x07', st), false);
});
