// Account -> terminal env resolution (v1.0.65). The Switch button became a
// pointer to which config dir NEW terminals get; these lock the resolution
// order (project assignment beats global active beats default) and the env
// shapes the spawn consumes.
import path from 'path';
import os from 'os';
import { resolveTerminalAccount, claudeEnvForAccount, expandTilde } from '../claude-account-env.js';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

const projAcct = { id: 'a1', type: 'claude', claudeJsonPath: '/p/proj/.claude.json' };
const activeAcct = { id: 'a2', type: 'claude', claudeJsonPath: '/p/active/.claude.json' };

check('project assignment beats the global active account',
  resolveTerminalAccount(projAcct, activeAcct), projAcct);
check('global active applies when the project has no assignment',
  resolveTerminalAccount(null, activeAcct), activeAcct);
check('neither -> null -> default ~/.claude identity',
  resolveTerminalAccount(null, null), null);

check('null account yields NO env (default identity untouched)',
  claudeEnvForAccount(null), {});
check('claude account env carries its config dir',
  claudeEnvForAccount(activeAcct), { CLAUDE_CONFIG_DIR: '/p/active' });
check('cliPath adds DOBIUS_CLI_DIR',
  claudeEnvForAccount({ type: 'claude', claudeJsonPath: '/p/a/.claude.json', cliPath: '/p/bin/claude' }),
  { CLAUDE_CONFIG_DIR: '/p/a', DOBIUS_CLI_DIR: '/p/bin' });
check('tilde paths expand (spawn env never tilde-expands)',
  claudeEnvForAccount({ type: 'claude', claudeJsonPath: '~/.claude-profiles/x/.claude.json' }),
  { CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude-profiles', 'x') });
check('codex account carries only the API key',
  claudeEnvForAccount({ type: 'codex', apiKey: 'sk-test' }), { OPENAI_API_KEY: 'sk-test' });
check('unknown type yields no env', claudeEnvForAccount({ type: 'other' }), {});
check('expandTilde leaves absolute paths alone', expandTilde('/a/b'), '/a/b');

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
