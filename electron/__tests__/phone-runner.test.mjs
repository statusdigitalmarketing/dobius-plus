// Phone runner: the gate, the runner and `done` against a fake main on a real socket, with a stand-in runner that uses
// the real runRunner and a fake SDK, and a fake `claude` that records when its stdin first receives a byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ensureRunDir, ticketPath, donePath, writeTokenFile, startPhoneSocket } from '../phone-socket.js';
import { runGate, runDone, claudeEnv, findOnPath, plain } from '../phone-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, '..', 'phone-runner.mjs');
const RUN = 'a'.repeat(32);
const GATE_TOKEN = 'g'.repeat(64);
const RUNNER_TOKEN = 'r'.repeat(64);
// npm test points TMPDIR at a deep folder (scripts/test-tmp.mjs), too long for the run folder's socket; use /tmp then.
const tmpBase = () => (Buffer.byteLength(os.tmpdir()) > 40 ? '/tmp' : os.tmpdir());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

async function until(fn, ms = 8000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function setup({ answerRunner = true, claudeOkDelay = 400, gateToken = GATE_TOKEN, stubborn = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'pr-')));
  const runDir = ensureRunDir(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const logs = { first: path.join(root, 'first-byte'), opts: path.join(root, 'opts.json'), perm: path.join(root, 'perm.log'), kid: path.join(root, 'kid.pid') };
  // The fake claude: records the time of the first stdin byte, exits when stdin ends.
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'); let first = true;
process.stdin.on('data', () => { if (first) { first = false; fs.writeFileSync(${JSON.stringify(logs.first)}, String(Date.now())); } });
// Stubborn: outlives its stdin, and has a child of its own (like a Bash tool command) that only a group kill reaches.
if (process.env.FAKE_STUBBORN) {
  const kid = require('child_process').spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(logs.kid)}, String(kid.pid));
} else process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1e6);
`, { mode: 0o755 });
  // The stand-in runner: the real runRunner with a fake SDK.
  const standin = path.join(root, 'standin.mjs');
  fs.writeFileSync(standin, `
