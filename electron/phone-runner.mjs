/**
 * Phone mode: the program a phone-mode tab runs (docs/phone-mode-design.md, "The runner runs inside the tab").
 *
 *   gate <ticket> <sessionId>  The tab's foreground program. Draws the Mac's "on your phone" screen, reads the keyboard
 *                              (Enter takes the conversation back), starts the runner in its own process group and
 *                              exits 0 only once that whole group and Claude are confirmed gone, so the launch line's
 *                              `&& claude --resume` can never start a second writer.
 *   run <runId>                Started by the gate (never by hand). Hosts Anthropic's Agent SDK, which runs the
 *                              person's own `claude` with that CLI's own login. The run id in argv is a non-secret tag
 *                              main's cleanup finds the process by.
 *   done <ticket> <runId>      Runs after the gate line, whatever its outcome: tells main the launch command is over.
 *
 * Started as `ELECTRON_RUN_AS_NODE=1 <Dobius binary> phone-runner.mjs ...`. Every message is one JSON object per line.
 *
 * To main (unix socket `<run dir>/phone.sock`, the ticket's folder):
 *   gate:   {t:'gate', token, pid}                 -> {t:'gate-ok', runId, runnerToken} | {t:'refused', code, error}
 *           {t:'runner-spawned', pid, lstart}
 *   runner: {t:'runner', token, pid}               -> {t:'runner-ok', permissionMode, model, resendNote} | refused
 *           {t:'claude', pid, lstart}              -> {t:'claude-ok'} | refused   (Claude's stdin waits for this)
 *           {t:'state', status}  {t:'card', card}  {t:'gone', requestId, why}  {t:'ended', reason}
 *           {t:'reply', reqId, ok, code?, error?}  answering one of main's commands:
 *           <- {t:'send', reqId, text} | {t:'answer', reqId, requestId, answer} | {t:'stop', reqId} | {t:'give-back', reqId}
 *   done:   {t:'done', token}                      -> {t:'done-ok'} | refused
 * Between the gate and the runner (fd 3 of the runner):
 *   gate -> runner: {t:'start', token, sessionId, sock}  {t:'stop'}
 *   runner -> gate: {t:'accepted'}  {t:'claude', pid, lstart}  {t:'state', status}  {t:'ended', reason}
 *
 * No token is ever in argv or the environment, and Claude's environment loses ELECTRON_RUN_AS_NODE (its Bash tool
 * would otherwise run every Electron app as plain Node) and every DOBIUS_PHONE_* name.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { socketPath, donePath, takeTokenFile, lineReader } from './phone-socket.js';
import { realSys, endGroup, endPid } from './phone-procs.js';
import { createPermissionRouter, createInputQueue, resolveEntrypoint, CARRY_MODES } from './phone-runner-core.mjs';

export const RUNNER_ACCEPT_MS = 30_000; // the runner must report main's acceptance within this, or the gate ends it
const ASK_MS = 10_000; // any one answer from main
const RUN_ID = /^[0-9a-f]{32}$/;
const SESSION_ID = /^[a-zA-Z0-9][\w-]{0,99}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\[1m\])?$/;
export const RESEND_TEXT = 'This conversation just moved to my phone while your last question or permission request was open, and it was cancelled. Please ask it again.';

/** Text from another process, made safe to print on a terminal or send on: no control characters, bounded. */
export const plain = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, n);

// ---- a newline-JSON channel over a socket or pipe ----

function channel(sock, { onMessage, onClose }) {
  const waiters = [];
  let closed = false;
  const read = lineReader((msg) => {
    const i = waiters.findIndex((w) => w.types.has(msg.t) || msg.t === 'refused');
    if (i !== -1) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); return; }
    onMessage?.(msg);
  }, () => sock.destroy());
  sock.on('data', read);
  sock.on('error', () => {}); // a close follows; that is what callers act on
  sock.on('close', () => {
    closed = true;
    for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.resolve({ t: 'refused', code: 'closed', error: 'the connection closed' }); }
    onClose?.();
  });
  const send = (obj) => {
    if (closed || sock.destroyed) return false;
    try { sock.write(`${JSON.stringify(obj)}\n`); return true; } catch { return false; }
  };
  return {
    send,
    get closed() { return closed; },
    /** Send, then wait for the next message of one of `types` (or a refusal). Never rejects. */
    ask(obj, types, ms = ASK_MS) {
      return new Promise((resolve) => {
        const w = { types: new Set(types), resolve, timer: null };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i !== -1) waiters.splice(i, 1);
          resolve({ t: 'refused', code: 'timeout', error: 'no answer in time' });
        }, ms);
        waiters.push(w);
        if (!send(obj)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); resolve({ t: 'refused', code: 'closed', error: 'the connection is closed' }); }
      });
    },
    close() { if (!closed) { sock.end(); setTimeout(() => sock.destroy(), 500).unref(); } },
  };
}

