import electronUpdater from 'electron-updater';
import { app, BrowserWindow, Notification, ipcMain } from 'electron';
import { setQuittingForUpdate } from './quit-state.js';
import { drainConfigWrites } from './config-manager.js';

const { autoUpdater } = electronUpdater;

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
  setQuittingForUpdate(true);
  try {
    await Promise.race([
      drainConfigWrites(), // v1.0.33: non-latching, so if quitAndInstall throws we can still persist
      new Promise((resolve) => setTimeout(resolve, QUIT_INSTALL_FLUSH_TIMEOUT_MS)),
    ]);
  } catch { /* best effort */ }
  try {
    autoUpdater.quitAndInstall(true, true);
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
  ipcMain.handle('updater:getCurrentVersion', () => app.getVersion());
  // Used by the renderer to persist "I acknowledged version X" so the toast
  // does not re-appear every 4h check. Renderer reads this on mount.
  ipcMain.handle('updater:isDismissed', () => {
    if (!pendingUpdate) return true;
    try {
      return lastReadyNotifiedVersion === pendingUpdate.version
        && pendingUpdate.__dismissed === true;
    } catch { return false; }
  });
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
  });

  setTimeout(safeCheck, 30000);
  setInterval(safeCheck, CHECK_INTERVAL_MS);
}
