// A Dobius window whose page process died, or whose page failed to load, stays blank: its tabs' shells keep running in
// main, but nothing draws them (Brett, 2026-11-16: three blank windows, fixed then by quitting and reopening). This
// reloads that window instead, the same as View > Reload: its tabs come back from the saved list and their Claude
// sessions resume under the launch rules. Only that window is touched.
//
// A GPU process that dies takes every window's drawing with it until Chromium starts a new one; that gets a repaint of
// every window (cheap, nothing is reloaded), never a reload, so running work is not interrupted on a guess.
//
// Bounded: windows reload one at a time, RECOVERY_GAP_MS apart; at most MAX_RECOVERIES reloads per window and
// MAX_TOTAL_RECOVERIES across all windows in RECOVERY_WINDOW_MS. Past that it stops, logs window.recovery-stopped
// (reported) and leaves the windows for the person to close or quit.

export const MAX_RECOVERIES = 3;
export const RECOVERY_WINDOW_MS = 10 * 60_000;
export const RECOVERY_DELAY_MS = 1000;
export const RECOVERY_GAP_MS = 5000; // between two windows' reloads, app-wide
export const MAX_TOTAL_RECOVERIES = 6; // reloads across all windows per RECOVERY_WINDOW_MS
const MAX_QUEUED = 64; // windows waiting to reload (there is never more than one entry per window)
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
 * Pure: the address to reload a window at. A torn-off window opened by a drag claims its one live tab; reloaded like
 * that it would show only that tab and overwrite its saved set. With tearOffRestore=1 it loads its saved tab set, the
 * way it comes back after a relaunch (Codex P1, PR 27). Anything else reloads as is (null).
 */
export function recoveryUrl(current) {
  let u;
  try { u = new URL(String(current || '')); } catch { return null; }
  if (!u.searchParams.has('tearOffTab') || u.searchParams.get('tearOffRestore') === '1') return null;
  u.searchParams.set('tearOffRestore', '1');
  return u.href;
}

/**
 * Wire it up. `app` is Electron's app; `isQuitting()` is true while the app is shutting down (nothing is recovered
 * then); `log(kind, detail)` writes error.log; `allWindows()` lists the open BrowserWindows.
 */
export function installWindowRecovery({ app, isQuitting, log, allWindows, delayMs = RECOVERY_DELAY_MS, gapMs = RECOVERY_GAP_MS, now = Date.now }) {
  const history = new WeakMap(); // webContents -> reload times (dropped with the webContents)
  const pending = new WeakSet(); // webContents waiting in the queue (two events for one death reload once)
  const queue = []; // [{ wc, why }], one entry per window at most, capped at MAX_QUEUED
  const total = []; // every reload's time, app-wide
  const navs = new WeakMap(); // webContents -> main-frame navigations started (a newer one supersedes a queued reload)
  let timer = null;
  let lastReloadAt = -Infinity; // the gap is kept from the last reload that ran, even when the queue emptied between

  // One reload at a time, RECOVERY_GAP_MS apart: when memory pressure kills many windows at once they come back one by
  // one, not all in the same millisecond (each reload respawns its window's shells). App-wide cap on top of the
  // per-window one, so a pressure storm cannot keep reloading forever (Codex P1, PR 27).
  const drain = () => {
    timer = null;
    const item = queue.shift();
    if (!item) return;
    const { wc, why } = item;
    pending.delete(wc);
    // The window moved on since the failure (a reload or navigation started, and the page is not dead): leave it, or
    // the reload would kill the shells the new page just started (Codex P1, PR 27).
    const superseded = !wc.isDestroyed() && (navs.get(wc) || 0) !== item.nav && !wc.isCrashed?.();
    if (superseded) log('diag.window-recovery', `skipped: the window loaded again after ${why}`);
    if (!superseded && !isQuitting() && !wc.isDestroyed()) {
      let times = history.get(wc);
      if (!times) { times = []; history.set(wc, times); }
      if (!allowRecovery(total, now(), { max: MAX_TOTAL_RECOVERIES })) {
        log('window.recovery-stopped', `${why}: ${MAX_TOTAL_RECOVERIES} reloads app-wide in ${RECOVERY_WINDOW_MS / 60_000} min, leaving ${queue.length + 1} window(s)`);
        for (const q of queue) pending.delete(q.wc);
        queue.length = 0;
        return;
      }
      if (!allowRecovery(times, now())) {
        total.pop(); // this one did not run
        log('window.recovery-stopped', `${why}: ${MAX_RECOVERIES} reloads in ${RECOVERY_WINDOW_MS / 60_000} min, leaving it`);
      } else {
        log('diag.window-recovery', `reloading a window after ${why}`);
        lastReloadAt = now();
        try {
          const url = recoveryUrl(wc.getURL?.());
          if (url) wc.loadURL(url); else wc.reload();
        } catch (err) { log('window.recovery-failed', `${why}: ${err?.message || err}`); }
      }
    }
    if (queue.length) timer = setTimeout(drain, gapMs);
  };

  const recover = (wc, why) => {
    if (pending.has(wc) || queue.length >= MAX_QUEUED) return;
    pending.add(wc);
    queue.push({ wc, why, nav: navs.get(wc) || 0 });
    if (!timer) timer = setTimeout(drain, Math.max(delayMs, lastReloadAt + gapMs - now()));
  };

  app.on('web-contents-created', (_e, wc) => {
    let type = '';
    try { type = wc.getType?.() || ''; } catch { type = ''; }
    if (type !== 'window') return; // a <webview> pane is a third-party page, never reloaded by us
    wc.on('did-start-navigation', (...args) => {
      // (event, url, isInPlace, isMainFrame) in Electron 33; also an event object with those fields in newer versions.
      const d = args[0] && typeof args[0] === 'object' && 'isMainFrame' in args[0] ? args[0] : { isSameDocument: args[2], isMainFrame: args[3] };
      if (d.isMainFrame && !(d.isSameDocument ?? d.isInPlace)) navs.set(wc, (navs.get(wc) || 0) + 1);
    });
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
