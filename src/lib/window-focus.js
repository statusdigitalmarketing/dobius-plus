// Is this window focused, for "has the user seen it" decisions (unread tabs)?
// Native focus from main OR document.hasFocus():
// - document.hasFocus() is false while a <webview> pane inside the window has
//   focus; the native window is still focused then.
// - native focus can lag or be unavailable (tests, a window behind others
//   under automation), where document.hasFocus() is right.
// Switching to another app makes both false.

let nativeFocused = false;
// The initial invoke reply and the pushed events travel separate IPC pipes,
// so a startup snapshot can land AFTER a newer blur. Any event wins.
let sawEvent = false;
const listeners = new Set();

if (typeof window !== 'undefined' && window.electronAPI?.onWindowFocusChanged) {
  window.electronAPI.onWindowFocusChanged((f) => {
    sawEvent = true;
    nativeFocused = f;
    if (f) for (const fn of listeners) fn();
  });
  window.electronAPI.windowIsFocused?.()
    .then((f) => { if (!sawEvent) nativeFocused = !!f; })
    .catch((err) => console.warn('[window-focus] initial read failed:', err?.message));
}

export function windowFocused() {
  return nativeFocused || (typeof document !== 'undefined' && document.hasFocus());
}

/** Run `fn` whenever the window gains focus (native or DOM). Returns unsubscribe. */
export function onWindowFocus(fn) {
  listeners.add(fn);
  window.addEventListener('focus', fn);
  return () => { listeners.delete(fn); window.removeEventListener('focus', fn); };
}
