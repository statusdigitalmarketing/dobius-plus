// Thorough error logging (v1.0.65): pure formatting, rotation, and throttle.
import { formatLine, shouldRotate, throttleCheck, isPriorityKind } from '../error-log.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

const ts = new Date('2026-09-02T16:00:00.000Z');
check('formats timestamp + version + kind',
  formatLine('main.error', 'boom', '1.0.65', ts),
  '[2026-09-02T16:00:00.000Z] [v1.0.65] main.error: boom\n');
check('multi-line detail is indented as one grouped entry',
  formatLine('crash', 'line1\nline2', '1.0.65', ts),
  '[2026-09-02T16:00:00.000Z] [v1.0.65] crash: line1\n  line2\n');
check('carriage returns are stripped',
  formatLine('x', 'a\r\nb', '1.0.65', ts).includes('\r'), false);
check('null detail does not throw', typeof formatLine('x', null, '1', ts), 'string');

check('rotate at the 2MB cap', shouldRotate(2 * 1024 * 1024), true);
check('no rotate below the cap', shouldRotate(2 * 1024 * 1024 - 1), false);

// Throttle: first 500 in a minute write, the 501st notes, the rest drop,
// and the next minute resets.
const st = { windowStart: 0, windowCount: 0, throttledNoted: false };
let writes = 0, notes = 0, drops = 0;
for (let i = 0; i < 700; i += 1) {
  const v = throttleCheck(st, 1000); // same minute
  if (v === 'write') writes += 1; else if (v === 'note') notes += 1; else drops += 1;
}
check('throttle writes exactly the cap', writes, 500);
check('throttle notes exactly once', notes, 1);
check('throttle drops the rest', drops, 199);
const after = throttleCheck(st, 1000 + 61_000); // next minute
check('a new minute resets to write', after, 'write');

// Priority kinds (crash/process-gone) bypass the throttle entirely, so a
// noisy console loop can't bury the fatal event (Codex Medium).
check('crash.* is priority', isPriorityKind('crash.uncaughtException'), true);
check('renderer.gone is priority', isPriorityKind('renderer.gone'), true);
check('child.gone is priority', isPriorityKind('child.gone'), true);
check('preload-error is priority', isPriorityKind('renderer.preload-error'), true);
check('ordinary console noise is NOT priority', isPriorityKind('main.error'), false);
check('renderer.error (console) is NOT priority', isPriorityKind('renderer.error'), false);

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
