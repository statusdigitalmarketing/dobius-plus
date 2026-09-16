// Discovery of live Claude processes and their real account binding (v1.0.75).
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/claude-process-scan.test.mjs
//
// The parsing is what matters and it is the part that can silently lie, so it
// is tested against real `ps eww` output shapes. An unreadable binding MUST
// report unknown, never "default": telling the user a session is on the default
// account when we could not read its environment is exactly the confident wrong
// answer that let a colleague's quota drain unnoticed.
import assert from 'node:assert/strict';
import { scanClaudeProcesses, defaultConfigDir, bindingFrom } from '../claude-process-scan.js';

let pass = 0;
const check = async (label, fn) => { await fn(); pass += 1; console.log(`PASS  ${label}`); };

// Exercise the REAL parser, never a copy of its regex: an earlier version of
// this file reimplemented the pattern and kept passing while the module's own
// pattern was truncating paths at the first space.
// `command` is `ps -o command=`, `envLine` is `ps eww -o command=` (argv, then
// the environment appended). Both are real shapes from this machine.
const CMD = 'claude --resume abc';
const bind = (envTail, command = CMD) => bindingFrom(command, `${command}${envTail}`);
// A value may contain spaces, so the parser offers every reading it cannot
// rule out, longest first, and the scan asks the filesystem which one is real.
// `dir` is the conservative reading (stop at the first thing shaped like a
// variable), which is what a normal environment yields.
const dir = (...a) => { const b = bind(...a); return b.candidates?.[b.candidates.length - 1]; };

await check('an explicit binding is read with its exact spelling', () => {
  assert.equal(
    dir(' SHELL=/bin/zsh CLAUDE_CONFIG_DIR=/Users/x/.claude-profiles/acct-1 TERM=xterm'),
    '/Users/x/.claude-profiles/acct-1',
  );
});

await check('a config dir CONTAINING SPACES survives intact', () => {
  // ps separates variables with spaces too, so a \\S* capture stopped at the
  // first one. That merged two distinct credentials and then logged out a third
  // directory belonging to neither.
  assert.equal(
    dir(' CLAUDE_CONFIG_DIR=/Users/x/Claude Profiles/a HOME=/Users/x'),
    '/Users/x/Claude Profiles/a',
  );
});

await check('a spaced path at the very END of the environment survives', () => {
  assert.equal(
    dir(' HOME=/Users/x CLAUDE_CONFIG_DIR=/Users/x/Claude Profiles/b'),
    '/Users/x/Claude Profiles/b',
  );
});

await check('two spaced paths stay two DIFFERENT credentials', () => {
  const a = dir(' CLAUDE_CONFIG_DIR=/Users/x/Claude Profiles/a HOME=/Users/x');
  const b = dir(' CLAUDE_CONFIG_DIR=/Users/x/Claude Profiles/b HOME=/Users/x');
  assert.notEqual(a, b, 'distinct directories must not collapse into one group');
});

await check('the trailing spelling is preserved, not normalised', () => {
  // The Keychain item is keyed by a hash of this exact string, so a trailing
  // slash must survive rather than being normalised away.
  assert.equal(dir(' CLAUDE_CONFIG_DIR=/Users/x/.claude-profiles/acct-2/ HOME=/Users/x'),
    '/Users/x/.claude-profiles/acct-2/');
});

await check('an env with no CLAUDE_CONFIG_DIR is the default, not unknown', () => {
  assert.equal(bind(' SHELL=/bin/zsh HOME=/Users/x TERM=xterm-256color').state, 'default');
});

await check('a command line with NO environment at all is UNKNOWN, never default', () => {
  // ps can print the command without the environment (permissions, a race).
  // Reporting "default" here would assert a binding we did not observe.
  assert.equal(bindingFrom(CMD, CMD).state, 'unknown');
  assert.equal(bindingFrom(CMD, null).state, 'unknown');
});

await check('the variable appearing as an ARGUMENT does not beat the real one', () => {
  // A command can legitimately mention the name; the real assignment is last.
  const cmd = 'claude -p CLAUDE_CONFIG_DIR=/decoy';
  assert.equal(dir(' HOME=/Users/x CLAUDE_CONFIG_DIR=/Users/x/.claude-profiles/real', cmd),
    '/Users/x/.claude-profiles/real');
});

await check('an empty assignment is unknown rather than an empty path', () => {
  assert.equal(bind(' CLAUDE_CONFIG_DIR= HOME=/Users/x').state, 'unknown');
});