function connectMain(file, handlers = {}) {
  return new Promise((resolve) => {
    const sock = net.createConnection(file);
    const fail = (e) => resolve({ error: e?.code || e?.message || 'could not connect' });
    sock.once('error', fail);
    sock.once('connect', () => { sock.off('error', fail); resolve({ ch: channel(sock, handlers) }); });
  });
}

// ---- done ----

/** `done <ticket> <runId>`. Returns an exit code; always 0 unless the arguments are wrong (the shell carries on). */
export async function runDone({ ticket, runId, err = process.stderr }) {
  if (typeof ticket !== 'string' || !path.isAbsolute(ticket) || !RUN_ID.test(String(runId))) return 2;
  const dir = path.dirname(ticket);
  let token;
  try { token = takeTokenFile(donePath(dir, runId)); } catch (e) {
    // Main keeps the conversation reserved until the tab closes: the safe side. Say so once.
    if (e.code !== 'ENOENT') err.write(`Dobius: could not report the phone session as finished (${plain(e.message, 120)}).\n`);
    return 0;
  }
  const c = await connectMain(socketPath(dir));
  if (c.error) return 0;
  await c.ch.ask({ t: 'done', token }, ['done-ok'], 5000);
  c.ch.close();
  return 0;
}

// ---- gate ----

function screen(out, lines) {
  try { out.write(`\x1b[2J\x1b[H${lines.map((l) => `  ${l}`).join('\r\n')}\r\n`); } catch { /* the tab is closing */ }
}

const STATUS_WORDS = {
  starting: 'Starting on your phone...', idle: 'Waiting for your next message.', working: 'Claude is working.',
  waiting: 'Waiting for you to answer on your phone.',
};

/**
 * `gate <ticket> <sessionId>`. Returns { done: Promise<exitCode>, stop(reason, { hard }) }.
 * `input`/`out` are the tab's terminal; `runnerArgv` overrides how the runner is started (tests).
 */
