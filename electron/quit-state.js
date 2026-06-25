// Tiny shared module for the "quitting for update" flag. Lives outside both
// main.js and window-manager.js so the bypass check in window-manager's
// close handler doesn't create a circular import. auto-updater.js sets it
// before calling autoUpdater.quitAndInstall(); main.js's before-quit and
// window-manager.js's per-window close handler read it to skip their
// graceful-shutdown paths so squirrel.mac can replace the bundle quickly.

let _isQuittingForUpdate = false;
export function setQuittingForUpdate(v) { _isQuittingForUpdate = !!v; }
export function getQuittingForUpdate() { return _isQuittingForUpdate; }
