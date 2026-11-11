// Codex, PR 7: a running stamp kept through failed checks must not bring back a session the person stopped while every
// check was failing. A stamp marked uncertain counts only if the checks had been failing for under 2 minutes at the
// quit; a confirmed check or a clear ends the uncertainty.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/resume-uncertain.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-uncertain-'));
process.env.DOBIUS_TEST_USERDATA = userData;
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ projects: {} }));
const cm = await import('../config-manager.js');
const { pickLaunchSessions } = await import('../auto-resume.js');
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));

const QUIT = 1_800_000_000_000;
const link = (n, extra = {}) => ({ tabId: `term-/tmp/proj-${n}`, projectPath: '/tmp/proj', resolvedBy: 'argv', capturedAt: QUIT - 3_600_000, lastRunningAt: QUIT - 10_000, ...extra });
const r = pickLaunchSessions({
  'sess-plain-0001': link(1),
  'sess-briefly-0002': link(2, { uncertainSince: QUIT - 30_000 }),
  'sess-long-0003': link(3, { uncertainSince: QUIT - 5 * 60_000 }),
  'sess-fresh-0004': link(4, { resolvedBy: 'fresh' }),
  'sess-stale-0005': link(5, { lastRunningAt: QUIT - 60 * 60_000 }),
}, QUIT, QUIT + 60_000);
assert.deepEqual([...r.tabToBest.values()].map((e) => e.sessionId).sort(), ['sess-briefly-0002', 'sess-plain-0001']);
assert.equal(r.skippedUncertain, 1);
assert.deepEqual(r.uncertainTabs, ['term-/tmp/proj-3']);
assert.equal(r.skippedHeuristic, 1);
assert.equal(r.skippedStale, 1);
console.log('PASS  a stamp uncertain for over 2 minutes at the quit is not resumed; a briefly uncertain one is');

// A crash (no fresh lastQuitAt): judged against now instead.
const crash = pickLaunchSessions({ 'sess-crash-0006': link(6, { lastRunningAt: QUIT, uncertainSince: QUIT - 5 * 60_000 }) }, 0, QUIT + 30_000);
assert.equal(crash.tabToBest.size, 0);
console.log('PASS  after a crash the uncertainty is measured to the relaunch');

// The lifecycle in config: marked once, kept by a later mark, cleared by a confirmed check or a clear.
cm.setSessionTabLink('sess-life-0007', 'term-/tmp/proj-7', '/tmp/proj', 'argv', 1000);
cm.markSessionTabUncertain('sess-life-0007', 2000);
cm.markSessionTabUncertain('sess-life-0007', 9000);
assert.equal(cm.getSessionTabMap()['sess-life-0007'].uncertainSince, 2000, 'the first failed check starts it');
cm.touchSessionTabLink('sess-life-0007', 10_000);
assert.equal(cm.getSessionTabMap()['sess-life-0007'].uncertainSince, undefined, 'a confirmed check ends it');
cm.markSessionTabUncertain('sess-life-0007', 11_000);
cm.clearSessionTabRunning('sess-life-0007');
assert.equal(cm.getSessionTabMap()['sess-life-0007'].uncertainSince, undefined, 'a clear ends it');
cm.markSessionTabUncertain('sess-life-0007', 12_000);
assert.equal(cm.getSessionTabMap()['sess-life-0007'].uncertainSince, undefined, 'a session not running is never marked');
console.log('PASS  uncertainty starts at the first failed check and ends on a confirmed check or a clear');
process.exit(0);
