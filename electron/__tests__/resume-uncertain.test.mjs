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
// Codex, PR 7: a clean quit, then the session ran again, checks started failing and Dobius crashed. The earlier quit is
// not the end of that uncertainty; it runs to the relaunch (7 minutes here), so the session is not resumed.
const near = pickLaunchSessions({ 'sess-near-0008': link(8, { lastRunningAt: QUIT + 2 * 60_000, uncertainSince: QUIT + 3 * 60_000 }) }, QUIT, QUIT + 10 * 60_000);
assert.equal(near.tabToBest.size, 0, 'an uncertainty that began after the last quit runs to now');
const shortNear = pickLaunchSessions({ 'sess-near-0009': link(9, { lastRunningAt: QUIT + 2 * 60_000, uncertainSince: QUIT + 9 * 60_000 }) }, QUIT, QUIT + 10 * 60_000);
assert.equal(shortNear.tabToBest.size, 1, 'one under 2 minutes at the relaunch still resumes');
console.log('PASS  after a crash the uncertainty is measured to the relaunch');

// Codex, PR 7: A was stopped and B resumed in the same tab; B then went uncertain for minutes. The tab is ruled out; it
// never falls back to A, the session the person stopped.
const two = pickLaunchSessions({
  'sess-old-a-0010': link(10, { tabId: 'term-/tmp/proj-10', lastRunningAt: QUIT - 9 * 60_000 }),
  'sess-new-b-0011': link(11, { tabId: 'term-/tmp/proj-10', lastRunningAt: QUIT - 8 * 60_000, uncertainSince: QUIT - 5 * 60_000 }),
}, QUIT, QUIT + 30_000);
assert.equal(two.tabToBest.size, 0, 'no fallback to the older session');
assert.deepEqual(two.uncertainTabs, ['term-/tmp/proj-10']);
const twoOk = pickLaunchSessions({
  'sess-old-a-0012': link(12, { tabId: 'term-/tmp/proj-12', lastRunningAt: QUIT - 9 * 60_000 }),
  'sess-new-b-0013': link(13, { tabId: 'term-/tmp/proj-12', lastRunningAt: QUIT - 8 * 60_000 }),
}, QUIT, QUIT + 30_000);
assert.equal(twoOk.tabToBest.get('term-/tmp/proj-12').sessionId, 'sess-new-b-0013', 'the newest link wins');
assert.equal('longUncertain' in twoOk.tabToBest.get('term-/tmp/proj-12'), false);
console.log('PASS  a tab whose newest session is long uncertain is ruled out, never handed an older one');

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

