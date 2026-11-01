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
  check('Enter answers (reported changed)', ts.noteInput(A, '\r', 5030), 'prompt');
  check('back to working', ts.statusFor(A).status, 'working');
  ts.ingest(A, 'long command output...\r\n', 5040);
  check('approved command output stays working (hook-owned)', ts.statusFor(A).status, 'working');
  ts.ingest(A, mk('needs'), 5050);
  check('a newer prompt turns it red again', ts.statusFor(A).status, 'needs');
  check('an option number answers', ts.noteInput(A, '2', 5060), 'prompt');
  ts.ingest(A, mk('done'), 5070);
  check('Enter on a green tab changes nothing', ts.noteInput(A, '\r', 5080), false);
  check('a tab never seen changes nothing', ts.noteInput('term-unknown-9', '\r', 5090), false);
}

// Out-of-band hook status (Codex hooks arrive over the bridge, not in the PTY).
{
  const C = 'term-codex-1';
  check('unknown terminal is not applied', ts.noteHookStatus(C, 'needs', 6000), false);
  ts.ingest(C, 'codex banner\r\n', 6000);
  check('working applies', ts.noteHookStatus(C, 'working', 6010), true);
  check('working is hook-owned', ts.statusFor(C).hookOwned, true);
  ts.settle(6010 + 5000);
  check('hook-owned working survives a quiet tool call', ts.statusFor(C).status, 'working');
  check('needs applies', ts.noteHookStatus(C, 'needs', 7000), true);
  ts.ingest(C, 'approval overlay repaint\r\n', 7010);
  check('output does not clear red', ts.statusFor(C).status, 'needs');
  check('stretch (begun by the first output) kept across the prompt', ts.activityFor(C).since, 6000);
  check('Enter answers a Codex approval too', ts.noteInput(C, '\r', 7020), 'prompt');
  ts.noteHookStatus(C, 'done', 9010);
  check('done releases', [ts.statusFor(C).status, ts.statusFor(C).hookOwned], ['done', false]);
  check('stretch timed to done', ts.activityFor(C).lastWorkMs, 3010);
  ts.ingest(C, 'trailing prompt bytes\r\n', 9100);
  check('done guard keeps green against its own trailing bytes', ts.statusFor(C).status, 'done');
  check('a bad state is refused', ts.noteHookStatus(C, 'bogus', 9200), false);
  check('and changes nothing', ts.statusFor(C).status, 'done');
}

// A hook 'done' holds against later output (a resize repaint) until Enter.
{
  const G = 'term-green-1';
  ts.ingest(G, mk('working'), 10000);
  ts.ingest(G, mk('done'), 10100);
  ts.ingest(G, 'repaint after a resize\r\n', 15000);
  check('green survives a repaint long after the turn', ts.statusFor(G).status, 'done');
  check('typing without Enter keeps it', ts.releaseDone(G, 'ls'), false);
  check('a pasted line break is not Enter', ts.releaseDone(G, '\x1b[200~one\rtwo\x1b[201~'), false);
  check('Enter releases it', ts.releaseDone(G, '\r', 15050), true);
  check('released once only', ts.releaseDone(G, '\r'), false);
  check('Enter itself is activity', ts.statusFor(G).status, 'working');
  ts.ingest(G, 'shell command output\r\n', 15100);
  check('output after Enter drives the dot again', ts.statusFor(G).status, 'working');
  ts.settle(15100 + 5000);
  check('and settles to idle', ts.statusFor(G).status, 'idle');
  ts.noteHookStatus(G, 'done', 21000);
  ts.ingest(G, 'codex idle repaint\r\n', 25000);
  check('an out-of-band done holds the same way', ts.statusFor(G).status, 'done');
  check('a tab never seen releases nothing', ts.releaseDone('term-unknown-7', '\r'), false);
}

// A turn that ended handing back a `! command` (needs;handoff).
{
  const H = 'term-handoff-1';
  ts.ingest(H, mk('working'), 30000);
  ts.ingest(H, '\x1b]777;dobius;needs;handoff\x07', 31000);
  check('handoff turns the tab red', ts.statusFor(H).status, 'needs');
  ts.ingest(H, '\x1b]777;dobius;done;idle\x07', 91000);
  check("Claude's idle-a-minute signal does not clear it", ts.statusFor(H).status, 'needs');
  check('the idle signal changes nothing out of band either', ts.noteHookStatus(H, 'done', 91500, 'idle'), false);
  check('a digit typed while copying the command is no answer', ts.noteInput(H, '1', 91800), false);
  check('Option+Enter (a newline in the prompt) is no answer', ts.noteInput(H, '\x1b\r', 91850), false);
  check('a paste with a line break is no answer', ts.noteInput(H, '\x1b[200~a\rb\x1b[201~', 91900), false);
  check('still red', ts.statusFor(H).status, 'needs');
  check('running the command (Enter) answers it as a handoff', ts.noteInput(H, '\r', 92000), 'handoff');
  check('yellow while it runs', ts.statusFor(H).status, 'working');
  check('but not held: no hook may follow', ts.statusFor(H).hookOwned, false);
  ts.settle(92000 + 5000);
  check('and it settles if none does', ts.statusFor(H).status, 'idle');
  ts.ingest(H, mk('done'), 99000);
  check('a later Stop turns it green as usual', ts.statusFor(H).status, 'done');
  // a plain 'done;idle' on a tab that is not red still turns it green
  ts.ingest(H, mk('working'), 100000);
  ts.ingest(H, '\x1b]777;dobius;done;idle\x07', 160000);
  check('the idle signal still settles a working tab green', ts.statusFor(H).status, 'done');
  // a permission prompt answered is still Claude's turn
  ts.ingest(H, mk('needs'), 170000);
  check('a permission prompt is answered as a prompt', ts.noteInput(H, '\r', 171000), 'prompt');
  check('and stays held', ts.statusFor(H).hookOwned, true);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
