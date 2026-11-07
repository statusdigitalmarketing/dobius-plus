// Tasks > Commands: the `! ` commands a session handed back, per tab. Run: npm run test:handoffcmds
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCommands, extractCommandsWithContext, createHandoffCommands, runScriptText, MAX_COMMANDS } from '../handoff-commands.js';
import { commandPlaceholder } from '../../shared/handoff.js';
import { isHandoff } from '../../shared/handoff.js';

test('extract: the same lines shared/handoff.js treats as a handback, cleaned', () => {
  const reply = [
    'Run this yourself:',
    '! ./release.sh patch',
    '- ! git push origin main',
    '1. `! npm test`',
    'not this ! one, an exclamation!',
    '```',
    '! codex login',
    '```',
    '! ./release.sh patch',
  ].join('\n');
  assert.equal(isHandoff(reply), true);
  assert.deepEqual(extractCommands(reply), ['./release.sh patch', 'git push origin main', 'npm test', 'codex login']);
});

test('extract: a trailing backslash joins the next line; control characters and empty lines are left out', () => {
  assert.deepEqual(extractCommands('! gh release upload v1 \\\n   file.zip --clobber'), ['gh release upload v1 file.zip --clobber']);
  assert.deepEqual(extractCommands('! echo \x1b[2Jhidden\n! ok\n!  \n! a\u202eb\n! ./re\u034flease.sh\n! a\u3164b'), ['ok']);
  assert.deepEqual(extractCommands(null), []);
  const many = Array.from({ length: 20 }, (_, i) => `! cmd${i}`).join('\n');
  assert.equal(extractCommands(many).length, MAX_COMMANDS);
});

let clock = 100_000;
function rig({ text = '! ./release.sh patch', at = null, session = { sessionId: 's1', sessionProject: '/p', pid: 42 }, cwd = '/p/sub', replies = null } = {}) {
  let n = 0;
  let notes = 0;
  // A transcript record keeps its timestamp: the first read fixes it.
  let fixed = null;
  const stamp = at || (() => (fixed ??= clock));
  const calls = { last: [] };
  const hc = createHandoffCommands({
    resolve: async () => session,
    lastReply: async (sid, proj) => {
      calls.last.push([sid, proj]);
      if (replies) return replies(proj);
      const t = typeof text === 'function' ? await text() : text;
      return t == null ? null : { text: t, at: stamp() };
    },
    processCwd: async () => cwd,
    projectOf: (id) => (id.startsWith('term-/p-') ? '/p' : null),
    notify: () => { notes += 1; },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    newId: () => `c${(n += 1)}`,
  });
  return { hc, calls, notes: () => notes };
}
const tick = async (k = 40) => { for (let i = 0; i < k; i += 1) await new Promise((r) => setImmediate(r)); };
const turn = (hc, tab = 'term-/p-1') => { hc.onHook(tab, 'working', null); clock += 1000; hc.onHook(tab, 'needs', 'handoff'); };

test('a handback is captured for its tab and project with the Claude folder; a new turn clears it', async () => {
  const { hc, calls, notes } = rig();
  turn(hc);
  await tick();
  const l = hc.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].projectPath, '/p');
  assert.equal(l[0].cwd, '/p/sub');
  assert.deepEqual(l[0].commands.map((c) => c.text), ['./release.sh patch']);
  assert.equal(calls.last[0][0], 's1');
  assert.equal(notes(), 1);
  hc.onHook('term-/p-1', 'needs', null); // a permission prompt: not a handback, keeps it
  assert.equal(hc.list().length, 1);
  hc.onHook('term-/p-1', 'working', null);
  assert.equal(hc.list().length, 0);
});

