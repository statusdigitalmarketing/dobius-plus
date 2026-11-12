// Live-Claude detection for the mobile Chat view. Brett's v1.0.56 report: the
// phone showed the sessionless "Start Claude / Resume last session" launcher
// over a tab where Claude was plainly RUNNING, so tapping Resume typed
// `claude --continue` into Claude's own prompt box (twice). The session link
// is not trustworthy; the PTY is. These frames are transcribed from Brett's
// screenshots and from live captures on this Mac.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/claude-live.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-livetest-'));
process.env.DOBIUS_TEST_USERDATA = userData;

const { claudeTuiPresent, tuiVisibleTail } = await import('../mobile-server.js');
const { stripAnsi } = await import('../selector-parser.js');
let pass = 0;
const ok = (name) => { console.log(`PASS  ${name}`); pass += 1; };

// 1. Brett's exact frame (b2b-portal website tab, v1.0.56): Claude live.
const brett = [
  '  clean.', '', '  > claude --continue',
  '  ' + '─'.repeat(60),
  '> Press up to edit queued messages',
  '  ' + '─'.repeat(60),
  '  >> auto mode on (shift+tab to cycle) . esc to interrupt . <- for agents',
  '/rc',
].join('\n');
assert.equal(claudeTuiPresent(brett), true);
ok('Brett live-Claude frame detected');

// 2. Bare zsh prompt (the genuinely sessionless case) must stay false, or the
// launcher would vanish from tabs that actually need it.
const shell = 'bigfuckingdog@Mac dobius-plus % echo hi\nhi\nbigfuckingdog@Mac dobius-plus % ';
assert.equal(claudeTuiPresent(shell), false);
ok('bare shell is not a live Claude');

// 3. Claude's boot banner + input hint, with real ANSI coloring around it.
const booted = '\x1b[38;2;153;153;153m> Try "edit store.js to..."\x1b[39m\n'
  + '\x1b[2m? for shortcuts\x1b[22m\n';
assert.equal(claudeTuiPresent(booted), true);
ok('freshly booted Claude detected through ANSI');

// 4. Only the TAIL matters: TUI chrome scrolled far above the visible tail
// (>4KB back) must not keep a long-exited Claude reading as live.
const stale = 'esc to interrupt\n' + 'x'.repeat(9000) + '\nuser@Mac project % ';
assert.equal(claudeTuiPresent(stale), false);
ok('stale chrome beyond the tail window is not live');

// 5. FALSE-POSITIVE guard (Codex, Medium): ordinary shell output mentioning
// shortcuts must NOT read as a live Claude, or the launcher disappears from a
// genuinely sessionless tab (the v1.0.51 dead end returning). Claude renders
// its hints as their OWN footer row, so the match is line-anchored.
const prose = [
  'user@Mac project % git help',
  '  see docs for shortcuts and aliases',
  '  press ? for shortcuts inside the pager',
  'user@Mac project % ',
].join('\n');
assert.equal(claudeTuiPresent(prose), false);
ok('shell prose mentioning shortcuts is not a live Claude');
// The real Claude footer row still matches.
assert.equal(claudeTuiPresent('some output\n  ? for shortcuts\n'), true);
assert.equal(claudeTuiPresent('  >> bypass permissions on\n'), true);
ok('anchored Claude footer rows still detected');

// 6. Chrome that merely SCROLLED PAST in a shell (Codex round 2): catting this
// repo's source, `claude --help`, or a pager showing Claude docs prints the
// same literals. Claude pins its footer to the bottom, so a returned shell
// prompt as the last line means the shell has control.
const catted = [
  'user@Mac project % cat electron/mobile-server.js',
  "  'esc to interrupt',",
  "  'shift+tab to cycle',",
  "  'Press up to edit queued messages',",
  'user@Mac project % ',
].join('\n');
assert.equal(claudeTuiPresent(catted), false);
ok('Claude literals scrolled past in a shell are not live');
// Same text WITHOUT a returned prompt (Claude actually holding the screen).
assert.equal(claudeTuiPresent(catted.replace(/\nuser@Mac project % $/, '\n')), true);
ok('no trailing prompt keeps a real live Claude detected');