export function runGate({
  ticket, sessionId, sys = realSys, input = process.stdin, out = process.stdout,
  runnerArgv = (runId) => [process.execPath, [process.argv[1], 'run', runId]], acceptMs = RUNNER_ACCEPT_MS,
}) {
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let main = null;
  let child = null;
  let pgid = null;
  let claude = null; // { pid, lstart }
  let accepted = false;
  let endReason = null;
  let stopping = null;
  let acceptTimer = null;
  let rawSet = false;

  const manual = () => `To open it here once the phone side has stopped, run: claude --resume ${sessionId}`;
  const restoreTty = () => {
    if (rawSet) { try { input.setRawMode(false); } catch { /* closing */ } rawSet = false; }
    try { input.pause(); } catch { /* closing */ }
  };
  const say = (line) => { try { out.write(`${line}\r\n`); } catch { /* closing */ } };
  const finish = (code) => { restoreTty(); main?.close(); resolveDone(code); };

  const ctlSend = (obj) => {
    const s = child?.stdio?.[3];
    if (!s || s.destroyed) return;
    try { s.write(`${JSON.stringify(obj)}\n`); } catch { /* the runner is gone */ }
  };

  async function stop(reason, { hard = false } = {}) {
    if (stopping) return stopping;
    stopping = (async () => {
      clearTimeout(acceptTimer);
      endReason = endReason || reason;
      if (!child) { finish(1); return; }
      ctlSend({ t: 'stop', reason: endReason });
      // Give the runner a moment to close the SDK, which ends Claude cleanly; then the group is ended either way.
      if (!hard && child.exitCode == null && child.signalCode == null) {
        await Promise.race([new Promise((r) => child.once('exit', r)), sys.sleep(4000)]);
      }
      // No pid means the spawn itself failed: there is no group to end.
      const g = Number.isSafeInteger(pgid) && pgid > 1 ? await endGroup(sys, pgid, { graceMs: hard ? 0 : 3000, maxMs: 15000 }) : 'gone';
      const c = claude ? await endPid(sys, claude.pid, claude.lstart, { maxMs: 15000 }) : 'gone';
      if (hard) { finish(1); return; }
      if (g === 'gone' && c === 'gone') {
        say('');
        say(`Back on the Mac (${plain(endReason, 120)}). Opening the conversation here.`);
        finish(0);
        return;
      }
      say('');
      say(`Could not confirm the phone side stopped (${g === 'gone' ? `Claude: ${c}` : `runner: ${g}`}).`);
      say(manual());
      finish(1);
    })();
    return stopping;
  }

  (async () => {
    if (!SESSION_ID.test(String(sessionId)) || typeof ticket !== 'string' || !path.isAbsolute(ticket)) {
      say('Dobius: this phone launch is malformed.');
      return finish(2);
    }
    const dir = path.dirname(ticket);
    let token;
    try { token = takeTokenFile(ticket); } catch (e) {
      say(`Dobius: could not read this tab's phone ticket (${plain(e.code || e.message, 80)}).`);
      say(manual());
      return finish(1);
    }
    // Main closing this connection needs no action here: the runner's own connection closes too and it ends itself.
    const c = await connectMain(socketPath(dir));
    if (c.error) { say(`Dobius: could not reach Dobius (${plain(c.error, 80)}).`); say(manual()); return finish(1); }
    main = c.ch;
    const ok = await main.ask({ t: 'gate', token, pid: process.pid }, ['gate-ok']);
    if (ok.t !== 'gate-ok' || !RUN_ID.test(String(ok.runId)) || typeof ok.runnerToken !== 'string') {
      say(`Dobius: phone mode did not start (${plain(ok.error || ok.code || 'refused', 160)}).`);
      say(manual());
      return finish(1);
    }

    screen(out, ['This conversation is on your phone.', '', STATUS_WORDS.starting, '', 'Press Enter here to take it back.']);
    if (input.isTTY && typeof input.setRawMode === 'function') { try { input.setRawMode(true); rawSet = true; } catch { /* plain mode still reads lines */ } }
    input.on('data', (d) => {
      const s = String(d);
      if (s.includes('\r') || s.includes('\n') || s.includes('\x03')) void stop('taken back on the Mac');
    });
    input.resume();

    const [cmd, args] = runnerArgv(ok.runId);
    try {
      child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe'], cwd: process.cwd(), env: process.env });
    } catch (e) {
      say(`Dobius: could not start the phone side (${plain(e.message, 120)}).`);
      return finish(1);
    }
    pgid = child.pid;
    child.on('error', () => {}); // an exit follows
    child.on('exit', () => { void stop(endReason || 'the phone side stopped'); });
    if (!Number.isSafeInteger(pgid)) { await sys.sleep(50); return stop('the phone side did not start'); }

    const ctl = child.stdio[3];
    ctl.on('error', () => {});
    ctl.on('data', lineReader((m) => {
      if (m.t === 'accepted') { accepted = true; clearTimeout(acceptTimer); }
      else if (m.t === 'claude' && Number.isSafeInteger(m.pid) && typeof m.lstart === 'string' && !claude) claude = { pid: m.pid, lstart: m.lstart };
      else if (m.t === 'state' && STATUS_WORDS[m.status]) screen(out, ['This conversation is on your phone.', '', STATUS_WORDS[m.status], '', 'Press Enter here to take it back.']);
      else if (m.t === 'ended' && !endReason) endReason = plain(m.reason, 120) || null; // the gate's own reason wins
    }, () => {}));
    acceptTimer = setTimeout(() => { if (!accepted) void stop('the phone side did not start in time', { hard: false }); }, acceptMs);
    ctlSend({ t: 'start', token: ok.runnerToken, sessionId, sock: socketPath(dir) });

    const lstart = await sys.psStart(pgid);
    if (!lstart) return stop('the phone side could not be identified');
    main.send({ t: 'runner-spawned', pid: pgid, lstart });
  })().catch((e) => { say(`Dobius: phone mode failed (${plain(e.message, 160)}).`); void stop('failed'); });

  return { done, stop };
}

// ---- runner ----

/** The first executable named `name` on PATH (absolute folders only), or null. */
export function findOnPath(name, envPath) {
  for (const dir of String(envPath || '').split(':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    try {
      if (!fs.statSync(p).isFile()) continue;
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here */ }
  }
  return null;
}