test('peek keeps it, take removes it once; the tab goes with its last one', async () => {
  const { hc } = rig({ text: '! a\n! b' });
  turn(hc);
  await tick();
  const [a, b] = hc.list()[0].commands;
  assert.deepEqual(hc.peek('term-/p-1', a.id), { tabId: 'term-/p-1', projectPath: '/p', cwd: '/p/sub', text: 'a' });
  assert.equal(hc.list()[0].commands.length, 2, 'peek does not remove');
  assert.equal(hc.take('term-/p-1', a.id), true);
  assert.equal(hc.take('term-/p-1', a.id), false, 'once');
  hc.take('term-/p-1', b.id);
  assert.equal(hc.list().length, 0);
});

test('a reply from before this turn is never taken; the turn\'s own reply is waited for', async () => {
  // The previous reply (old.sh) is on disk; this turn's (new.sh) lands only on the third read.
  let reads = 0;
  const started = { at: 0 };
  const { hc } = rig({ replies: () => { reads += 1; return reads < 3 ? { text: '! ./old.sh', at: started.at - 60_000 } : { text: '! ./new.sh', at: started.at + 3000 }; } });
  hc.onHook('term-/p-1', 'working', null);
  started.at = clock;
  clock += 5000;
  hc.onHook('term-/p-1', 'needs', 'handoff');
  await tick(60);
  assert.deepEqual(hc.list()[0].commands.map((c) => c.text), ['./new.sh']);
});

test('the newest reply of this turn wins across the places the transcript may be', async () => {
  const T0 = clock;
  const { hc, calls } = rig({ session: { sessionId: 's1', sessionProject: null, pid: 7 }, cwd: '/q', replies: (proj) => (proj === '/q' ? { text: '! ./from-q.sh', at: T0 + 2000 } : { text: '! ./from-p.sh', at: T0 + 1500 }) });
  turn(hc);
  await tick(60);
  assert.deepEqual([...new Set(calls.last.map((x) => x[1]))].sort(), ['/p', '/q']);
  assert.deepEqual(hc.list()[0].commands.map((c) => c.text), ['./from-q.sh']);
  assert.equal(hc.list()[0].cwd, '/q');
});

test('a slow read that lands after the tab moved on is dropped; no session or a relative cwd', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { hc } = rig({ text: () => gate });
  turn(hc);
  hc.onHook('term-/p-1', 'working', null); // the next turn starts before the read finished
  release('! late');
  await tick(60);
  assert.equal(hc.list().length, 0);
  const none = rig({ session: null });
  turn(none.hc);
  await tick();
  assert.equal(none.hc.list().length, 0);
  const rel = rig({ cwd: 'relative/dir' });
  turn(rel.hc);
  await tick();
  assert.equal(rel.hc.list()[0].cwd, '/p', 'unknown folder: the project folder, named, never wherever a shell starts');
});

test('a phone tab is filed under the session\'s project', async () => {
  const { hc } = rig();
  turn(hc, 'term-mobile-123');
  await tick();
  assert.equal(hc.list()[0].projectPath, '/p');
});


test('r2: a reply written even a moment before the turn began is not this turn\'s; a failed lookup is retried', async () => {
  const started = clock;
  // The previous turn's reply: this turn's prompt comes after it in the transcript.
  const old = rig({ replies: () => ({ text: '! ./old.sh', at: started - 1000, promptAfter: true }) });
  old.hc.onHook('term-/p-1', 'working', null);
  clock += 5000;
  old.hc.onHook('term-/p-1', 'needs', 'handoff');
  await tick(60);
  assert.equal(old.hc.list().length, 0, 'the previous reply is never taken');
  let n = 0;
  const T1 = clock + 500;
  const real = { sessionId: 's1', sessionProject: '/p', pid: 1 };
  const r3 = createHandoffCommands({
    resolve: async () => (n++ === 0 ? null : real),
    lastReply: async () => ({ text: '! ok', at: T1 }),
    processCwd: async () => '/p', projectOf: () => '/p', now: () => clock, sleep: async (ms) => { clock += ms; }, newId: () => 'x',
  });
  r3.onHook('term-/p-1', 'working', null);
  r3.onHook('term-/p-1', 'needs', 'handoff');
  await tick(60);
  assert.deepEqual(r3.list()[0]?.commands.map((c) => c.text), ['ok'], 'retried after the first lookup found nothing');
});

