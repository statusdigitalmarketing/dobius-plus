// Which ps command lines count as a live Claude CLI.
//
// This has been wrong in both directions in review, and each direction has a
// real cost, so both are pinned here:
//   too loose (r3): `vim claude-notes.md` counted as a live Claude, so the quit
//                   reconcile saw claudeAlive, skipped clearing a stopped
//                   session's stamp, and auto-resume resurrected it.
//   too tight (r9): judging argv[0] alone missed `node /path/claude --resume x`
//                   (the npm shebang shim), so on those installs every running
//                   session looked idle and lost its tab name + auto-resume.
//
// Cases marked REAL are verbatim ps lines captured from this machine.
import { isClaudeCommand, classifyClaudeProcess } from '../claude-argv.js';

let pass = 0, fail = 0;
const check = (cmd, want, note) => {
  const got = isClaudeCommand(cmd);
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(got).padEnd(5)} (want ${String(want).padEnd(5)})  ${note}`);
  if (!ok) console.log(`        cmd: ${cmd}`);
};

// --- must MATCH ---
check('claude --resume 8f33dfd4-6457-4728-b7c9-44c20fc8b250', true, 'REAL: resumed session');
check('claude', true, 'bare fresh claude (the v1.0.39 case)');
check('claude --system-prompt-file /var/folders/x/dobius-voice-conductor-prompt.txt --model claude-opus-4-8', true, 'REAL: voice conductor');
check('/Users/bigfuckingdog/.local/share/claude/versions/2.1.208 --chrome-native-host', true, 'REAL: native versioned binary');
check('/Users/bigfuckingdog/.local/bin/claude --resume abc', true, 'absolute path to claude');
check('node /opt/homebrew/bin/claude --resume abc123', true, 'r9: npm shebang shim');
check('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume abc', true, 'r9: npm cli.js entrypoint');
check('/usr/bin/env node /opt/homebrew/bin/claude', true, 'r9: env node shim');
check('bun /opt/homebrew/bin/claude --resume x', true, 'r9: bun shim');
check('node /Users/bigfuckingdog/.local/share/claude/versions/2.1.211/cli.js --resume abc', true, 'r14: native versioned cli.js');

// --- must NOT match ---
check('vim claude-notes.md', false, 'r3: editing a file named claude-*');
check('tail -f claude.log', false, 'r3: tailing claude.log');
check('node claude-notes.js', false, 'r3: interpreter + bare filename (no path separator)');
check('node /private/tmp/x/node_modules/.bin/tsx watch server/index.ts', false, 'REAL: tsx dev server');
check('node /private/tmp/y/node_modules/.bin/vite --port 5194', false, 'REAL: vite dev server');
check('grep -iE claude', false, 'grep mentioning claude');
check('/bin/zsh -c source /Users/bigfuckingdog/.claude/shell-snapshots/snapshot-zsh-123.sh', false, 'REAL: zsh snapshot, path contains /.claude/ but is not claude');
// r14: ~/.claude holds hooks, skills and user scripts. Running one is not a session.
check('node /Users/bigfuckingdog/.claude/foo.js --resume abc', false, 'r14: arbitrary .js under ~/.claude');
check('node /Users/bigfuckingdog/.claude/hooks/notify.js', false, 'r14: a Claude hook script is not the CLI');
check('node /Users/bigfuckingdog/.claude/skills/x/build.mjs', false, 'r14: a skill script is not the CLI');
check('', false, 'empty command');

// classifyClaudeProcess: the THREE-WAY variant, for callers whose answer drives
// something destructive. isClaudeCommand may say yes to a command that merely
// passes a claude path as an ARGUMENT, which costs a stale tab name. The
// account switch signs a credential OUT, so there that false positive logs a
// real account out of a directory that never ran Claude, and a false NEGATIVE
// leaves a live session spending the old account while the UI claims full
// coverage. Both hurt, so an unclear line answers 'maybe' and is reported as
// unidentified rather than forced into either.
console.log('\n-- classifyClaudeProcess (drives a logout) --');
const strict = (cmd, want, note) => {
  const got = classifyClaudeProcess(cmd).kind;
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${got.padEnd(11)} (want ${want.padEnd(11)})  ${note}`);
};
strict('/Users/x/.local/bin/claude --resume abc', 'claude', 'the native binary');
strict('node /opt/homebrew/bin/claude --resume abc', 'claude', 'the npm shebang shim');
strict('node --enable-source-maps /opt/homebrew/bin/claude', 'claude', 'a valueless flag is skipped');
// A flag that eats the NEXT token: treating its value as the entrypoint dropped
// a real session from discovery entirely, with no unresolved warning.
strict('node --require /tmp/boot.cjs /opt/homebrew/bin/claude --resume abc', 'claude', 'a flag with a separate value');
strict('node -r /tmp/boot.cjs /opt/homebrew/bin/claude', 'claude', 'its short form');
strict('env node /usr/local/bin/claude', 'claude', 'an interpreter chain still resolves');
strict('env FOO=1 node /usr/local/bin/claude', 'claude', 'env assignments are skipped');
// ONLY env interprets leading assignments. To node, `MODE=watch` is the SCRIPT,
// so skipping it there read the next argument as the entrypoint and put an
// unrelated credential up for a logout.
strict('node MODE=watch /usr/local/bin/claude', 'maybe', 'an assignment-shaped SCRIPT name');
strict('npx claude', 'claude', 'npx form');
// The case isClaudeCommand gets wrong: a watcher that merely NAMES the CLI
// would have had its CLAUDE_CONFIG_DIR scheduled for a logout.
strict('node /tmp/watcher.js /opt/homebrew/bin/claude', 'maybe', 'claude as an ARGUMENT, not the entrypoint');
// Only env and npx exec another program, so a SCRIPT named node must not be
// skipped as though it were the interpreter.
strict('node /tmp/node /usr/local/bin/claude', 'maybe', 'a script whose own name is an interpreter');
strict('node --unknown-flag /tmp/x.js /usr/local/bin/claude', 'maybe', 'an interpreter flag we do not know');
// A path with spaces and "some program, then a claude path" are the SAME shape
// in ps output, so neither may be decided. Acting on it logs out a profile no
// session uses; dropping it hides a live session. Both were shipped and both
// were caught, so it answers 'maybe' and is surfaced as unidentified.
strict('/Users/x/CLI Tools/claude --resume abc', 'maybe', 'an executable path containing spaces');
strict('vim /opt/homebrew/bin/claude', 'maybe', 'an editor opening the CLI by path');
strict('node --eval=setInterval(()=>{},1) /usr/local/bin/claude', 'maybe', 'an ATTACHED eval value');
strict('node -e code /usr/local/bin/claude', 'maybe', 'a detached eval value');
strict('node -esetInterval(()=>{},1) /usr/local/bin/claude', 'maybe', 'an ATTACHED short eval value');
strict('node -p1 /usr/local/bin/claude', 'maybe', 'the attached print form');
strict('vim claude-notes.md', 'not-claude', 'unrelated process naming claude');
strict('node /Users/bigfuckingdog/.claude/hooks/notify.js', 'not-claude', 'a hook script is not the CLI');
strict('', 'not-claude', 'empty command');
// The verdict names the token it rests on, so the scan can confirm that token
// is a real executable FILE. A DIRECTORY named claude satisfies the name test.
{
  const r = classifyClaudeProcess('node /tmp/claude tools/sleep.js');
  if (r.token !== '/tmp/claude') { fail++; console.log('FAIL  token should name the deciding path, got', r.token); }
  else { pass++; console.log('PASS  the verdict names the path it rests on'); }
}
if (isClaudeCommand('node /tmp/watcher.js /opt/homebrew/bin/claude') !== true) {
  fail++; console.log('FAIL  the loose variant was expected to still accept the argument form');
} else { pass++; console.log('PASS  the loose variant is deliberately unchanged'); }

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
