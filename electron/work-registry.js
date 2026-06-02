/**
 * work-registry.js — Phase 2 of the iMessage platform.
 *
 * Tracks in-flight work items dispatched by the Voice Conductor. Each item:
 *   - registers when Conductor calls `dobius-track <workId> <tabId> <description>`
 *   - watches the tracked tab via subscribeTerminal; on tab exit, auto-fires
 *     a "final report" iMessage to Sam closing the loop
 *   - can be queried at any time by `dobius-status [target]` (Conductor uses
 *     this to answer "how's the brain agent thing going?")
 *
 * State persists to config.workRegistry. Capped at 200 items FIFO so the
 * map can't grow unbounded across long sessions.
 *
 * Concurrency safeguards live elsewhere (the spawn pipeline in Phase 3
 * enforces maxConcurrentAgents); the registry is purely an observability +
 * notification layer.
 */
import { subscribeTerminal } from './terminal-manager.js';
import { sendImessageToSelf } from './imessage-bridge.js';
import { loadConfig, saveConfig } from './config-manager.js';

const MAX_ITEMS = 200;
const items = new Map();        // workId -> entry
const watchers = new Map();     // workId -> { unsubscribe }

// --- Load persisted state on import --------------------------------------

function rehydrate() {
  try {
    const cfg = loadConfig();
    const persisted = cfg.workRegistry?.items;
    if (Array.isArray(persisted)) {
      for (const e of persisted) {
        if (e && typeof e.workId === 'string') items.set(e.workId, e);
      }
    }
  } catch (err) {
    console.warn(`[work-registry] rehydrate failed: ${err.message}`);
  }
}
rehydrate();

function persist() {
  try {
    const cfg = loadConfig();
    if (!cfg.workRegistry || typeof cfg.workRegistry !== 'object') cfg.workRegistry = {};
    cfg.workRegistry.items = Array.from(items.values()).slice(-MAX_ITEMS);
    saveConfig(cfg);
  } catch (err) {
    console.warn(`[work-registry] persist failed: ${err.message}`);
  }
}

// --- Public API ----------------------------------------------------------

/**
 * Register a new work item. Watches its tab for exit; on exit, sends a
 * final-report iMessage to Sam.
 *
 * @param {object} opts
 * @param {string} opts.workId — short stable id chosen by Conductor (e.g. "wk-abc12")
 * @param {string} opts.tabId — the Dobius+ tab id the work is running in
 * @param {string} opts.description — one-line human summary of the work
 * @param {string} [opts.requestId] — the iMessage requestId that kicked it off
 * @param {string} [opts.projectPath] — for filtering "status for slimject"
 */
export function registerWork(opts) {
  const { workId, tabId, description, requestId, projectPath } = opts || {};
  if (typeof workId !== 'string' || !/^[a-zA-Z0-9_-]{3,80}$/.test(workId)) return { ok: false, error: 'workId malformed' };
  if (typeof tabId !== 'string' || !/^term-.+-\d+$/.test(tabId)) return { ok: false, error: 'tabId malformed' };

  // Concurrency cap — strictly serial by default (maxConcurrentAgents=1).
  // The Conductor must check `dobius-status` and back off / re-queue when
  // this fires. Phase 5 will add an internal FIFO that resumes paused work
  // automatically; for now the Conductor mediates retries.
  try {
    const cfg = loadConfig();
    const limits = cfg.workRegistry?.limits || { maxConcurrentAgents: 1, maxPerProject: 1 };
    const running = Array.from(items.values()).filter((e) => e.status === 'running');
    if (running.length >= (limits.maxConcurrentAgents || 1)) {
      return { ok: false, error: `concurrency cap: ${running.length}/${limits.maxConcurrentAgents} agents already running`, retryable: true };
    }
    if (projectPath) {
      const inProject = running.filter((e) => e.projectPath === projectPath).length;
      if (inProject >= (limits.maxPerProject || 1)) {
        return { ok: false, error: `per-project cap: ${inProject}/${limits.maxPerProject} agents already running in ${projectPath}`, retryable: true };
      }
    }
  } catch { /* config error: proceed without cap rather than block */ }

  const entry = {
    workId,
    tabId,
    description: typeof description === 'string' ? description.slice(0, 200) : '',
    requestId: typeof requestId === 'string' ? requestId : null,
    projectPath: typeof projectPath === 'string' ? projectPath.slice(0, 500) : '',
    status: 'running',
    startedAt: Date.now(),
    lastUpdate: Date.now(),
    completedAt: null,
    exitCode: null,
    finalReport: null,
  };

  // Replace any prior entry for this workId
  cleanupWatcher(workId);
  items.set(workId, entry);
  trimToMax();

  // Watch the tab for exit. On exit, mark completed + send final-report.
  const sub = subscribeTerminal(tabId, {
    onExit: (_id, exitCode) => {
      cleanupWatcher(workId);
      void handleTabExit(workId, exitCode);
    },
  });
  watchers.set(workId, sub);

  persist();
  return { ok: true, workId };
}

