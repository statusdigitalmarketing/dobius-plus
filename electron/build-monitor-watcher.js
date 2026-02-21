import { watch } from 'chokidar';
import path from 'path';
import { pathExists } from './data-utils.js';

/**
 * Watch build-related files in a project directory and notify the renderer.
 * Watches: claude-progress.json, HANDOFF.md, scripts/supervisor.log
 */
const watchers = new Map(); // key: `${wcId}:${projectDir}`

const WATCHED_FILES = [
  'claude-progress.json',
  'HANDOFF.md',
  'scripts/supervisor.log',
];

export async function watchBuildDir(webContents, projectDir) {
  const wcId = webContents.id;
  const key = `${wcId}:${projectDir}`;

  // Close existing watcher for this combo
  if (watchers.has(key)) {
    watchers.get(key).close();
    watchers.delete(key);
  }

  const watchPaths = [];
  for (const file of WATCHED_FILES) {
    const filePath = path.join(projectDir, file);
    if (await pathExists(filePath)) {
      watchPaths.push(filePath);
    }
  }

  // Even if no files exist yet, watch the dir for new file creation
  if (watchPaths.length === 0) {
    watchPaths.push(path.join(projectDir, 'claude-progress.json'));
  }

  const watcher = watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher.on('change', () => {
    if (!webContents.isDestroyed()) {
      webContents.send('buildMonitor:updated', projectDir);
    }
  });

  watcher.on('add', () => {
    if (!webContents.isDestroyed()) {
      webContents.send('buildMonitor:updated', projectDir);
    }
  });

  watchers.set(key, watcher);

  webContents.once('destroyed', () => {
    const w = watchers.get(key);
    if (w) {
      w.close();
      watchers.delete(key);
    }
  });
}

export function unwatchBuildDir(webContents, projectDir) {
  const key = `${webContents.id}:${projectDir}`;
  const watcher = watchers.get(key);
  if (watcher) {
    watcher.close();
    watchers.delete(key);
  }
}

export function stopAllBuildWatchers() {
  for (const [, watcher] of watchers) {
    watcher.close();
  }
  watchers.clear();
}
