// Main-thread stall watchdog (v1.0.70). A "not responding" dialog with no
// crash, no log and no hang report left nothing to diagnose; this records the
// next one with the IPC handlers that were in flight.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/stall-watchdog.test.mjs
import assert from 'node:assert/strict';
import { createStallWatchdog, evaluateTick, monotonicNow } from '../stall-watchdog.js';
import { isPriorityKind } from '../error-log.js';

let pass = 0;
const check = async (label, fn) => { await fn(); pass += 1; console.log(`PASS  ${label}`); };

const fakeMem = () => ({ heapUsed: 100 * 1048576, heapTotal: 200 * 1048576, rss: 500 * 1048576 });

// A controllable clock + a fake ipcMain that stores the wrapped handlers.
function harness(opts = {}) {
  let t = 1_000_000;
  const logs = [];
  const wd = createStallWatchdog({ thresholdMs: 2000, intervalMs: 250, minReportGapMs: 30_000,
    log: (kind, detail) => logs.push({ kind, detail }), now: () => t, memory: fakeMem, ...opts });
  const handlers = new Map();
  const ipc = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) };
  wd.wrapIpc(ipc);
  return { wd, logs, handlers, ipc, advance: (ms) => { t += ms; }, now: () => t };
}

await check('a tick that lands on time reports nothing', async () => {
  const h = harness();
  h.wd.state.lastTickAt = h.now();
  h.advance(250); h.wd.tick();
  assert.equal(h.logs.length, 0);
});

await check('a tick 3s late reports a ~3s stall with heap and rss', async () => {
  const h = harness();
  h.wd.state.lastTickAt = h.now();
  h.advance(250 + 3000); h.wd.tick();
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].kind, 'main.stall');
  assert.match(h.logs[0].detail, /blocked ~3\.0s/);
  assert.match(h.logs[0].detail, /heap 100\/200MB rss 500MB/);
});

await check('lag just under the threshold is not a stall', async () => {
  const h = harness();
  h.wd.state.lastTickAt = h.now();
  h.advance(250 + 1999); h.wd.tick();
  assert.equal(h.logs.length, 0);
});

await check('the in-flight IPC handler is named in the report, with its age', async () => {
  const h = harness();
  h.ipc.handle('sessions:loadAll', () => new Promise(() => {})); // never resolves
  h.handlers.get('sessions:loadAll')();
  h.wd.state.lastTickAt = h.now();
  h.advance(250 + 5000); h.wd.tick();
  assert.match(h.logs[0].detail, /last IPC entered: sessions:loadAll \(5250ms ago, still in flight\)/);
  assert.match(h.logs[0].detail, /in flight at recovery: sessions:loadAll \(5250ms, entered before the stall\)/);
});

await check('a handler that finished before the stall is reported as finished, not in flight', async () => {
  const h = harness();
  h.ipc.handle('config:get', async () => 42);
  const out = await h.handlers.get('config:get')();
  assert.equal(out, 42, 'wrapped handler passes the return value through');
  h.wd.state.lastTickAt = h.now();
  h.advance(250 + 2500); h.wd.tick();
  assert.match(h.logs[0].detail, /last IPC entered: config:get \(2750ms ago, finished\)/);
  assert.match(h.logs[0].detail, /in flight at recovery: none/);
});

await check('a rejecting handler is cleared from in-flight and its error is re-thrown unchanged', async () => {
  const h = harness();
  const boom = new Error('boom');
  h.ipc.handle('x:fail', async () => { throw boom; });
  await assert.rejects(h.handlers.get('x:fail')(), (e) => e === boom);
  assert.equal(h.wd.state.inflight.size, 0);
});

await check('ipcMain.on listeners are tracked too and their return value passes through', async () => {
  const h = harness();
  h.ipc.on('terminal:write', (_e, data) => `wrote:${data}`);
  assert.equal(h.handlers.get('terminal:write')(null, 'ls'), 'wrote:ls');
  assert.equal(h.wd.state.inflight.size, 0);
  assert.equal(h.wd.state.lastEntered.channel, 'terminal:write');
});

await check('a second stall inside the 30s gap is suppressed and counted in the next report', async () => {
  const h = harness();
  h.wd.state.lastTickAt = h.now();
  h.advance(250 + 3000); h.wd.tick();            // reported
  h.advance(250 + 3000); h.wd.tick();            // suppressed (within 30s)
  assert.equal(h.logs.length, 1);
  h.advance(40_000); h.wd.state.lastTickAt = h.now();
  h.advance(250 + 2500); h.wd.tick();            // reported, mentions 1 suppressed
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[1].detail, /1 earlier stall\(s\) went unreported/);
});

