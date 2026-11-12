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
const CHILD = 'term-/tmp/unknowntest-4';
for (const id of [AMBIG, SHELL, TAIL, CHILD]) assert.ok(tm.createTerminal(id, os.tmpdir(), null), `terminal ${id} created`);
await new Promise((r) => setTimeout(r, 1800));
tm.writeTerminal(AMBIG, `exec '${path.join(binDir, 'CLI Tools', 'claude')}' 25\r`);
tm.writeTerminal(TAIL, `exec /usr/bin/tail -f '${path.join(binDir, 'claude.log')}'\r`);
tm.writeTerminal(CHILD, `'${path.join(binDir, 'CLI Tools', 'claude')}' 25 &\r`);
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
// Codex, PR 7: a child that may be Claude under a plain shell keeps the tab could-not-tell; the shell root must not
// turn it into "no Claude".
assert.equal(await tm.getTerminalClaudeInfo(CHILD, { unknown: true, rootCheck: true }), tm.CLAUDE_UNKNOWN, 'an ambiguous child stays unknown');
console.log('PASS  an ambiguous child under a plain shell stays could-not-tell');
const src = fs.readFileSync(new URL('../terminal-manager.js', import.meta.url), 'utf8');
assert.match(src, /const self = await ptySelf\(pid, strict, strict \|\| thorough \|\| unknown \? null : entry, unknown\);/, 'with children, unknown callers always look at the PTY root');
assert.match(src, /if \(winShellMayHoldClaude\(rows, pid, progs\)\) return CLAUDE_UNKNOWN;/, 'Windows: a Claude the dated list could not see stays could-not-tell');
{
  const { winShellMayHoldClaude, shellPrograms, winClaudeCommand } = await import('../win-proc.js');
  const ft = (n) => String(133000000000000000n + BigInt(n));
  const shell = { pid: 10, ppid: 1, name: 'pwsh.exe', command: 'pwsh.exe', startFt: ft(1), startedAt: 1 };
  const cmd = { pid: 11, ppid: 10, name: 'cmd.exe', command: 'cmd.exe /d /s /c "C:\\x\\npm\\claude.cmd" --resume ab', startFt: null, startedAt: NaN };
  const node = { pid: 12, ppid: 11, name: 'node.exe', command: '"node" "C:\\x\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --resume ab', startFt: ft(3), startedAt: 3 };
  assert.ok(winClaudeCommand(node.command), 'the grandchild is a Claude command');
  const rows = [shell, cmd, node];
  const progs = shellPrograms(rows, 10);
  assert.equal(progs.includes(node), false, 'the dated list misses it under an undated launcher');
  assert.equal(winShellMayHoldClaude(rows, 10, progs), true, 'so the tab is could-not-tell');
  const vim = { pid: 13, ppid: 10, name: 'notepad.exe', command: 'notepad.exe C:\\tmp\\claude.txt', startFt: ft(4), startedAt: 4 };
  assert.equal(winShellMayHoldClaude([shell, vim], 10, shellPrograms([shell, vim], 10)), false, 'notepad with claude.txt is not');
}
const { winMayBeClaude } = await import('../win-proc.js');
assert.equal(winMayBeClaude({ name: 'notepad.exe', command: 'notepad.exe C:\\tmp\\claude.txt' }), false, 'notepad with claude.txt is not Claude');
assert.equal(winMayBeClaude({ name: 'node.exe', command: '' }), true, 'node with an unreadable command may be');
assert.equal(winMayBeClaude({ name: 'node.exe', command: 'node C:\\x\\claude-code\\cli.js' }), true);
assert.equal(winMayBeClaude({ name: 'node.exe', command: 'node server.js' }), false);
assert.equal(winMayBeClaude({ name: 'claude.exe', command: '' }), true);
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