test('r4: an earlier message of the same turn is not taken while the final reply is still being written', async () => {
  // Read 1: the turn's earlier message (deploy-production). Read 2 onward: the final reply (deploy-staging).
  let reads = 0;
  const T = clock;
  // One attempt reads every candidate folder; count attempts by the first one ('/p').
  const { hc } = rig({ replies: (proj) => { if (proj === '/p') reads += 1; return reads <= 1 ? { text: '! ./deploy-production.sh', at: T + 1000 } : { text: '! ./deploy-staging.sh', at: T + 4000 }; } });
  hc.onHook('term-/p-1', 'working', null);
  clock += 5000;
  hc.onHook('term-/p-1', 'needs', 'handoff');
  await tick(60);
  assert.deepEqual(hc.list()[0].commands.map((c) => c.text), ['./deploy-staging.sh']);
});

test('r5: markers processed late (a busy app) still find their turn\'s reply; a reply with a newer prompt after it never', async () => {
  const T = clock;
  // The reply was written at T; the turn's first hook is only processed at T + 5 s.
  const late = rig({ replies: () => ({ text: '! ./late-but-mine.sh', at: T, promptAfter: false }) });
  clock += 5000;
  late.hc.onHook('term-/p-1', 'working', null);
  clock += 1000;
  late.hc.onHook('term-/p-1', 'needs', 'handoff');
  await tick(60);
  assert.deepEqual(late.hc.list()[0]?.commands.map((c) => c.text), ['./late-but-mine.sh']);
  const stale = rig({ replies: () => ({ text: '! ./previous.sh', at: clock, promptAfter: true }) });
  turn(stale.hc);
  await tick(60);
  assert.equal(stale.hc.list().length, 0);
});

test('ux: each command carries what Claude said around it; the full reply is kept for display', async () => {
  const reply = [
    'The release is ready. This publishes 2.2.7 to GitHub and the auto-updater.',
    'First copy the notary password into your Keychain if you have not.',
    '',
    '```',
    '! ./release.sh patch',
    '```',
    'It takes about ten minutes.',
    '',
    'Then check the release page.',
  ].join('\n');
  const [c] = extractCommandsWithContext(reply);
  assert.equal(c.text, './release.sh patch');
  assert.equal(c.why, 'The release is ready. This publishes 2.2.7 to GitHub and the auto-updater.\nFirst copy the notary password into your Keychain if you have not.\nIt takes about ten minutes.');
  const two = extractCommandsWithContext('Install it:\n! npm i\nThen start it:\n! npm start');
  assert.deepEqual(two.map((x) => x.why), ['Install it:', 'Then start it:']);
  const { hc } = rig({ text: reply });
  turn(hc);
  await tick(60);
  const e = hc.list()[0];
  assert.match(e.reply, /publishes 2\.2\.7/);
  assert.equal(e.commands[0].why.split('\n').length, 3);
  assert.equal(e.commands[0].state, 'waiting');
});

test('ux: placeholders to fill in are spotted; real commands are not', () => {
  for (const [cmd, hole] of [['export OPENAI_API_KEY=<your-key>', '<your-key>'], ['gh secret set X --body YOUR_TOKEN', 'YOUR_TOKEN'], ['curl -H "x: xxxx" host', 'xxxx'], ['git clone git@github.com:your-org/app', 'your-org'], ['echo ...', '...']]) {
    assert.equal(commandPlaceholder(cmd), hole, cmd);
  }
  for (const ok of ['./release.sh patch', 'npm test -- --watch', 'git push origin main', 'echo "a > b"', 'cat <<EOF', 'ls -la /tmp']) {
    assert.equal(commandPlaceholder(ok), null, ok);
  }
});

