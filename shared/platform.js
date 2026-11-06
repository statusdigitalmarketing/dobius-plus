// Platform facts shared by main and the renderer (Windows build, 2026-11-06).
// No Node or Electron imports: the renderer reads the platform from preload.

/** 'win32', 'darwin' or 'linux', in main or a renderer. */
export function currentPlatform() {
  if (typeof process !== 'undefined' && process?.platform && typeof window === 'undefined') return process.platform;
  if (typeof window !== 'undefined' && window.electronAPI?.platform) return window.electronAPI.platform;
  if (typeof navigator !== 'undefined' && /^Win/.test(navigator.platform || '')) return 'win32';
  if (typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '')) return 'darwin';
  return 'linux';
}

export const isWindows = (platform = currentPlatform()) => platform === 'win32';

/**
 * An absolute path ON THIS PLATFORM: `/x` on macOS and Linux; `C:\x` or `C:/x`
 * on Windows (a drive letter, never a drive-relative `C:x`). Network (UNC)
 * paths are refused: checking one makes Windows contact that server, which a
 * phone or bridge caller could otherwise trigger (Codex). A Windows-shaped
 * string on the Mac stays relative, so no guard that relied on a leading slash
 * gets wider there.
 */
export function isAbsPath(p, platform = currentPlatform()) {
  if (typeof p !== 'string' || !p || p.length > 4096) return false;
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p);
  return p.startsWith('/');
}

/** Last path segment for display: / and \ on Windows, only / elsewhere. */
export function baseName(p, platform = currentPlatform()) {
  const parts = String(p || '').split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

/**
 * Whether `child` is `parent` itself or inside it, by path segments (never a
 * sibling that merely shares a prefix: /a/bc is not inside /a/b). Windows
 * compares case-insensitively and treats / and \ alike.
 */
export function isInsidePath(child, parent, platform = currentPlatform()) {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  const win = platform === 'win32';
  const norm = (s) => {
    let t = win ? s.replace(/\//g, '\\') : s;
    const sep = win ? '\\' : '/';
    while (t.length > 1 && t.endsWith(sep) && !(win && /^[A-Za-z]:\\$/.test(t))) t = t.slice(0, -1);
    return win ? t.toLowerCase() : t;
  };
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  const sep = win ? '\\' : '/';
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}
