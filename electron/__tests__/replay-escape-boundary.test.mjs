// The mobile replay buffer must never begin mid escape sequence (v1.0.74).
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/replay-escape-boundary.test.mjs
//
// Sam, on the phone: the terminal showed stray digits inside words
// ("backgro8", "backgro30", a literal "a38;2;211;218;") and Claude's live
// region piled up as "W Wa Wai Wait Waiti Waitin Waiting" instead of
// overwriting itself.
//
// Cause: the rolling buffer a freshly attached phone replays was kept with a
// plain `.slice(-cap)`, which cuts at an arbitrary offset. When the cut lands
// inside a sequence the leftover parameters PRINT AS TEXT, and the truncated
// move never happens, so the cursor is permanently off. Claude Code positions
// its live region relatively (cursor-up N then redraw), so every later frame
// then lands on the wrong rows and accumulates.
//
// This asserts against REAL captured Claude Code frames, not synthetic bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import headless from '@xterm/headless';
import { trimToEscapeBoundary } from '../terminal-manager.js';

const { Terminal } = headless;
const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, 'fixtures', 'askq-multi-q1-2.1.233-raw.bin')).toString('binary');

let pass = 0;
const check = async (label, fn) => { await fn(); pass += 1; console.log(`PASS  ${label}`); };

const render = (s) => {
  const t = new Terminal({ cols: 80, rows: 30, allowProposedApi: true, logLevel: 'off' });
  t.write(Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff));
  return new Promise((r) => setTimeout(() => {
    const out = [];
    for (let i = 0; i < t.buffer.active.length; i++) {
      const l = t.buffer.active.getLine(i);
      if (l) { const v = l.translateToString(true).replace(/\s+$/, ''); if (v.trim()) out.push(v); }
    }
    r(out);
  }, 120));
};

// Leftover escape parameters surface as digits welded to text, or a line that
// starts with parameter bytes.
const isCorrupt = (lines) => lines.some((l) => /⏺\d|backgro\d|\b\d{1,3};\d/.test(l) || /^\d+[A-Za-z]/.test(l));

await check('a buffer shorter than the cap is returned untouched', () => {
  assert.equal(trimToEscapeBoundary('plain text', 1000), 'plain text');
});

await check('a cut landing mid sequence resyncs forward to the next ESC', () => {
  const s = `abc\x1b[38;2;1;2;3mDEF\x1b[0mghi`;
  // cap chosen so the cut lands inside the SGR parameters
  const out = trimToEscapeBoundary(s, 14);
  assert.ok(out.startsWith('\x1b'), `expected to start at ESC, got ${JSON.stringify(out.slice(0, 8))}`);
});

await check('plain text with no escapes at all is kept as-is', () => {
  const s = 'x'.repeat(50);
  assert.equal(trimToEscapeBoundary(s, 10), 'x'.repeat(10));
});

await check('every cut of the real capture resyncs to an ESC (its escapes are dense)', () => {
  // Contract: resync happens only within ESC_RESYNC_WINDOW (4096). These
  // fixtures are dense TUI output, so a resync point is always close and
  // every trimmed cut must begin at an ESC. Assert the distance too, so this
  // cannot pass by accidentally falling into the far-away branch.
  for (let cap = 500; cap <= 8000; cap += 137) {
    const out = trimToEscapeBoundary(raw, cap);
    if (out.length === raw.length) continue;      // shorter than cap
    const plainCut = raw.slice(-cap);
    const firstEsc = plainCut.indexOf('\x1b');
    if (firstEsc === -1) continue;                // no escapes present
    assert.ok(firstEsc <= 4096, `cap=${cap}: fixture escape density changed (first ESC at ${firstEsc})`);
    if (firstEsc === 0) continue;                 // already at a boundary
    assert.equal(out[0], '\x1b', `cap=${cap} did not resync to an ESC`);
  }
});

await check('a plain-text tail is NOT gutted when the nearest ESC is far away', () => {
  // A build log: one escape 50k chars in. Resyncing to it would throw away the
  // whole visible tail, so the resync only applies within a short window.
  const plain = `${'x'.repeat(50000)}\x1b[0mEND`;
  const out = trimToEscapeBoundary(plain, 20000);
  assert.equal(out.length, 20000, 'kept a full cap of real output');
});

await check('real captured frames: the OLD slice corrupts some replays, the NEW trim corrupts none', async () => {
  let oldBad = 0; let newBad = 0; let tested = 0;
  for (let cap = 3000; cap <= 7000; cap += 250) {
    tested += 1;
    if (isCorrupt(await render(`\x1b[0m${raw.slice(-cap)}`))) oldBad += 1;
    if (isCorrupt(await render(`\x1b[0m${trimToEscapeBoundary(raw, cap)}`))) newBad += 1;
  }
  assert.ok(tested > 10, 'enough cut points exercised');
  assert.ok(oldBad > 0, 'the old behavior really did corrupt some replays (guards the fixture)');
  assert.equal(newBad, 0, `escape-aware trim still corrupted ${newBad} replays`);
});

console.log(`\nALL PASS  (${pass} passed)`);
