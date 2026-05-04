import electronUpdater from 'electron-updater';
import { app, BrowserWindow, Notification, ipcMain } from 'electron';

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
let pendingUpdate = null;

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function initAutoUpdater() {
  // Always register IPC handlers so the renderer's UpdateBanner can call them
  // without errors in dev mode. The actual update polling only runs in packaged builds.
  ipcMain.handle('updater:check', () => {
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
    return { ok: app.isPackaged };
  });
  ipcMain.handle('updater:install', () => {
    if (app.isPackaged && pendingUpdate) autoUpdater.quitAndInstall();
    return { ok: app.isPackaged && !!pendingUpdate };
  });
  ipcMain.handle('updater:getPending', () => pendingUpdate);

  if (!app.isPackaged) return; // skip the rest in dev — no app-update.yml

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    broadcast('updater:status', { state: 'downloading', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    broadcast('updater:status', { state: 'idle' });
  });

  autoUpdater.on('download-progress', (p) => {
    broadcast('updater:status', { state: 'downloading', percent: Math.round(p.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    pendingUpdate = info;
    broadcast('updater:status', { state: 'ready', version: info.version });
    if (Notification.isSupported()) {
      const n = new Notification({
        title: `Dobius+ ${info.version} ready`,
        body: 'Click to restart and install the update.',
      });
      n.on('click', () => autoUpdater.quitAndInstall());
      n.show();
    }
  });

  autoUpdater.on('error', (err) => {
    broadcast('updater:status', { state: 'error', message: String(err?.message || err) });
  });

  // First check 30s after launch (don't block startup), then every 4h
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 30000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), CHECK_INTERVAL_MS);
}
