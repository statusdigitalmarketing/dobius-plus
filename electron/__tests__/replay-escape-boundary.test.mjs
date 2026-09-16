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

await check('a cut landing mid sequence resyncs to an ESC, never emitting a fragment', () => {
  const s1 = `X\x1b[31mRED\x1b[0m`;
  const out = trimToEscapeBoundary(s1, 11); // cut lands just after the ESC
  assert.equal(out[0], '\x1b', `started mid sequence: ${JSON.stringify(out.slice(0, 8))}`);
  assert.ok(!out.startsWith('[31m'), 'a CSI fragment leaked into the replay');
});

await check('an OSC payload fragment is never emitted either', () => {
  const s1 = `X\x1b]0;title\x07OK\x1b[0m`;
  const out = trimToEscapeBoundary(s1, 12);
  assert.ok(!out.startsWith('title'), `OSC payload leaked: ${JSON.stringify(out.slice(0, 8))}`);
});

await check('ordinary text that merely LOOKS like parameters is kept', () => {
  // "123abc" is indistinguishable from CSI params plus a final byte. A pattern
  // loose enough to strip fragments would eat it; resyncing to a real ESC does not.
  assert.equal(trimToEscapeBoundary('prefix123abc', 6), '123abc');
});

await check('plain text with no escapes at all is kept as-is', () => {
  const s = 'x'.repeat(50);
  assert.equal(trimToEscapeBoundary(s, 10), 'x'.repeat(10));
});

await check('no cut of the real capture starts mid sequence', () => {
  for (let cap = 500; cap <= 8000; cap += 137) {
    const out = trimToEscapeBoundary(raw, cap);
    if (out.length === raw.length) continue;          // shorter than cap
    const firstEsc = raw.slice(-cap).indexOf('\x1b');
    if (firstEsc <= 0) continue;                      // already safe
    assert.equal(out[0], '\x1b', `cap=${cap} did not resync to an ESC`);
  }
});

await check('a plain-text tail is NOT gutted', () => {
  // A build log with one escape far in. Only leftovers are stripped, so the
  // visible output survives intact.
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