import fs from 'node:fs';
import { runRunner } from ${JSON.stringify(RUNNER)};
const fakeSdk = { query({ prompt, options }) {
  const proc = options.spawnClaudeCodeProcess({ command: options.pathToClaudeCodeExecutable, args: [], cwd: options.cwd, env: options.env, signal: new AbortController().signal });
  proc.stdin.write('init\\n'); // held until main has recorded Claude
  fs.writeFileSync(${JSON.stringify(logs.opts)}, JSON.stringify({ resume: options.resume, permissionMode: options.permissionMode ?? null,
    settingSources: options.settingSources, preset: options.systemPrompt?.preset,
    env: { ELECTRON_RUN_AS_NODE: options.env.ELECTRON_RUN_AS_NODE ?? null, DOBIUS_PHONE_X: options.env.DOBIUS_PHONE_X ?? null, CLAUDE_CODE_ENTRYPOINT: options.env.CLAUDE_CODE_ENTRYPOINT } }));
  async function* gen() {
    for await (const m of prompt) {
      yield { type: 'assistant' };
      if (m.message.content === 'perm') {
        const r = await options.canUseTool('Bash', { command: 'ls' }, { toolUseID: 'tu1', signal: new AbortController().signal, title: 'Claude wants to run ls' });
        fs.appendFileSync(${JSON.stringify(logs.perm)}, JSON.stringify(r) + '\\n');
      }
      yield { type: 'result' };
    }
  }
  const g = gen();
  g.close = () => proc.stdin.end();
  g.interrupt = async () => {};
  g.setPermissionMode = async () => {};
  return g;
} };
const env = { ...process.env, PATH: ${JSON.stringify(bin)} + ':' + process.env.PATH, ELECTRON_RUN_AS_NODE: '1', DOBIUS_PHONE_X: 'leak'${stubborn ? ", FAKE_STUBBORN: '1'" : ''} };
delete env.CLAUDE_CODE_ENTRYPOINT;
runRunner({ runId: process.argv[3], loadSdk: async () => fakeSdk, env }).then((c) => process.exit(c));
`);
  const ticket = ticketPath(runDir, RUN);
  writeTokenFile(ticket, gateToken);
  const log = [];
  const ctx = { root, runDir, ticket, logs, log, standin, runnerConn: null };
  ctx.ready = startPhoneSocket(runDir, {
    handler: (conn, msg) => {
      conn.authed = true;
      log.push({ ...msg, at: Date.now() });
      if (msg.t === 'gate') conn.send(msg.token === GATE_TOKEN ? { t: 'gate-ok', runId: RUN, runnerToken: RUNNER_TOKEN } : { t: 'refused', code: 'bad_token', error: 'that ticket is not valid' });
      else if (msg.t === 'runner' && answerRunner) {
        ctx.runnerConn = conn;
        conn.send(msg.token === RUNNER_TOKEN ? { t: 'runner-ok', permissionMode: 'acceptEdits', model: null, resendNote: false } : { t: 'refused', code: 'bad_token' });
      } else if (msg.t === 'claude') setTimeout(() => conn.send({ t: 'claude-ok' }), claudeOkDelay);
      else if (msg.t === 'done') conn.send({ t: 'done-ok' });
    },
  }).then((srv) => { ctx.srv = srv; return ctx; });
  ctx.gate = () => {
    const input = new PassThrough();
    const out = new PassThrough();
    let text = '';
    out.on('data', (d) => { text += d; });
    const g = runGate({ ticket, sessionId: 'sess-1', input, out, acceptMs: ctx.acceptMs ?? 30000, runnerArgv: (id) => [process.execPath, [standin, 'run', id]] });
    return { ...g, input, text: () => text };
  };
  // The gate runs in this process, so its hello carries OUR pid: never signal it or its group.
  ctx.pids = () => log.filter((m) => Number.isSafeInteger(m.pid) && m.pid !== process.pid).map((m) => m.pid);
  ctx.cleanup = async () => {
    const group = log.find((m) => m.t === 'runner-spawned')?.pid;
    if (group && group !== process.pid && group !== process.getpgid?.(0)) { try { process.kill(-group, 'SIGKILL'); } catch { /* gone */ } }
    for (const pid of ctx.pids()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await ctx.srv?.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  ctx.cmd = async (obj) => {
    const before = log.length;
    ctx.runnerConn.send(obj);
    return until(() => log.slice(before).find((m) => m.t === 'reply' && m.reqId === obj.reqId), 5000, `reply to ${obj.t}`);
  };
  return ctx;
}

test('gate + runner: Claude gets nothing before main records it, cards round trip, give back exits 0 with nothing left', async () => {
  const ctx = await setup().ready;
  try {
    const g = ctx.gate();
    await until(() => ctx.log.find((m) => m.t === 'state' && m.status === 'idle'), 8000, 'idle');
    const rep = await until(() => ctx.log.find((m) => m.t === 'claude'), 5000, 'Claude report'); // may follow the first state
    const spawned = ctx.log.find((m) => m.t === 'runner-spawned');
    const hello = ctx.log.find((m) => m.t === 'runner');
    assert.equal(spawned.pid, hello.pid); // the runner leads its own group
    assert.equal(typeof spawned.lstart, 'string');
    const first = Number(await until(() => fs.existsSync(ctx.logs.first) && fs.readFileSync(ctx.logs.first, 'utf8'), 5000, 'first byte'));
    assert.ok(first >= rep.at + 350, `Claude read stdin ${first - rep.at} ms after the report; main answers after 400`);
    assert.equal(fs.existsSync(ctx.ticket), false); // the ticket was consumed

    const opts = JSON.parse(fs.readFileSync(ctx.logs.opts, 'utf8'));
    assert.deepEqual(opts, {
      resume: 'sess-1', permissionMode: 'acceptEdits', settingSources: ['user', 'project', 'local'], preset: 'claude_code',
      env: { ELECTRON_RUN_AS_NODE: null, DOBIUS_PHONE_X: null, CLAUDE_CODE_ENTRYPOINT: 'remote_mobile' },
    });

    assert.deepEqual(await ctx.cmd({ t: 'send', reqId: '1', text: 'perm' }), { t: 'reply', reqId: '1', ok: true, at: ctx.log.find((m) => m.reqId === '1').at });
    const card = (await until(() => ctx.log.find((m) => m.t === 'card'), 5000, 'card')).card;
    assert.equal(card.requestId, 'tu1');
    assert.equal(card.kind, 'permission');
    await until(() => ctx.log.find((m) => m.t === 'state' && m.status === 'waiting'), 5000, 'waiting');
    assert.equal((await ctx.cmd({ t: 'answer', reqId: '2', requestId: 'nope', answer: { kind: 'permission', allow: true } })).code, 'not_pending');
    assert.equal((await ctx.cmd({ t: 'answer', reqId: '3', requestId: 'tu1', answer: { kind: 'permission', allow: true } })).ok, true);
    const perm = JSON.parse(await until(() => fs.existsSync(ctx.logs.perm) && fs.readFileSync(ctx.logs.perm, 'utf8'), 5000, 'permission result'));
    assert.equal(perm.behavior, 'allow');

    const claudePid = rep.pid;
    assert.equal((await ctx.cmd({ t: 'give-back', reqId: '4' })).ok, true);
    assert.equal(await g.done, 0);
    assert.match(g.text(), /Back on the Mac \(given back on the phone\)/);
    assert.equal(alive(claudePid), false);
    assert.equal(alive(hello.pid), false);
    assert.ok(ctx.log.find((m) => m.t === 'ended' && m.reason === 'given back on the phone'));
  } finally { await ctx.cleanup(); }
});

test('gate: Enter takes it back, and Claude and the runner are gone before it exits 0', async () => {
  const ctx = await setup({ claudeOkDelay: 0 }).ready;
  try {
    const g = ctx.gate();
    await until(() => ctx.log.find((m) => m.t === 'state' && m.status === 'idle'), 8000, 'idle');
    await until(() => ctx.log.find((m) => m.t === 'claude'), 5000, 'Claude report');
    const pids = ctx.pids();
    g.input.write('\r');
    assert.equal(await g.done, 0);
    assert.match(g.text(), /taken back on the Mac/);
    for (const pid of pids) assert.equal(alive(pid), false, `pid ${pid} still alive`);
  } finally { await ctx.cleanup(); }
});

test('gate: a runner killed outright still has its group and Claude ended before the gate exits 0', async () => {
  const ctx = await setup({ claudeOkDelay: 0, stubborn: true }).ready;
  try {
    const g = ctx.gate();
    await until(() => ctx.log.find((m) => m.t === 'state' && m.status === 'idle'), 8000, 'idle');
    const runnerPid = ctx.log.find((m) => m.t === 'runner').pid;
    const claudePid = (await until(() => ctx.log.find((m) => m.t === 'claude'), 5000, 'Claude report')).pid;
    const kidPid = Number(await until(() => fs.existsSync(ctx.logs.kid) && fs.readFileSync(ctx.logs.kid, 'utf8'), 5000, 'kid pid'));
    process.kill(runnerPid, 'SIGKILL'); // Claude survives its parent: only the gate's group cleanup can end it
    await sleep(100);
    const code = await g.done;
    assert.equal(code, 0, g.text());
    assert.equal(alive(claudePid), false);
    assert.equal(alive(kidPid), false); // only the group kill reaches this one
    try { process.kill(kidPid, 'SIGKILL'); } catch { /* gone, as asserted */ }
  } finally { await ctx.cleanup(); }
});

test('gate: a runner main never accepts is ended at the deadline, and no Claude is ever started', async () => {
  const ctx = await setup({ answerRunner: false }).ready;
  ctx.acceptMs = 800;
  try {
    const g = ctx.gate();
    const code = await g.done;
    assert.equal(code, 0); // confirmed gone: the tab may resume on the Mac
    assert.match(g.text(), /did not start in time/);
    assert.equal(ctx.log.some((m) => m.t === 'claude'), false);
    assert.equal(fs.existsSync(ctx.logs.first), false);
    for (const pid of ctx.pids()) assert.equal(alive(pid), false);
  } finally { await ctx.cleanup(); }
});

test('gate: a refused hello starts nothing and exits 1 with the manual line', async () => {
  const ctx = await setup({ gateToken: 'x'.repeat(64) }).ready;
  try {
    const g = ctx.gate();
    assert.equal(await g.done, 1);
    assert.match(g.text(), /did not start \(that ticket is not valid\)/);
    assert.match(g.text(), /claude --resume sess-1/);
    assert.equal(ctx.log.some((m) => m.t === 'runner-spawned'), false);
  } finally { await ctx.cleanup(); }
});

test('done: reports its token once and consumes the file; a missing file is quiet', async () => {
  const ctx = await setup().ready;
  try {
    writeTokenFile(donePath(ctx.runDir, RUN), 'd'.repeat(64));
    assert.equal(await runDone({ ticket: ctx.ticket, runId: RUN }), 0);
    assert.deepEqual(ctx.log.filter((m) => m.t === 'done').map((m) => m.token), ['d'.repeat(64)]);
    assert.equal(fs.existsSync(donePath(ctx.runDir, RUN)), false);
    let err = '';
    assert.equal(await runDone({ ticket: ctx.ticket, runId: RUN, err: { write: (s) => { err += s; } } }), 0);
    assert.equal(err, '');
    assert.equal(await runDone({ ticket: 'relative/x', runId: RUN }), 2);
  } finally { await ctx.cleanup(); }
});

test('claudeEnv, findOnPath and plain', () => {
  assert.deepEqual(claudeEnv({ A: '1', ELECTRON_RUN_AS_NODE: '1', DOBIUS_PHONE_T: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli' }), { A: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
  assert.equal(claudeEnv({}).CLAUDE_CODE_ENTRYPOINT, 'remote_mobile');
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), 'pf-')));
  try {
    fs.writeFileSync(path.join(d, 'claude'), '', { mode: 0o644 }); // not executable
    assert.equal(findOnPath('claude', `rel:${d}`), null);
    fs.chmodSync(path.join(d, 'claude'), 0o755);
    assert.equal(findOnPath('claude', `relative/bin:${d}`), path.join(d, 'claude'));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  assert.equal(plain('a\x1b[2Jb\nc', 10), 'a [2Jb c');
});
