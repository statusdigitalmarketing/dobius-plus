// Phone mode (main): the start checks, the socket handshake, phone commands, and release, against a fake process
// table and the real socket, with test clients playing the gate, the runner and `done`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createPhoneMode, descends, carryFlags, HELLO_MS, SHELL_KILL_MS } from '../phone-mode.js';
import { socketPath, ticketPath, donePath } from '../phone-socket.js';

const S = '0b5c2a6e-1111-4222-8333-444455556666';
const T0 = 'Sat Nov 14 09:00:00 2026';
// npm test points TMPDIR at a deep folder (scripts/test-tmp.mjs), too long for the run folder's socket; use /tmp then.
const tmpBase = () => (Buffer.byteLength(os.tmpdir()) > 40 ? '/tmp' : os.tmpdir());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSys(rows) {
  const table = new Map(rows.map((p) => [p.pid, { ...p }]));
  let clock = 0;
  const err = (code) => Object.assign(new Error(code), { code });
  const sys = {
    table,
    psAll: async () => [`1 1 0 ${T0} /sbin/launchd`, ...[...table.values()].map((p) => `${p.pid} ${p.pgid} ${p.ppid} ${p.lstart || T0} ${p.command || 'x'}`)].join('\n'),
    psStart: async (pid) => (table.has(pid) ? table.get(pid).lstart || T0 : null),
    kill(pid, sig) {
      const targets = pid < 0 ? [...table.values()].filter((p) => p.pgid === -pid) : [table.get(pid)].filter(Boolean);
      if (!targets.length) throw err('ESRCH');
      if (sig === 'SIGKILL' || sig === 'SIGTERM') for (const p of targets) table.delete(p.pid);
    },
    bootSec: async () => 1000,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return sys;
}

function setup(over = {}) {
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'pm-')));
  const sys = fakeSys([{ pid: 1000, pgid: 1000, ppid: 1 }, { pid: 900, pgid: 1000, ppid: 1000 }]);
  let clock = 5_000_000;
  let tuiAlive = true;
  let shell = 1000;
  const calls = { stop: [], restart: [], notify: [] };
  const d = {
    userData, sys, log: () => {}, manualTick: true,
    now: () => clock, sleep: async (ms) => { clock += ms; },
    on: () => true, memoryLow: () => false,
    tabs: () => [{ id: 'T1', pid: shell, cwd: userData }],
    cannotRestart: () => null,
    inputSeq: () => 7, inputHeld: () => false,
    claudeInfo: async () => (tuiAlive ? { pid: 900, soleChild: true } : null),
    presence: async () => ({ sessionId: S, status: 'idle' }),
    hasTranscript: async () => true,
    activity: () => ({ status: 'done' }),
    screen: async () => ({ lines: ['x'], modes: {} }), promptBox: () => '', promptMode: () => 'default',
    processArgv: async () => ['claude', '--permission-mode', 'acceptEdits', '--model', 'opus'],
    processCwd: async () => userData, isDir: () => true,
    stop: (pid) => { calls.stop.push(pid); tuiAlive = false; sys.table.delete(900); },
    alive: () => tuiAlive,
    restart: (tabId, cwd, phone) => {
      calls.restart.push({ tabId, cwd, phone });
      sys.table.delete(1000);
      shell = 2000;
      sys.table.set(2000, { pid: 2000, pgid: 2000, ppid: 1 });
      return true;
    },
    tuiSessionIds: async () => [],
    notify: (tabId, st) => calls.notify.push(st),
    exe: '/Applications/Dobius+.app/Contents/MacOS/Dobius+', runnerPath: '/x/phone-runner.mjs',
    ...over,
  };
  const mode = createPhoneMode(d);
  return {
    mode, d, sys, calls, userData,
    advance: (ms) => { clock += ms; },
    cleanup: async () => { await mode.close(); fs.rmSync(userData, { recursive: true, force: true }); },
  };
}

function client(file) {
  const sock = net.connect(file);
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  const lines = [];
  let waiters = [];
  let buf = '';
  sock.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    waiters.forEach((w) => w()); waiters = [];
  });
  const closed = new Promise((r) => sock.on('close', r));
  return {
    closed,
    send: (o) => sock.write(`${JSON.stringify(o)}\n`),
    next: async (ms = 3000) => {
      const t0 = Date.now();
      while (!lines.length) {
        if (Date.now() - t0 > ms) throw new Error('no message');
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
      return lines.shift();
    },
    end: () => sock.end(),
  };
}

