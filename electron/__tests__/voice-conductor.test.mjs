// Voice Conductor crash-loop breaker (v1.0.65). Bounds respawns so a claude
// that OOMs on startup cannot hammer, while normal recycles still proceed.
import { isCrashLooping } from '../voice-conductor.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

const now = 1_000_000;
const win = 5 * 60 * 1000;
check('under the limit is not a crash loop', isCrashLooping([now - 1000, now - 2000], now, win, 5), false);
check('exactly at the limit trips', isCrashLooping([now, now - 1, now - 2, now - 3, now - 4], now, win, 5), true);
check('old exits outside the window do not count',
  isCrashLooping([now - win - 1, now - win - 2, now - win - 3, now - win - 4, now - win - 5, now], now, win, 5), false);
check('empty history is never a loop', isCrashLooping([], now, win, 5), false);

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
