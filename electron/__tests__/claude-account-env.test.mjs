// Account -> terminal env resolution (v1.0.65). The Switch button became a
// pointer to which config dir NEW terminals get; these lock the resolution
// order (project assignment beats global active beats default) and the env
// shapes the spawn consumes.
import path from 'path';
import os from 'os';
import { resolveTerminalAccount, claudeEnvForAccount, expandTilde, sharedPluginRoot, resolvePluginRoot, pinPluginRoot } from '../claude-account-env.js';

// Hermetic: the runner's own shell may carry a plugin-root override (it is a
// supported setting), and the default-root assertions below must not see it.
const INHERITED_PLUGIN_ROOT = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
process.on('exit', () => {
  if (INHERITED_PLUGIN_ROOT !== undefined) process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = INHERITED_PLUGIN_ROOT;
});

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
check('claude account env carries its config dir AND the one shared plugin root',
  claudeEnvForAccount(activeAcct), { CLAUDE_CONFIG_DIR: '/p/active', CLAUDE_CODE_PLUGIN_CACHE_DIR: sharedPluginRoot() });
check('the shared plugin root is the Mac\'s own ~/.claude/plugins',
  sharedPluginRoot(), path.join(os.homedir(), '.claude', 'plugins'));
check('an explicit CLAUDE_CODE_PLUGIN_CACHE_DIR in the environment wins for saved accounts too',
  resolvePluginRoot({ CLAUDE_CODE_PLUGIN_CACHE_DIR: '/custom/plugins' }), '/custom/plugins');
check('a tilde in the explicit override is expanded (spawn env never tilde-expands)',
  resolvePluginRoot({ CLAUDE_CODE_PLUGIN_CACHE_DIR: '~/mine' }), path.join(os.homedir(), 'mine'));
check('a blank override falls back to the shared root',
  resolvePluginRoot({ CLAUDE_CODE_PLUGIN_CACHE_DIR: '   ' }), sharedPluginRoot());
{
  const prev = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = '/custom/plugins';
  try {
    check('a saved account honours the explicit override instead of replacing it',
      claudeEnvForAccount(activeAcct).CLAUDE_CODE_PLUGIN_CACHE_DIR, '/custom/plugins');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR; else process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = prev;
  }
}
{
  const env = {};
  check('pinPluginRoot writes the shared root into an environment that has none',
    pinPluginRoot(env), sharedPluginRoot());
  check('and the pinned value is what children will inherit',
    env.CLAUDE_CODE_PLUGIN_CACHE_DIR, sharedPluginRoot());
  const env2 = { CLAUDE_CODE_PLUGIN_CACHE_DIR: '/custom/plugins' };
  check('pinPluginRoot keeps an explicit override', pinPluginRoot(env2), '/custom/plugins');
}
check('a codex account gets no plugin root (it is not a Claude config dir)',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR' in claudeEnvForAccount({ type: 'codex', apiKey: 'k' }), false);
check('cliPath adds DOBIUS_CLI_DIR',
  claudeEnvForAccount({ type: 'claude', claudeJsonPath: '/p/a/.claude.json', cliPath: '/p/bin/claude' }),
  { CLAUDE_CONFIG_DIR: '/p/a', CLAUDE_CODE_PLUGIN_CACHE_DIR: sharedPluginRoot(), DOBIUS_CLI_DIR: '/p/bin' });
check('tilde paths expand (spawn env never tilde-expands)',
  claudeEnvForAccount({ type: 'claude', claudeJsonPath: '~/.claude-profiles/x/.claude.json' }),
  { CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude-profiles', 'x'), CLAUDE_CODE_PLUGIN_CACHE_DIR: sharedPluginRoot() });
check('codex account carries only the API key',
  claudeEnvForAccount({ type: 'codex', apiKey: 'sk-test' }), { OPENAI_API_KEY: 'sk-test' });
check('unknown type yields no env', claudeEnvForAccount({ type: 'other' }), {});
check('expandTilde leaves absolute paths alone', expandTilde('/a/b'), '/a/b');

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