await check('a value ending in an ODD variable name still offers the real reading', () => {
  // `BUILD-TAG=` is not a POSIX name, so a strict boundary did not stop the
  // value there and the parser returned the variable glued onto the path. The
  // candidate list must still contain the directory itself for the filesystem
  // check to find it.
  const c = bind(' CLAUDE_CONFIG_DIR=/profiles/alice BUILD-TAG=prod HOME=/Users/x').candidates;
  assert.ok(c.includes('/profiles/alice'), 'the real directory is among the readings');
  assert.ok(c.indexOf('/profiles/alice BUILD-TAG=prod') < c.indexOf('/profiles/alice'),
    'longer readings come first so the filesystem can prefer them');
});

await check('a spaced directory and its truncation are BOTH offered', () => {
  // The ps line is identical whether the value contains a space or TAG is
  // simply the next variable. The parser may not choose; it hands over every
  // reading and the scan takes the one the filesystem confirms, treating two
  // survivors as undecidable rather than flipping a coin over a logout.
  const c = bind(' CLAUDE_CONFIG_DIR=/profiles/team TAG=prod PATH=/usr/bin').candidates;
  assert.ok(c.includes('/profiles/team'), 'the short reading is offered');
  assert.ok(c.includes('/profiles/team TAG=prod'), 'the spaced reading is offered');
});

await check('the variable appearing TWICE in the environment is undecidable', () => {
  // A real environment carries it once. A second occurrence means one sits
  // inside another variable's value, and `HINT=use CLAUDE_CONFIG_DIR=/p/bob`
  // is shaped exactly like a real assignment. Taking the last one aimed the
  // logout at Bob while Alice's session kept spending.
  assert.equal(bind(' CLAUDE_CONFIG_DIR=/p/alice HINT=use CLAUDE_CONFIG_DIR=/p/bob').state, 'unknown');
});

await check('a RELATIVE binding is unknown, never resolved against our own cwd', () => {
  // The CLI resolves it against ITS working directory, which we cannot read.
  // Resolving `.claude` against Dobius's cwd mapped it onto the DEFAULT
  // credential and aimed a logout at the wrong Keychain item.
  assert.equal(bind(' CLAUDE_CONFIG_DIR=.claude HOME=/Users/x').state, 'unknown');
  assert.equal(bind(' CLAUDE_CONFIG_DIR=~/.claude-profiles/a HOME=/Users/x').state, 'unknown');
});

await check('argv changing BETWEEN the two ps reads is unknown, never default', () => {
  // The env read is sliced by the argv read's length. If the process rewrote
  // its argv in between, that slice cut into the environment and ate the
  // CLAUDE_CONFIG_DIR assignment while HOME survived, so an explicitly bound
  // session read as "default" and the wrong credential was re-logged.
  const first = 'claude --resume abc';
  const second = 'claude CLAUDE_CONFIG_DIR=/profiles/colleague HOME=/Users/x TERM=xterm';
  assert.equal(bindingFrom(first, second).state, 'unknown');
});

await check('scanning this machine returns a coherent, read-only result', async () => {
  const res = await scanClaudeProcesses();
  assert.ok(Array.isArray(res.groups), 'groups is an array');
  assert.ok(Array.isArray(res.unresolved), 'unresolved is an array');
  assert.equal(typeof res.total, 'number');
  assert.equal(typeof res.discoveryFailed, 'boolean');
  for (const g of res.groups) {
    assert.ok(g.pids.length > 0, 'group has pids');
    assert.ok(typeof g.key === 'string' && g.key.length > 0, 'group has a credential key');
    assert.ok(typeof g.configDir === 'string' && g.configDir.length > 0, 'group has a config dir');
    assert.equal(typeof g.envUnset, 'boolean', 'group records the binding mode');
  }
  // Accounting: every counted process is either grouped or listed as unresolved.
  // A process must never be silently dropped, or the caller would imply full
  // coverage it does not have.
  const grouped = res.groups.reduce((n, g) => n + g.pids.length, 0);
  assert.equal(grouped + res.unresolved.length, res.total, 'every process is accounted for');
});

await check('unset and explicit default collapse into ONE credential group', async () => {
  // They resolve to the same Keychain service, so treating them as two groups
  // would sign the same credential out twice, and a cancel between the two
  // would strand the sessions the first pass had just moved.
  const { keychainServiceFor } = await import('../account-identity.js');
  const { defaultConfigDir } = await import('../claude-process-scan.js');
  assert.equal(keychainServiceFor(defaultConfigDir()), keychainServiceFor(`${defaultConfigDir()}/`));
  const res = await scanClaudeProcesses();
  const keys = res.groups.map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate credential keys');
});

await check('the default config dir is the CLI home, not a profile', () => {
  assert.ok(defaultConfigDir().endsWith('/.claude'));
});

console.log(`\nALL PASS  (${pass} passed)`);
