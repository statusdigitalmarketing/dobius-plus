import electronUpdater from 'electron-updater';
import { app, BrowserWindow, Notification, ipcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setQuittingForUpdate } from './quit-state.js';
import { drainConfigWrites, backupConfigForUpdate } from './config-manager.js';
import { mapRelease } from './release-info.js';

const { autoUpdater } = electronUpdater;

// electron-updater's cache on macOS (this app is mac-only). A wedged cache is
// the failure mode that stranded Sam on 1.0.48 for 5 releases: a stale pending
// zip made every differential download fail, silently, every 4 hours, forever.
const UPDATER_CACHE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'dobius-plus-updater');

// Purge the updater cache after a download error so the NEXT periodic check
// starts clean instead of re-wedging against the same stale state. Rate-limited
// to once per 10 minutes so an offline burst doesn't thrash the disk.
let lastCachePurgeAt = 0;
function purgeUpdaterCache() {
  const now = Date.now();
  if (now - lastCachePurgeAt < 10 * 60 * 1000) return;
  lastCachePurgeAt = now;
  try {
    fs.rmSync(UPDATER_CACHE_DIR, { recursive: true, force: true });
    console.log('[updater] purged wedged updater cache');
  } catch (err) {
    console.warn('[updater] cache purge failed:', err.message);
  }
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const QUIT_INSTALL_FLUSH_TIMEOUT_MS = 2500;
let pendingUpdate = null;
let lastStatus = { state: 'idle' };
// Tracks the last "ready" version we already notified for, so the same
// downloaded ZIP doesn't re-fire on every periodic check.
let lastReadyNotifiedVersion = null;

function broadcast(channel, payload) {
  if (channel === 'updater:status') lastStatus = payload;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// Numeric compare on dotted version strings ("1.0.29" > "1.0.28").
// Returns true iff `nextVer` is strictly newer than `curVer`. Avoids pulling
// in semver as a direct dep; covers every Dobius+ version shape so far.
function isStrictlyNewer(nextVer, curVer) {
  if (!nextVer || !curVer) return false;
  const a = String(nextVer).split('-')[0].split('.').map((n) => parseInt(n, 10));
  const b = String(curVer).split('-')[0].split('.').map((n) => parseInt(n, 10));
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = Number.isFinite(b[i]) ? b[i] : 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false; // equal
}

// Must match electron-builder.yml publish.owner/repo: the same release feed the
// updater itself reads.
const GITHUB_REPO = 'statusdigitalmarketing/dobius-plus';

// GitHub's unauthenticated API is 60 requests/hour per IP. The Updates tab
// refreshes on mount and on every manual check, and Sam runs a lot of windows,
// so without this a busy session can rate-limit itself into the very "couldn't
// reach GitHub" error this code exists to fix.
const RELEASE_TTL_MS = 60_000;
// `at` is when the value was STORED (drives the TTL). `startedAt` is when the
// request that produced it BEGAN (drives ordering). They are different clocks
// for different jobs: comparing a new request's start against the stored
// completion time let a later, fresher request lose to an earlier one that
// simply finished first (Codex P2).
let releaseCache = { at: 0, startedAt: 0, release: null };
// Concurrent windows share one request. Without this two windows race, and the
// SLOWER response wins the cache, so a newly published release can be
// overwritten by the older one the other window was already fetching, leaving a
// third window told it is on the latest version when it is not (Codex P2).
let inFlight = null;

/**
 * The RENDERER cannot do this itself. index.html sets
 * `connect-src 'self' http://localhost:5173 ws://localhost:5173`, so a renderer
 * fetch to api.github.com is blocked by CSP and fails with "Failed to fetch"
 * every single time. That is what the Updates tab was reporting as "Couldn't
 * reach GitHub", while the updater kept working fine and downloading releases,
 * because it runs HERE and CSP does not apply to the main process.
 */
async function fetchLatestRelease({ force = false } = {}) {
  if (!force && releaseCache.release && Date.now() - releaseCache.at < RELEASE_TTL_MS) {
    return releaseCache.release;
  }
  // A manual "Check for updates" is an explicit request for a fresh answer, so
  // it skips both the TTL and the shared request. Serving it the cache let the
  // updater download a release the panel still called "latest" (Codex P2).
  if (!force && inFlight) return inFlight;

  const startedAt = Date.now();
  const request = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: {
          // GitHub asks API clients to identify themselves. Node's fetch does
          // send a default agent, so this is not load-bearing; it just makes
          // the caller legible in GitHub's logs and rate-limit accounting.
          'User-Agent': `dobius-plus/${app.getVersion()}`,
          Accept: 'application/vnd.github+json',
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
      const release = mapRelease(await res.json());
      // The request that STARTED last wins, whatever order the responses land
      // in. A failed fetch throws before here and so never clears a good value.
      if (startedAt >= releaseCache.startedAt) releaseCache = { at: Date.now(), startedAt, release };
      return release;
    } finally {
      clearTimeout(timer);
    }
  })();

  if (!force) inFlight = request;
  try {
    return await request;
  } finally {
    if (inFlight === request) inFlight = null;
  }
}

