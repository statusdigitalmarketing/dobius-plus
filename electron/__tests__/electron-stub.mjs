// Minimal 'electron' stub so the pure data-service helpers can be imported in
// plain Node for testing. config-manager.js calls app.getPath('userData') at
// module load; nothing under test touches config.
const app = {
  getPath: () => '/private/tmp/dobius-freshtest-userdata',
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
export default { app, ipcMain, BrowserWindow, shell, dialog, Notification, powerMonitor, nativeTheme };
