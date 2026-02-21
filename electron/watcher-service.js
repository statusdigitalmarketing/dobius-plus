import { watch } from 'chokidar';
import { HISTORY_PATH, STATS_PATH, pathExists } from './data-utils.js';

/**
 * Watch key ~/.claude/ files for changes and notify the renderer.
 * Uses a per-window watcher map so multiple windows all receive updates.
 */
const watchers = new Map();

export async function watchFiles(webContents) {
  const wcId = webContents.id;

  if (watchers.has(wcId)) {
    watchers.get(wcId).close();
  }

  const watchPaths = [];
  if (await pathExists(HISTORY_PATH)) watchPaths.push(HISTORY_PATH);
  if (await pathExists(STATS_PATH)) watchPaths.push(STATS_PATH);
  if (watchPaths.length === 0) return;

  const watcher = watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('change', (changedPath) => {
    if (!webContents.isDestroyed()) {
      webContents.send('data:updated', changedPath);
    }
  });

  watchers.set(wcId, watcher);

  webContents.once('destroyed', () => {
    const w = watchers.get(wcId);
    if (w) {
      w.close();
      watchers.delete(wcId);
    }
  });
}

export function stopWatching() {
  for (const [, watcher] of watchers) {
    watcher.close();
  }
  watchers.clear();
}
