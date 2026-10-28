// Which sessions count as LIVE right now.
//
// Both the desktop Loose Ends tab and the mobile board subtract this set from
// the abandoned-work scan, so it has one job in each direction and both are
// costly to get wrong:
//   - too eager  -> a session already running is offered for Resume, and
//                   accepting double-runs the same transcript under two
//                   processes
//   - too shy    -> genuinely abandoned work is suppressed and never
//                   resurfaces, which makes the whole feature a lie
// The saved sessionId -> tabId map is a CACHE and it lies in three ways that
// all showed up in review: the tab can be dead, the tab can be alive with
// claude long since exited (the abandoned case itself), and the tab can have
// moved on to a different session while the link goes stale. This suite drives
// real PTYs running a stand-in `claude` binary so each of those is exercised
// against the actual process-inspection path, not a mock.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/live-sessions.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-livetest-'));
process.env.DOBIUS_TEST_USERDATA = userData;

const tm = await import('../terminal-manager.js');
const cfg = await import('../config-manager.js');

let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };

// A stand-in for the claude CLI. Detection keys off the BASENAME of argv[0]
// (see claude-argv.js), so /bin/sh reached through a symlink named `claude` is
// indistinguishable from the real thing to getTerminalClaudeInfo, and it can be
// told to sit still.
//
// A symlink, NOT a copy: macOS SIGKILLs a copied system binary on exec (the
// copy does not carry a valid signature), so the process is dead before ps can
// ever see it. The trailing `; true` matters too, because sh exec-optimises a
// `-c` script that is a single simple command and replaces itself with `sleep`,
// leaving nothing named `claude` in the process table.
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-fakebin-'));
const fakeClaude = path.join(binDir, 'claude');
fs.symlinkSync('/bin/sh', fakeClaude);
// PTYs start in os.tmpdir(). A relative argv[0] also works when TMPDIR has
// spaces, which ps cannot quote unambiguously for the process-name parser.
const fakeClaudeCommand = `./${path.basename(binDir)}/claude`;

