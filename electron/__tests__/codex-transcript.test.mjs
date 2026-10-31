// Codex transcript + listing over a real temp CODEX_HOME (v1.0.72 review round 2).
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/codex-transcript.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// CODEX_HOME resolves os.homedir() at call time, so override before importing.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-codextx-'));
os.homedir = () => tmp;

const { codexTranscript, listCodexSessions } = await import('../codex-sessions.js');

let pass = 0;
const check = async (label, fn) => { await fn(); pass += 1; console.log(`PASS  ${label}`); };

const sessionsDir = path.join(tmp, '.codex', 'sessions', '2026', '09', '15');
fs.mkdirSync(sessionsDir, { recursive: true });

const j = (o) => JSON.stringify(o);
const metaLine = (id, cwd) => j({ type: 'session_meta', timestamp: '2026-09-15T10:00:00.000Z',
  payload: { id, cwd, originator: 'codex-tui', source: 'cli', timestamp: '2026-09-15T10:00:00.000Z' } });
const userLine = (text) => j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const asstLine = (text) => j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text }] } });

await check('a real message SANDWICHED between two large records is still found (streaming)', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  // Two big records with a small real prompt BETWEEN them. A head-or-tail byte
  // window would miss the middle; a streaming reader delivers every complete
  // line wherever it sits. Kept at 2MB each so the test is fast; the mechanism
  // is size-independent.
  const big = 'x'.repeat(2 * 1024 * 1024);
  const file = path.join(sessionsDir, `rollout-2026-09-15T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, [
    metaLine(id, '/Users/x/proj'),
    asstLine(big),
    userLine('the sandwiched real prompt'),
    asstLine(big),
  ].join('\n') + '\n');
  const entries = await codexTranscript(id, { limit: 0 });
  assert.ok(entries.length >= 1, 'transcript must not be empty for a resolvable session');
  assert.ok(entries.some((e) => e.content.includes('the sandwiched real prompt')),
    'the message between two large records must be found');
});

await check('an oversized record (>64MB line) is SKIPPED, not crashed, and neighbors parse', async () => {
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  // A single record larger than the MAX_LINE cap. readline would assemble the
  // whole line and, past V8's ~512MB limit, throw RangeError and crash the app.
  // The manual capped reader must SKIP it and still return the small neighbors.
  const overCap = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'z'.repeat(70 * 1024 * 1024) } });
  const file = path.join(sessionsDir, `rollout-2026-09-15T08-00-00-${id}.jsonl`);
  fs.writeFileSync(file, [
    metaLine(id, '/Users/x/proj'),
    userLine('before the giant record'),
    overCap,
    asstLine('after the giant record'),
  ].join('\n') + '\n');
  const entries = await codexTranscript(id, { limit: 0 }); // must not throw
  assert.ok(entries.some((e) => e.content.includes('before the giant record')), 'earlier message parses');
  assert.ok(entries.some((e) => e.content.includes('after the giant record')), 'later message parses');
});

await check('a literal null / primitive line is skipped, not crashed, and neighbors parse', async () => {
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const file = path.join(sessionsDir, `rollout-2026-09-15T07-00-00-${id}.jsonl`);
  // Lines that JSON.parse to null / a number / a string / an array must not
  // throw (which would abort the read and blank the transcript).
  fs.writeFileSync(file, [
    metaLine(id, '/Users/x/proj'),
    'null', '42', '"a bare string"', '[1,2,3]',
    userLine('a valid prompt after junk lines'),
  ].join('\n') + '\n');
  const entries = await codexTranscript(id, { limit: 0 });
  assert.ok(entries.some((e) => e.content.includes('a valid prompt after junk lines')), 'valid record after junk parses');
});

await check('a large record is truncated to a bounded, detached 20000-char preview', async () => {
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const file = path.join(sessionsDir, `rollout-2026-09-15T06-00-00-${id}.jsonl`);
  // 8MB assistant record: the retained entry must be capped to 20000 chars and
  // not keep the 8MB backing string alive (Buffer-detached copy).
  fs.writeFileSync(file, [metaLine(id, '/Users/x/proj'), asstLine('q'.repeat(8 * 1024 * 1024))].join('\n') + '\n');
  const entries = await codexTranscript(id, { limit: 0 });
  const big = entries.find((e) => e.role === 'assistant');
  assert.ok(big, 'assistant record present');
  assert.equal(big.content.length, 20000, 'content capped to 20000');
});

await check('a message that is mostly whitespace trims to its visible content (detached)', async () => {
  const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const file = path.join(sessionsDir, `rollout-2026-09-15T05-00-00-${id}.jsonl`);
  // 65000 leading spaces then 24 visible chars: this is BELOW an absolute 64KB
  // detach threshold, so it exercises the ratio rule (parent > 2x kept text).
  // trim() must yield the short visible text without retaining the parent.
  fs.writeFileSync(file, [metaLine(id, '/Users/x/proj'), asstLine(' '.repeat(65000) + 'the actual visible text')].join('\n') + '\n');
  const entries = await codexTranscript(id, { limit: 0 });
  const m = entries.find((e) => e.role === 'assistant');
  assert.ok(m, 'assistant record present');
  assert.equal(m.content, 'the actual visible text');
});

await check('a positive limit keeps the last N messages', async () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const file = path.join(sessionsDir, `rollout-2026-09-15T09-00-00-${id}.jsonl`);
  fs.writeFileSync(file, [
    metaLine(id, '/Users/x/proj'),
    userLine('first'), asstLine('second'), userLine('third'),
  ].join('\n') + '\n');
  const entries = await codexTranscript(id, { limit: 1 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, 'third');
});

await check('listCodexSessions excludePaths skips a hidden project during the walk', async () => {
  const idVisible = '22222222-2222-4222-8222-222222222222';
  const idHidden = '33333333-3333-4333-8333-333333333333';
  fs.writeFileSync(path.join(sessionsDir, `rollout-2026-09-15T11-00-00-${idVisible}.jsonl`),
    [metaLine(idVisible, '/Users/x/visible'), userLine('visible work')].join('\n') + '\n');
  fs.writeFileSync(path.join(sessionsDir, `rollout-2026-09-15T12-00-00-${idHidden}.jsonl`),
    [metaLine(idHidden, '/Users/x/hidden'), userLine('hidden work')].join('\n') + '\n');
  const all = await listCodexSessions({ limit: 50 });
  assert.ok(all.some((s) => s.projectPath === '/Users/x/hidden'), 'hidden shows without exclude');
  const filtered = await listCodexSessions({ limit: 50, excludePaths: new Set(['/Users/x/hidden']) });
  assert.ok(filtered.some((s) => s.projectPath === '/Users/x/visible'), 'visible still listed');
  assert.ok(!filtered.some((s) => s.projectPath === '/Users/x/hidden'), 'hidden excluded');
});

// Speak in a Codex tab: which rollout the tab's running codex is writing.
{
  const { findCodexSessionForProcess, parseCodexCommand } = await import('../codex-sessions.js');
  const day = path.join(tmp, '.codex', 'sessions', '2026', '10', '31');
  fs.mkdirSync(day, { recursive: true });
  const write = (id, cwd, originator, mtimeMs) => {
    const f = path.join(day, `rollout-2026-10-31T12-00-00-${id}.jsonl`);
    fs.writeFileSync(f, j({ type: 'session_meta', payload: { id, cwd, originator, source: originator === 'codex_exec' ? 'exec' : 'cli' } }) + '\n' + asstLine('hello') + '\n');
    fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  };
  const start = Date.parse('2026-10-31T12:00:00Z');
  const OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
  const MINE = 'aaaaaaaa-0000-4000-8000-000000000002';
  const EXEC = 'aaaaaaaa-0000-4000-8000-000000000003';
  const OTHER = 'aaaaaaaa-0000-4000-8000-000000000004';
  write(OLD, '/p/app', 'codex_cli_rs', start - 3600_000); // before the process started
  write(MINE, '/p/app', 'codex_cli_rs', start + 60_000);
  write(EXEC, '/p/app', 'codex_exec', start + 120_000); // a review run, newer, same folder
  write(OTHER, '/p/other', 'codex_cli_rs', start + 180_000); // another folder, newest

  await check('finds the interactive rollout for the folder written since the process started', async () => {
    assert.equal(await findCodexSessionForProcess({ cwd: '/p/app', startedAt: start }), MINE);
  });
  await check('a resumed older session counts once it is written to after the start', async () => {
    write(OLD, '/p/app', 'codex_cli_rs', start + 240_000);
    assert.equal(await findCodexSessionForProcess({ cwd: '/p/app', startedAt: start }), OLD);
  });
  await check('nothing written since the start, or no cwd: no session', async () => {
    assert.equal(await findCodexSessionForProcess({ cwd: '/p/app', startedAt: start + 3600_000 }), null);
    assert.equal(await findCodexSessionForProcess({ cwd: null, startedAt: start }), null);
  });
  await check('the previous run\'s file written a moment before the start is not this run\'s', async () => {
    const PREV = 'aaaaaaaa-0000-4000-8000-000000000005';
    const later = start + 3600_000;
    write(PREV, '/p/prev', 'codex_cli_rs', later - 500);
    assert.equal(await findCodexSessionForProcess({ cwd: '/p/prev', startedAt: later }), null);
  });
  await check('parseCodexCommand: TUI forms, resume id, --cd, and non-TUI subcommands', async () => {
    const tui = (sessionId = null, cd = null) => ({ sessionId, cd });
    assert.deepEqual(parseCodexCommand('node /opt/homebrew/bin/codex'), tui());
    assert.deepEqual(parseCodexCommand('node --no-warnings /opt/homebrew/bin/codex'), tui());
    assert.deepEqual(parseCodexCommand('/opt/x/codex-darwin-arm64/vendor/bin/codex --model gpt-6'), tui());
    assert.deepEqual(parseCodexCommand(`codex resume ${MINE}`), tui(MINE));
    assert.deepEqual(parseCodexCommand('codex resume --last'), tui());
    assert.deepEqual(parseCodexCommand('codex fix the resume bug'), tui());
    assert.deepEqual(parseCodexCommand('codex -m exec'), tui(), 'an option value is not a subcommand');
    assert.deepEqual(parseCodexCommand('codex --cd /p/target'), tui(null, '/p/target'));
    assert.deepEqual(parseCodexCommand('codex -C sub resume --last'), tui(null, 'sub'));
    assert.deepEqual(parseCodexCommand('codex explain --cd /tmp/other'), tui(), 'a --cd inside the prompt is not an option');
    assert.deepEqual(parseCodexCommand('codex -m gpt-6 fix it --cd /x'), tui());
    assert.equal(parseCodexCommand('codex exec --skip-git-repo-check -'), null);
    assert.equal(parseCodexCommand('-zsh'), null);
    assert.equal(parseCodexCommand('zsh -l -i -c trap : INT; [[ $1 == codex ]] && codex;'), null);
    assert.equal(parseCodexCommand('node /opt/homebrew/bin/codex app-server'), null);
    assert.equal(parseCodexCommand('claude --resume abc'), null);
    assert.equal(parseCodexCommand('vim codex.md'), null);
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nALL PASS  (${pass} passed)`);
