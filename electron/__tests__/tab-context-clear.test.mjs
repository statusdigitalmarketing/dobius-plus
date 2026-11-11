// After a /clear, a `claude --resume S` process still names S in argv while Claude's own record has moved to T: the
// record wins (Codex 2.2.24 round 5). Module mocks stand in for the process and file reads.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const S = 'aaaaaaaa-1111-2222-3333-444444444444';
const T = 'bbbbbbbb-1111-2222-3333-444444444444';
let record = { sessionId: T, cwd: '/p' };
let birth = 1;
let argv = S;
let sole = true;
mock.module('./../terminal-manager.js', { namedExports: {
  getTerminalClaudeInfo: async () => ({ sessionId: argv, pid: 4242, startedAt: 1, soleChild: sole }),
  getTerminalCwd: async () => '/p',
  listTerminals: () => [{ id: 'term-/p-1', claudeConfigDir: null }],
} });
mock.module('./../config-manager.js', { namedExports: { getSessionTabMap: () => ({ [S]: { tabId: 'term-/p-1', projectPath: '/p', lastRunningAt: Date.now() } }) } });
mock.module('./../data-service.js', { namedExports: { estimateContextForSession: async () => null, sessionTranscriptBirth: async () => birth } });
mock.module('./../claude-presence.js', { namedExports: { presenceOf: async () => record } });
mock.module('./../terminal-status.js', { namedExports: { snapshot: () => ({ live: {} }) } });
const { resolveSessionForTab } = await import('../tab-context.js');

test('the record wins over a stale --resume argv after /clear', async () => {
  assert.equal((await resolveSessionForTab('term-/p-1'))?.sessionId, T);
});

test('argv still answers when the record agrees or is missing', async () => {
  record = { sessionId: S, cwd: '/p' };
  assert.equal((await resolveSessionForTab('term-/p-1'))?.sessionId, S);
  record = null;
  assert.equal((await resolveSessionForTab('term-/p-1'))?.sessionId, S);
});

test('cleared into a session with nothing said yet: no session, never the cleared one', async () => {
  record = { sessionId: T, cwd: '/p' };
  birth = 0;
  assert.equal(await resolveSessionForTab('term-/p-1'), null);
  birth = 1;
});

test('a fresh claude cleared into an empty session: no session, never the recent saved link', async () => {
  argv = null;
  record = { sessionId: T, cwd: '/p' };
  birth = 0;
  assert.equal(await resolveSessionForTab('term-/p-1'), null);
  birth = 1;
  assert.equal((await resolveSessionForTab('term-/p-1'))?.sessionId, T);
  argv = S;
});

test('strict: two programs in the shell is unknown (throws), not "no session"', async () => {
  argv = null; sole = false;
  assert.equal(await resolveSessionForTab('term-/p-1'), null);
  await assert.rejects(resolveSessionForTab('term-/p-1', { strict: true }));
  argv = S; sole = true;
});

test('an empty record for the same session the tab is linked to keeps it (an unreadable transcript is not a /clear)', async () => {
  argv = null;
  record = { sessionId: S, cwd: '/p' };
  birth = 0;
  assert.equal((await resolveSessionForTab('term-/p-1'))?.sessionId, S);
  birth = 1; argv = S;
});
