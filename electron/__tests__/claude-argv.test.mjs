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
import { isClaudeCommand } from '../claude-argv.js';

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

// --- must NOT match ---
check('vim claude-notes.md', false, 'r3: editing a file named claude-*');
check('tail -f claude.log', false, 'r3: tailing claude.log');
check('node claude-notes.js', false, 'r3: interpreter + bare filename (no path separator)');
check('node /private/tmp/x/node_modules/.bin/tsx watch server/index.ts', false, 'REAL: tsx dev server');
check('node /private/tmp/y/node_modules/.bin/vite --port 5194', false, 'REAL: vite dev server');
check('grep -iE claude', false, 'grep mentioning claude');
check('/bin/zsh -c source /Users/bigfuckingdog/.claude/shell-snapshots/snapshot-zsh-123.sh', false, 'REAL: zsh snapshot, path contains /.claude/ but is not claude');
check('', false, 'empty command');

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
