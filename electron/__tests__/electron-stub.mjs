// Minimal 'electron' stub so the pure data-service helpers can be imported in
// plain Node for testing. config-manager.js calls app.getPath('userData') at
// module load; nothing under test touches config.
const app = {
  // Honor a per-test userData dir so suites that write config are isolated from
  // each other and from the real app config.
  getPath: () => process.env.DOBIUS_TEST_USERDATA || '/private/tmp/dobius-freshtest-userdata',
  getVersion: () => '0.0.0-test',
  getName: () => 'dobius-test',
  setName: () => {},
  on: () => {},
  whenReady: () => Promise.resolve(),
};
export { app };
export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} };
export const BrowserWindow = class {};
export const shell = {};
export const dialog = {};
export const Notification = class {};
export const powerMonitor = { on: () => {} };
export const nativeTheme = { on: () => {} };
// mobile-server.js imports this at module load (it holds a power assertion
// while the phone bridge is up); the pure helpers under test never call it.
export const powerSaveBlocker = { start: () => 0, stop: () => {}, isStarted: () => false };
export default {
  app, ipcMain, BrowserWindow, shell, dialog, Notification,
  powerMonitor, nativeTheme, powerSaveBlocker,
};
