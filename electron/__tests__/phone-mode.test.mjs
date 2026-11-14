// Phone mode (main): the start checks, the socket handshake, phone commands, and release, against a fake process
// table and the real socket, with test clients playing the gate, the runner and `done`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createPhoneMode, descends, HELLO_MS, SHELL_KILL_MS } from '../phone-mode.js';
import { socketPath, ticketPath, donePath } from '../phone-socket.js';

const S = '0b5c2a6e-1111-4222-8333-444455556666';
const T0 = 'Sat Nov 14 09:00:00 2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSys(rows) {
  const table = new Map(rows.map((p) => [p.pid, { ...p }]));
  let clock = 0;
  const err = (code) => Object.assign(new Error(code), { code });
  const sys = {
    table,
    psAll: async () => [`1 1 0 ${T0} /sbin/launchd`, ...[...table.values()].map((p) => `${p.pid} ${p.pgid} ${p.ppid} ${T0} ${p.command || 'x'}`)].join('\n'),
    psStart: async (pid) => (table.has(pid) ? T0 : null),
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
  const userData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')));
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
    screen: async () => ({ lines: ['x'], modes: {} }), promptBox: () => '',
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
async function live(ctx) {
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
  gate.send({ t: 'runner-spawned', pid: 2200, lstart: T0 });
  const runner = client(socketPath(dir));
  await sleep(30);
  runner.send({ t: 'runner', token: gok.runnerToken, pid: 2200 });
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

test('full run: handshake, carried flags, cards, sends once per id, give back, done, released and forgotten', async () => {
  const ctx = setup();
  try {
    const { runId, gate, runner, rok, doneToken } = await live(ctx);
    const restart = ctx.calls.restart[0];
    assert.equal(restart.phone.runId, runId);
    assert.equal(restart.phone.sessionId, S);
    assert.equal(restart.phone.runner, '/x/phone-runner.mjs');
    assert.deepEqual(rok, { t: 'runner-ok', permissionMode: 'acceptEdits', model: 'opus', resendNote: false });
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

test('no hello in time ends the run; the closed tab\'s shell is confirmed gone (killed after its grace) before release', async () => {
  const ctx = setup();
  try {
    await ctx.mode.init();
    await ctx.mode.take('T1', { sessionId: S, gen: ctx.mode.gen('T1') });
    ctx.advance(HELLO_MS + 1);
    await ctx.mode._tick();
    assert.equal(ctx.mode.stateOf('T1').status, 'ending');
    assert.ok(ctx.mode.heldSessions().has(S), 'no done and no closed tab: still held');
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