/** take + gate hello + runner hello + Claude: a live run with the test clients holding the gate and runner sides. */
async function live(ctx, { runnerFirst = false } = {}) {
  const { mode, sys } = ctx;
  await mode.init();
  const r = await mode.take('T1', { sessionId: S, gen: mode.gen('T1') });
  assert.equal(r.ok, true, JSON.stringify(r));
  const dir = mode._runDir();
  const gateToken = fs.readFileSync(ticketPath(dir, r.runId), 'utf8');
  const doneToken = fs.readFileSync(donePath(dir, r.runId), 'utf8');
  fs.unlinkSync(ticketPath(dir, r.runId)); // the gate consumes it
  sys.table.set(2100, { pid: 2100, pgid: 2000, ppid: 2000 }); // the gate, under the new shell
  const gate = client(socketPath(dir));
  gate.send({ t: 'gate', token: gateToken, pid: 2100 });
  const gok = await gate.next();
  assert.equal(gok.t, 'gate-ok');
  sys.table.set(2200, { pid: 2200, pgid: 2200, ppid: 2100, command: `/x/Dobius+ /x/phone-runner.mjs run ${r.runId}` });
  const runner = client(socketPath(dir));
  if (runnerFirst) {
    // The real gate starts the runner before its spawn report goes out, so the hello can win the race.
    runner.send({ t: 'runner', token: gok.runnerToken, pid: 2200 });
    await sleep(100);
    gate.send({ t: 'runner-spawned', pid: 2200, lstart: T0 });
  } else {
    gate.send({ t: 'runner-spawned', pid: 2200, lstart: T0 });
    await sleep(30);
    runner.send({ t: 'runner', token: gok.runnerToken, pid: 2200 });
  }
  const rok = await runner.next();
  sys.table.set(2300, { pid: 2300, pgid: 2200, ppid: 2200 });
  runner.send({ t: 'claude', pid: 2300, lstart: T0 });
  assert.deepEqual(await runner.next(), { t: 'claude-ok' });
  return { runId: r.runId, gate, runner, rok, doneToken, dir };
}

/** Answer the runner's next command like the real runner would. */
async function serve(runner, reply = (m) => ({ ok: true })) {
  const m = await runner.next();
  runner.send({ t: 'reply', reqId: m.reqId, ...reply(m) });
  return m;
}

test('carryFlags: the shown mode can only tighten the launch flag; the phone never runs looser than asking (round 34 ship-test, security review)', () => {
  // Launched skipping permissions, then switched to manual with Shift+Tab: both sides follow the screen.
  assert.deepEqual(carryFlags({ permissionMode: 'bypassPermissions', model: 'opus' }, 'default'), { permissionMode: 'default', model: 'opus', phoneMode: 'default' });
  assert.deepEqual(carryFlags({ permissionMode: 'acceptEdits' }, 'plan'), { permissionMode: 'plan', model: null, phoneMode: 'plan' });
  // A screen claiming a looser mode than the flag is never believed, on either side.
  assert.deepEqual(carryFlags({ permissionMode: 'default' }, 'bypassPermissions'), { permissionMode: 'default', model: null, phoneMode: 'default' });
  assert.deepEqual(carryFlags({ permissionMode: 'acceptEdits' }, 'auto'), { permissionMode: 'acceptEdits', model: null, phoneMode: 'default' });
  assert.deepEqual(carryFlags({ permissionMode: 'plan' }, 'default'), { permissionMode: 'plan', model: null, phoneMode: 'plan' });
  // No flag: the TUI comes back without one unless the screen shows a strict mode; the phone asks at least.
  assert.deepEqual(carryFlags({ permissionMode: null, model: null }, 'auto'), { permissionMode: null, model: null, phoneMode: 'default' });
  assert.deepEqual(carryFlags({ permissionMode: null }, 'plan'), { permissionMode: 'plan', model: null, phoneMode: 'plan' });
  assert.equal(carryFlags({ permissionMode: null }, 'bypassPermissions').permissionMode, null);
  assert.equal(carryFlags({ permissionMode: 'default' }, 'nonsense').permissionMode, 'default');
  // Nothing shown: the TUI comes back as launched, the phone asks first unless the flag already asks as much.
  assert.deepEqual(carryFlags({ permissionMode: 'bypassPermissions', model: null }, null), { permissionMode: 'bypassPermissions', model: null, phoneMode: 'default' });
  assert.equal(carryFlags({ permissionMode: 'acceptEdits' }, null).phoneMode, 'default');
  assert.equal(carryFlags({ permissionMode: 'plan' }, null).phoneMode, 'plan');
  assert.equal(carryFlags({ permissionMode: null }, null).phoneMode, 'default');
});

test('take: the mode shown on screen goes to the phone and comes back to the TUI', async () => {
  const ctx = setup({ promptMode: () => 'plan' });
  try {
    const { rok } = await live(ctx);
    assert.equal(rok.permissionMode, 'plan');
    assert.equal(ctx.calls.restart[0].phone.permissionMode, 'plan', 'the TUI restarts in the shown mode, not its launch flag');
  } finally { await ctx.cleanup(); }
});

