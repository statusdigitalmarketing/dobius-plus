// Tiny shared module for the "quitting for update" flag. Lives outside both
// main.js and window-manager.js so the bypass check in window-manager's
// close handler doesn't create a circular import. auto-updater.js sets it
// before calling autoUpdater.quitAndInstall(); main.js's before-quit and
// window-manager.js's per-window close handler read it to skip their
// graceful-shutdown paths so squirrel.mac can replace the bundle quickly.

let _isQuittingForUpdate = false;
export function setQuittingForUpdate(v) { _isQuittingForUpdate = !!v; }
export function getQuittingForUpdate() { return _isQuittingForUpdate; }

// Generic "a quit is underway and will not be cancelled" flag, set once a
// quit is CONFIRMED (Cmd+Q phase 2/3, updater restart, will-quit). NOT set on
// the first Cmd+Q press, which only shows the overlay and can be cancelled.
//
// window-manager persists the open-project list live on every window
// open/close so ANY exit path (update restart, force quit, OS shutdown,
// crash) can restore the session. During a quit the windows all close in a
// cascade, which would otherwise rewrite that list to [] and destroy the
// very state we're trying to restore. This flag freezes the snapshot the
// moment a quit is committed. v1.0.38.
let _isQuitting = false;
export function setQuitting(v) { _isQuitting = !!v; }
export function getQuitting() { return _isQuitting; }