/** Claude's environment: the tab's, minus what must not leak into Claude and its tools. */
export function claudeEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v == null || k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('DOBIUS_PHONE_')) continue;
    out[k] = v;
  }
  out.CLAUDE_CODE_ENTRYPOINT = resolveEntrypoint(env?.CLAUDE_CODE_ENTRYPOINT);
  return out;
}

/**
 * `run <runId>`. Returns a Promise of an exit code. `ctl` is the gate's pipe (fd 3); `loadSdk` returns the SDK module.
 */
export async function runRunner({
  runId, sys = realSys, ctl = new net.Socket({ fd: 3, readable: true, writable: true }),
  loadSdk = () => import('@anthropic-ai/claude-agent-sdk'), env = process.env, cwd = process.cwd(), exitWaitMs = 3000,
}) {
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  let main = null;
  let q = null;
  let router = null;
  let queue = null;
  let claudeProc = null;
  let finishing = false;
  let turnActive = false;
  let lastStatus = null;

  let gotStart;
  const startMsg = new Promise((r) => { gotStart = r; });
  const ctlCh = channel(ctl, {
    onMessage: (m) => {
      if (m.t === 'start') gotStart(m);
      else if (m.t === 'stop') void finish(typeof m.reason === 'string' && m.reason ? m.reason : 'taken back on the Mac');
    },
    onClose: () => { gotStart(null); void finish('the Mac screen closed'); },
  });

  const status = () => (router?.size() ? 'waiting' : turnActive ? 'working' : 'idle');
  const pushState = () => {
    const s = status();
    if (s === lastStatus) return;
    lastStatus = s;
    main?.send({ t: 'state', status: s });
    ctlCh.send({ t: 'state', status: s });
  };

  async function finish(reason) {
    if (finishing) return;
    finishing = true;
    const why = plain(reason, 200);
    try { router?.cancelAll('ended'); } catch { /* ending anyway */ }
    queue?.close();
    try { q?.close(); } catch { /* ending anyway */ }
    main?.send({ t: 'ended', reason: why });
    ctlCh.send({ t: 'ended', reason: why });
    if (claudeProc && claudeProc.exitCode == null && claudeProc.signalCode == null) {
      await Promise.race([new Promise((r) => claudeProc.once('exit', r)), sys.sleep(exitWaitMs)]);
      if (claudeProc.exitCode == null && claudeProc.signalCode == null) { try { claudeProc.kill('SIGKILL'); } catch { /* gone */ } }
    }
    main?.close();
    ctlCh.close();
    resolveExit(0);
  }

  const run = async () => {
    if (!RUN_ID.test(String(runId))) return finish('bad run id');
    const start = await Promise.race([startMsg, sys.sleep(ASK_MS).then(() => null)]);
    if (!start || typeof start.token !== 'string' || !SESSION_ID.test(String(start.sessionId)) || typeof start.sock !== 'string') {
      return finish('the Mac screen did not hand over');
    }
    const c = await connectMain(start.sock, {
      onMessage: (m) => void command(m),
      onClose: () => void finish('Dobius closed the connection'),
    });
    if (c.error) return finish(`could not reach Dobius (${c.error})`);
    main = c.ch;
    const ok = await main.ask({ t: 'runner', token: start.token, pid: process.pid }, ['runner-ok']);
    if (ok.t !== 'runner-ok') return finish(`Dobius refused the phone side (${ok.error || ok.code})`);
    if (finishing) return undefined;
    ctlCh.send({ t: 'accepted' });

    const claudePath = findOnPath('claude', env.PATH);
    if (!claudePath) return finish("claude was not found on this tab's PATH");
    let sdk;
    try { sdk = await loadSdk(); } catch (e) { return finish(`the Agent SDK did not load (${e.message})`); }
    if (finishing) return undefined;

    queue = createInputQueue();
    router = createPermissionRouter({
      onCard: (card) => { main?.send({ t: 'card', card }); pushState(); },
      onGone: (requestId, why) => { main?.send({ t: 'gone', requestId, why: plain(why, 200) }); pushState(); },
      setMode: (mode) => q.setPermissionMode(mode),
    });
    if (ok.resendNote === true) { queue.push(RESEND_TEXT); turnActive = true; }

    const mode = CARRY_MODES.has(ok.permissionMode) ? ok.permissionMode : undefined;
    const model = typeof ok.model === 'string' && MODEL_RE.test(ok.model) ? ok.model : undefined;
    q = sdk.query({
      prompt: queue,
      options: {
        cwd,
        resume: start.sessionId,
        pathToClaudeCodeExecutable: claudePath,
        env: claudeEnv(env),
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...(mode ? { permissionMode: mode } : {}),
        ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        ...(model ? { model } : {}),
        canUseTool: router.canUseTool,
        spawnClaudeCodeProcess: spawnClaude,
      },
    });
    pushState();
    try {
      for await (const m of q) {
        if (finishing) break;
        if (m?.type === 'result') turnActive = false;
        else if (m?.type === 'assistant' || m?.type === 'stream_event') turnActive = true;
        pushState();
      }
      return finish('Claude finished');
    } catch (e) {
      return finish(`Claude stopped (${e?.message || e})`);
    }
  };

  /**
   * The SDK's spawn hook. Claude starts in this process's group (never detached), and nothing reaches its stdin until
   * main has recorded its pid and start time, so main can always find and confirm the Claude it must clean up.
   */
  function spawnClaude(opts) {
    const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, signal: opts.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    claudeProc = child;
    const held = new PassThrough();
    child.stdin.on('error', () => {}); // EPIPE when Claude exits first; its exit is what the SDK acts on
    child.stderr.on('data', () => {}); // drained, never shown: the SDK reports Claude's failures itself
    child.on('error', () => {});
    child.once('spawn', async () => {
      const lstart = await sys.psStart(child.pid);
      const okc = lstart ? await main.ask({ t: 'claude', pid: child.pid, lstart }, ['claude-ok']) : { t: 'refused', error: 'no start time' };
      if (okc.t !== 'claude-ok') {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        void finish(`Dobius could not record Claude (${okc.error || okc.code})`);
        return;
      }
      ctlCh.send({ t: 'claude', pid: child.pid, lstart });
      held.pipe(child.stdin);
    });
    return {
      stdin: held,
      stdout: child.stdout,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      get signalCode() { return child.signalCode; },
      kill: (sig) => child.kill(sig),
      on: (ev, fn) => { child.on(ev, fn); },
      once: (ev, fn) => { child.once(ev, fn); },
      off: (ev, fn) => { child.off(ev, fn); },
    };
  }

  async function command(m) {
    const reply = (ok, code, error) => main?.send({ t: 'reply', reqId: m.reqId, ok, ...(ok ? {} : { code, error }) });
    if (typeof m.reqId !== 'string') return;
    if (finishing || !queue) return reply(false, 'ending', 'the phone session is ending');
    if (m.t === 'send') {
      if (typeof m.text !== 'string' || !m.text.trim()) return reply(false, 'bad_request', 'empty message');
      if (!queue.push(m.text)) return reply(false, 'busy', 'too many messages are already waiting');
      turnActive = true;
      pushState();
      return reply(true);
    }
    if (m.t === 'answer') {
      const r = await router.answer(m.requestId, m.answer);
      pushState();
      return r.ok ? reply(true) : reply(false, r.code, r.error);
    }
    if (m.t === 'stop') {
      try { await q.interrupt(); return reply(true); } catch (e) { return reply(false, 'failed', plain(e?.message, 200)); }
    }
    if (m.t === 'give-back') { reply(true); return finish('given back on the phone'); }
    return reply(false, 'bad_request', 'unknown command');
  }

  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.once(sig, () => void finish('stopped'));
  run().catch((e) => finish(`the phone side failed (${e?.message || e})`));
  return exited;
}

// ---- entry ----

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  const [, , sub, a, b] = process.argv;
  if (sub === 'done') {
    runDone({ ticket: a, runId: b }).then((code) => process.exit(code));
  } else if (sub === 'gate') {
    const g = runGate({ ticket: a, sessionId: b });
    process.on('SIGHUP', () => void g.stop('the tab closed', { hard: true }));
    process.on('SIGTERM', () => void g.stop('stopped', { hard: true }));
    process.on('SIGINT', () => void g.stop('taken back on the Mac')); // only when the terminal is not in raw mode
    g.done.then((code) => process.exit(code));
  } else if (sub === 'run') {
    runRunner({ runId: a }).then((code) => process.exit(code));
  } else {
    process.stderr.write('usage: phone-runner.mjs gate <ticket> <sessionId> | run <runId> | done <ticket> <runId>\n');
    process.exit(2);
  }
}
