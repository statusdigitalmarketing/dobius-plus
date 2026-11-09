import path from 'path';
import { watch } from 'chokidar';
import { HISTORY_PATH, STATS_PATH } from './data-utils.js';
import { historyIndex, projectsSince } from './history-index.js';

/**
 * Watch key ~/.claude/ files for changes and tell every window.
 *
 * ONE watcher for the whole app, batched. Every prompt in any Claude session
 * appends to history.jsonl, and with ~45 sessions that is many events a minute;
 * each window answers one with reloads (sessions, history, stats). It used to
 * be one watcher per window and an event per change, so 14 windows each
 * rescanned their sessions on every prompt (2026-11-09: ~3.7s of main-process
 * CPU and ~200MB of heap churn per prompt, measured). Now changes are batched
 * for BATCH_MS and the event says which projects had a prompt
 * (`{ projects: string[] }`, or `projects: null` when that cannot be told), so
 * a window can skip a reload that is not about its project.
 */
const BATCH_MS = 2000;
const HISTORY = path.resolve(HISTORY_PATH);

const subscribers = new Set(); // webContents
let watcher = null;
let timer = null;
const pendingPaths = new Set();
// The history index as of the last event, and its line count. Null until the
// first event, which therefore names no projects (every window reloads once):
// a baseline taken at start could count a prompt that lands between the
// watcher attaching and the baseline read as already delivered.
let lastIdx = null;
let lastSeq = NaN;

// Called just before windows are told (main drops its shared session scans,
// which may predate the change).
let beforeNotify = () => {};
export function setBeforeNotify(fn) { beforeNotify = typeof fn === 'function' ? fn : () => {}; }

async function flush() {
  timer = null;
  const paths = [...pendingPaths];
  pendingPaths.clear();
  if (!paths.length) return;
  let projects = null;
  if (paths.every((p) => path.resolve(p) === HISTORY)) {
    try {
      const idx = await historyIndex.read();
      projects = projectsSince(idx, lastIdx, lastSeq);
      lastIdx = idx;
      lastSeq = idx.seq;
    } catch (err) {
      console.warn('[watcher] history read failed:', err?.message);
    }
  }
  try { beforeNotify(); } catch (err) { console.warn('[watcher] beforeNotify failed:', err?.message); }
  for (const wc of subscribers) {
    if (!wc.isDestroyed()) wc.send('data:updated', paths[0], { projects });
  }
}

function onChange(changedPath) {
  pendingPaths.add(changedPath);
  if (!timer) timer = setTimeout(() => { flush().catch((err) => console.warn('[watcher] flush failed:', err?.message)); }, BATCH_MS);
}

function closeWatcher() {
  if (timer) { clearTimeout(timer); timer = null; }
  pendingPaths.clear();
  const w = watcher;
  watcher = null;
  lastIdx = null;
  lastSeq = NaN;
  w?.close().catch(() => {});
}

// Synchronous, so there is no window in which a watcher is half started. Both
// files are watched whether or not they exist yet: chokidar reports one that
// appears later as 'add' (a fresh install has no history.jsonl).
function ensureWatcher() {
  if (watcher || subscribers.size === 0) return;
  watcher = watch([HISTORY_PATH, STATS_PATH], {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  watcher.on('change', onChange);
  watcher.on('add', onChange);
  watcher.on('error', (err) => console.warn('[watcher] error:', err?.message));
}

export function watchFiles(webContents) {
  if (subscribers.has(webContents)) return;
  subscribers.add(webContents);
  webContents.once('destroyed', () => {
    subscribers.delete(webContents);
    if (subscribers.size === 0) closeWatcher();
  });
  ensureWatcher();
}

export function stopWatching() {
  subscribers.clear();
  closeWatcher();
}
