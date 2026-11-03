/**
 * Dobius windows never leave Dobius. Every app window carries the preload,
 * so whatever page it shows holds the whole bridge: terminals, settings,
 * the shared keys. A plain link in rendered markdown (Notes, a CLAUDE.md
 * preview) used to navigate the window itself to that site. Now an app
 * window only ever navigates to its own page; an http(s) or mailto link opens
 * in the default browser or mail app instead, and any popup is refused the same way.
 *
 * Only BrowserWindow contents ('window') are guarded. A browser pane is a
 * <webview> ('webview'), has no preload, and must keep browsing freely.
 */
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Is `target` Dobius's own page? Dev: the Vite origin. Packaged: exactly the
 * bundled index.html (query and hash may differ: windows pass ?project=...).
 */
export function isAppUrl(target, { dev, appFile }) {
  let u;
  try { u = new URL(target); } catch { return false; } // not a URL: never the app
  if (dev) return u.origin === 'http://localhost:5173';
  if (u.protocol !== 'file:' || u.host) return false;
  try {
    return path.resolve(fileURLToPath(u)) === path.resolve(appFile);
  } catch {
    return false; // malformed file URL
  }
}

// Web links and email links go to the default browser or mail app; nothing
// else (file:, javascript:, custom schemes) is handed to the OS.
const openableExternally = (target) => /^(?:https?:\/\/|mailto:)/i.test(target);

/** Attach the guard to every app window as it is created. */
export function installNavGuard(app, shell, { dev, appFile }) {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return;
    contents.on('will-navigate', (event, target) => {
      if (isAppUrl(target, { dev, appFile })) return;
      event.preventDefault();
      if (openableExternally(target)) shell.openExternal(target);
    });
    contents.on('will-redirect', (event, target) => {
      if (!isAppUrl(target, { dev, appFile })) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (openableExternally(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}
