// Tasks > Commands: a handed-back command that ran some other way (typed as `! cmd` into Claude, or Claude ran it
// itself) leaves the waiting list, and nothing that did not surely run it does. Run: npm run test:cmdruns
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DOBIUS_TEST_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-cmdruns-ud-'));
// The reader looks in ~/.claude/projects: point HOME at a scratch tree before anything is imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-cmdruns-home-'));
process.env.HOME = home;

const { readTranscriptAppended } = await import('../data-service.js');
const { createHandoffCommands, commandRunsFrom } = await import('../handoff-commands.js');

const PROJECT = '/tmp/cmdruns-proj';
const SID = 'aaaaaaaa-1111-4222-8333-444444444444';
const T = Date.parse('2026-11-10T18:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const user = (at, content, extra = {}) => ({ type: 'user', timestamp: iso(at), cwd: PROJECT, message: { role: 'user', content }, ...extra });
const bash = (at, id, command, extra = {}, cwd = PROJECT) => ({ type: 'assistant', timestamp: iso(at), cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, ...extra } }] } });
const result = (at, id, text, isError, toolUseResult = { stdout: text }) => user(at, [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }], { toolUseResult });

test('commandRunsFrom: what ran, and what only looks like it', () => {
  const pending = new Map();
  const runs = commandRunsFrom([
    user(T + 1000, '<bash-input> ./release.sh   patch</bash-input>'),
    user(T + 1100, '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'),
    user(T + 1200, '<bash-input>./meta.sh</bash-input>', { isMeta: true }),
    user(T + 1300, '<bash-input>gh auth login</bash-input>'),
    user(T + 1400, '<bash-stdout></bash-stdout><bash-stderr>\x1b[31merror: no TTY\x1b[0m\nmore</bash-stderr>'),
    user(T + 1310, '<bash-input>./slow.sh</bash-input>'),
    user(T + 1320, '<bash-stdout>Command did not complete within its 120s timeout and was moved to the background (ID: b1). It is running now</bash-stdout><bash-stderr></bash-stderr>'),
    user(T + 1330, '<bash-input>./esc.sh</bash-input>'), user(T + 1340, [{ type: 'text', text: '[Request interrupted by user]' }]),
    user(T + 1350, `<bash-input>${'x'.repeat(5000)}</bash-input>`), // too long to keep, and it still ends the wait
    user(T + 1360, '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'), // pairs with neither ./esc.sh nor the long one
    user(T + 1370, '<bash-input>./grep-out.sh</bash-input>'),
    user(T + 1380, '<bash-stdout>saw <bash-stderr></bash-stderr> in a file</bash-stdout><bash-stderr>real err</bash-stderr>'),
    bash(T + 1390, 'g1', 'grep -q x f'), { ...result(T + 1395, 'g1', 'No matches found', false, { stdout: '', returnCodeInterpretation: 'No matches found' }) },
    user(T + 1500, '<bash-input>./still-running.sh</bash-input>'), // its output is not in yet
    bash(T + 1600, 'cd1', 'cd packages/a'), bash(T + 1600, 'np', 'npm publish'), // the same turn: the cd moves the shell
    bash(T + 2000, 't1', 'gh release view v1'),
    bash(T + 3000, 't2', 'npm test'),
    bash(T + 4000, 't3', 'rm -rf build'),
    bash(T + 5000, 't4', 'npm run release', { run_in_background: true }),
    bash(T + 6000, 't5', './long.sh'),
    bash(T + 7000, 't6', './later.sh'),
  ], pending);
  // Results arrive in a later read: the calls wait in `pending`.
  runs.push(...commandRunsFrom([
    { ...result(T + 1700, 'cd1', '', false), cwd: `${PROJECT}/packages/a` },
    { ...result(T + 1800, 'np', 'published', false), cwd: `${PROJECT}/packages/a` },
    result(T + 2100, 't1', 'v1 published', false),
    result(T + 3100, 't2', 'Exit code 2\nfailures', true),
    result(T + 4100, 't3', 'Permission for this action was denied', true),
    result(T + 5100, 't4', 'Command running in background with ID: b1', false),
    result(T + 6100, 't5', 'started', false, { stdout: '', backgroundTaskId: 'b2' }), // moved to the background
  ], pending));
  assert.deepEqual(runs.map((r) => [r.text.trim(), r.by, r.exit, r.at, r.err ?? null, r.cwd]), [
    ['./release.sh   patch', 'you', null, T + 1000, null, PROJECT],
    ['gh auth login', 'you', null, T + 1300, 'error: no TTY', PROJECT],
    ['./grep-out.sh', 'you', null, T + 1370, 'real err', PROJECT],
    ['grep -q x f', 'claude', null, T + 1390, null, PROJECT], // exit 1 read as "no match": not a success
    ['cd packages/a', 'claude', 0, T + 1600, null, null],
    ['npm publish', 'claude', 0, T + 1600, null, null], // called in the root, finished in packages/a: no folder
    ['gh release view v1', 'claude', 0, T + 2000, null, PROJECT],
    ['npm test', 'claude', 2, T + 3000, null, PROJECT],
  ]);
  assert.equal(pending.has('t6'), true); // no result yet: not a run
  assert.equal(pending.size, 1); // the bash-mode wait ended at the next record (a miss, never a false run)
  const p2 = new Map();
  assert.deepEqual(commandRunsFrom([user(T, '<bash-input>./still-running.sh</bash-input>')], p2), []); // output not in yet
  assert.equal(p2.size, 1);
  assert.equal(commandRunsFrom([user(T + 1, '<bash-stdout>done</bash-stdout><bash-stderr></bash-stderr>')], p2).length, 1); // next read
});

