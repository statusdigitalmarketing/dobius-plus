// Mobile server auto-start that keeps trying (v1.0.77).
//
// Before this, launch called startMobileServer() exactly once. When Tailscale
// had not handed the Mac its 100.x address yet (login items after a reboot,
// a tailnet reconnect, an update restart) the start answered "No Tailscale
// connection found" and nothing ever tried again, so the phone was dead until
// Sam opened Settings and flipped the switch. Asana: "make sure the mobile
// server ALWAYS DEFAULTS TO ON".
//
// This loop retries every 5s for the first two minutes (the boot case), then
// every 30s for as long as the app runs, and stops the moment the server is
// up, the user turns the server off in Settings, or the app shuts down. The
// timer is unref'd so it can never keep the process alive. Pure: timers,
// clock and the start function are injected so the behaviour is unit-tested
// without Electron or a network interface.

import { WebSocketServer } from 'ws';

export const FAST_RETRY_MS = 5_000;
export const FAST_WINDOW_MS = 120_000;
export const SLOW_RETRY_MS = 30_000;

export function createAutoStart({
  start,
  enabled,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
}) {
  let timer = null;
  let cancelled = false;
  let startedAt = null;
  let attempts = 0;
  let warned = false;

  const schedule = (ms) => {
    timer = setTimer(tick, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  async function tick() {
    timer = null;
    if (cancelled) return null;
    if (!enabled()) {
      log('info', 'auto-start stopped: mobile server is off in Settings');
      return null;
    }
    attempts += 1;
    let status;
    try {
      status = await start();
    } catch (e) {
      status = { running: false, error: String(e?.message || e) };
    }
    if (cancelled) return status;
    if (status?.running) {
      if (attempts > 1) log('info', `mobile server up after ${attempts} attempts`);
      return status;
    }
    if (!warned) {
      warned = true;
      log('warn', `mobile server not up (${status?.error || 'unknown error'}); retrying until it is`);
    }
    schedule(now() - startedAt < FAST_WINDOW_MS ? FAST_RETRY_MS : SLOW_RETRY_MS);
    return status;
  }

  return {
    /**
     * First attempt now; resolves with its status (later retries run on the
     * timer). A second call does nothing and resolves null.
     */
    run() {
      if (startedAt !== null) return Promise.resolve(null);
      startedAt = now();
      return tick();
    },
    cancel() {
      cancelled = true;
      if (timer) { clearTimer(timer); timer = null; }
    },
    get attempts() { return attempts; },
    get pending() { return timer !== null; },
  };
}

/**
 * Start gate: one in-flight start at a time, and a stop that lands while a
 * start is still preparing (awaiting MagicDNS, reading a cert) makes that
 * start throw itself away instead of bringing up a server nobody asked for.
 *
 * run(fn) shares the in-flight promise between the launch retry and the
 * Settings switch, so two callers can never build two servers on one port.
 * fn receives stillCurrent(): true until the next bump(). stop() bumps.
 */
export function createStartGate() {
  let inFlight = null;
  let life = 0;
  return {
    bump() { life += 1; },
    get inFlight() { return inFlight !== null; },
    run(fn) {
      if (inFlight) return inFlight;
      const mine = life;
      inFlight = Promise.resolve()
        .then(() => fn(() => mine === life))
        .finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}

/**
 * listen() that always settles. 'listening' resolves { ok: true }, 'error'
 * resolves { ok: false, error }, and a close() that lands before either (a
 * stop between listen() and its callback) resolves { ok: false, error:
 * 'closed before listening' }. Node emits only 'close' in that last case, so
 * a promise built on the listen callback alone never settles, which held the
 * start gate open forever and left the Settings switch stuck busy.
 */
export function listenSettled(server, port, host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      server.removeListener('error', onError);
      server.removeListener('close', onClose);
      server.removeListener('listening', onListening);
      resolve(r);
    };
    const onError = (err) => finish({ ok: false, error: String(err?.message || err) });
    const onClose = () => finish({ ok: false, error: 'closed before listening' });
    const onListening = () => finish({ ok: true });
    server.once('error', onError);
    server.once('close', onClose);
    server.once('listening', onListening);
    try { server.listen(port, host); } catch (e) { onError(e); }
  });
}

/**
 * A WebSocketServer riding on an HTTP server that may still fail to bind.
 * ws re-emits the HTTP server's 'error' on the WebSocketServer, and an
 * 'error' with no listener THROWS out of that emit, before the HTTP server's
 * own 'error' listener ever runs: a busy port 8420 was an uncaught exception
 * that exited the app, not a failed start. The HTTP listener (listenSettled)
 * owns the failure; this listener only has to exist.
 */
export function attachWebSocketServer(httpServer, options) {
  const wss = new WebSocketServer({ server: httpServer, ...options });
  wss.on('error', () => {});
  return wss;
}

