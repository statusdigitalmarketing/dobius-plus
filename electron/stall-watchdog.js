// Main-thread stall watchdog (v1.0.70).
//
// Sam hit macOS's "You can't open the application because it is not
// responding" on 2026-09-14 10:03. The process survived, and nothing recorded
// it: no crash report, no hang report, nothing in the unified log, nothing in
// error.log. Every theory about the cause was unfalsifiable because there was
// no evidence of what the main thread was doing when it stopped answering.
//
// This gives the NEXT stall a record. It is a drift check, not a profiler: a
// short timer runs on the main event loop, and when a tick arrives far later
// than it should have, the loop was blocked for about that long. A blocked
// loop cannot observe itself mid-stall, so the report is written the moment
// it recovers, and it carries the thing that matters most for attribution:
// which IPC handlers were IN FLIGHT when the stall began, and which one was
// entered last. In this app nearly all main-thread work starts from an IPC
// call, so that names the suspect nine times out of ten. Heap and RSS come
// along so an allocation spike is visible too.
//
// Cost: one unref'd 250ms timer and a Map write per IPC call. Nothing here
// can throw into app code: the wrapper re-throws the handler's own errors
// unchanged and swallows only its own bookkeeping.

import { performance } from 'node:perf_hooks';

const MB = (n) => (n / 1048576).toFixed(0);

// Monotonic, never wall-clock. Date.now() moves when NTP or the user corrects
// the clock: a backward step parked lastReportAt in the future and suppressed
// real stalls for the size of the correction, and a forward step read as a
// 60s "stall" with nothing blocked (Codex P2). performance.now() only ever
// goes forward.
export const monotonicNow = () => performance.now();

/**
 * Pure: decide whether a tick's lag is a stall worth reporting.
 * @returns {{ report: string } | null}
 */
export function evaluateTick(state, opts, now, memory) {
  const expectedAt = state.lastTickAt + opts.intervalMs;
  const lagMs = now - expectedAt;
  state.lastTickAt = now;
  // Belt and braces for an injected or misbehaving clock: time going backwards
  // is never a stall, and must not leave the report budget in the future.
  if (lagMs < -opts.intervalMs) {
    if (state.lastReportAt > now) state.lastReportAt = now - opts.minReportGapMs;
    return { clockJump: true, lagMs, report: `clock stepped back ${((-lagMs) / 1000).toFixed(0)}s; baseline reset, not a stall` };
  }
  if (lagMs < opts.thresholdMs) return null;
  // A gap far beyond any plausible block is the Mac sleeping (or a resume the
  // powerMonitor hook did not see). Reporting it as a 28,800s stall was wrong
  // twice over: it was false, and it consumed the report budget, so a REAL
  // 3s stall right after wake went unrecorded (Codex P2). Note it under the
  // watchdog's own kind, reset the baseline, and leave the budget untouched.
  // A tick that runs while the machine is (or was, until the async 'resume'
  // lands) suspended measured a nap, not a block. Chromium delivers power
  // notifications asynchronously, so the first tick after wake can beat the
  // resume event; the suspend event, however, always precedes the sleep, so
  // the flag is reliable where the event ordering is not (Codex P2).
  if (state.suspended || lagMs > opts.maxPlausibleStallMs) {
    return { clockJump: true, lagMs, report: `clock jumped ${(lagMs / 1000).toFixed(0)}s (sleep or suspend); baseline reset, not a stall` };
  }
  if (now - state.lastReportAt < opts.minReportGapMs) {
    state.suppressed += 1;
    return null;
  }
  state.lastReportAt = now;
  const stallStart = expectedAt; // the loop stopped answering around here
  const inflight = [...state.inflight.values()]
    .map((c) => `${c.channel} (${now - c.startedAt}ms, entered ${c.startedAt <= stallStart ? 'before' : 'during'} the stall)`)
    .join('; ') || 'none';
  const last = state.lastEntered
    ? `${state.lastEntered.channel} (${now - state.lastEntered.at}ms ago${state.inflight.has(state.lastEntered.key) ? ', still in flight' : ', finished'})`
    : 'none yet';
  const mem = memory();
  const suppressedNote = state.suppressed ? ` | ${state.suppressed} earlier stall(s) went unreported inside the ${opts.minReportGapMs / 1000}s gap` : '';
  state.suppressed = 0;
  const report = [
    `event loop blocked ~${(lagMs / 1000).toFixed(1)}s`,
    `last IPC entered: ${last}`,
    `in flight at recovery: ${inflight}`,
    `heap ${MB(mem.heapUsed)}/${MB(mem.heapTotal)}MB rss ${MB(mem.rss)}MB`,
    `uptime ${(process.uptime() / 3600).toFixed(1)}h`,
  ].join(' | ') + suppressedNote;
  return { report, lagMs };
}