await check('wrapIpc is idempotent: wrapping twice does not double-count', async () => {
  const h = harness();
  assert.equal(h.wd.wrapIpc(h.ipc), false);
  h.ipc.handle('a', async () => {});
  await h.handlers.get('a')();
  assert.equal(h.wd.state.seq, 1);
});

await check('start() arms once, logs that it is armed, and stop() clears the timer', async () => {
  const h = harness();
  h.wd.start(); h.wd.start();
  assert.equal(h.logs[0].kind, 'main.stall-watchdog');
  assert.match(h.logs[0].detail, /armed: reporting main-thread stalls over 2000ms/);
  h.wd.stop(); h.wd.stop();
  assert.equal(h.logs.length, 1);
});

await check('a broken memory() probe cannot take the tick down', async () => {
  const h = harness({ memory: () => { throw new Error('no mem'); } });
  h.wd.state.lastTickAt = h.now();
  h.advance(250 + 3000);
  assert.doesNotThrow(() => h.wd.tick());
});

await check('main.stall is a PRIORITY log kind, so a noisy minute cannot drop the one line that matters', async () => {
  assert.equal(isPriorityKind('main.stall'), true);
  assert.equal(isPriorityKind('main.stall-watchdog'), true);
  assert.equal(isPriorityKind('main.error'), false);
});

await check('an 8-hour gap (the Mac slept) is a clock jump, NOT a stall, and burns no report budget', async () => {
  const h = harness();
  h.wd.state.lastTickAt = h.now();
  h.advance(250 + 8 * 3600 * 1000); h.wd.tick();
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].kind, 'main.stall-watchdog');
  assert.match(h.logs[0].detail, /clock jumped 28800s \(sleep or suspend\); baseline reset, not a stall/);
  // The very next real stall must still be reported in full.
  h.advance(250 + 3000); h.wd.tick();
  assert.equal(h.logs.length, 2);
  assert.equal(h.logs[1].kind, 'main.stall');
  assert.match(h.logs[1].detail, /blocked ~3\.0s/);
});

await check('resume resets the baseline so the first tick after wake is not a stall', async () => {
  const h = harness();
  h.wd.state.lastTickAt = h.now();
  h.advance(3 * 3600 * 1000);
  h.wd.resetBaseline();
  h.advance(250); h.wd.tick();
  assert.equal(h.logs.length, 0);
});

await check('start() subscribes to powerMonitor resume/suspend when given one', async () => {
  const h = harness();
  const subs = [];
  h.wd.start({ powerMonitor: { on: (ev, _fn) => subs.push(ev) } });
  assert.deepEqual(subs.sort(), ['resume', 'suspend']);
  h.wd.stop();
});

await check('ipcMain.off(ch, fn) still removes a listener registered through the wrapped .on', async () => {
  const { EventEmitter } = await import('node:events');
  const em = new EventEmitter();
  em.handle = () => {}; // shape only; not used here
  const wd = createStallWatchdog({ now: () => 0, memory: fakeMem });
  wd.wrapIpc(em);
  let calls = 0; const fn = () => { calls += 1; };
  em.on('x', fn); em.emit('x'); em.off('x', fn); em.emit('x');
  assert.equal(calls, 1);
  assert.equal(em.listenerCount('x'), 0);
});

await check('ipcMain.once(ch, fn) fires exactly once through the wrapped .on', async () => {
  const { EventEmitter } = await import('node:events');
  const em = new EventEmitter();
  em.handle = () => {};
  const wd = createStallWatchdog({ now: () => 0, memory: fakeMem });
  wd.wrapIpc(em);
  let calls = 0;
  em.once('y', () => { calls += 1; });
  em.emit('y'); em.emit('y'); em.emit('y');
  assert.equal(calls, 1);
  assert.equal(em.listenerCount('y'), 0, 'the once wrapper must detach after firing');
});

await check('a wrapped .on listener keeps `this` bound to the emitter', async () => {
  const { EventEmitter } = await import('node:events');
  const em = new EventEmitter();
  em.handle = () => {};
  createStallWatchdog({ now: () => 0, memory: fakeMem }).wrapIpc(em);
  let seen = null;
  em.on('z', function () { seen = this; });
  em.emit('z');
  assert.equal(seen, em);
});