test('take: the mode must read the same on two looks in a row, each with no draft, or the move is refused (Codex r36)', async () => {
  // A redraw caught halfway: no mode, then a statusLine's own "manual" while Claude's plan line is half drawn.
  const seq = [null, 'default', 'plan', 'plan'];
  let reads = 0;
  let ctx = setup({ promptMode: () => seq[reads++] });
  try {
    const { rok } = await live(ctx);
    assert.equal(reads, 4);
    assert.equal(rok.permissionMode, 'plan');
    assert.equal(ctx.calls.restart[0].phone.permissionMode, 'plan');
  } finally { await ctx.cleanup(); }
  for (const [over, code] of [
    [{ promptMode: () => null }, 'cannot'],
    [{ promptMode: (() => { let i = 0; return () => (i++ % 2 ? 'plan' : 'default'); })() }, 'cannot'],
    // Two frames of one redraw read the same mode, but the screen is still changing (Codex r36e).
    [{ promptMode: () => 'default', screen: (() => { let i = 0; return async () => ({ lines: ['x', `frame ${i++}`], modes: {} }); })() }, 'cannot'],
    // The look that supplies the mode shows a draft typed before the move began.
    [{ promptBox: (() => { let i = 0; return () => (i++ ? 'do not lose this draft' : ''); })() }, 'draft'],
  ]) {
    ctx = setup(over);
    try {
      await ctx.mode.init();
      const r = await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
      assert.equal(r.code, code, JSON.stringify(r));
      assert.deepEqual([ctx.calls.stop, ctx.calls.restart], [[], []], 'nothing was stopped or restarted');
      assert.equal(ctx.mode.heldSessions().size, 0);
    } finally { await ctx.cleanup(); }
  }
});

test('take: phone mode turned off during the checks stops nothing (Codex r37)', async () => {
  let on = true;
  const ctx = setup({ on: () => on, processCwd: async () => { on = false; return process.cwd(); } });
  try {
    await ctx.mode.init();
    const r = await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
    assert.equal(r.code, 'off', JSON.stringify(r));
    assert.deepEqual(ctx.calls.stop, []);
    assert.equal(ctx.mode.heldSessions().size, 0);
  } finally { await ctx.cleanup(); }
});

test('descends walks parents in one listing', () => {
  const rows = [{ pid: 3, ppid: 2 }, { pid: 2, ppid: 1 }, { pid: 9, ppid: 1 }];
  assert.equal(descends(rows, 3, 1), true);
  assert.equal(descends(rows, 3, 2), true);
  assert.equal(descends(rows, 9, 2), false);
});