async function safeCheck() {
  broadcast('updater:status', { state: 'checking' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    broadcast('updater:status', { state: 'error', message: String(err?.message || err) });
  }
}

// Centralized install routine. Sets the bypass flag (main.js's before-quit
// gate checks it), drains pending config writes with a hard timeout so a
// stuck flush can't strand the quit, then calls quitAndInstall(true, true).
// The (isSilent=true, isForceRunAfter=true) args are critical:
//   - isSilent=true: skip the macOS installer's confirm prompt
//   - isForceRunAfter=true: actually relaunch the new build after install
// The default (false, false) on macOS means "install but do NOT relaunch",
// which is the second half of the bug Sam reported: even when the quit
// worked, his app stayed dead.
async function performInstall() {
  if (!app.isPackaged) {
    broadcast('updater:status', { state: 'error', message: 'Updates only run in packaged builds.' });
    return false;
  }
  if (!pendingUpdate) {
    broadcast('updater:status', { state: 'error', message: 'No update is pending.' });
    return false;
  }
  // Belt-and-suspenders: snapshot config.json before the bundle is replaced, so
  // a bad future build that somehow wiped accounts/auth on first launch is
  // instantly recoverable from config.json.pre-update-<version>.bak. The update
  // never touches userData, so this is insurance, not a fix.
  try { backupConfigForUpdate(pendingUpdate.version); } catch { /* best effort */ }
  // Ask every window's terminals to flush scrollback NOW. The update quit
  // bypasses the graceful 3-phase Cmd+Q save, so without this the restored
  // buffers were up to 60s stale (the autosave cadence). The session-tab links
  // that drive `claude --resume` on relaunch are captured continuously (15s),
  // and Claude's own transcript is the source of truth for the conversation,
  // so this only affects the restored VISUAL scrollback. v1.0.54 (Sam's
  // "seamless restart" question).
  broadcast('terminal:requestSave');
  // Scale the wait with how much there is to save. A flat 600ms was tuned on a
  // single window; with several windows of tabs the save IPCs had not landed
  // before the quit, so the restored scrollback was stale (Sam: "I have a
  // bunch of windows open when I click restart"). Bounded so a wedged renderer
  // cannot stall the install.
  const windowCount = Math.max(1, BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
  await new Promise((resolve) => setTimeout(resolve, Math.min(600 + 200 * windowCount, 3000)));
  try {
    await Promise.race([
      drainConfigWrites(), // v1.0.33: non-latching, so if quitAndInstall throws we can still persist
      new Promise((resolve) => setTimeout(resolve, QUIT_INSTALL_FLUSH_TIMEOUT_MS)),
    ]);
  } catch { /* best effort */ }
  // A late throw from a native callback during teardown is what turned a
  // successful install into "Dobius+ quit unexpectedly". That is handled in
  // ONE place: setupCrashLogging's uncaughtException handler logs and returns
  // instead of process.exit(1) while getQuittingForUpdate() is true. Adding a
  // second listener here would never run anyway, because the crash logger is
  // registered first and exits (Codex High). setQuittingForUpdate(false) in
  // the catch below therefore also restores normal fatal-error behaviour.
  // Arm the updater bypass at the LAST possible moment. Setting it at the top
  // of this function left ~5s of prep (save wait + config drain) during which
  // an unrelated crash was suppressed and a user-initiated quit would take the
  // updater bypass path even though no install had started (Codex, Medium).
  setQuittingForUpdate(true);
  try {
    autoUpdater.quitAndInstall(true, true);
    // quitAndInstall does not throw when the install simply fails to take, so
    // without this the app keeps running with fatal-error handling suppressed
    // forever (Codex). If we are still alive well past a normal exit, put the
    // app back into its normal state and say so.
    //
    // But on macOS quitAndInstall can DEFER the quit: when Squirrel has not
    // finished staging the local zip it registers a native listener and
    // returns, quitting only on a later event. Disarming the bypass while that
    // quit is still coming would reintroduce the graceful-close race this
    // whole fix exists to remove (Codex round 3). So the reset is cancelled
    // the moment a quit actually begins.
    const cancelReset = () => clearTimeout(resetTimer);
    const resetTimer = setTimeout(() => {
      // Drop the listener too, or a repeated Restart accumulates one per
      // attempt (Codex round 4).
      app.off('before-quit', cancelReset);
      setQuittingForUpdate(false);
      broadcast('updater:status', {
        state: 'error',
        message: 'The update did not install. Quit and reopen Dobius+ to try again.',
      });
    }, 60000);
    resetTimer.unref?.();
    app.once('before-quit', cancelReset);
    return true;
  } catch (err) {
    // Reset the flag so a later normal quit isn't silently broken.
    setQuittingForUpdate(false);
    broadcast('updater:status', { state: 'error', message: `Install failed: ${String(err?.message || err)}` });
    return false;
  }
}

export function initAutoUpdater() {
  ipcMain.handle('updater:check', () => {
    if (app.isPackaged) safeCheck();
    else broadcast('updater:status', { state: 'error', message: 'Updates only run in packaged builds (you are running dev mode).' });
    return { ok: app.isPackaged };
  });
  ipcMain.handle('updater:install', async () => {
    const ok = await performInstall();
    return { ok };
  });
  // getPending now filters out anything that is not strictly newer than the
  // running version, so a late-mounting window can't resurrect a stale toast.
  ipcMain.handle('updater:getPending', () => {
    if (!pendingUpdate) return null;
    if (!isStrictlyNewer(pendingUpdate.version, app.getVersion())) return null;
    return pendingUpdate;
  });
  ipcMain.handle('updater:getStatus', () => lastStatus);

  ipcMain.handle('updater:getLatestRelease', async (_event, force = false) => {
    try {
      return { ok: true, release: await fetchLatestRelease({ force: force === true }) };
    } catch (err) {
      const message = err?.name === 'AbortError'
        ? 'GitHub did not respond within 10s'
        : String(err?.message || err);
      console.warn('[updater] latest-release lookup failed:', message);
      return { ok: false, error: message };
    }
  });
  ipcMain.handle('updater:getCurrentVersion', () => app.getVersion());
  ipcMain.handle('updater:dismiss', (_event, version) => {
    if (pendingUpdate && pendingUpdate.version === version) {
      pendingUpdate.__dismissed = true;
    }
    return { ok: true };
  });

  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  // autoInstallOnAppQuit is INCOMPATIBLE with the 3-phase Cmd+Q gate: the
  // bypass flag isn't set for a normal Cmd+Q quit, so squirrel would try to
  // run mid-teardown and either fail or race. We force install through the
  // explicit Restart button (performInstall) instead.
  autoUpdater.autoInstallOnAppQuit = false;
  // Full downloads only. Differential patching against the cached previous zip
  // is what wedged (stale pending zip -> every diff failed -> no banner, no
  // install, for days). The full zip is ~120MB on a fast connection; the delta
  // saves seconds and cost us five releases of updates. v1.0.54.
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on('update-available', (info) => {
    // Only surface as "downloading" if it's actually newer than what's
    // running. update-available fires for cached pending too.
    if (!isStrictlyNewer(info.version, app.getVersion())) {
      broadcast('updater:status', { state: 'idle' });
      return;
    }
    broadcast('updater:status', { state: 'downloading', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    // Clear any stale pendingUpdate so getPending can't resurrect a banner
    // for an install that no longer applies.
    pendingUpdate = null;
    lastReadyNotifiedVersion = null;
    broadcast('updater:status', { state: 'idle' });
  });

  autoUpdater.on('download-progress', (p) => {
    broadcast('updater:status', { state: 'downloading', percent: Math.round(p.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    // Hard version gate: if the downloaded asset is not strictly newer than
    // running, treat it as a no-op. Without this guard the toast appears
    // when the user is already on the latest version (the exact symptom
    // Sam reported), because electron-updater re-emits this event on every
    // periodic check while a same-version ZIP sits in
    // ~/Library/Caches/dobius-plus-updater/pending/.
    if (!isStrictlyNewer(info.version, app.getVersion())) {
      pendingUpdate = null;
      broadcast('updater:status', { state: 'idle' });
      return;
    }
    pendingUpdate = info;
    broadcast('updater:status', { state: 'ready', version: info.version });
    // Only emit the native notification ONCE per downloaded version, even
    // if update-downloaded re-fires.
    if (Notification.isSupported() && lastReadyNotifiedVersion !== info.version) {
      lastReadyNotifiedVersion = info.version;
      const n = new Notification({
        title: `Dobius+ ${info.version} ready`,
        body: 'Click to restart and install the update.',
      });
      n.on('click', () => { void performInstall(); });
      n.show();
    }
  });

  autoUpdater.on('error', (err) => {
    broadcast('updater:status', { state: 'error', message: String(err?.message || err) });
    // Self-heal: a failed download usually means wedged cache state (partial
    // zip, stale pending). Purge so the next check starts clean. v1.0.54.
    // ONLY when no valid downloaded update is pending: a transient CHECK-stage
    // error (offline, GitHub hiccup) must not delete a good pending zip out
    // from under the Restart button (Codex: quitAndInstall would then have no
    // file to hand Squirrel). The wedge scenario this heals is exactly the
    // no-pendingUpdate state: downloads failing before update-downloaded fires.
    if (!pendingUpdate) purgeUpdaterCache();
  });

  setTimeout(safeCheck, 30000);
  setInterval(safeCheck, CHECK_INTERVAL_MS);
}
