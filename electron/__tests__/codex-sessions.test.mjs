// Codex session parsing (v1.0.72). Pure over the file head, so no filesystem.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/codex-sessions.test.mjs
import assert from 'node:assert/strict';
import { parseCodexSessionHead, sessionIdFromFilename } from '../codex-sessions.js';

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };
const j = (o) => JSON.stringify(o);

const meta = (extra = {}) => j({ type: 'session_meta', timestamp: '2026-09-14T15:31:32.908Z',
  payload: { id: '01a0a08b-838c-73e2-a584-0f3fa5133268', cwd: '/Users/x/Projects (Code)/pays', originator: 'codex-tui', source: 'cli', timestamp: '2026-09-14T15:31:32.908Z', ...extra } });
const userMsg = (text) => j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const eventUser = (message) => j({ type: 'event_msg', payload: { type: 'user_message', message } });

check('parses an interactive session: id, cwd, not exec, timestamp', () => {
  const r = parseCodexSessionHead([meta(), userMsg('fix the merchant payout bug')].join('\n'));
  assert.equal(r.sessionId, '01a0a08b-838c-73e2-a584-0f3fa5133268');
  assert.equal(r.cwd, '/Users/x/Projects (Code)/pays');
  assert.equal(r.isExec, false);
  assert.equal(r.timestamp, new Date('2026-09-14T15:31:32.908Z').getTime());
});

check('title skips the injected AGENTS.md preamble and uses the first REAL prompt', () => {
  const r = parseCodexSessionHead([meta(), userMsg('# AGENTS.md instructions for /Users/x/pays'), userMsg('now actually do the thing')].join('\n'));
  assert.equal(r.preview, 'now actually do the thing');
});

check('also skips <environment_context> and <user_instructions> preambles', () => {
  const r = parseCodexSessionHead([meta(), userMsg('<environment_context>cwd=...</environment_context>'), userMsg('<user_instructions>be terse</user_instructions>'), userMsg('the real ask')].join('\n'));
  assert.equal(r.preview, 'the real ask');
});

check('session_index thread_name wins over the first user message', () => {
  const r = parseCodexSessionHead([meta(), userMsg('some long first prompt')].join('\n'), { indexTitle: 'Audit gaps and failure risks' });
  assert.equal(r.preview, 'Audit gaps and failure risks');
});

check('a headless codex exec run is flagged isExec (originator)', () => {
  const r = parseCodexSessionHead([meta({ originator: 'codex_exec', source: 'exec' }), userMsg('review the diff')].join('\n'));
  assert.equal(r.isExec, true);
});

check('isExec is also true on source=exec alone', () => {
  const r = parseCodexSessionHead([meta({ originator: 'other', source: 'exec' })].join('\n'));
  assert.equal(r.isExec, true);
});

check('event_msg user_message shape is understood', () => {
  const r = parseCodexSessionHead([meta(), eventUser('hello from event_msg')].join('\n'));
  assert.equal(r.preview, 'hello from event_msg');
});

check('a clipped final line (truncated head read) does not throw', () => {
  const r = parseCodexSessionHead([meta(), userMsg('good'), '{"type":"response_item","payl'].join('\n'));
  assert.equal(r.preview, 'good');
});

check('no session_meta returns null (not a rollout / meta clipped off)', () => {
  assert.equal(parseCodexSessionHead([userMsg('orphan')].join('\n')), null);
  assert.equal(parseCodexSessionHead(''), null);
  assert.equal(parseCodexSessionHead(null), null);
});

check('preview falls back to a label when there is no real user message', () => {
  const r = parseCodexSessionHead([meta(), userMsg('# AGENTS.md only')].join('\n'));
  assert.equal(r.preview, 'Codex session');
});

check('preview is collapsed and capped at 200 chars', () => {
  const r = parseCodexSessionHead([meta(), userMsg('a\n\n   b   ' + 'x'.repeat(400))].join('\n'));
  assert.ok(r.preview.length <= 200);
  assert.ok(!r.preview.includes('\n'));
});

check('sessionIdFromFilename extracts the uuid', () => {
  assert.equal(sessionIdFromFilename('rollout-2026-09-14T11-31-32-01a0a08b-838c-73e2-a584-0f3fa5133268.jsonl'),
    '01a0a08b-838c-73e2-a584-0f3fa5133268');
  assert.equal(sessionIdFromFilename('not-a-rollout.jsonl'), null);
});

console.log(`\nALL PASS  (${pass} passed)`);