/**
 * Manually mark a work item as done (when Conductor observes completion
 * without the tab exiting). Used by `dobius-mark-done` CLI.
 */
export function markDone(workId, summary, status = 'completed') {
  const entry = items.get(workId);
  if (!entry) return { ok: false, error: 'workId not found' };
  if (entry.status !== 'running') return { ok: false, error: `already ${entry.status}` };
  cleanupWatcher(workId);
  entry.status = ['completed', 'failed', 'cancelled'].includes(status) ? status : 'completed';
  entry.completedAt = Date.now();
  entry.lastUpdate = Date.now();
  entry.finalReport = typeof summary === 'string' ? summary.slice(0, 400) : '';
  persist();
  fireFinalReport(entry);
  return { ok: true };
}

/**
 * Query status. `target` can be a workId, a substring matching projectPath
 * or description, or 'all' / empty for everything.
 */
export function getStatus(target) {
  const all = Array.from(items.values()).sort((a, b) => b.lastUpdate - a.lastUpdate);
  if (!target || target === 'all') return all;
  const q = String(target).toLowerCase();
  return all.filter((e) =>
    e.workId.toLowerCase() === q
    || (e.description || '').toLowerCase().includes(q)
    || (e.projectPath || '').toLowerCase().includes(q)
    || (e.tabId || '').toLowerCase().includes(q));
}

/** Cancel a tracked item (does not kill the tab itself; just stops tracking). */
export function cancelWork(workId) {
  const entry = items.get(workId);
  if (!entry) return { ok: false, error: 'not found' };
  cleanupWatcher(workId);
  entry.status = 'cancelled';
  entry.completedAt = Date.now();
  persist();
  return { ok: true };
}

// --- Internal ------------------------------------------------------------

function cleanupWatcher(workId) {
  const w = watchers.get(workId);
  if (w) { try { w.unsubscribe?.(); } catch { /* noop */ } watchers.delete(workId); }
}

function trimToMax() {
  if (items.size <= MAX_ITEMS) return;
  // FIFO — drop oldest entries (insertion order)
  const drop = items.size - MAX_ITEMS;
  let i = 0;
  for (const k of items.keys()) {
    if (i >= drop) break;
    items.delete(k);
    cleanupWatcher(k);
    i += 1;
  }
}

async function handleTabExit(workId, exitCode) {
  const entry = items.get(workId);
  if (!entry || entry.status !== 'running') return;
  entry.status = exitCode === 0 ? 'completed' : 'failed';
  entry.completedAt = Date.now();
  entry.lastUpdate = Date.now();
  entry.exitCode = typeof exitCode === 'number' ? exitCode : null;
  entry.finalReport = entry.finalReport || `tab exited (code ${exitCode ?? '?'})`;
  persist();
  await fireFinalReport(entry);
}

async function fireFinalReport(entry) {
  // Sam only gets a text if the work was kicked off via iMessage (we know
  // the requestId is set in that case). Internal/desktop-launched work
  // gets tracked but doesn't ping the phone.
  if (!entry.requestId) return;
  const icon = entry.status === 'completed' ? '✅' : entry.status === 'failed' ? '❌' : '⚠️';
  const desc = entry.description || entry.workId;
  const summary = entry.finalReport || '';
  const text = `${icon} ${desc}${summary ? ` — ${summary}` : ''}`;
  try {
    await sendImessageToSelf(text.slice(0, 1000));
  } catch (err) {
    console.warn(`[work-registry] final-report send failed: ${err.message}`);
  }
}

/**
 * Format a status snapshot as a single short string suitable for an
 * iMessage reply (capped to ~500 chars). Conductor calls this via
 * /getStatus and uses the result as its dobius-reply payload.
 */
export function formatStatusSnapshot(target) {
  const list = getStatus(target);
  if (list.length === 0) return target ? `No work matching "${target}"` : 'No tracked work';
  const lines = list.slice(0, 8).map((e) => {
    const age = Math.round((Date.now() - e.startedAt) / 60000);
    const stat = e.status === 'running' ? `${age}m in` : e.status;
    return `${e.workId.slice(0, 12)} • ${stat} • ${e.description?.slice(0, 60) || '(no desc)'}`;
  });
  if (list.length > 8) lines.push(`...and ${list.length - 8} more`);
  return lines.join('\n');
}