// Codex, PR 7 round 11: doubt from before a quit does not survive the launch that resumes the session. Quit at QUIT with
// doubt since QUIT-30s; the next launch resumes it (doubt cleared), checks fail from QUIT+75s, the person stops Claude,
// Dobius crashes and relaunches at QUIT+11min with lastQuitAt still QUIT. The new doubt is 9+ minutes: not resumed.
{
  const Q0 = Date.now() - 20 * 60_000; // config clamps stamps to now, so this timeline lives in the past
  cm.setSessionTabLink('sess-carry-0014', 'term-/tmp/proj-14', '/tmp/proj', 'argv', Q0 - 40_000);
  cm.markSessionTabUncertain('sess-carry-0014', Q0 - 30_000);
  assert.equal(pickLaunchSessions({ 'sess-carry-0014': cm.getSessionTabMap()['sess-carry-0014'] }, Q0, Q0 + 60_000).tabToBest.size, 1, 'first launch resumes it');
  cm.clearSessionTabUncertain('sess-carry-0014');
  assert.equal(cm.getSessionTabMap()['sess-carry-0014'].uncertainSince, undefined, 'the resume ends the old doubt');
  cm.markSessionTabUncertain('sess-carry-0014', Q0 + 75_000);
  const after = pickLaunchSessions({ 'sess-carry-0014': cm.getSessionTabMap()['sess-carry-0014'] }, Q0, Q0 + 11 * 60_000);
  assert.equal(after.tabToBest.size, 0, 'doubt from this run is measured to the relaunch after the crash');
  const { readFileSync } = await import('node:fs');
  const ar = readFileSync(new URL('../auto-resume.js', import.meta.url), 'utf8');
  assert.match(ar, /writeTerminal\(e\.tabId, cmd\);[\s\S]{0,300}?clearSessionTabUncertain\(e\.sessionId\);/, 'auto-resume ends the old doubt when it types the resume');
  console.log('PASS  doubt carried from before a quit ends when auto-resume starts the session again');
}
// Codex, PR 7 round 8: a session first unreadable during the quit's own final check is dated at the quit stamp, so an
// hour with the app closed does not count as an hour of doubt.
{
  const atQuit = pickLaunchSessions({ 'sess-quit-0012': link(12, { lastRunningAt: QUIT - 10_000, uncertainSince: QUIT }) }, QUIT, QUIT + 60 * 60_000);
  assert.equal(atQuit.tabToBest.size, 1, 'doubt that began at the quit is not measured through the closed hour');
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /quitStampAt = cfgQuit\.lastQuitAt;/, 'the quit records the stamp it wrote');
  assert.match(main, /markSessionTabUncertain\(sidUnknown, quitStampAt \?\? Date\.now\(\)\)/, 'the final check dates doubt at that stamp');
  assert.match(main, /\} else if \(running && running === sid\) \{[\s\S]{0,400}?touchSessionTabLink\(sid, quitStampAt \?\? Date\.now\(\)\)/, 'a session the quit check sees running is touched, ending its doubt');
  assert.match(main, /got\.sessionId === sidNow[\s\S]{0,200}?touchSessionTabLink\(sidNow, quitStampAt \?\? Date\.now\(\)\)/, 'argv proof at quit is recorded before the shared deadline can stop the pass');
  console.log('PASS  doubt first seen by the quit check is dated at the quit');
}

// Codex, PR 7 round 13: a quit from BEFORE the run that just ended (that run started later and crashed) does not end its
// doubt, whether the doubt was carried in or the launch's resume was cancelled. The run's start is recorded at launch.
{
  const L = { 'sess-cancel-0015': link(15, { lastRunningAt: QUIT - 40_000, uncertainSince: QUIT - 30_000 }) };
  assert.equal(pickLaunchSessions(L, QUIT, QUIT + 11 * 60_000, QUIT + 60_000).tabToBest.size, 0, 'the last run started after the quit and crashed: doubt runs to now');
  assert.equal(pickLaunchSessions(L, QUIT, QUIT + 11 * 60_000, QUIT - 3_600_000).tabToBest.size, 1, 'the quit ended the last run: doubt ends at the quit');
  assert.equal(pickLaunchSessions(L, QUIT, QUIT + 11 * 60_000).tabToBest.size, 1, 'no launch record (an older version wrote the quit): as before');
  const first = cm.recordLaunch(1_000);
  assert.equal(cm.recordLaunch(2_000), 1_000, 'each launch returns when the run before it started');
  assert.equal(cm.getPreviousLaunchAt(), 1_000);
  assert.equal(typeof first, 'number');
  const { readFileSync } = await import('node:fs');
  const mainSrc = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(mainSrc, /recordLaunch\(\);[^\n]*\n\s*void startAutoResume\(/, 'the launch is recorded right before auto-resume reads it');
  const arSrc = readFileSync(new URL('../auto-resume.js', import.meta.url), 'utf8');
  assert.match(arSrc, /pickLaunchSessions\(getSessionTabMap\(\) \|\| \{\}, lastQuitAt, Date\.now\(\), getPreviousLaunchAt\(\)\)/, 'auto-resume passes it');
  console.log('PASS  a crashed run\'s doubt is measured to the relaunch, not to an older quit');
}

process.exit(0);

