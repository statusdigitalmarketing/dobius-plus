// A Dobius window whose page process died, or whose page failed to load, stays blank: its tabs' shells keep running in
// main, but nothing draws them (Brett, 2026-11-16: three blank windows, fixed then by quitting and reopening). This
// reloads that window instead, the same as View > Reload: its tabs come back from the saved list and their Claude
// sessions resume under the launch rules. Only that window is touched.
//
// A GPU process that dies takes every window's drawing with it until Chromium starts a new one; that gets a repaint of
// every window (cheap, nothing is reloaded), never a reload, so running work is not interrupted on a guess.
//
// Bounded: at most MAX_RECOVERIES reloads per window in RECOVERY_WINDOW_MS. Past that the page is dying on load, so it
// stops, logs window.recovery-stopped (reported) and leaves the window for the person to close.

export const MAX_RECOVERIES = 3;
export const RECOVERY_WINDOW_MS = 10 * 60_000;
export const RECOVERY_DELAY_MS = 1000;
const ERR_ABORTED = -3; // a navigation replaced by another one: not a failure

/** Pure: may this window be reloaded now? `times` is its recent reload times, oldest first (trimmed and appended). */
export function allowRecovery(times, now, { max = MAX_RECOVERIES, windowMs = RECOVERY_WINDOW_MS } = {}) {
  while (times.length && now - times[0] >= windowMs) times.shift();
  if (times.length >= max) return false;
  times.push(now);
  return true;
}

/** Pure: does this render-process-gone call for a reload? A clean exit is a window closing, not a crash. */
export function renderGoneNeedsReload(details) {
  return String(details?.reason || '') !== 'clean-exit';
}

/** Pure: does this did-fail-load call for a reload? Only the window's own page, and not a replaced navigation. */
export function loadFailNeedsReload(errorCode, isMainFrame) {
  return isMainFrame === true && Number(errorCode) !== ERR_ABORTED;
}

/** Pure: does this child-process-gone call for a repaint of every window? */
export function gpuGoneNeedsRepaint(details) {
  return details?.type === 'GPU' && String(details?.reason || '') !== 'clean-exit';
}

/**
 * Wire it up. `app` is Electron's app; `isQuitting()` is true while the app is shutting down (nothing is recovered
 * then); `log(kind, detail)` writes error.log; `allWindows()` lists the open BrowserWindows.
 */
export function installWindowRecovery({ app, isQuitting, log, allWindows, delayMs = RECOVERY_DELAY_MS, now = Date.now }) {
  const history = new WeakMap(); // webContents -> reload times (dropped with the webContents)
  const pending = new WeakSet(); // webContents with a reload already scheduled (two events for one death reload once)

  const recover = (wc, why) => {
    if (pending.has(wc)) return;
    let times = history.get(wc);
    if (!times) { times = []; history.set(wc, times); }
    if (!allowRecovery(times, now())) {
      log('window.recovery-stopped', `${why}: ${MAX_RECOVERIES} reloads in ${RECOVERY_WINDOW_MS / 60_000} min, leaving it`);
      return;
    }
    pending.add(wc);
    setTimeout(() => {
      pending.delete(wc);
      if (isQuitting() || wc.isDestroyed()) return;
      log('diag.window-recovery', `reloading a window after ${why}`);
      try { wc.reload(); } catch (err) { log('window.recovery-failed', `${why}: ${err?.message || err}`); }
    }, delayMs);
  };

  app.on('web-contents-created', (_e, wc) => {
    let type = '';
    try { type = wc.getType?.() || ''; } catch { type = ''; }
    if (type !== 'window') return; // a <webview> pane is a third-party page, never reloaded by us
    wc.on('render-process-gone', (_ev, details) => {
      if (isQuitting() || !renderGoneNeedsReload(details)) return;
      recover(wc, `page process gone (${String(details?.reason || 'unknown').slice(0, 40)})`);
    });
    wc.on('did-fail-load', (_ev, errorCode, _desc, _url, isMainFrame) => {
      if (isQuitting() || !loadFailNeedsReload(errorCode, isMainFrame)) return;
      recover(wc, `page failed to load (${Number(errorCode) || 'unknown'})`);
    });
  });

  let repaintTimer = null;
  app.on('child-process-gone', (_e, details) => {
    if (isQuitting() || !gpuGoneNeedsRepaint(details) || repaintTimer) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      if (isQuitting()) return;
      let n = 0;
      for (const win of allWindows()) {
        try {
          if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
          win.webContents.invalidate();
          n += 1;
        } catch (err) { log('main.warn', `[window-recovery] repaint: ${err?.message || err}`); }
      }
      log('diag.window-recovery', `GPU process gone (${String(details?.reason || 'unknown').slice(0, 40)}), repainted ${n} window(s)`);
    }, delayMs);
  });
}
