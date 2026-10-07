// Mobile server auto-start retry (v1.0.77): launch keeps trying until the
// server is up or the user turns it off, instead of giving up once when
// Tailscale is not ready yet.
// Run: node ./electron/__tests__/mobile-autostart.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAutoStart, createStartGate, listenSettled, attachWebSocketServer, FAST_RETRY_MS, FAST_WINDOW_MS, SLOW_RETRY_MS } from '../mobile-autostart.js';

let pass = 0;
const check = async (label, fn) => { await fn(); pass += 1; console.log(`PASS  ${label}`); };

// Fake clock + timers: nothing fires on its own, the test drives each tick.
function harness({ failures = 0, enabled = () => true, startImpl } = {}) {
  let t = 1_000_000;
  const timers = [];
  const logs = [];
  let calls = 0;
  const start = startImpl || (async () => {
    calls += 1;
    if (calls <= failures) return { running: false, error: 'No Tailscale connection found. Open Tailscale, sign in, then try again.' };
    return { running: true };
  });
  let nextId = 1;
  const setTimer = (fn, ms) => { const it = { id: nextId++, fn, ms, cleared: false, unrefd: false, unref() { this.unrefd = true; } }; timers.push(it); return it; };
  const clearTimer = (h) => { h.cleared = true; };
  const a = createAutoStart({ start, enabled, now: () => t, setTimer, clearTimer, log: (level, msg) => logs.push({ level, msg }) });
  // Run the most recent scheduled timer as if it fired, advancing the clock by its delay.
  const fire = async () => { const it = timers.filter((x) => !x.cleared).at(-1); t += it.ms; await it.fn(); };
  return { a, timers, logs, fire, calls: () => calls, advance: (ms) => { t += ms; } };
}

await check('a start that succeeds first time schedules nothing', async () => {
  const h = harness();
  const first = await h.a.run();
  assert.equal(first.running, true, 'run resolves with the first attempt status');
  assert.equal(h.calls(), 1);
  assert.equal(h.timers.length, 0);
  assert.equal(h.a.pending, false);
  assert.equal(h.logs.length, 0);
});

await check('no tailnet at launch: retries every 5s in the boot window and comes up', async () => {
  const h = harness({ failures: 3 });
  const first = await h.a.run();
  assert.match(first.error, /No Tailscale connection/, 'the first failure rides back to the caller');
  assert.equal(h.a.pending, true);
  assert.equal(h.timers[0].ms, FAST_RETRY_MS);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].level, 'warn');
  assert.match(h.logs[0].msg, /No Tailscale connection/);
  await h.fire(); await h.fire();
  assert.equal(h.a.pending, true);
  await h.fire();
  assert.equal(h.calls(), 4);
  assert.equal(h.a.pending, false);
  assert.equal(h.a.attempts, 4);
  assert.match(h.logs.at(-1).msg, /up after 4 attempts/);
  assert.equal(h.logs.length, 2, 'the warning is logged once, not per attempt');
});

await check('after the two minute boot window the retry slows to 30s and never stops', async () => {
  const h = harness({ failures: 1_000_000 });
  await h.a.run();
  let fired = 0;
  while (h.timers.at(-1).ms === FAST_RETRY_MS) { await h.fire(); fired += 1; if (fired > 100) assert.fail('never slowed'); }
  assert.equal(fired, FAST_WINDOW_MS / FAST_RETRY_MS);
  assert.equal(h.timers.at(-1).ms, SLOW_RETRY_MS);
  for (let i = 0; i < 50; i += 1) await h.fire();
  assert.equal(h.timers.at(-1).ms, SLOW_RETRY_MS);
  assert.equal(h.a.pending, true);
  assert.equal(h.logs.length, 1, 'still one warning after 70+ attempts');
});

await check('the user turning the server off in Settings ends the loop before the next attempt', async () => {
  let on = true;
  const h = harness({ failures: 10, enabled: () => on });
  await h.a.run();
  on = false;
  await h.fire();
  assert.equal(h.calls(), 1, 'no start attempted once disabled');
  assert.equal(h.a.pending, false);
  assert.match(h.logs.at(-1).msg, /off in Settings/);
});

await check('cancel clears the pending timer and a late tick does nothing', async () => {
  const h = harness({ failures: 10 });
  await h.a.run();
  const pending = h.timers.at(-1);
  h.a.cancel();
  assert.equal(pending.cleared, true);
  assert.equal(h.a.pending, false);
  await pending.fn();
  assert.equal(h.calls(), 1);
});

await check('cancel during an in-flight start drops its result and schedules no retry', async () => {
  let release;
  const h = harness({ startImpl: () => new Promise((r) => { release = r; }) });
  const running = h.a.run();
  h.a.cancel();
  release({ running: false, error: 'late' });
  await running;
  assert.equal(h.timers.length, 0);
  assert.equal(h.logs.length, 0);
});

await check('a start that throws is a failed attempt, not a crash', async () => {
  const h = harness({ startImpl: async () => { throw new Error('EADDRINUSE 8420'); } });
  await h.a.run();
  assert.equal(h.a.pending, true);
  assert.match(h.logs[0].msg, /EADDRINUSE 8420/);
});

await check('run is idempotent: a second call does not start a second loop', async () => {
  const h = harness({ failures: 10 });
  await h.a.run();
  assert.equal(await h.a.run(), null);
  assert.equal(h.calls(), 1);
  assert.equal(h.timers.length, 1);
});

