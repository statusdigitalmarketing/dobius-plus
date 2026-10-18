// Mobile persistent storage. Capacitor @capacitor/preferences on iOS/Android
// (which lands in NSUserDefaults on iOS: per-app sandbox, not world-readable),
// localStorage in the browser-dev build. The host and token both live here,
// so a bundled Capacitor PWA keeps them across launches without relying on
// WebView localStorage (which iOS can purge under memory pressure for a
// cross-origin bundled WebView). The returned API is intentionally thin and
// identical in both environments: await get/set/remove by key.
//
// A tightening pass (follow-up to this follow-up) moves the token specifically
// into the iOS Keychain via a native plugin. That is deliberately out of
// scope for the first App Store submission so there is only one new native
// dependency to review.

import { Preferences } from '@capacitor/preferences';

// Capacitor sets window.Capacitor; isNativePlatform() returns true inside the
// iOS/Android WebView and false in Vite's dev browser.
const isNative = () => {
  try { return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true; }
  catch { return false; }
};

export async function get(key) {
  if (isNative()) {
    const { value } = await Preferences.get({ key });
    return value ?? null;
  }
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export async function set(key, value) {
  if (isNative()) {
    await Preferences.set({ key, value: String(value) });
    return;
  }
  try { window.localStorage.setItem(key, String(value)); } catch { /* quota */ }
}

export async function remove(key) {
  if (isNative()) {
    await Preferences.remove({ key });
    return;
  }
  try { window.localStorage.removeItem(key); } catch { /* noop */ }
}