test('readTranscriptAppended: reads only what was added, whole lines only', async () => {
  const dir = path.join(home, '.claude', 'projects', PROJECT.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify(bash(T, 'a', 'one'))}\n`);
  const first = await readTranscriptAppended(SID, PROJECT, null);
  assert.equal(first.records.length, 1);
  fs.appendFileSync(file, `${JSON.stringify(bash(T, 'b', 'two'))}\n{"type":"assist`); // the last line is half written
  const second = await readTranscriptAppended(SID, PROJECT, first.next);
  assert.deepEqual(second.records.map((r) => r.message.content[0].input.command), ['two']);
  fs.appendFileSync(file, 'ant"}\n');
  const third = await readTranscriptAppended(SID, PROJECT, second.next);
  assert.equal(third.records.length, 1);
  assert.equal(third.next, fs.statSync(file).size);
  assert.equal(await readTranscriptAppended('../x', PROJECT, null), null);
  assert.equal(await readTranscriptAppended('bbbbbbbb-0000-4000-8000-000000000000', PROJECT, null), null);
});

function rig(reply, records) {
  let clock = T + 500;
  let n = 0;
  const calls = { reads: 0, notes: 0, offsets: [] };
  const hc = createHandoffCommands({
    resolve: async () => ({ sessionId: SID, sessionProject: PROJECT, pid: 1 }),
    lastReply: async () => ({ text: reply, at: T }),
    processCwd: async () => PROJECT,
    projectOf: () => PROJECT,
    readAppended: async (sid, project, offset) => {
      calls.reads += 1;
      calls.offsets.push(offset);
      assert.equal(sid, SID);
      assert.equal(project, PROJECT);
      const recs = records();
      return { records: recs.slice(offset || 0), next: recs.length };
    },
    notify: () => { calls.notes += 1; },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    newId: () => `c${(n += 1)}`,
  });
  return { hc, calls, advance: (ms) => { clock += ms; } };
}
const tick = async (k = 60) => { for (let i = 0; i < k; i += 1) await new Promise((r) => setImmediate(r)); };
const handBack = async (hc) => { hc.onHook('term-/p-1', 'working', null); hc.onHook('term-/p-1', 'needs', 'handoff'); await tick(); };
const byText = (hc) => Object.fromEntries(hc.list()[0].commands.map((c) => [c.text, c]));

test('store: only the exact command, in the card folder, after the handback, is marked run', async () => {
  let recs = [];
  const { hc, calls, advance } = rig('Run these:\n! ./release.sh patch\n! gh release view v1\n! npm test\n! ./deploy.sh\n! npm publish\n! gh auth login', () => recs);
  await handBack(hc);
  assert.equal(hc.list()[0].commands.filter((c) => c.state === 'waiting').length, 6);
  recs = [
    bash(T - 10, 'early', './release.sh patch'), result(T - 5, 'early', 'ok', false), // before the handback
    user(T + 1000, '<bash-input> ./release.sh   patch</bash-input>'), user(T + 1100, '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>'),
    user(T + 1200, '<bash-input>gh auth login</bash-input>'), user(T + 1300, '<bash-stdout></bash-stdout><bash-stderr>no TTY</bash-stderr>'),
    bash(T + 2000, 't1', 'gh release view v1'), result(T + 2100, 't1', 'ok', false),
    bash(T + 3000, 't2', 'npm test'), result(T + 3100, 't2', 'Exit code 2', true),
    bash(T + 4000, 't3', 'npm test && ./deploy.sh'), result(T + 4100, 't3', 'Exit code 1', true), // never reached it
    bash(T + 4200, 't4', 'git commit -m "bump; ./deploy.sh; tag"'), result(T + 4300, 't4', 'ok', false),
    bash(T + 5000, 't5', 'npm publish', {}, `${PROJECT}/packages/a`), result(T + 5100, 't5', 'ok', false), // another folder
    bash(T + 6000, 't6', './deploy.sh', { run_in_background: true }), result(T + 6100, 't6', 'Command running in background', false),
  ];
  await hc.markRanElsewhere();
  let b = byText(hc);
  assert.equal(b['./release.sh patch'].state, 'ran');
  assert.equal(b['./release.sh patch'].ranBy, 'you');
  assert.equal(b['./release.sh patch'].ranErr, null);
  assert.equal(b['gh auth login'].state, 'ran');
  assert.equal(b['gh auth login'].ranErr, 'no TTY'); // detail only: 'ran' is never shown as a success
  assert.equal(b['gh release view v1'].state, 'done');
  assert.equal(b['gh release view v1'].ranBy, 'claude');
  assert.equal(b['npm test'].state, 'failed');
  assert.equal(b['npm test'].exit, 2);
  assert.equal(b['./deploy.sh'].state, 'waiting');
  assert.equal(b['npm publish'].state, 'waiting');
  assert.equal('sid' in b['./deploy.sh'], false); // the session details never reach a window
  assert.equal(hc.hasWaiting('term-/p-1'), true);
  // Read again within MIN_READ_MS: skipped. After it: only what was appended is asked for.
  const before = calls.reads;
  await hc.markRanElsewhere();
  assert.equal(calls.reads, before);
  recs = [...recs, bash(T + 9000, 't7', './deploy.sh'), result(T + 9100, 't7', 'ok', false)];
  advance(6000);
  await hc.markRanElsewhere();
  assert.equal(calls.reads, before + 1);
  assert.equal(calls.offsets.at(-1), recs.length - 2);
  b = byText(hc);
  assert.equal(b['./deploy.sh'].state, 'done');
});

test('readTranscriptAppended: a burst past the read cap reports the gap', async () => {
  const dir = path.join(home, '.claude', 'projects', PROJECT.replace(/[^a-zA-Z0-9]/g, '-'));
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify(bash(T, 'a', 'one'))}\n`);
  const first = await readTranscriptAppended(SID, PROJECT, null);
  assert.equal(first.gap, false);
  const filler = `${JSON.stringify(user(T, 'y'.repeat(100 * 1024)))}\n`.repeat(25); // ~2.5MB, over the 2MB cap
  fs.appendFileSync(file, `${filler}${JSON.stringify(bash(T, 'b', 'two'))}\n`);
  const second = await readTranscriptAppended(SID, PROJECT, first.next);
  assert.equal(second.gap, true);
  assert.equal(second.records.at(-1).message.content[0].input.command, 'two');
  fs.writeFileSync(file, `${JSON.stringify(bash(T, 'c', 'three'))}\n`); // rewritten shorter
  const third = await readTranscriptAppended(SID, PROJECT, second.next);
  assert.equal(third.gap, true);
  assert.equal(third.records[0].message.content[0].input.command, 'three');
});

test('store: without a transcript reader nothing is marked', async () => {
  const hc = createHandoffCommands({
    resolve: async () => ({ sessionId: SID, sessionProject: PROJECT, pid: 1 }),
    lastReply: async () => ({ text: '! ./x.sh', at: T }),
    processCwd: async () => PROJECT,
    projectOf: () => PROJECT,
    now: () => T + 500,
    sleep: async () => {},
    newId: () => 'c1',
  });
  await handBack(hc);
  await hc.markRanElsewhere();
  assert.equal(hc.list()[0].commands[0].state, 'waiting');
});
