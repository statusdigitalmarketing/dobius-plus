// Main-process terminal status authority (v1.0.43, remote Phase 1). Verifies it
// reproduces the renderer's OSC-marker + output-flow status logic.
import * as ts from '../terminal-status.js';
import { answersPrompt } from '../../shared/prompt-answer.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const mk = (s) => `\x1b]777;dobius;${s}\x07`;
const ID = 'term-/Users/sam/Projects (Code)/dobius-plus-1';

ts._reset();

// 1. Plain output -> working.
ts.ingest(ID, 'building...\r\n', 1000);
check('output -> working', ts.statusFor(ID).status, 'working');

// 2. `working` marker is hook-owned (survives the settle tick during quiet).
ts.ingest(ID, mk('working'), 1100);
check('working marker sets working', ts.statusFor(ID).status, 'working');
check('working marker is hook-owned', ts.statusFor(ID).hookOwned, true);
ts.settle(1100 + 5000); // 5s of silence
check('hook-owned working does NOT settle to done', ts.statusFor(ID).status, 'working');

// 3. `needs` marker, and output must NOT override it.
ts.ingest(ID, mk('needs'), 2000);
check('needs marker sets needs', ts.statusFor(ID).status, 'needs');
ts.ingest(ID, 'some repaint output', 2100);
check('output does not override needs', ts.statusFor(ID).status, 'needs');

// 4. `done` marker releases ownership, but the green must survive the marker's
// own trailing bytes (guard) AND the settle tick: a finished managed turn stays
// green, it does NOT go gray.
ts.ingest(ID, mk('done'), 3000);
check('done marker sets done', ts.statusFor(ID).status, 'done');
check('done releases hook ownership', ts.statusFor(ID).hookOwned, false);
ts.ingest(ID, 'trailing line\r\n', 3100); // within the done guard window
check('trailing bytes after done keep done (not working)', ts.statusFor(ID).status, 'done');
ts.settle(3100 + 2000); // >1.5s quiet, not hook-owned
check('managed done stays green after settle', ts.statusFor(ID).status, 'done');

// 4b. A plain shell (no markers) settles to IDLE (gray), not done (green),
// matching the desktop gray-dot behavior. Also: genuine output AFTER the done
// guard is treated as new plain-shell activity (Claude exited), so it can go
// yellow -> gray.
ts._reset();
ts.ingest(ID, 'ls -la\r\n', 5000);
check('plain output -> working', ts.statusFor(ID).status, 'working');
ts.settle(5000 + 2000); // >1.5s quiet, not hook-owned
check('plain shell settles to idle (gray)', ts.statusFor(ID).status, 'idle');

// 5. Marker split across two chunks is still detected.
ts._reset();
ts.ingest(ID, 'output\x1b]777;dob', 100);
check('partial marker chunk 1 not yet needs', ts.statusFor(ID).status !== 'needs', true);
ts.ingest(ID, 'ius;needs\x07', 150);
check('split marker across chunks -> needs', ts.statusFor(ID).status, 'needs');

// 6. Multiple markers in one chunk: last wins.
ts._reset();
ts.ingest(ID, `${mk('working')}...${mk('done')}`, 100);
check('multiple markers -> last wins (done)', ts.statusFor(ID).status, 'done');

// 7. A processed marker is not re-matched on the next chunk.
ts._reset();
ts.ingest(ID, mk('needs'), 100);
ts.ingest(ID, 'x', 200); // no marker; needs must persist, not be re-derived oddly
check('after needs, plain output keeps needs', ts.statusFor(ID).status, 'needs');

// 8. Exit moves the terminal into the recent-exit cache and drops it live.
ts._reset();
ts.ingest(ID, mk('working'), 100);
ts.noteExit(ID, { cwd: '/Users/sam/Projects (Code)/dobius-plus', exitCode: 0 }, 200);
check('exited terminal no longer live', ts.statusFor(ID), null);
const snap = ts.snapshot();
check('exit recorded in recentExits', snap.recentExits.length, 1);
check('exit carries project name', snap.recentExits[0].projectName, 'dobius-plus');
check('exit carries code', snap.recentExits[0].exitCode, 0);

// 9. snapshot returns live statuses.
ts._reset();
ts.ingest('term-a-1', mk('working'), 100);
ts.ingest('term-b-2', mk('needs'), 100);
const s2 = ts.snapshot();
check('snapshot lists both live tabs', Object.keys(s2.live).sort(), ['term-a-1', 'term-b-2']);

// Answering a permission prompt clears red: main injects a 'working' marker
// (terminal-manager injectStatusMarker) when answersPrompt says so.
check('Enter answers', answersPrompt('\r'), true);
check('an option number answers', answersPrompt('2'), true);
check('an arrow does not answer', answersPrompt('\x1b[B'), false);
check('Esc does not (Stop turns it green)', answersPrompt('\x1b'), false);
check('a multi-line paste does not', answersPrompt('\x1b[200~line one\rline two\x1b[201~'), false);
check('a number inside typed text does not', answersPrompt('12'), false);
{
  const A = 'term-answer-1';
  ts.ingest(A, mk('working'), 5000);
  ts.ingest(A, mk('needs'), 5010);
  check('an arrow keeps red', ts.noteInput(A, '\x1b[B', 5020), false);
  check('still red', ts.statusFor(A).status, 'needs');
  check('Enter answers (reported changed)', ts.noteInput(A, '\r', 5030), true);
  check('back to working', ts.statusFor(A).status, 'working');
  ts.ingest(A, 'long command output...\r\n', 5040);
  check('approved command output stays working (hook-owned)', ts.statusFor(A).status, 'working');
  ts.ingest(A, mk('needs'), 5050);
  check('a newer prompt turns it red again', ts.statusFor(A).status, 'needs');
  check('an option number answers', ts.noteInput(A, '2', 5060), true);
  ts.ingest(A, mk('done'), 5070);
  check('Enter on a green tab changes nothing', ts.noteInput(A, '\r', 5080), false);
  check('a tab never seen changes nothing', ts.noteInput('term-unknown-9', '\r', 5090), false);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
