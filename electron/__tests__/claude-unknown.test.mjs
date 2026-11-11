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
process.exit(0);