// Unconditional teardown. This suite spawns real PTYs with real sleeping
// children, so a FAILING run must not leave them (or its temp dirs) behind.
// Cleanup written only at the bottom of the file runs on the happy path alone,
// and the failing runs during development leaked a dozen temp dirs before this.
process.on('exit', () => {
  try { tm.killAll(); } catch { /* already down */ }
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

const SHELL_TAB = 'term-/tmp/livetest-1';   // plain shell, no claude
const FRESH_TAB = 'term-/tmp/livetest-2';   // claude with no --resume in argv
const ARGV_TAB = 'term-/tmp/livetest-3';    // claude --resume <id>
const DEAD_TAB = 'term-/tmp/livetest-99';   // never existed in this process

for (const id of [SHELL_TAB, FRESH_TAB, ARGV_TAB]) {
  const res = tm.createTerminal(id, os.tmpdir(), null);
  assert.ok(res && res.ok !== false, `terminal ${id} created`);
}
// Let the login shells finish starting before typing at them.
await new Promise((r) => setTimeout(r, 1800));
// A fresh claude generates its session id at runtime, so nothing in its argv
// names it. Only the saved map can.
tm.writeTerminal(FRESH_TAB, `'${fakeClaudeCommand}' -c 'sleep 25; true'\r`);
tm.writeTerminal(ARGV_TAB, `'${fakeClaudeCommand}' -c 'sleep 25; true' --resume argv-session-0003\r`);
// Let the shells actually exec their children before inspecting them.
await new Promise((r) => setTimeout(r, 2000));

cfg.setSessionTabLink('sess-shell-0001', SHELL_TAB, os.tmpdir());
cfg.setSessionTabLink('sess-fresh-0002', FRESH_TAB, os.tmpdir());
cfg.setSessionTabLink('sess-dead-0004', DEAD_TAB, os.tmpdir());
// A STALE link: this tab has moved on to argv-session-0003, but the config
// still names the session that used to run there.
cfg.setSessionTabLink('sess-stale-0005', ARGV_TAB, os.tmpdir());
assert.equal(Object.keys(cfg.getSessionTabMap() || {}).length, 4, 'four links recorded');

const live = await tm.liveClaudeSessionIds();

// The argv id is read straight off the running process. Nothing else is as
// trustworthy, so it also settles what its tab is doing.
assert.ok(live.includes('argv-session-0003'), 'a --resume id in argv is live');
ok('argv names the session for a tab running claude --resume');

// The whole reason the map exists: this claude has no id to read.
assert.ok(live.includes('sess-fresh-0002'), 'a fresh claude is named by the map');
ok('the map supplies the id for a fresh claude');

// The three ways the map lies.
assert.ok(!live.includes('sess-dead-0004'), 'link to a tab that does not exist');
// The High fix: a tab you left open after claude exited is the ABANDONED case.
// Counting it as live is what hid genuinely abandoned work forever.
assert.ok(!live.includes('sess-shell-0001'), 'link to a live tab with no claude running');
// The tab moved on. Its old link must not suppress that session either.
assert.ok(!live.includes('sess-stale-0005'), 'stale link on a tab that changed session');
ok('a dead tab, a claude-less tab, and a superseded link are all ignored');

assert.equal(new Set(live).size, live.length, 'result is unique');
ok('result contains no duplicates');

// Killing the tab releases its session immediately. This is the transition
// that makes work eligible to show up as a loose end.
tm.killTerminal(ARGV_TAB);
tm.killTerminal(FRESH_TAB);
await new Promise((r) => setTimeout(r, 500));
const after = await tm.liveClaudeSessionIds();
assert.ok(!after.includes('argv-session-0003'), 'argv session released');
assert.ok(!after.includes('sess-fresh-0002'), 'fresh session released');
// The links themselves must survive: they are what name the sessions later.
assert.ok(cfg.getSessionTabMap()['sess-fresh-0002'], 'the link is not deleted, only ignored');
ok('killing the tab frees its session without destroying the link');

// A link that PREDATES the claude currently running in its tab is stale even
// though that claude is fresh and the tab is the right one. Stop `old`, start
// a bare `claude` in the same tab, and for up to 15s (until the next capture
// tick) the link still names `old` while the tab runs something else. That
// hid `old` from loose ends even though it was genuinely abandoned.
// Codex High, round 3.
{
  const TAB = 'term-/tmp/livetest-4';
  tm.createTerminal(TAB, os.tmpdir(), null);
  await new Promise((r) => setTimeout(r, 1800));
  tm.writeTerminal(TAB, `'${fakeClaudeCommand}' -c 'sleep 25; true'\r`);
  await new Promise((r) => setTimeout(r, 2000));
  // Backdate the link to well before this process started.
  cfg.setSessionTabLink('sess-predates-0006', TAB, os.tmpdir());
  const map = cfg.getSessionTabMap();
  map['sess-predates-0006'].capturedAt = Date.now() - 3600_000;
  const withStale = await tm.liveClaudeSessionIds();
  assert.ok(!withStale.includes('sess-predates-0006'), 'a link older than the running claude is stale');
  // The boundary is the whole point. `ps lstart` truncates DOWN to the second,
  // so the reported startedAt is up to 999ms EARLIER than the real start, and
  // a link captured inside that second cannot be proven current. Slack in that
  // direction is what let the stale link back through (Codex High, round 4),
  // so a link stamped just after the REPORTED start must still be rejected.
  const info = await tm.getTerminalClaudeInfo(TAB);
  assert.ok(Number.isFinite(info?.startedAt), 'the stand-in claude reports a start time');
  map['sess-predates-0006'].capturedAt = info.startedAt + 500;
  const inTruncationWindow = await tm.liveClaudeSessionIds();
  assert.ok(!inTruncationWindow.includes('sess-predates-0006'),
    'a link inside the ps truncation window is not proof and is rejected');

  // Clear of the window, it IS current.
  map['sess-predates-0006'].capturedAt = info.startedAt + 5000;
  const withFresh = await tm.liveClaudeSessionIds();
  assert.ok(withFresh.includes('sess-predates-0006'), 'a link clearly after the process is current');
  tm.killTerminal(TAB);
  ok('a link is only believed when it postdates the claude it describes');
}

// The claim closes the window between accepting a resume and that resume
// becoming visible as a process. Two surfaces checking inside it both got
// "not running" and both resumed. Codex Critical, round 3.
{
  const S = 'claimtest-session-0008';
  assert.equal(await tm.claimSessionResume(S), true, 'first claim wins');
  assert.equal(await tm.claimSessionResume(S), false, 'second claim is refused');
  assert.ok((await tm.liveClaudeSessionIds()).includes(S), 'a reservation reads as live');
  // A different session is unaffected.
  assert.equal(await tm.claimSessionResume('claimtest-other-0009'), true);
  // Bad input never reserves anything.
  assert.equal(await tm.claimSessionResume(''), false);
  assert.equal(await tm.claimSessionResume(null), false);
  ok('a claim is granted once and refuses every later caller');

  // A claim handed back frees the session immediately. The desktop claims
  // BEFORE the store asks its oversized-transcript question, so declining
  // that prompt would otherwise hold the session for the whole reservation.
  // Codex Medium, round 4.
  tm.releaseSessionResume(S);
  assert.ok(!(await tm.liveClaudeSessionIds()).includes(S), 'released');
  assert.equal(await tm.claimSessionResume(S), true, 'claimable again after release');
  tm.releaseSessionResume(S);
  tm.releaseSessionResume('claimtest-other-0009');
  // Release is ownership-checked too. A stale auto-resume timer giving up on a
  // session the PHONE had since claimed used to delete the phone's reservation
  // and re-open the double-run window. Codex Critical, round 10.
  const OWNED = 'releaseowner-0014';
  const OWNER_TAB = 'term-/tmp/livetest-10';
  tm.createTerminal(OWNER_TAB, os.tmpdir(), null);
  assert.equal(await tm.claimSessionResume(OWNED, OWNER_TAB), true);
  assert.equal(tm.releaseSessionResume(OWNED, 'term-/tmp/other-2'), false, 'a stranger cannot release it');
  assert.equal(tm.releaseSessionResume(OWNED), false, 'nor can a placeholder-shaped release');
  assert.ok((await tm.liveClaudeSessionIds()).includes(OWNED), 'so it is still held');
  assert.equal(tm.releaseSessionResume(OWNED, OWNER_TAB), true, 'the owner can');
  assert.ok(!(await tm.liveClaudeSessionIds()).includes(OWNED), 'and then it is free');
  assert.equal(tm.releaseSessionResume(OWNED, OWNER_TAB), false, 'releasing twice is a no-op');
  tm.killTerminal(OWNER_TAB);
  ok('a released claim frees the session at once');
}

// A tab-bound reservation has to outlive a slow shell profile plus claude
// startup, so it cannot be a short fixed timeout (Codex Critical, round 4).
// What ends it is the TAB going away, not the clock.
{
  const S = 'tabbound-session-0010';
  const TAB = 'term-/tmp/livetest-5';
  tm.createTerminal(TAB, os.tmpdir(), null);
  assert.equal(await tm.claimSessionResume(S, TAB), true, 'claimed for this tab');
  assert.ok((await tm.liveClaudeSessionIds()).includes(S), 'held while its tab lives');
  assert.equal(await tm.claimSessionResume(S), false, 'and refuses a second resume');
  tm.killTerminal(TAB);
  assert.ok(!(await tm.liveClaudeSessionIds()).includes(S), 'freed the moment its tab dies');
  // A reservation naming a tab that never existed must not wedge a session.
  await tm.claimSessionResume('ghost-session-0011', 'term-/tmp/never-1');
  assert.ok(!(await tm.liveClaudeSessionIds()).includes('ghost-session-0011'), 'ghost tab frees at once');
  ok('a tab-bound reservation lives and dies with its tab');
}

// The reservation lifetime rule itself, every branch, without waiting out real
// timeouts. Note what it does NOT do: it does not try to spot a FAILED resume
// by looking for a claude process after a grace period. That was implemented
// and it re-opened the double-run (Codex Critical, round 6), because a shell
// profile slower than the grace is indistinguishable from a resume that
// failed. Retrying a failed resume is handled by ownership instead.
{
  const now = 1_000_000;
  const held = { tabId: 'term-/p-1', reservedAt: now, expiry: now + 600_000 };
  const drop = (r, ctx) => tm.shouldDropReservation(r, { now, tabLive: true, ...ctx });

  assert.equal(drop(held), false, 'a live tab holds its reservation');
  assert.equal(drop(held, { tabLive: false }), true, 'a dead tab drops it');
  assert.equal(drop({ ...held, expiry: now - 1 }), true, 'expiry always wins');
  // No timing guess: an old reservation on a live tab is STILL held, because a
  // slow shell looks exactly like a failed resume from out here.
  assert.equal(drop({ ...held, reservedAt: now - 600_000 }), false, 'age alone never drops it');
  // A placeholder (no tab yet) rides its own short expiry and ignores tab state.
  assert.equal(drop({ tabId: null, reservedAt: now, expiry: now + 1000 }, { tabLive: false }), false, 'placeholder held');
  assert.equal(drop({ tabId: null, reservedAt: now, expiry: now - 1 }), true, 'placeholder expires');
  assert.equal(drop(null), true, 'a missing reservation is not held');
  ok('a reservation is held by its tab being alive, never by a timer guess');
}

// Ownership, which is what makes a failed resume retryable without any timing
// guess: the tab that holds the session may resume it again; another tab may
// not. Codex round 5 Medium, resolved without reopening round 6 Critical.
{
  const S = 'ownership-session-0012';
  const MINE = 'term-/tmp/livetest-6';
  const OTHER = 'term-/tmp/livetest-7';
  tm.createTerminal(MINE, os.tmpdir(), null);
  tm.createTerminal(OTHER, os.tmpdir(), null);

  assert.equal(await tm.claimSessionResume(S, MINE), true, 'first claim wins');
  // The resume failed (claude not on PATH, say). Retrying in the SAME tab is
  // the obvious move and must work, with no waiting.
  assert.equal(await tm.claimSessionResume(S, MINE), true, 'the owning tab may retry at once');
  // A different tab is still refused: that is the case that would put two
  // processes on one transcript.
  assert.equal(await tm.claimSessionResume(S, OTHER), false, 'another tab is refused');
  // And so is a caller with no tab at all (the phone always opens a new one).
  assert.equal(await tm.claimSessionResume(S), false, 'an untabbed caller is refused');

  tm.killTerminal(MINE);
  assert.equal(await tm.claimSessionResume(S, OTHER), true, 'freed once the owner is gone');
  tm.releaseSessionResume(S, OTHER);
  tm.killTerminal(OTHER);
  ok('the owning tab can retry; every other caller is refused');
}

// Binding a tab must never be able to TAKE a session. An unconditional
// reserve was exported for this and auto-resume used it to overwrite a claim
// the phone already held, so both ran (Codex Critical, round 9).
{
  const S = 'bind-session-0013';
  const MINE = 'term-/tmp/livetest-8';
  const THEIRS = 'term-/tmp/livetest-9';
  tm.createTerminal(MINE, os.tmpdir(), null);
  tm.createTerminal(THEIRS, os.tmpdir(), null);

  // Nothing reserved: a bind is a no-op, not a back door.
  assert.equal(tm.bindReservationTab(S, MINE), false, 'bind cannot create a reservation');
  assert.ok(!(await tm.liveClaudeSessionIds()).includes(S), 'and nothing is held');

  // Someone else holds it: a bind must not move it.
  assert.equal(await tm.claimSessionResume(S, THEIRS), true);
  assert.equal(tm.bindReservationTab(S, MINE), false, 'bind cannot steal another tab\'s claim');
  assert.equal(await tm.claimSessionResume(S, MINE), false, 'and the other tab is still refused');

  // The holder attaching its own tab (the placeholder-to-tab upgrade the phone
  // does once its terminal exists) is fine.
  tm.releaseSessionResume(S, THEIRS);
  assert.equal(await tm.claimSessionResume(S), true, 'claimed with no tab yet');
  assert.equal(tm.bindReservationTab(S, MINE), true, 'the holder may attach its tab');
  tm.killTerminal(MINE);
  assert.ok(!(await tm.liveClaudeSessionIds()).includes(S), 'and it now dies with that tab');
  tm.killTerminal(THEIRS);
  ok('binding a tab annotates a claim, it can never take one');
}

tm.killAll();
const empty = await tm.liveClaudeSessionIds();
// Every reservation above was released or died with its tab, so this really is
// empty. Reservation state leaking between groups would show up right here.
assert.deepEqual(empty, [], 'nothing is live with nothing running');
ok('safe to call with nothing running');

console.log(`live-sessions: ${pass} groups pass`);
