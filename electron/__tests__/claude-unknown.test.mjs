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
fs.symlinkSync('/bin/sleep', path.join(binDir, 'claudette'));
process.on('exit', () => {
  try { tm.killAll(); } catch { /* already down */ }
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

const AMBIG = 'term-/tmp/unknowntest-1';
const SHELL = 'term-/tmp/unknowntest-2';
for (const id of [AMBIG, SHELL]) assert.ok(tm.createTerminal(id, os.tmpdir(), null), `terminal ${id} created`);
await new Promise((r) => setTimeout(r, 1800));
tm.writeTerminal(AMBIG, `exec '${path.join(binDir, 'claudette')}' 25\r`);
await new Promise((r) => setTimeout(r, 1500));

assert.equal(await tm.getTerminalClaudeInfo(AMBIG), null, 'the default answer is still null');
assert.equal(await tm.getTerminalClaudeInfo(AMBIG, { unknown: true }), tm.CLAUDE_UNKNOWN, 'a check that cannot tell says so');
console.log('PASS  a check that cannot tell returns CLAUDE_UNKNOWN, not null');

// A plain shell is a definite "no Claude", in both modes.
assert.equal(await tm.getTerminalClaudeInfo(SHELL, { unknown: true }), null);
assert.equal(await tm.getTerminalClaudeInfo('term-/tmp/unknowntest-99', { unknown: true }), null, 'a closed tab is no Claude');
console.log('PASS  a plain shell or a closed tab is still null');
// Codex, PR 7: a failed check with the tab's shell in front is a definite "no Claude", so a session the person stopped
// loses its stamp even while every ps times out. Anything else in front, or an unreadable one, stays unknown.
const fake = (process) => ({ pty: { get process() { if (process instanceof Error) throw process; return process; } } });
assert.equal(tm.claudeCheckFailed(fake('zsh')), null);
assert.equal(tm.claudeCheckFailed(fake('-bash')), null);
assert.equal(tm.claudeCheckFailed(fake('/bin/zsh')), null);
assert.equal(tm.claudeCheckFailed(fake('node')), tm.CLAUDE_UNKNOWN, 'Claude (node) in front: could not tell');
assert.equal(tm.claudeCheckFailed(fake('vim')), tm.CLAUDE_UNKNOWN);
assert.equal(tm.claudeCheckFailed(fake(new Error('tty gone'))), tm.CLAUDE_UNKNOWN);
assert.equal(tm.claudeCheckFailed(null), tm.CLAUDE_UNKNOWN);
console.log('PASS  a failed check with a shell in front is "no Claude"; anything else stays unknown');
const src = fs.readFileSync(new URL('../terminal-manager.js', import.meta.url), 'utf8');
assert.match(src, /if \(!found\) return await ptySelf\(pid, strict, strict \|\| thorough \|\| unknown \? null : entry, unknown\);/, 'with children, unknown callers always look at the PTY root');
console.log('PASS  with children present, the running-stamp check always looks at the PTY root');
process.exit(0);
