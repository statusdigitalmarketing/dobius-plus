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
