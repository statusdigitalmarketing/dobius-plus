// Tasks > Commands: the `! ` commands a session handed back, per tab. Run: npm run test:handoffcmds
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCommands, createHandoffCommands, runScriptText, MAX_COMMANDS } from '../handoff-commands.js';
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
  assert.equal(hc.take('term-/p-1', a.id).text, 'a');
  assert.equal(hc.take('term-/p-1', a.id), null, 'once');
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

test('runScriptText: enters the folder or stops, shows the command quoted, runs it verbatim, deletes itself', () => {
  const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
  const t = runScriptText("./a.sh & ./b.sh", '/repo/wt', q).split('\n');
  assert.match(t[0], /^\/bin\/rm -f -- "\$0"/);
  assert.match(t[1], /^builtin cd -- '\/repo\/wt' \|\| \{ printf .*exit 1; \}$/);
  assert.match(t[2], /^printf .* '\.\/a\.sh & \.\/b\.sh'$/);
  assert.equal(t[3], './a.sh & ./b.sh');
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
