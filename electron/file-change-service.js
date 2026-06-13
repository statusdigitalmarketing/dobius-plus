import { watch } from 'chokidar';
import path from 'path';

const watchers = new Map(); // projectPath → { watcher, events }
const MAX_EVENTS = 150;
const IGNORED = /(node_modules|\.git|dist|dist-electron|\.DS_Store|__pycache__|\.next|\.nuxt)/;

export function watchProjectDir(projectPath, webContents) {
  if (watchers.has(projectPath)) return;

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
    if (!webContents.isDestroyed()) {
      webContents.send('filewatcher:change', projectPath, entry);
    }
  };

  watcher.on('add', (p) => push('add', p));
  watcher.on('change', (p) => push('change', p));
  watcher.on('unlink', (p) => push('unlink', p));
  watcher.on('addDir', (p) => push('addDir', p));
  watcher.on('unlinkDir', (p) => push('unlinkDir', p));

  watchers.set(projectPath, { watcher, events });

  webContents.once('destroyed', () => unwatchProjectDir(projectPath));
}

export function unwatchProjectDir(projectPath) {
  const entry = watchers.get(projectPath);
  if (entry) {
    entry.watcher.close();
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
