// Run: node ./electron/__tests__/claude-child-env.test.mjs
import assert from 'node:assert/strict';
import { CLAUDE_CHILD_MARKERS, dropClaudeChildMarkers } from '../claude-child-env.js';

const env = {
  CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CONFIG_DIR: '/p/a', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1', PATH: '/bin',
};
assert.deepEqual(dropClaudeChildMarkers(env), ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED']);
assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/p/a', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1', PATH: '/bin' },
  'only the child-session markers go; the account and the person\'s own persistence choices stay');
assert.deepEqual(dropClaudeChildMarkers(env), [], 'a clean environment is left alone');
// An empty value still marks a child for some of Claude's checks (Boolean("") is false, but presence is probed too).
const empty = { CLAUDE_CODE_CHILD_SESSION: '' };
assert.deepEqual(dropClaudeChildMarkers(empty), ['CLAUDE_CODE_CHILD_SESSION']);
assert.equal('CLAUDE_CODE_CHILD_SESSION' in empty, false);
assert.equal(CLAUDE_CHILD_MARKERS.includes('CLAUDE_CONFIG_DIR'), false, 'never the account binding');
console.log('ALL PASS  (claude-child-env)');