// 7. The prompt guard must not fire on CLAUDE'S OWN bottom line merely because
// it ends in a shell symbol (Codex round 3, Medium): that would put the
// launcher back over a running session, which is the whole bug.
const liveEndingInDollar = [
  '  >> auto mode on (shift+tab to cycle) . esc to interrupt',
  '> echo $',
].join('\n');
assert.equal(claudeTuiPresent(liveEndingInDollar), true);
ok('live Claude whose last line ends in $ stays live');


// 8. ANSI-HEAVY RAW buffer (the live-harness regression): a repainting TUI
// emits many KB of escapes per frame, so slicing RAW bytes and stripping
// afterwards left only a line or two of visible text and the footer fell
// outside the window: a plainly-running Claude read as DEAD. Stripping must
// happen before the window is taken. Plain-text unit tests cannot catch this.
const heavyAnsi = [
  '  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 esc to interrupt',
  '  \u25c9 xhigh \u00b7 /effort',
].join('\n') + '\u001b[2K\u001b[1A'.repeat(3000);
assert.equal(claudeTuiPresent(heavyAnsi), true);
ok('live Claude detected through an ANSI-heavy repaint tail');

// 9. Defensive inputs.
assert.equal(claudeTuiPresent(''), false);
assert.equal(claudeTuiPresent(null), false);
assert.equal(claudeTuiPresent(undefined), false);
ok('empty/null input is not live');

// 10. The windowed strip gives exactly the old full strip's tail (perf, 2026-11-12): real Claude frames, every cut
// point class, escape-dense stretches that force the wider windows, ESC + newline, no newline at all.
{
  const ref = (t) => stripAnsi(String(t || '').slice(-262144)).slice(-4096);
  const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  const frames = fs.readdirSync(fx).filter((f) => /-raw\.(txt|bin)$/.test(f)).map((f) => fs.readFileSync(path.join(fx, f), 'latin1'));
  assert.ok(frames.length >= 8);
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const dense = '\u001b[2K\u001b[1A\u001b[38;5;246m\u001b[0m'.repeat(4000); // ~100KB, no visible text, no newline
  const cases = [];
  for (let k = 0; k < 40; k += 1) {
    let b = '';
    while (b.length < 300000) {
      const r = rnd(10);
      if (r === 0) b += dense;
      else if (r === 1) b += '\u001b\n\u001b\r\nx\u001b\n';
      else if (r === 2) b += 'y'.repeat(rnd(9000));
      else b += frames[rnd(frames.length)];
    }
    cases.push(b, b.slice(-(rnd(70000) + 1)), b.slice(0, rnd(b.length)), b.slice(-(16384 + rnd(64)) ), b.slice(-(65536 + rnd(64))));
  }
  // ESC + newline exactly where a window would start, with a column move after it: only a correct cut keeps the
  // column the full scan has there (the full scan never resets it, the ESC swallowed the newline).
  for (const after of [2000, 9000, 30000]) cases.push('x'.repeat(100000) + 'Q'.repeat(60) + '\u001b\n' + 'ab\u001b[5Gz\n' + 'v'.repeat(after));
  cases.push('', 'plain', dense, dense + 'tail\n', 'a\n'.repeat(200000), '\u001b\n'.repeat(50000) + 'end', '\u001b\n'.repeat(131072), 'z'.repeat(20000) + '\u001b\n'.repeat(40) + 'tail\n' + 'w'.repeat(5000));
  for (const [i, c] of cases.entries()) assert.equal(tuiVisibleTail(c), ref(c), `case ${i}`);
  ok(`windowed strip equals the full strip on ${cases.length} buffers`);
}

fs.rmSync(userData, { recursive: true, force: true });
console.log(`claude-live: ${pass} groups pass`);