// ---- start gate: one in-flight start, and a stop mid-preparation discards it ----

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

await check('gate: the Settings switch and the launch retry share one in-flight start', async () => {
  const g = createStartGate();
  let builds = 0;
  const d = deferred();
  const fn = async () => { builds += 1; await d.promise; return { running: true }; };
  const p1 = g.run(fn);
  const p2 = g.run(fn);
  assert.equal(p1, p2, 'the second caller gets the same promise');
  assert.equal(g.inFlight, true);
  d.resolve();
  assert.deepEqual(await p1, { running: true });
  assert.equal(builds, 1, 'one server built, not two');
  assert.equal(g.inFlight, false);
});

await check('gate: after the start settles, the next run is a fresh attempt', async () => {
  const g = createStartGate();
  let n = 0;
  await g.run(async () => { n += 1; return { running: false, error: 'no tailnet' }; });
  await g.run(async () => { n += 1; return { running: true }; });
  assert.equal(n, 2);
});

await check('gate: a stop while the start awaits MagicDNS makes that start step back', async () => {
  const g = createStartGate();
  const dns = deferred();
  const entered = deferred();
  let built = false;
  const p = g.run(async (stillCurrent) => {
    entered.resolve();
    await dns.promise;
    if (!stillCurrent()) return { running: false, error: 'stopped during start' };
    built = true;
    return { running: true };
  });
  await entered.promise; // the start is genuinely inside its DNS wait now
  g.bump(); // stopMobileServer() during the await
  dns.resolve();
  const status = await p;
  assert.equal(built, false, 'no server was created after the stop');
  assert.equal(status.error, 'stopped during start');
});

await check('gate: a start that began after the last stop is current', async () => {
  const g = createStartGate();
  g.bump(); g.bump();
  let current = null;
  await g.run(async (stillCurrent) => { current = stillCurrent(); return { running: true }; });
  assert.equal(current, true);
});

await check('gate: a start that throws releases the gate', async () => {
  const g = createStartGate();
  await assert.rejects(g.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(g.inFlight, false);
  assert.deepEqual(await g.run(async () => ({ running: true })), { running: true });
});

await check('the retry timer is unref\'d so it never keeps the process alive', async () => {
  const h = harness({ failures: 10 });
  await h.a.run();
  const handle = h.timers.at(-1);
  assert.equal(handle.cleared, false);
  assert.equal(handle.unrefd, true);
});

// ---- listenSettled: the bind promise always settles ----

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} never settled`)), ms).unref())]);

await check('listenSettled: a normal bind resolves ok and the server is listening', async () => {
  const srv = http.createServer();
  const r = await withTimeout(listenSettled(srv, 0, '127.0.0.1'), 2000, 'bind');
  assert.deepEqual(r, { ok: true });
  assert.equal(srv.listening, true);
  await new Promise((res) => srv.close(res));
});

await check('listenSettled: a busy port resolves with the error instead of throwing', async () => {
  const first = http.createServer();
  await listenSettled(first, 0, '127.0.0.1');
  const { port } = first.address();
  const second = http.createServer();
  const r = await withTimeout(listenSettled(second, port, '127.0.0.1'), 2000, 'busy bind');
  assert.equal(r.ok, false);
  assert.match(r.error, /EADDRINUSE/);
  await new Promise((res) => first.close(res));
});

await check('listenSettled: a stop that closes the server before it listens still settles', async () => {
  const srv = http.createServer();
  const p = listenSettled(srv, 0, '127.0.0.1');
  srv.close(); // stopMobileServer() between listen() and its callback
  const r = await withTimeout(p, 2000, 'closed-before-listening bind');
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(srv.listening, false, 'the server did not stay up after the stop');
  if (r.ok) await new Promise((res) => srv.close(res)); // listened first, then closed: fine either way
});

await check('listenSettled: no listener is left behind after it settles', async () => {
  const srv = http.createServer();
  const before = ['error', 'close', 'listening'].map((e) => srv.listenerCount(e));
  await listenSettled(srv, 0, '127.0.0.1');
  const after = ['error', 'close', 'listening'].map((e) => srv.listenerCount(e));
  assert.deepEqual(after, before, 'listener counts return to what Node itself installs');
  await new Promise((res) => srv.close(res));
});

await check('a real WebSocketServer on a busy port is a failed bind, not an uncaught exception', async () => {
  const first = http.createServer();
  await listenSettled(first, 0, '127.0.0.1');
  const { port } = first.address();
  const second = http.createServer();
  const wss = attachWebSocketServer(second, { path: '/ws' });
  let uncaught = null;
  const onUncaught = (e) => { uncaught = e; };
  process.on('uncaughtException', onUncaught);
  try {
    const r = await withTimeout(listenSettled(second, port, '127.0.0.1'), 2000, 'ws busy bind');
    await new Promise((res) => setTimeout(res, 20)); // let any re-emitted error surface
    assert.equal(r.ok, false);
    assert.match(r.error, /EADDRINUSE/);
    assert.equal(uncaught, null, 'ws re-emitted the bind error on wss and nothing caught it');
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    try { wss.close(); } catch { /* noop */ }
    await new Promise((res) => first.close(res));
  }
});

console.log(`\n${pass} passed`);