export function createStallWatchdog({
  thresholdMs = 2000,
  intervalMs = 250,
  minReportGapMs = 30_000,
  maxPlausibleStallMs = 10 * 60_000,
  log = () => {},
  now = monotonicNow,
  memory = () => process.memoryUsage(),
} = {}) {
  const opts = { thresholdMs, intervalMs, minReportGapMs, maxPlausibleStallMs };
  const state = {
    lastTickAt: 0,
    lastReportAt: -Infinity,
    suspended: false,
    suppressed: 0,
    inflight: new Map(), // key -> { channel, startedAt }
    lastEntered: null,   // { channel, at, key }
    seq: 0,
  };
  let timer = null;

  function enter(channel) {
    const key = ++state.seq;
    const at = now();
    state.inflight.set(key, { channel, startedAt: at });
    state.lastEntered = { channel, at, key };
    return key;
  }
  function exit(key) { state.inflight.delete(key); }

  /**
   * Wrap ipcMain.handle / ipcMain.on so every invocation is tracked. Must run
   * BEFORE any handler registers; in main.js every registration happens inside
   * functions called after app.whenReady, so wrapping at import time is safe.
   */
  function wrapIpc(ipcMain) {
    if (!ipcMain || ipcMain.__stallWatchdogWrapped) return false;
    const origHandle = ipcMain.handle.bind(ipcMain);
    const origOn = ipcMain.on.bind(ipcMain);
    ipcMain.handle = (channel, fn) => origHandle(channel, async (...args) => {
      const key = enter(channel);
      try { return await fn(...args); } finally { exit(key); }
    });
    // Removal must still pair with the ORIGINAL listener, per channel, newest
    // registration first, exactly as EventEmitter does. Each wrapper carries
    // `.listener` (the function .on received; for once() that is Node's own
    // once-wrapper, which in turn carries the user's function), so removal
    // walks that chain. A WeakMap keyed by function alone got this wrong for
    // the same listener on two channels, for a duplicate registration, and for
    // cancelling a pending once() by its original function (Codex P3 x3).
    ipcMain.on = (channel, fn) => {
      const w = function (...args) {
        const key = enter(channel);
        try { return fn.apply(this, args); } finally { exit(key); }
      };
      w.listener = fn;
      return origOn(channel, w);
    };
    for (const name of ['off', 'removeListener']) {
      const orig = typeof ipcMain[name] === 'function' ? ipcMain[name].bind(ipcMain) : null;
      if (!orig) continue;
      ipcMain[name] = (channel, x) => {
        const list = typeof ipcMain.rawListeners === 'function' ? ipcMain.rawListeners(channel) : [];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const w = list[i];
          if (w === x || w.listener === x || w.listener?.listener === x) return orig(channel, w);
        }
        return orig(channel, x);
      };
    }
    ipcMain.__stallWatchdogWrapped = true;
    return true;
  }

  function tick() {
    let result = null;
    try { result = evaluateTick(state, opts, now(), memory); } catch { /* bookkeeping only */ }
    if (result) {
      try { log(result.clockJump ? 'main.stall-watchdog' : 'main.stall', result.report); } catch { /* never throw */ }
    }
  }

  // Sleep/wake: the baseline is reset on resume so the first tick after wake
  // measures the wake, not the nap. Any emitter with on('resume') works; in
  // main.js it is electron's powerMonitor, which only exists after app ready.
  function resetBaseline() { state.lastTickAt = now(); }
  function onSuspend() { state.suspended = true; resetBaseline(); }
  function onResume() { state.suspended = false; resetBaseline(); }
  let power = null; // { monitor } while subscribed, so stop() can unsubscribe

  function start({ powerMonitor = null } = {}) {
    if (timer) return;
    state.lastTickAt = now();
    timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref(); // never keeps the app alive
    if (powerMonitor && typeof powerMonitor.on === 'function') {
      try {
        powerMonitor.on('suspend', onSuspend);
        powerMonitor.on('resume', onResume);
        power = { monitor: powerMonitor };
      } catch { /* optional */ }
    }
    try { log('main.stall-watchdog', `armed: reporting main-thread stalls over ${thresholdMs}ms`); } catch { /* never throw */ }
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    // Symmetric with start(): a start/stop cycle must not leave power
    // listeners behind on a long-lived emitter (Codex P3).
    if (power) {
      const m = power.monitor; power = null;
      const off = typeof m.off === 'function' ? 'off' : (typeof m.removeListener === 'function' ? 'removeListener' : null);
      if (off) { try { m[off]('suspend', onSuspend); m[off]('resume', onResume); } catch { /* optional */ } }
    }
  }

  return { wrapIpc, start, stop, tick, resetBaseline, onSuspend, onResume, state, opts };
}
