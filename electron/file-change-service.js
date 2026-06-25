import { watch } from 'chokidar';
import path from 'path';

// projectPath → { watcher, events, subs: Set<WebContents> }
// `subs` is a refcount of live subscribers. Multiple windows can watch the same
// project; the chokidar watcher is created once and closed only when the LAST
// subscriber goes away — so one window unwatching (or closing) never silently
// stops another window's feed, and events fan out to every live subscriber.
const watchers = new Map();
const MAX_EVENTS = 150;
// Match path COMPONENTS, not substrings. The previous /(node_modules|\.git|dist|...)/
// regex hit any path containing those letters, so .gitignore, .github/workflows,
// and any project with "dist" in its name (e.g. /Users/sam/distributed-app)
// silently never reported file changes. Codex PR#3 r18 P2.
const IGNORED_COMPONENTS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', '.DS_Store',
  '__pycache__', '.next', '.nuxt',
]);
function IGNORED(p) {
  // chokidar passes the full path. Split on the OS separator and any forward
  // slash (we may see either on macOS), check each segment for an exact match.
  if (typeof p !== 'string') return false;
  const parts = p.split(/[/\\]/);
  for (const part of parts) {
    if (IGNORED_COMPONENTS.has(part)) return true;
  }
  return false;
}

export function watchProjectDir(projectPath, webContents) {
  const existing = watchers.get(projectPath);
  if (existing) {
    // Already watching this path — just register this window as a subscriber so
    // it receives events too (its buffered backlog comes via getProjectEvents).
    addSubscriber(existing, projectPath, webContents);
    return;
  }

  const subs = new Set();
  const events = [];

  const watcher = watch(projectPath, {
    persistent: true,
    ignoreInitial: true,
    ignored: IGNORED,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    depth: 5,
  });

  const push = (type, filePath) => {
    const rel = path.relative(projectPath, filePath);
    if (rel.startsWith('..')) return; // outside project root
    const entry = { type, path: rel, timestamp: Date.now() };
    events.push(entry);
    if (events.length > MAX_EVENTS) events.shift();
    // Fan out to every live subscriber; prune any whose window has gone.
    for (const wc of subs) {
      if (wc.isDestroyed()) { subs.delete(wc); continue; }
      wc.send('filewatcher:change', projectPath, entry);
    }
  };

  watcher.on('add', (p) => push('add', p));
  watcher.on('change', (p) => push('change', p));
  watcher.on('unlink', (p) => push('unlink', p));
  watcher.on('addDir', (p) => push('addDir', p));
  watcher.on('unlinkDir', (p) => push('unlinkDir', p));

  const record = { watcher, events, subs };
  watchers.set(projectPath, record);
  addSubscriber(record, projectPath, webContents);
}

// Register a webContents as a subscriber (deduped) and arrange for it to be
// released automatically when its window is destroyed.
function addSubscriber(record, projectPath, webContents) {
  if (!webContents || webContents.isDestroyed?.()) return;
  if (record.subs.has(webContents)) return;
  record.subs.add(webContents);
  webContents.once('destroyed', () => releaseSubscriber(projectPath, webContents));
}

// Release one specific subscriber. Closes the watcher when the last one leaves.
// Idempotent: a no-op if the path or subscriber is already gone.
function releaseSubscriber(projectPath, webContents) {
  const record = watchers.get(projectPath);
  if (!record || !record.subs.has(webContents)) return;
  record.subs.delete(webContents);
  if (record.subs.size === 0) {
    record.watcher.close();
    watchers.delete(projectPath);
  }
}

export function unwatchProjectDir(projectPath, webContents) {
  const record = watchers.get(projectPath);
  if (!record) return;

  if (webContents) {
    // Caller identity known — release exactly that subscriber.
    releaseSubscriber(projectPath, webContents);
    return;
  }

  // Manual unwatch via IPC does not carry the calling window's identity (the
  // handler only passes projectPath). With a single subscriber that must be the
  // caller, so close now (the common single-window case, and project switches).
  // With multiple live subscribers we cannot tell which one stopped, so we leave
  // the watcher running for the others — each window's `destroyed` handler will
  // release it. This never prematurely kills another window's feed.
  if (record.subs.size <= 1) {
    record.watcher.close();
    watchers.delete(projectPath);
  }
}

export function getProjectEvents(projectPath) {
  return (watchers.get(projectPath)?.events || []).slice();
}

export function stopAllFileWatchers() {
  for (const { watcher } of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
}
