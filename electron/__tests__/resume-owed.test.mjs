// Bug report 2026-11-14: after a quit, a Mac restart and an update, 28 tabs came back as bare shells. The launch before
// had typed their resumes, but the 15 s capture zeroed each tab's running stamp while its resume was still queued (the
// tab shows no Claude yet), nothing stamped it again before the quit, and the quit check reached only the first
// windows' tabs. A launch resume still on its way keeps its stamp now; the quit check looks at tabs a few at a time.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/resume-owed.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-owed-'));
process.env.DOBIUS_TEST_USERDATA = userData;
const now = Date.now();
const link = (n) => ({ tabId: `term-/tmp/owed-proj-${n}`, projectPath: '/tmp/owed-proj', resolvedBy: 'argv', capturedAt: now - 3_600_000, lastRunningAt: now - 60_000 });
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  autoResume: { enabled: true, staggerMs: 50, skipOversizedMB: 4000, cancelOnUserInput: true },
  lastQuitAt: now - 30_000,
  sessionTabMap: { 'sess-owed-0001': link(1), 'sess-owed-0002': link(2), 'sess-owed-0003': link(3) },
  projects: {},
}));
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));

const ar = await import('../auto-resume.js');
const T1 = 'term-/tmp/owed-proj-1';
const T2 = 'term-/tmp/owed-proj-2';
const T3 = 'term-/tmp/owed-proj-3';

assert.equal(ar.resumeOwedFor(T1), null, 'nothing is owed before the launch pass has read the map');
// No window is open in the test, so the launch pass finds none of these tabs and leaves all three for later windows.
await ar.startAutoResume({ startupDelayMs: 500 });
assert.equal(ar.resumeOwedFor(T1), 'sess-owed-0001', 'a tab whose window has not opened yet is still owed its session');
assert.equal(ar.resumeOwedFor('term-/tmp/owed-proj-9'), null, 'a tab that ran nothing at the last quit is owed nothing');
console.log('PASS  a session waiting for its window keeps its stamp');

// The window opens: while its resume is being prepared it is still owed; once the resume is dropped it is not.
const pending = ar.resumeRestoredTab(T1);
assert.equal(ar.resumeOwedFor(T1), 'sess-owed-0001', 'owed while the resume is being prepared');
await pending; // no transcript in the test, so it is dropped
assert.equal(ar.resumeOwedFor(T1), null, 'a dropped resume owes nothing, so a tab showing no Claude clears as before');
console.log('PASS  owed while being prepared, released once the resume is dropped');

ar.forgetClosedTab(T2);
assert.equal(ar.resumeOwedFor(T2), null, 'a closed tab owes nothing');
console.log('PASS  a closed tab owes nothing');

ar.noteTabClaudeSeen(T3);
assert.equal(ar.resumeOwedFor(T3), 'sess-owed-0003', 'seeing Claude in a tab never typed into changes nothing');
ar.cancelAll();
assert.equal(ar.resumeOwedFor(T3), null, 'after a cancel all, nothing undecided is owed');
console.log('PASS  a cancel all ends what is owed');

// The parts that need a live PTY, pinned in the source.
const resume = fs.readFileSync(new URL('../auto-resume.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
assert.match(resume, /writeTerminal\(e\.tabId, cmd\);\s*typed\.set\(e\.tabId, \{ sessionId: e\.sessionId, at: Date\.now\(\), seq: terminalInputSeq\(e\.tabId\), pid: e\.pidAt \}\);/, 'a typed resume records the input count right after its own write');
assert.match(resume, /if \(cancelGen !== 0 \|\| terminalInputSeq\(tabId\) !== 0\) return null;\s*if \(queue\.has\(tabId\)\) return pidNow\(\) === queue\.get\(tabId\)\.pidAt \? queue\.get\(tabId\)\.sessionId : null;/, 'a queued or prepared resume is owed only while nothing was typed and nothing cancelled');
assert.match(main, /process\.kill\(n, 'SIGTERM'\);\s*endTypedResumes\(\);/, 'a Dashboard kill ends every typed resume');
assert.match(resume, /if \(pidNow\(\) !== t\.pid\) \{ typed\.delete\(tabId\); return null; \}/, 'a typed resume is owed only in the shell it was typed into');
assert.match(resume, /if \(now - t\.at < RESUME_SIGHT_MS && terminalInputSeq\(tabId\) === t\.seq\) return t\.sessionId;/, 'a typed resume is owed for a bounded time, and only until anything else is typed into the tab');
assert.match(resume, /export function forgetClosedTab\(tabId\) \{\s*handled\.add\(tabId\);\s*typed\.delete\(tabId\);/, 'closing the tab ends a typed resume');
assert.match(main, /if \(mappedIdle && resumeOwedFor\(t\.id\) !== mappedIdle\) clearSessionTabRunning\(mappedIdle\);\s*continue;\s*\}\s*noteTabClaudeSeen\(t\.id\);/, 'the capture spares an owed stamp and notes a Claude it sees');
assert.match(main, /if \(resumeOwedFor\(t\.id\) !== sid\) clearSessionTabRunning\(sid\);/, 'the quit check spares an owed stamp');
assert.match(main, /await mapLimit\(liveTabs, QUIT_PROBE_CONCURRENCY, async \(t\) => \{/, 'the quit check looks at tabs a few at a time');
console.log('PASS  the capture and the quit check both spare an owed stamp');
process.exit(0);