await check('a 60s nap where the tick beats the async resume event is a clock jump, and the real stall after it is reported', async () => {
  const h = harness();
  h.wd.state.lastTickAt = h.now();
  h.wd.onSuspend();                       // macOS always sends suspend before sleeping
  h.advance(60_000); h.wd.tick();         // wakes; resume has NOT arrived yet
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].kind, 'main.stall-watchdog');
  h.wd.onResume();
  h.advance(250 + 3000); h.wd.tick();     // a real stall right after wake
  assert.equal(h.logs[1].kind, 'main.stall');
  assert.match(h.logs[1].detail, /blocked ~3\.0s/);
});

await check('the same listener on two channels: off() on one leaves the other attached', async () => {
  const { EventEmitter } = await import('node:events');
  const em = new EventEmitter(); em.handle = () => {};
  createStallWatchdog({ now: () => 0, memory: fakeMem }).wrapIpc(em);
  let calls = 0; const fn = () => { calls += 1; };
  em.on('a', fn); em.on('b', fn);
  em.off('a', fn);
  em.emit('a'); em.emit('b');
  assert.equal(calls, 1);
  assert.equal(em.listenerCount('a'), 0);
  assert.equal(em.listenerCount('b'), 1);
});

await check('a listener registered twice on one channel needs two off() calls, newest removed first', async () => {
  const { EventEmitter } = await import('node:events');
  const em = new EventEmitter(); em.handle = () => {};
  createStallWatchdog({ now: () => 0, memory: fakeMem }).wrapIpc(em);
  let calls = 0; const fn = () => { calls += 1; };
  em.on('a', fn); em.on('a', fn);
  em.off('a', fn); em.emit('a');
  assert.equal(calls, 1);
  em.off('a', fn); em.emit('a');
  assert.equal(calls, 1);
  assert.equal(em.listenerCount('a'), 0);
});

await check('a pending once() can be cancelled with its ORIGINAL function', async () => {
  const { EventEmitter } = await import('node:events');
  const em = new EventEmitter(); em.handle = () => {};
  createStallWatchdog({ now: () => 0, memory: fakeMem }).wrapIpc(em);
  let calls = 0; const fn = () => { calls += 1; };
  em.once('a', fn); em.off('a', fn); em.emit('a');
  assert.equal(calls, 0);
  assert.equal(em.listenerCount('a'), 0);
});

await check('stop() removes the power listeners it added, so start/stop cycles do not accumulate', async () => {
  const { EventEmitter } = await import('node:events');
  const pm = new EventEmitter();
  const h = harness();
  for (let i = 0; i < 3; i += 1) { h.wd.start({ powerMonitor: pm }); h.wd.stop(); }
  assert.equal(pm.listenerCount('suspend'), 0);
  assert.equal(pm.listenerCount('resume'), 0);
});

await check('the default clock is monotonic, not the wall clock', async () => {
  const a = monotonicNow(); const b = monotonicNow(); const c = monotonicNow();
  assert.ok(a <= b && b <= c);
  assert.ok(c < 1e11, 'performance.now() is ms since process start, not an epoch timestamp');
  assert.equal(createStallWatchdog().opts.thresholdMs, 2000);
});

await check('a backward clock step after a report does not suppress the next real stall', async () => {
  const h = harness();
  h.wd.state.lastTickAt = h.now();
  h.advance(250 + 3000); h.wd.tick();            // real stall, reported
  assert.equal(h.logs.length, 1);
  h.advance(-120_000); h.wd.tick();              // clock corrected 2 minutes backwards
  assert.equal(h.logs[1].kind, 'main.stall-watchdog');
  assert.match(h.logs[1].detail, /clock stepped back 120s/);
  h.advance(63_500); h.wd.state.lastTickAt = h.now();
  h.advance(250 + 3000); h.wd.tick();            // a real stall 63.5s later
  assert.equal(h.logs[2].kind, 'main.stall', 'must not be parked behind a future lastReportAt');
});

await check('evaluateTick with no IPC history still produces a complete report', async () => {
  const st = { lastTickAt: 0, lastReportAt: -Infinity, suppressed: 0, inflight: new Map(), lastEntered: null, seq: 0 };
  const r = evaluateTick(st, { intervalMs: 250, thresholdMs: 2000, minReportGapMs: 30000, maxPlausibleStallMs: 600000 }, 10_000, fakeMem);
  assert.match(r.report, /last IPC entered: none yet \| in flight at recovery: none/);
});

console.log(`\nALL PASS  (${pass} passed)`);