test('take: every refusal leaves the tab alone', async () => {
  const cases = [
    [{ on: () => false }, 'off'],
    [{ memoryLow: () => true }, 'memory'],
    [{ activity: () => ({ status: 'working' }) }, 'working'],
    [{ presence: async () => ({ sessionId: S, status: 'busy' }) }, 'working'],
    [{ promptBox: () => 'half a sentence' }, 'draft'],
    [{ promptBox: () => null }, 'draft'],
    [{ inputHeld: () => true }, 'draft'],
    [{ presence: async () => ({ sessionId: 'other-session', status: 'idle' }) }, 'stale_view'],
    [{ hasTranscript: async () => false }, 'no_transcript'],
    [{ claudeInfo: async () => ({ pid: 900, soleChild: false }) }, 'other'],
    [{ cannotRestart: () => 'the tab is moving to another window' }, 'cannot'],
  ];
  for (const [over, code] of cases) {
    const ctx = setup(over);
    try {
      await ctx.mode.init();
      const r = await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
      assert.equal(r.code, code, `${JSON.stringify(Object.keys(over))}: ${JSON.stringify(r)}`);
      assert.deepEqual(ctx.calls.stop, []);
      assert.deepEqual(ctx.calls.restart, []);
      assert.equal(ctx.mode.heldSessions().size, 0);
    } finally { await ctx.cleanup(); }
  }
  const ctx = setup();
  try {
    await ctx.mode.init();
    assert.equal((await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') - 1 })).code, 'stale_view');
    let seq = 7;
    ctx.d.inputSeq = () => seq++; // something typed between the read and the stop
    assert.equal((await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') })).code, 'typed');
    assert.deepEqual(ctx.calls.stop, []);
  } finally { await ctx.cleanup(); }
});

test('take: a restart that fails cancels the run, removes its files and frees the session', async () => {
  const ctx = setup({ restart: () => false });
  try {
    await ctx.mode.init();
    const r = await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
    assert.equal(r.code, 'failed');
    assert.match(r.error, /claude --resume/);
    assert.deepEqual(ctx.calls.stop, [900]);
    assert.equal(ctx.mode.heldSessions().size, 0);
    assert.deepEqual(fs.readdirSync(ctx.mode._runDir()).filter((n) => n.startsWith('phone-') && !n.endsWith('.sock')), []);
  } finally { await ctx.cleanup(); }
});

test('take: a pairing revoked before the stop moves nothing; revoked after it, the tab is not restarted (Codex impl r14)', async () => {
  const a = setup();
  try {
    await a.mode.init();
    const r = await a.mode.take('T1', { sessionId: S, gen: a.mode.gen('T1'), stillOk: () => false });
    assert.equal(r.code, 'revoked');
    assert.deepEqual(a.calls.stop, []);
    assert.deepEqual(a.calls.restart, []);
    assert.equal(a.mode.heldSessions().size, 0);
  } finally { await a.cleanup(); }
  let paired = true;
  const b = setup();
  const stop = b.d.stop;
  b.d.stop = (pid) => { stop(pid); paired = false; }; // unpaired while Claude was stopping
  try {
    await b.mode.init();
    const r = await b.mode.take('T1', { sessionId: S, gen: b.mode.gen('T1'), stillOk: () => paired });
    assert.equal(r.code, 'revoked');
    assert.match(r.error, /claude --resume/);
    assert.deepEqual(b.calls.stop, [900]);
    assert.deepEqual(b.calls.restart, []);
    assert.equal(b.mode.heldSessions().size, 0);
    assert.equal(b.mode.isPhoneTab('T1'), false);
  } finally { await b.cleanup(); }
});

test('an earlier run\'s session is held from construction, before init, until the sweep clears it (Codex impl r16)', async () => {
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'pm-')));
  const S2 = '1b5c2a6e-1111-4222-8333-444455556666';
  // An earlier boot's record: the sweep drops it without signalling anything.
  fs.writeFileSync(path.join(userData, 'phone-runs.json'), JSON.stringify([{ runId: 'c'.repeat(32), sessionId: S2, boot: 1, pgid: null, claudePid: null, aliveAt: 0 }]));
  const ctx = setup();
  const mode = createPhoneMode({ ...ctx.d, userData });
  try {
    assert.deepEqual([...mode.heldSessions()], [S2], 'held before init');
    assert.equal(mode.heldUntilSwept(S2), true, 'a launch resume should wait for the sweep (Codex impl r17)');
    let swept = false;
    void mode.whenSwept().then(() => { swept = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(swept, false, 'not settled before init');
    await mode.init();
    await mode.whenSwept();
    assert.equal(mode.heldUntilSwept(S2), false);
    assert.deepEqual([...mode.heldSessions()], [], 'released once the sweep found it safe');
  } finally {
    await mode.close();
    await ctx.cleanup();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('the gate must find the account the conversation ran on, after the shell\'s startup files (Codex impl r16)', async () => {
  for (const [cfg, ok] of [['/p/b', false], [undefined, false], [null, false], ['/p/a/', false], ['/p/a', true]]) {
    const ctx = setup({ binding: () => '/p/a' });
    try {
      await ctx.mode.init();
      const r = await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
      assert.equal(r.ok, true);
      const dir = ctx.mode._runDir();
      const token = fs.readFileSync(ticketPath(dir, r.runId), 'utf8');
      fs.unlinkSync(ticketPath(dir, r.runId));
      ctx.sys.table.set(2100, { pid: 2100, pgid: 2000, ppid: 2000 });
      const gate = client(socketPath(dir));
      gate.send({ t: 'gate', token, pid: 2100, ...(cfg === undefined ? {} : { cfg }) });
      const reply = await gate.next();
      assert.equal(reply.t, ok ? 'gate-ok' : 'refused', String(cfg));
      if (!ok) assert.equal(reply.code, 'account');
      else assert.equal(typeof reply.runnerToken, 'string');
      // Refused or not, the session stays held: a refused run keeps its claim until its processes are confirmed gone.
      assert.ok(ctx.mode.heldSessions().has(S));
      gate.end();
    } finally { await ctx.cleanup(); }
  }
});

test('sessionOfTab names the session a tab runs on the phone, and nothing for other tabs', async () => {
  const ctx = setup();
  try {
    await ctx.mode.init();
    assert.equal(ctx.mode.sessionOfTab('T1'), null);
    const r = await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
    assert.equal(r.ok, true);
    assert.equal(ctx.mode.sessionOfTab('T1'), S);
    assert.equal(ctx.mode.sessionOfTab('T2'), null);
  } finally { await ctx.cleanup(); }
});

test('full run: handshake, carried flags, cards, sends once per id, give back, done, released and forgotten', async () => {
  const ctx = setup({ promptMode: () => 'acceptEdits' });
  try {
    const { runId, gate, runner, rok, doneToken } = await live(ctx);
    const restart = ctx.calls.restart[0];
    assert.equal(restart.phone.runId, runId);
    assert.equal(restart.phone.sessionId, S);
    assert.equal(restart.phone.runner, '/x/phone-runner.mjs');
    assert.deepEqual([restart.phone.permissionMode, restart.phone.model], ['acceptEdits', 'opus'], 'the TUI comes back with its flags');
    // The screen shows the launch mode: the TUI comes back in it, and the phone side still asks first (capped at manual).
    assert.deepEqual(rok, { t: 'runner-ok', permissionMode: 'default', model: 'opus', resendNote: false });
    const rec = JSON.parse(fs.readFileSync(path.join(ctx.userData, 'phone-runs.json'), 'utf8'));
    assert.deepEqual(rec.map((x) => [x.runId, x.pgid, x.claudePid]), [[runId, 2200, 2300]]);
    assert.ok(ctx.mode.isPhoneTab('T1'));
    assert.ok(ctx.mode.heldSessions().has(S));

    runner.send({ t: 'state', status: 'working' });
    runner.send({ t: 'card', card: { requestId: 'tu1', kind: 'permission', tool: 'Bash' } });
    await sleep(50);
    const st = ctx.mode.stateOf('T1');
    assert.equal(st.status, 'working');
    assert.deepEqual(st.pending.map((c) => c.requestId), ['tu1']);

    const [a] = await Promise.all([ctx.mode.answer('T1', runId, 'tu1', { kind: 'permission', allow: true }), serve(runner)]);
    assert.deepEqual(a, { ok: true });
    assert.equal((await ctx.mode.answer('T1', runId, 'tu1', { kind: 'permission', allow: true })).code, 'not_pending');
    const [s1, m1] = await Promise.all([ctx.mode.send('T1', runId, 'hello', 'send-1'), serve(runner)]);
    assert.deepEqual(s1, { ok: true });
    assert.deepEqual([m1.t, m1.text], ['send', 'hello']);
    assert.deepEqual(await ctx.mode.send('T1', runId, 'hello', 'send-1'), { ok: true, duplicate: true });
    assert.equal((await ctx.mode.send('T1', 'f'.repeat(32), 'x', 'send-2')).code, 'stale_run');

    const [g] = await Promise.all([ctx.mode.giveBack('T1', runId), serve(runner)]);
    assert.deepEqual(g, { ok: true });
    runner.send({ t: 'ended', reason: 'given back on the phone' });
    await sleep(50);
    assert.equal(ctx.mode.stateOf('T1').status, 'ending');
    assert.ok(ctx.mode.heldSessions().has(S), 'held through ending');
    // The runner group, Claude and the gate exit; the launch line's fallback ran and finished; `done` arrives.
    for (const pid of [2200, 2300, 2100]) ctx.sys.table.delete(pid);
    runner.end();
    gate.end();
    const done = client(socketPath(ctx.mode._runDir()));
    done.send({ t: 'done', token: doneToken });
    assert.deepEqual(await done.next(), { t: 'done-ok' });
    await ctx.mode._tick();
    assert.equal(ctx.mode.heldSessions().size, 0);
    assert.equal(ctx.mode.isPhoneTab('T1'), false);
    assert.equal(ctx.mode._registry.list().length, 0, 'forgotten');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ctx.userData, 'phone-runs.json'), 'utf8')), []);
  } finally { await ctx.cleanup(); }
});

test('the setting turned off mid-run: no new move, but the run still takes messages, answers and give back (Codex r26)', async () => {
  let on = true;
  const ctx = setup({ on: () => on });
  try {
    const { runId, runner } = await live(ctx);
    on = false;
    runner.send({ t: 'card', card: { requestId: 'tu1', kind: 'permission', tool: 'Bash' } });
    await sleep(50);
    const [a] = await Promise.all([ctx.mode.answer('T1', runId, 'tu1', { kind: 'permission', allow: false }), serve(runner)]);
    assert.deepEqual(a, { ok: true });
    const [s1] = await Promise.all([ctx.mode.send('T1', runId, 'still here', 'send-off'), serve(runner)]);
    assert.deepEqual(s1, { ok: true });
    const [g] = await Promise.all([ctx.mode.giveBack('T1', runId), serve(runner)]);
    assert.deepEqual(g, { ok: true });
  } finally { await ctx.cleanup(); }
});

test('a send the runner refuses can go again with the same id; one that timed out is not known until the runner answers (Codex r26, r28)', async () => {
  const ctx = setup({ commandMs: 300 });
  try {
    const { runId, runner } = await live(ctx);
    const [r1] = await Promise.all([ctx.mode.send('T1', runId, 'hi', 'send-busy'), serve(runner, () => ({ ok: false, code: 'busy', error: 'full' }))]);
    assert.equal(r1.code, 'busy');
    const [r2, m2] = await Promise.all([ctx.mode.send('T1', runId, 'hi', 'send-busy'), serve(runner)]);
    assert.deepEqual(r2, { ok: true }, 'delivered on the retry, not called a duplicate');
    assert.equal(m2.text, 'hi');
    // No answer in time: not known, and a retry says so again rather than "duplicate".
    const r3 = await ctx.mode.send('T1', runId, 'lost?', 'send-lost');
    assert.equal(r3.code, 'timeout');
    const late = await runner.next();
    assert.equal((await ctx.mode.send('T1', runId, 'lost?', 'send-lost')).code, 'timeout');
    // The runner's late answer settles it: refused, so the retry is the delivery.
    runner.send({ t: 'reply', reqId: late.reqId, ok: false, code: 'busy', error: 'full' });
    await sleep(30);
    const [r4, m4] = await Promise.all([ctx.mode.send('T1', runId, 'lost?', 'send-lost'), serve(runner)]);
    assert.deepEqual(r4, { ok: true });
    assert.equal(m4.text, 'lost?');
    // A late "taken" makes the retry a duplicate, and nothing is sent again.
    assert.equal((await ctx.mode.send('T1', runId, 'slow', 'send-slow')).code, 'timeout');
    const slow = await runner.next();
    runner.send({ t: 'reply', reqId: slow.reqId, ok: true });
    await sleep(30);
    assert.deepEqual(await ctx.mode.send('T1', runId, 'slow', 'send-slow'), { ok: true, duplicate: true });
  } finally { await ctx.cleanup(); }
});

test('the phone learns which messages Claude read, and after the run which it never got, even once the run is forgotten (Codex r34)', async () => {
  const ctx = setup({ commandMs: 300 });
  try {
    const { runId, runner, gate, doneToken } = await live(ctx);
    const sendOne = async (text, id) => {
      const p = ctx.mode.send('T1', runId, text, id);
      const m = await runner.next();
      return { p, m };
    };
    // The reply and the runner's `delivered` in one write: the reply settles a microtask later and must not undo it.
    const a = await sendOne('a', 'send-a');
    runner.send({ t: 'reply', reqId: a.m.reqId, ok: true });
    runner.send({ t: 'delivered', reqIds: [a.m.reqId, 'c-unknown'] });
    assert.deepEqual(await a.p, { ok: true });
    const [, b] = await Promise.all([ctx.mode.send('T1', runId, 'b', 'send-b'), serve(runner)]);
    const [, c] = await Promise.all([ctx.mode.send('T1', runId, 'c', 'send-c'), serve(runner)]);
    const [, e] = await Promise.all([ctx.mode.send('T1', runId, 'e', 'send-e'), serve(runner)]);
    await sleep(50);
    let st = ctx.mode.stateOf('T1');
    assert.deepEqual(st.delivered, ['send-a']);
    assert.equal(st.ended, undefined);
    assert.deepEqual(await ctx.mode.send('T1', runId, 'a', 'send-a'), { ok: true, duplicate: true });

    // Give back with the runner slow to answer: main ends the run itself, then hears from the runner.
    const gb = ctx.mode.giveBack('T1', runId);
    assert.equal((await runner.next()).t, 'give-back');
    assert.deepEqual(await gb, { ok: true });
    assert.deepEqual(ctx.mode.stateOf('T1').ended[0].lost.map((x) => x.sendId), ['send-b', 'send-c', 'send-e']);
    // The runner: c never left its queue, b reached Claude unread; e was read as it ended.
    runner.send({ t: 'delivered', reqIds: [e.reqId] });
    runner.send({ t: 'ended', reason: 'given back on the phone', notSent: [c.reqId], unsure: [b.reqId] });
    await sleep(50);
    const lost = [{ sendId: 'send-b', why: 'unsure' }, { sendId: 'send-c', why: 'not_sent' }];
    assert.deepEqual(ctx.mode.stateOf('T1').ended, [{ runId, lost }]);
    // Cleanup finishes and the run is forgotten: a phone asking later still learns it.
    for (const pid of [2200, 2300, 2100]) ctx.sys.table.delete(pid);
    runner.end();
    gate.end();
    const done = client(socketPath(ctx.mode._runDir()));
    done.send({ t: 'done', token: doneToken });
    assert.deepEqual(await done.next(), { t: 'done-ok' });
    await ctx.mode._tick();
    assert.equal(ctx.mode._registry.list().length, 0, 'forgotten');
    st = ctx.mode.stateOf('T1');
    assert.equal(st.on, false);
    assert.deepEqual(st.ended, [{ runId, lost }]);
  } finally { await ctx.cleanup(); }
});

test('a runner that drops without a word leaves every message Claude was not seen to read as not confirmed (Codex r34)', async () => {
  const ctx = setup();
  try {
    const { runId, runner } = await live(ctx);
    const [, a] = await Promise.all([ctx.mode.send('T1', runId, 'a', 'send-a'), serve(runner)]);
    await Promise.all([ctx.mode.send('T1', runId, 'b', 'send-b'), serve(runner)]);
    runner.send({ t: 'delivered', reqIds: [a.reqId] });
    await sleep(30);
    runner.end();
    await sleep(80);
    assert.deepEqual(ctx.mode.stateOf('T1').ended, [{ runId, lost: [{ sendId: 'send-b', why: 'unsure' }] }]);
  } finally { await ctx.cleanup(); }
});

test('a phone away while 64 other messages were read still learns its own were read, by asking (Codex r35)', async () => {
  const ctx = setup();
  try {
    const { runId, runner } = await live(ctx);
    const reqs = [];
    for (let i = 0; i < 100; i++) {
      const [, m] = await Promise.all([ctx.mode.send('T1', runId, `m${i}`, `send-${i}`), serve(runner)]);
      reqs.push(m.reqId);
    }
    const [, held] = await Promise.all([ctx.mode.send('T1', runId, 'held', 'send-held'), serve(runner)]);
    runner.send({ t: 'delivered', reqIds: reqs });
    await sleep(50);
    assert.ok(held.reqId, 'queued, not read');
    const plain = ctx.mode.stateOf('T1').delivered;
    assert.equal(plain.length, 64);
    assert.equal(plain.includes('send-0'), false, 'pushed out of the newest 64');
    const asked = ctx.mode.stateOf('T1', ['send-0', 'send-1', 'send-held', 'send-never']).delivered;
    assert.deepEqual(asked.filter((x) => !plain.includes(x)).sort(), ['send-0', 'send-1']);
    assert.equal(asked.includes('send-held') || asked.includes('send-never'), false, 'only what Claude read');
    assert.equal(ctx.mode.stateOf('T1', Array.from({ length: 40 }, (_, i) => `send-${i}`)).delivered.length, 64 + 32,
      'at most ASK_MAX asked ids are looked up');
  } finally { await ctx.cleanup(); }
});

test('a retry while the first send is still waiting gets its outcome, not an early duplicate (Codex r27)', async () => {
  const ctx = setup();
  try {
    const { runId, runner } = await live(ctx);
    // The first send is refused (queue full) only after the retry arrived: the retry is then the delivery.
    const first = ctx.mode.send('T1', runId, 'hi', 'send-x');
    const m1 = await runner.next();
    const retry = ctx.mode.send('T1', runId, 'hi', 'send-x');
    await sleep(30);
    runner.send({ t: 'reply', reqId: m1.reqId, ok: false, code: 'busy', error: 'full' });
    assert.equal((await first).code, 'busy');
    const [r2] = await Promise.all([retry, serve(runner)]);
    assert.deepEqual(r2, { ok: true }, 'delivered by the retry, never reported as a duplicate of a refused send');
    // A first send that is taken makes a waiting retry a duplicate.
    const f2 = ctx.mode.send('T1', runId, 'yo', 'send-y');
    const m2 = await runner.next();
    const again = ctx.mode.send('T1', runId, 'yo', 'send-y');
    await sleep(30);
    runner.send({ t: 'reply', reqId: m2.reqId, ok: true });
    assert.deepEqual(await f2, { ok: true });
    assert.deepEqual(await again, { ok: true, duplicate: true });
  } finally { await ctx.cleanup(); }
});

test('done while the gate still runs: refused loudly and the session stays held', async () => {
  const ctx = setup();
  try {
    const { runner, doneToken } = await live(ctx);
    runner.send({ t: 'ended', reason: 'x' });
    for (const pid of [2200, 2300]) ctx.sys.table.delete(pid);
    const done = client(socketPath(ctx.mode._runDir()));
    done.send({ t: 'done', token: doneToken }); // the gate (2100) is alive: this did not come from the launch line
    await done.next();
    await ctx.mode._tick();
    assert.ok(ctx.mode.heldSessions().has(S));
    assert.match(ctx.mode._registry.list()[0].error, /another program/);
  } finally { await ctx.cleanup(); }
});

test('a runner that does not run under the tab is refused and the run ends', async () => {
  const ctx = setup();
  try {
    await ctx.mode.init();
    const r = await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
    const dir = ctx.mode._runDir();
    const gate = client(socketPath(dir));
    ctx.sys.table.set(2100, { pid: 2100, pgid: 2000, ppid: 2000 });
    gate.send({ t: 'gate', token: fs.readFileSync(ticketPath(dir, r.runId), 'utf8'), pid: 2100 });
    const gok = await gate.next();
    ctx.sys.table.set(2200, { pid: 2200, pgid: 2200, ppid: 1 }); // reparented away from the tab
    gate.send({ t: 'runner-spawned', pid: 2200, lstart: T0 });
    await sleep(30);
    const runner = client(socketPath(dir));
    runner.send({ t: 'runner', token: gok.runnerToken, pid: 2200 });
    assert.equal((await runner.next()).t, 'refused');
    assert.equal(ctx.mode.stateOf('T1').status, 'ending');
    assert.ok(ctx.mode.heldSessions().has(S));
  } finally { await ctx.cleanup(); }
});

test('no hello in time ends the run; a closed tab\'s shell never identified by a hello is never signalled, and held until it is gone', async () => {
  const ctx = setup();
  try {
    await ctx.mode.init();
    await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
    ctx.advance(HELLO_MS + 1);
    await ctx.mode._tick();
    assert.equal(ctx.mode.stateOf('T1').status, 'ending');
    assert.ok(ctx.mode.heldSessions().has(S), 'no done and no closed tab: still held');
    ctx.mode.tabClosed('T1');
    ctx.advance(SHELL_KILL_MS + 1);
    await ctx.mode._tick();
    assert.ok(ctx.sys.table.has(2000), 'no identity, no signal (the close itself SIGKILLs the PTY)');
    assert.ok(ctx.mode.heldSessions().has(S));
    ctx.sys.table.delete(2000);
    await ctx.mode._tick();
    assert.equal(ctx.mode.heldSessions().size, 0);
  } finally { await ctx.cleanup(); }
});
test('init removes one-time files an earlier run left behind', async () => {
  const ctx = setup();
  try {
    const dir = path.join(ctx.userData, 'run');
    fs.mkdirSync(dir, { mode: 0o700 });
    const id = 'c'.repeat(32);
    for (const n of [`phone-${id}.ticket`, `phone-${id}.done`, `phone-${id}.ticket.taken-0123456789abcdef`, 'keep.txt']) fs.writeFileSync(path.join(dir, n), 'x', { mode: 0o600 });
    await ctx.mode.init();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['keep.txt', 'phone.sock']);
  } finally { await ctx.cleanup(); }
});

test('take: a Claude pid freed and reused before the stop is never signalled', async () => {
  const ctx = setup();
  try {
    await ctx.mode.init();
    ctx.d.processCwd = async () => {
      // The TUI Claude exits during the reads and an unrelated process takes pid 900.
      ctx.sys.table.set(900, { pid: 900, pgid: 900, ppid: 1, lstart: 'Sat Nov 14 09:05:00 2026' });
      return ctx.userData;
    };
    const r = await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
    assert.equal(r.code, 'stale_view', JSON.stringify(r));
    assert.deepEqual(ctx.calls.stop, []);
    assert.equal(ctx.mode.heldSessions().size, 0);
  } finally { await ctx.cleanup(); }
});

test('a runner hello that arrives before the gate\'s spawn report is accepted', async () => {
  const ctx = setup();
  try {
    const { rok } = await live(ctx, { runnerFirst: true });
    assert.equal(rok.t, 'runner-ok');
    assert.ok(ctx.mode.isPhoneTab('T1'));
  } finally { await ctx.cleanup(); }
});

/** A live run whose processes then all exit, with `ended` received: only the tab's shell is left. */
async function endedRun(ctx) {
  const l = await live(ctx);
  l.runner.send({ t: 'ended', reason: 'x' });
  await sleep(50);
  for (const pid of [2200, 2300, 2100]) ctx.sys.table.delete(pid);
  l.runner.end(); l.gate.end();
  return l;
}

test('with the shell identified by the gate\'s hello, a closed tab\'s shell is killed after its grace, then released', async () => {
  const ctx = setup();
  try {
    await endedRun(ctx);
    ctx.mode.tabClosed('T1');
    await ctx.mode._tick();
    assert.ok(ctx.sys.table.has(2000), 'the shell gets its grace');
    assert.ok(ctx.mode.heldSessions().has(S));
    ctx.advance(SHELL_KILL_MS + 1);
    await ctx.mode._tick();
    assert.equal(ctx.sys.table.has(2000), false);
    assert.equal(ctx.mode.heldSessions().size, 0);
  } finally { await ctx.cleanup(); }
});

test('a shell that exited and whose pid was reused counts as gone and the new process is never signalled (Codex impl r8, r9)', async () => {
  const ctx = setup();
  try {
    await endedRun(ctx);
    ctx.sys.table.set(2000, { pid: 2000, pgid: 2000, ppid: 1, lstart: 'Sat Nov 14 09:30:00 2026' }); // reused
    ctx.mode.tabClosed('T1');
    ctx.advance(SHELL_KILL_MS + 1);
    await ctx.mode._tick();
    assert.ok(ctx.sys.table.has(2000), 'the unrelated process is never signalled');
    assert.equal(ctx.mode.heldSessions().size, 0, 'its start time shows the shell is gone');
  } finally { await ctx.cleanup(); }
});

test('a gate that does not run under the tab\'s shell is refused and the run ends', async () => {
  const ctx = setup();
  try {
    await ctx.mode.init();
    const r = await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
    const dir = ctx.mode._runDir();
    ctx.sys.table.set(2100, { pid: 2100, pgid: 2100, ppid: 1 }); // not under shell 2000
    const gate = client(socketPath(dir));
    gate.send({ t: 'gate', token: fs.readFileSync(ticketPath(dir, r.runId), 'utf8'), pid: 2100 });
    assert.equal((await gate.next()).t, 'refused');
    assert.equal(ctx.mode.stateOf('T1').status, 'ending');
    assert.ok(ctx.mode.heldSessions().has(S));
  } finally { await ctx.cleanup(); }
});

test('a failed init still settles whenSwept, and keeps the start hold (Codex impl r17)', async () => {
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'pm-')));
  const S2 = '1b5c2a6e-1111-4222-8333-444455556666';
  fs.writeFileSync(path.join(userData, 'phone-runs.json'), JSON.stringify([{ runId: 'c'.repeat(32), sessionId: S2, boot: 1, pgid: null, claudePid: null, aliveAt: 0 }]));
  const ctx = setup();
  const sys = { ...ctx.sys, bootSec: async () => { throw new Error('no boot time'); } };
  const mode = createPhoneMode({ ...ctx.d, userData, sys });
  try {
    await assert.rejects(mode.init(), /no boot time/);
    await mode.whenSwept();
    assert.equal(mode.heldUntilSwept(S2), true);
    assert.ok(mode.heldSessions().has(S2));
  } finally {
    await mode.close();
    await ctx.cleanup();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
