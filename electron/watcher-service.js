import path from 'path';
import { watch } from 'chokidar';
import { HISTORY_PATH, STATS_PATH, pathExists } from './data-utils.js';
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
let starting = null;
let timer = null;
const pendingPaths = new Set();
let lastIdx = null; // the history index as of the last event, and its line count
let lastSeq = NaN;

async function baseline() {
  try {
    const idx = await historyIndex.read();
    lastIdx = idx;
    lastSeq = idx.seq;
  } catch (err) {
    console.warn('[watcher] history baseline failed:', err?.message);
  }
}

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
  w?.close().catch(() => {});
}

async function ensureWatcher() {
  if (watcher || starting) return starting;
  starting = (async () => {
    const watchPaths = [];
    if (await pathExists(HISTORY_PATH)) watchPaths.push(HISTORY_PATH);
    if (await pathExists(STATS_PATH)) watchPaths.push(STATS_PATH);
    if (watchPaths.length === 0 || subscribers.size === 0) return;
    watcher = watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    watcher.on('change', onChange);
    await baseline();
  })().finally(() => { starting = null; });
  return starting;
}

export async function watchFiles(webContents) {
  if (subscribers.has(webContents)) return;
  subscribers.add(webContents);
  webContents.once('destroyed', () => {
    subscribers.delete(webContents);
    if (subscribers.size === 0) closeWatcher();
  });
  await ensureWatcher();
}

export function stopWatching() {
  subscribers.clear();
  closeWatcher();
}