test('ux: a run is followed to Done or Failed; a new turn drops only what is still waiting; a closed run tab says so', async () => {
  const { hc } = rig({ text: '! a\n! b\n! c' });
  turn(hc);
  await tick(60);
  const [a, b, c] = hc.list()[0].commands;
  assert.equal(hc.startRun('term-/p-1', a.id, 'term-/p-9', 'a --edited', '/run/x.exit'), true);
  assert.equal(hc.startRun('term-/p-1', a.id, 'term-/p-9', 'a', '/run/x.exit'), false, 'only once');
  assert.deepEqual(hc.running(), [{ tabId: 'term-/p-1', id: a.id, exitFile: '/run/x.exit' }]);
  let row = hc.list()[0].commands.find((x) => x.id === a.id);
  assert.equal(row.state, 'running');
  assert.equal(row.edited, true);
  assert.equal('exitFile' in row, false, 'internal paths are not sent to the window');
  assert.equal('ran' in row, false, 'the edited text (it may hold a key) is not sent to the window');
  assert.equal(hc.finishRun('term-/p-1', a.id, 2), true);
  row = hc.list()[0].commands.find((x) => x.id === a.id);
  assert.equal(row.state, 'failed');
  assert.equal(row.exit, 2);
  hc.startRun('term-/p-1', b.id, 'term-/p-8', 'b', '/run/y.exit');
  hc.onHook('term-/p-8', 'exit', null); // the run tab closed before it finished
  assert.equal(hc.list()[0].commands.find((x) => x.id === b.id).state, 'closed');
  hc.onHook('term-/p-1', 'working', null); // the session moves on
  const left = hc.list()[0].commands.map((x) => x.id);
  assert.deepEqual(left.sort(), [a.id, b.id].sort(), 'c (still waiting) went; the ones already run stay');
  assert.equal(hc.peek('term-/p-1', a.id), null, 'a finished command cannot be run again');
  void c;
  clock += 2 * 3600 * 1000;
  assert.equal(hc.list().length, 0, 'finished ones leave after an hour');
});


test('ux r2: a closed run tab keeps its real result', async () => {
  const { hc } = rig({ text: '! a' });
  turn(hc);
  await tick(60);
  const [a] = hc.list()[0].commands;
  hc.startRun('term-/p-1', a.id, 'term-/p-9', 'a', '/run/x.exit');
  hc.onHook('term-/p-9', 'exit', null); // closed right after it finished
  assert.equal(hc.list()[0].commands[0].state, 'closed');
  assert.deepEqual(hc.running().map((r) => r.id), [a.id], 'still checked');
  hc.finishRun('term-/p-1', a.id, 4);
  assert.equal(hc.list()[0].commands[0].state, 'failed');
});

test('ux r2: prefixed placeholder keys are caught; a command keeps the folder it ran in', async () => {
  for (const cmd of ['gh secret set API_TOKEN --body ghp_xxxxxxxxxxxxxxxxxxxx', 'export K=sk_test_xxxxxxxx', 'curl -H "Authorization: Bearer XXXXXXXX" host']) {
    assert.notEqual(commandPlaceholder(cmd), null, cmd);
  }
  let folder = '/p/staging';
  let reply = '! ./deploy.sh';
  let n = 0;
  const T = clock;
  const hc = createHandoffCommands({
    resolve: async () => ({ sessionId: 's1', sessionProject: '/p', pid: 3 }),
    lastReply: async () => ({ text: reply, at: T + (reply === '! ./deploy.sh' ? 1 : 2) }),
    processCwd: async () => folder, projectOf: () => '/p', now: () => clock, sleep: async (ms) => { clock += ms; }, newId: () => `k${(n += 1)}`,
  });
  turn(hc);
  await tick(60);
  const [a] = hc.list()[0].commands;
  hc.startRun('term-/p-1', a.id, 'term-/p-9', a.text, '/run/x.exit');
  hc.finishRun('term-/p-1', a.id, 0);
  // The next turn hands back a command from another folder.
  folder = '/p/production';
  reply = '! ./deploy-prod.sh';
  turn(hc);
  await tick(60);
  const e = hc.list()[0];
  assert.equal(e.cwd, '/p/production');
  assert.equal(e.commands.find((c) => c.text === './deploy.sh').cwd, '/p/staging', 'the earlier run keeps where it ran');
  assert.equal(e.commands.find((c) => c.text === './deploy-prod.sh').cwd, '/p/production');
});


