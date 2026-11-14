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
  // Codex P2: a column past 2^53 (columns now stop at 1e9 in both modes, so this compares like with like).
  cases.push('\u001b[9007199254740994Gesc to \u001b[9007199254740994Ginterrupt', '\u001b[2000000000G' + 'x'.repeat(5000) + '\u001b[5G\u001b[B');
  for (const [i, c] of cases.entries()) assert.equal(tuiVisibleTail(c), ref(c), `case ${i}`);
  ok(`windowed strip equals the full strip on ${cases.length} buffers`);
}

// 11. Escape runs with no terminator stay linear (Codex P1, 2026-11-12): stripAnsi searched the rest of the string for
// an ST on every OSC, about 30s of blocked main process for 256KB of ESC ] BEL. Generous limits, still far below that.
{
  const runs = [
    '\u001b]\u0007'.repeat(87000),
    '\u001bP' + 'a'.repeat(196606) + '\n' + '\u001b]\u0007'.repeat(16383) + '\n' + '\u001b]\u0007'.repeat(5461),
    '\u001bPq'.repeat(87000),
  ];
  for (const r of runs) {
    const t0 = Date.now();
    stripAnsi(r);
    claudeTuiPresent(r);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  }
  ok('unterminated OSC and DCS runs strip in linear time');
}

// 12. stripAnsi's tail mode is the tail of the full strip, and cursor motion that expands 3 bytes into 401 characters
// costs input time, not output time (Codex P1, 2026-11-12).
{
  let seed = 99;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const parts = ['\u001b]', '\u0007', '\u001b\\', '\u001bP', '\u001b[', '\u001b', '\n', '\r', 'ab', '0;t', '\u001b[5G', '\u001b[1G',
    '\u001b[9007199254740994G', '\u001b[999999999G', '\u001b[4000000000C',
    '\u001b[400G', '\u001b[3C', '\u001b[2B', '\u001b[E', '\u001bX', 'zz ', '\u001b[0m', 'x'];
  for (let k = 0; k < 20000; k += 1) {
    let s = '';
    const L = rnd(80);
    for (let j = 0; j < L; j += 1) s += parts[rnd(parts.length)];
    const T = 1 + rnd(40);
    assert.equal(stripAnsi(s, T), stripAnsi(s).slice(-T), JSON.stringify([s, T]));
  }
  const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  for (const f of fs.readdirSync(fx).filter((n) => /-raw\.(txt|bin)$/.test(n))) {
    const raw = fs.readFileSync(path.join(fx, f), 'latin1');
    for (const T of [1, 50, 4096, 100000]) assert.equal(stripAnsi(raw, T), stripAnsi(raw).slice(-T), `${f} ${T}`);
  }
  const amp = [
    '\u001b[400G' + '\u001b[B'.repeat(87000),
    '\u001bP' + 'a'.repeat(245758) + '\n' + '\u001b[400G' + '\u001b[B'.repeat(5458),
    '\u001b[400C'.repeat(43000),
  ];
  // CPU time, fastest of three runs, not wall time: wall time on this Mac (load 20+ on 18 cores with dozens of
  // sessions) failed two release preflights on 2026-11-14 with nothing wrong in the code, and a budget scaled by load
  // average admits the regression once the load drops (Codex P2, PR #15). Measured 2026-11-14, 10 calls on the first
  // input: stripAnsi 70 to 150ms now and 450 to 500ms for the code before 095453b, so it gets a fixed 200ms.
  // claudeTuiPresent is the production caller and costs what stripAnsi does on these inputs (70 to 100ms); a caller
  // that drops the tail argument brings the expansion back while stripAnsi alone stays fast (Codex P2, PR #15 round 3)
  // and costs 1.8 times as much in this run (each escape pads at most 400 characters and joining them is cheap, so that
  // regression costs memory far more than CPU). So it is bounded against stripAnsi measured in the same run, which load
  // moves together, at 1.5x with a 20ms floor for the input that costs almost nothing either way, and every stripAnsi
  // call in mobile-server.js must pass the tail, which no load can move.
  const cpuMs = (f) => { const c0 = process.cpuUsage(); f(); const c = process.cpuUsage(c0); return (c.user + c.system) / 1000; };
  const ten = (f) => cpuMs(() => { for (let n = 0; n < 10; n += 1) f(); });
  for (const r of amp) {
    let strip = Infinity;
    let tui = Infinity;
    const okNow = () => strip < 200 && tui < Math.max(20, 1.5 * strip);
    for (let tries = 0; tries < 3 && !okNow(); tries += 1) {
      strip = Math.min(strip, ten(() => stripAnsi(r, 4096)));
      tui = Math.min(tui, ten(() => claudeTuiPresent(r)));
    }
    assert.ok(strip < 200, `10 stripAnsi calls took ${strip.toFixed(0)}ms of CPU at best of 3 (budget 200ms)`);
    assert.ok(tui < Math.max(20, 1.5 * strip), `10 claudeTuiPresent calls took ${tui.toFixed(0)}ms of CPU, stripAnsi ${strip.toFixed(0)}ms`);
  }
  const msSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile-server.js'), 'utf8');
  const calls = msSrc.split('\n').filter((l) => !l.trim().startsWith('//') && l.includes('stripAnsi('));
  assert.ok(calls.length >= 2, 'tuiVisibleTail strips through stripAnsi');
  for (const l of calls) assert.match(l, /stripAnsi\((?:[^()]|\([^()]*\))*, TUI_TAIL\)/, `stripAnsi without the tail: ${l.trim()}`);
  ok('tail mode equals the full strip tail and stays fast on cursor-motion runs');
}

fs.rmSync(userData, { recursive: true, force: true });
console.log(`claude-live: ${pass} groups pass`);
