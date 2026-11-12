// A Claude check that cannot tell must say so (bug report 2026-11-11). The session capture reads null as "Claude
// stopped" and clears the running stamp auto-resume needs; on a loaded Mac a timed-out ps did exactly that, so tabs came
// back from a restart as bare shells. With { unknown: true } a failed check returns CLAUDE_UNKNOWN, never null.
// Driven against a real PTY: its shell is replaced (exec) by a program whose command names claude but is not Claude,
// which the process check refuses to classify (it throws), the same path a ps timeout takes.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/claude-unknown.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-unknowntest-'));
process.env.DOBIUS_TEST_USERDATA = userData;
const tm = await import('../terminal-manager.js');

// A symlink, not a copy: macOS kills a copied system binary on exec.
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-unknownbin-'));
// `<dir>/CLI Tools/claude` is the shape the classifier cannot rule out (a path with a space, ending in claude).
fs.mkdirSync(path.join(binDir, 'CLI Tools'));
fs.symlinkSync('/bin/sleep', path.join(binDir, 'CLI Tools', 'claude'));
fs.writeFileSync(path.join(binDir, 'claude.log'), '');
process.on('exit', () => {
  try { tm.killAll(); } catch { /* already down */ }
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

const AMBIG = 'term-/tmp/unknowntest-1';
const SHELL = 'term-/tmp/unknowntest-2';
const TAIL = 'term-/tmp/unknowntest-3';
for (const id of [AMBIG, SHELL, TAIL]) assert.ok(tm.createTerminal(id, os.tmpdir(), null), `terminal ${id} created`);
await new Promise((r) => setTimeout(r, 1800));
tm.writeTerminal(AMBIG, `exec '${path.join(binDir, 'CLI Tools', 'claude')}' 25\r`);
tm.writeTerminal(TAIL, `exec /usr/bin/tail -f '${path.join(binDir, 'claude.log')}'\r`);
await new Promise((r) => setTimeout(r, 1500));

assert.equal(await tm.getTerminalClaudeInfo(AMBIG), null, 'the default answer is still null');
assert.equal(await tm.getTerminalClaudeInfo(AMBIG, { unknown: true }), tm.CLAUDE_UNKNOWN, 'a check that cannot tell says so');
console.log('PASS  a check that cannot tell returns CLAUDE_UNKNOWN, not null');

// A plain shell is a definite "no Claude", in both modes.
assert.equal(await tm.getTerminalClaudeInfo(SHELL, { unknown: true }), null);
assert.equal(await tm.getTerminalClaudeInfo('term-/tmp/unknowntest-99', { unknown: true }), null, 'a closed tab is no Claude');
// Codex, PR 7: a root that only names claude in an argument the classifier rules out is a definite no Claude.
assert.equal(await tm.getTerminalClaudeInfo(TAIL, { unknown: true, rootCheck: true }), null, 'tail -f claude.log is not Claude');
console.log('PASS  a plain shell or a closed tab is still null; tail -f claude.log is no Claude');
const src = fs.readFileSync(new URL('../terminal-manager.js', import.meta.url), 'utf8');
assert.match(src, /if \(!found\) return await ptySelf\(pid, strict, strict \|\| thorough \|\| unknown \? null : entry, unknown\);/, 'with children, unknown callers always look at the PTY root');
console.log('PASS  with children present, the running-stamp check always looks at the PTY root');
assert.ok(!/claudeCheckFailed/.test(src), 'a failed check is never decided from the foreground name');
assert.match(src, /if \(err\?\.code === 1\) return null; \/\/ ps exit 1: the PTY's own process is gone/, 'a root that is gone is no Claude');
console.log('PASS  a failed check stays unknown; a PTY root that is gone is no Claude');
assert.match(src, /return await ptySelf\(pid, strict, strict \|\| thorough \|\| rootCheck \? null : entry, unknown\);/, 'no children: a stamped tab still looks at its root');
assert.match(src, /if \(rows === WIN_ROOT_GONE\) return null;/, 'Windows: a read table without the shell is no Claude');
const mainSrc = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
assert.equal((mainSrc.match(/getTerminalClaudeInfo\(t\.id, \{ unknown: true, rootCheck: stampedTabs\.has\(t\.id\) \}\)/g) || []).length, 2, 'capture and quit pass rootCheck for stamped tabs');
assert.match(src, /return root\.startFt == null \|\| !Number\.isFinite\(root\.startedAt\) \? null : WIN_ROOT_GONE;/, 'Windows: a shell row with no creation time stays could-not-tell');
console.log('PASS  stamped tabs always get the root checked; a Windows table without the shell is no Claude');
process.exit(0);