// The real script and command file, run by /bin/bash -p, as a Run tab does.
async function runForReal(cmd, { cwd = null, shown = cmd, mkdir = true } = {}) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { shQuote } = await import('../../shared/sh-quote.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-run-t-'));
  const base = path.join(dir, 'dobius-run-abcdefabcdefabcdef');
  const exitFile = `${base}.exit`;
  fs.writeFileSync(`${base}.cmd`, `${cmd}\n`);
  const where = cwd || (mkdir ? dir : path.join(dir, 'gone'));
  fs.writeFileSync(`${base}.sh`, runScriptText(`${base}.cmd`, where, shQuote, exitFile, shown));
  const r = spawnSync('/bin/bash', ['-p', `${base}.sh`], { encoding: 'utf8', timeout: 10000 });
  const out = { stdout: r.stdout + r.stderr, exit: fs.existsSync(exitFile) ? fs.readFileSync(exitFile, 'utf8') : null, left: fs.readdirSync(dir).filter((f) => f !== 'dobius-run-abcdefabcdefabcdef.exit'), dir };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('script: the real exit status whatever the command does; files cleaned up; the folder or nothing', async () => {
  for (const [cmd, want] of [["trap 'exit 7' EXIT; true", '7'], ['exec /usr/bin/false', '1'], ['set -e; false; echo no', '1'], ['exit 3', '3'], ['true', '0'], ['echo "A $(pwd -P)" & wait', '0']]) {
    const r = await runForReal(cmd);
    assert.equal(r.exit, want, cmd);
    assert.deepEqual(r.left, [], `${cmd}: the script and the command file are gone`);
  }
  const a = await runForReal('echo "IN $(pwd -P)"');
  assert.match(a.stdout, /IN \/.*dobius-run-t-/);
  // An unterminated heredoc cannot reach the wrapper: it still reports.
  const h = await runForReal('cat <<EOF\nhello');
  assert.notEqual(h.exit, null);
  const gone = await runForReal('touch SHOULD_NOT', { mkdir: false });
  assert.equal(gone.exit, '127');
  assert.match(gone.stdout, /could not open/);
});

test('script: an edited command prints the version the card showed', async () => {
  const r = await runForReal('true # sk-live-123', { shown: 'true # <your-key>   (edited)' });
  assert.match(r.stdout, /<your-key>   \(edited\)/);
  assert.equal(r.stdout.includes('sk-live-123'), false);
});

test('script: Ctrl+C stops the command and the result is still reported', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { shQuote } = await import('../../shared/sh-quote.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-run-int-'));
  try {
    const base = path.join(dir, 'dobius-run-abcdefabcdefabcdef');
    fs.writeFileSync(`${base}.cmd`, 'sleep 30\n');
    fs.writeFileSync(`${base}.sh`, runScriptText(`${base}.cmd`, dir, shQuote, `${base}.exit`, 'sleep 30'));
    // Its own process group, as a terminal's foreground job: Ctrl+C reaches the whole group.
    const child = spawn('/bin/bash', ['-p', `${base}.sh`], { detached: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 600));
    process.kill(-child.pid, 'SIGINT');
    await new Promise((r) => child.on('exit', r));
    assert.equal(fs.readFileSync(`${base}.exit`, 'utf8'), '130');
    assert.equal(fs.existsSync(`${base}.cmd`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
