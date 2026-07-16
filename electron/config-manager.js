import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { app } from 'electron';

const CONFIG_DIR = path.join(app.getPath('userData'));
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
// Per-tab scrollback lives in its own file under terminal-history so config.json
// stays tiny. Before this, scrollback was inlined into config.projects[*].terminalStates
// and every per-tab auto-save serialized + sync-wrote the entire config (12+ MB).
const SCROLLBACK_DIR = path.join(CONFIG_DIR, 'terminal-history');

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DEFAULT_CONFIG = {
  defaultTheme: 0,
  projects: {},
  pinnedSessions: [],
  sessionTabMap: {}, // sessionId -> { tabId, projectPath, capturedAt }
  launcherBounds: null,
  settings: {
    projectScanDir: '',
    scrollbackLines: 1000,
    terminalFontSize: 13,
    sidebarDefaultOpen: false,
  },
  mobileServer: {
    enabled: false,
    port: 8420,
    bindMode: 'tailscale', // 'tailscale' (remote, private) or 'lan' (same Wi-Fi)
    devices: [], // [{ token, name, pairedAt }] for paired phones
  },
  imessageBridge: {
    enabled: false,
    triggerPrefix: 'd:',         // commands must start with this
    selfHandle: null,            // Sam's own iMessage handle (email or phone) — required
    lastSeenRowid: 0,            // chat.db ROWID high-water mark for restart safety
  },
  workRegistry: {
    items: [],                   // capped at 200 entries (FIFO), see work-registry.js
    limits: {
      maxConcurrentAgents: 1,    // strictly serial by default
      maxPerProject: 1,
    },
  },
  asanaQueue: {
    pat: '',                     // Asana personal access token
    allowedProjects: [],         // [{ name, gid }] — auto-process only these
    myGid: '1215600517617968',   // Carson — tasks assigned to me get BUILT (full pipeline)
    reviewGid: '1213473231797717', // Sam — tasks assigned to him only get REVIEWED (double-check)
    autoMode: {                  // hands-off intake (auto-mode.js); writes managed there
      enabled: false,            // OFF by default
      intervalMinutes: 10,       // poll cadence
      lanes: ['build', 'review'],
      seen: [],                  // dispatched task GIDs (capped)
    },
    docsFolder: '~/Projects (Code)/Docs', // per-task PDFs land here (per-project subfolders)
  },
  accounts: [],                  // [{ id, name, type: 'claude'|'codex', claudeJsonPath?, apiKey? }]
  projectAccounts: {},           // projectPath → accountId
  autoResume: {
    // Re-engage every previously-active Claude session on app launch.
    // Reads sessionTabMap to find each tab's last-running sessionId, validates
    // the transcript (exists + under skipOversizedMB) and project, then
    // staggers `claude --resume <id>` writes into each tab so 14 PTYs don't
    // spin up simultaneously. See electron/auto-resume.js.
    enabled: true,               // default ON per Sam's choice
    staggerMs: 50,               // delay between consecutive resume writes
    skipOversizedMB: 80,         // matches the existing dead-session guard
    cancelOnUserInput: true,     // skip a tab if the user types into it first
  },
};

let configCache = null;
let saveTimer = null;
// Single promise chain so every async config write runs sequentially. Combined
// with a per-write unique tmp file, concurrent writers can never interleave a
// write→rename and tear config.json.
let writeChain = Promise.resolve();
// Set true by flushConfig() at quit time. Any pending or new atomicWrite
// callbacks that fire after this flips become no-ops, so a queued async
// rename can't land AFTER the sync flush and overwrite fresher state
// (v1.0.25/v1.0.26 tab/grid/browser-pane/terminal-ownership). Codex v1.0.27
// round-1 HIGH.
let flushed = false;

/**
 * Drop terminalStates entries whose tab no longer exists in either the live
 * tabs list or the closedTabs list. Orphans accumulate over time as tabs come
 * and go; left unchecked, the config grows into the tens of MB which slows
 * every save and load. Called once on config load.
 */
function pruneOrphanTerminalStates(cfg) {
  if (!cfg || typeof cfg !== 'object' || !cfg.projects) return;
  let prunedCount = 0;
  for (const proj of Object.values(cfg.projects)) {
    if (!proj || typeof proj !== 'object') continue;
    const states = proj.terminalStates;
    if (!states || typeof states !== 'object') continue;
    const liveIds = new Set();
    for (const t of (Array.isArray(proj.tabs) ? proj.tabs : [])) {
      if (t && typeof t.id === 'string') liveIds.add(t.id);
    }
    for (const c of (Array.isArray(proj.closedTabs) ? proj.closedTabs : [])) {
      if (c && typeof c.id === 'string') liveIds.add(c.id);
    }
    for (const tabId of Object.keys(states)) {
      if (!liveIds.has(tabId)) { delete states[tabId]; prunedCount += 1; }
    }
  }
  if (prunedCount > 0) {
    console.log(`[config-manager] pruned ${prunedCount} orphaned terminalStates`);
  }
}

/**
 * Atomic write (async) — write to a unique tmp then rename. Does not block the
 * main thread, which matters because writes can hit 100KB+ and they used to
 * stall every IPC round-trip while the renderer waited.
 *
 * Serialized through `writeChain` and given a per-call unique tmp name: a shared
 * tmp path let two overlapping writers race write→rename and leave config.json
 * truncated (the app's source of truth — accounts, projects, Asana PAT, tabs).
 * Errors are logged, never rethrown, so a single failed write can't poison the
 * chain and block every later write.
 */
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`;
  writeChain = writeChain.then(async () => {
    // If flushConfig already wrote synchronously at quit time, the queued
    // async write is stale by definition — skip it so it can't land after
    // the sync flush and clobber fresher state.
    if (flushed) return;
    try {
      await fsp.writeFile(tmp, data);
      if (flushed) { try { await fsp.unlink(tmp); } catch { /* ignore */ } return; }
      await fsp.rename(tmp, filePath);
    } catch (err) {
      console.warn('[config-manager] config write failed:', err.message);
      try { await fsp.unlink(tmp); } catch { /* nothing to clean up */ }
    }
  });
  return writeChain;
}

/**
 * Atomic write (sync) — used by flushConfig on app quit and the load-time
 * migration, where blocking is acceptable because we need the data to land
 * before continuing. Unique tmp so it never collides with an in-flight async
 * write's rename.
 */
function atomicWriteSync(filePath, data) {
  const tmp = `${filePath}.${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

/**
 * Resolve the scrollback file path for a (project, tab) pair. Uses the same
 * base64url encoding scheme as the per-project zsh-history dir.
 */
function getScrollbackPath(projectPath, tabId) {
  const encoded = Buffer.from(projectPath).toString('base64url');
  return path.join(SCROLLBACK_DIR, encoded, `${tabId}.scrollback.json`);
}

/**
 * Save a tab's scrollback to its own file. Replaces the old pattern of
 * stuffing scrollback into config.projects[*].terminalStates and rewriting
 * the whole config blob every 30s per tab.
 */
export async function saveTerminalScrollback(projectPath, tabId, state) {
  if (!projectPath || typeof projectPath !== 'string') return;
  if (!tabId || typeof tabId !== 'string') return;
  if (UNSAFE_KEYS.has(projectPath) || UNSAFE_KEYS.has(tabId)) return;
  const filePath = getScrollbackPath(projectPath, tabId);
  // Unique tmp suffix per call: concurrent saves for the same (project, tab)
  // can occur when a manual checkpoint fires alongside the 30s autosave.
  // A shared `.tmp` path would race write→rename and silently clobber.
  const tmpPath = `${filePath}.${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(tmpPath, JSON.stringify(state));
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    console.warn(`[config-manager] saveTerminalScrollback failed for ${tabId}: ${err.message}`);
    // Best-effort cleanup of orphan tmp file (rename failure leaves it behind).
    try { await fsp.unlink(tmpPath); } catch { /* nothing to do */ }
  }
}

/**
 * Load a tab's scrollback from its own file. Returns null if no file exists.
 */
export async function loadTerminalScrollback(projectPath, tabId) {
  if (!projectPath || !tabId) return null;
  try {
    const content = await fsp.readFile(getScrollbackPath(projectPath, tabId), 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * One-time migration: move every config.projects[*].terminalStates[*] with a
 * scrollback array into its per-tab file, then strip the inlined data from
 * config. Drops config.json from 13 MB to ~50 KB on first load after upgrade.
 */
function migrateScrollbackOutOfConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || !cfg.projects) return false;
  let migrated = 0;
  let configChanged = false;
  for (const [projectPath, proj] of Object.entries(cfg.projects)) {
    if (!proj?.terminalStates || typeof proj.terminalStates !== 'object') continue;
    for (const [tabId, state] of Object.entries(proj.terminalStates)) {
      if (!state || typeof state !== 'object') continue;
      if (Array.isArray(state.scrollback) && state.scrollback.length > 0) {
        try {
          const filePath = getScrollbackPath(projectPath, tabId);
          // Atomic per-file write (tmp + rename) — if the process dies between
          // write and rename, we leave the inline entry intact and the next
          // boot retries the migration. Without rename, a half-written file
          // could be returned by loadTerminalScrollback as valid scrollback.
          const tmpPath = `${filePath}.migrate.${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`;
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(tmpPath, JSON.stringify(state));
          fs.renameSync(tmpPath, filePath);
          delete proj.terminalStates[tabId];
          migrated += 1;
          configChanged = true;
        } catch (err) {
          console.warn(`[config-manager] migrate failed for ${tabId}: ${err.message}`);
        }
      }
    }
    if (Object.keys(proj.terminalStates).length === 0) {
      delete proj.terminalStates;
      configChanged = true;
    }
  }
  if (migrated > 0) {
    console.log(`[config-manager] migrated ${migrated} scrollback entries to per-tab files`);
  }
  return configChanged;
}

/**
 * Load config from disk or return defaults.
 */
export function loadConfig() {
  if (configCache) return configCache;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      let loaded;
      try {
        loaded = JSON.parse(content);
      } catch (parseErr) {
        // CRITICAL: previously this silently reset configCache to DEFAULT_CONFIG
        // on parse failure. Accounts, Asana PAT, tabs, every per-project
        // setting were destroyed permanently. Now we BACK UP the corrupt
        // file with a timestamp suffix and surface the error so the user
        // can recover by hand. Apple-grade audit P2 from UX agent.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${CONFIG_PATH}.corrupt-${stamp}.bak`;
        try {
          fs.copyFileSync(CONFIG_PATH, backupPath);
          console.error(`[config-manager] CORRUPT CONFIG, original saved at: ${backupPath}`);
          console.error(`[config-manager] parse error: ${parseErr.message}`);
        } catch (cpErr) {
          console.error(`[config-manager] CORRUPT CONFIG and backup FAILED: ${cpErr.message}`);
        }
        // Use defaults this session, but DO NOT overwrite the on-disk file
        // until the user takes an action that triggers saveConfig. That way
        // a separate process or manual fix to the corrupt file is recoverable.
        configCache = { ...DEFAULT_CONFIG, __loadedFromCorrupt: true, __corruptBackup: backupPath };
        return configCache;
      }
      // Sanitize unsafe keys from nested objects (prototype pollution guard)
      for (const topKey of ['agentMemory', 'sessionTags', 'sessionTabMap', 'projects', 'orchestrationRuns', 'imessageBridge', 'workRegistry', 'asanaQueue', 'scheduledTasks']) {
        if (loaded[topKey] && typeof loaded[topKey] === 'object') {
          for (const key of UNSAFE_KEYS) delete loaded[topKey][key];
        }
      }
      configCache = { ...DEFAULT_CONFIG, ...loaded };
      pruneOrphanTerminalStates(configCache);
      const migrated = migrateScrollbackOutOfConfig(configCache);
      if (migrated) {
        try {
          atomicWriteSync(CONFIG_PATH, JSON.stringify(configCache, null, 2));
        } catch (err) {
          console.warn('[config-manager] post-migration save failed:', err.message);
        }
      }
    } else {
      configCache = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.warn('[config-manager] Failed to load config:', err.message);
    configCache = { ...DEFAULT_CONFIG };
  }
  return configCache;
}

/**
 * Save config to disk (debounced 500ms, atomic write, ASYNC I/O).
 * The async write means the main process keeps responding to IPC while the
 * file is being written. Previously, sync writes stalled every IPC round-trip.
 */
export function saveConfig(config) {
  if (!configCache) loadConfig();
  if (config && config === configCache) {
    // Native writers do loadConfig() → mutate the live cache → saveConfig(cache).
    // The cache already holds their change; nothing to merge.
  } else if (config && typeof config === 'object') {
    // A foreign full object (renderer config:save) is a stale whole-config
    // snapshot. Replacing the cache with it would clobber changes other writers
    // made since that snapshot (e.g. a tab/grid save dropped by a Git-dir save).
    // config:save callers only set top-level SCALAR keys (gitProjectDir,
    // monitoredBuildDir), so apply just those onto the live cache and leave the
    // object/array sections — owned by their dedicated writers — untouched.
    mergeForeignScalars(config);
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
    } catch (err) {
      console.warn('[config-manager] mkdir failed:', err.message);
      return;
    }
    // Persist the LIVE cache (not the captured arg) so a coalesced write always
    // flushes the freshest merged state. The write is serialized in atomicWrite.
    void atomicWrite(CONFIG_PATH, JSON.stringify(configCache, null, 2));
  }, 500);
}

// Apply only top-level scalar keys of a foreign whole-config snapshot onto the
// live cache (add/update, and honor deletions of scalar keys). Object/array
// sections are skipped so a stale snapshot can never overwrite the nested state
// (projects, settings, accounts, …) that other writers manage concurrently.
function mergeForeignScalars(foreign) {
  if (!configCache) return;
  const isScalar = (v) => v === null || typeof v !== 'object';
  for (const [key, value] of Object.entries(foreign)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (isScalar(value)) configCache[key] = value;
  }
  for (const key of Object.keys(configCache)) {
    if (isScalar(configCache[key]) && !(key in foreign)) delete configCache[key];
  }
}

/**
 * Get per-project config.
 */
export function getProjectConfig(projectPath) {
  const config = loadConfig();
  return config.projects[projectPath] || { themeIndex: config.defaultTheme };
}

/**
 * Set per-project config (merge with prototype pollution guard).
 */
export function setProjectConfig(projectPath, settings) {
  if (UNSAFE_KEYS.has(projectPath)) return;
  if (!settings || typeof settings !== 'object') return;
  const config = loadConfig();
  const existing = config.projects[projectPath] || {};
  const sanitized = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!UNSAFE_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  config.projects[projectPath] = { ...existing, ...sanitized };
  saveConfig(config);
}

/**
 * Get global settings.
 */
export function getSettings() {
  const config = loadConfig();
  return { ...DEFAULT_CONFIG.settings, ...config.settings };
}

/**
 * Update global settings (merge).
 */
export function updateSettings(updates) {
  if (!updates || typeof updates !== 'object') return;
  const config = loadConfig();
  const sanitized = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!UNSAFE_KEYS.has(key)) sanitized[key] = value;
  }
  config.settings = { ...DEFAULT_CONFIG.settings, ...config.settings, ...sanitized };
  saveConfig(config);
  return config.settings;
}

/**
 * Get iMessage bridge config.
 */
export function getImessageBridge() {
  const config = loadConfig();
  return { ...DEFAULT_CONFIG.imessageBridge, ...config.imessageBridge };
}

/**
 * Get autoResume config (the v1.0.30 staggered re-engage-on-launch feature).
 */
export function getAutoResume() {
  const config = loadConfig();
  return { ...DEFAULT_CONFIG.autoResume, ...(config.autoResume || {}) };
}

/**
 * Update autoResume config (merge with sanitize). Renderer Settings UI
 * writes here when the user toggles or tunes stagger.
 */
export function updateAutoResume(updates) {
  if (!updates || typeof updates !== 'object') return getAutoResume();
  const config = loadConfig();
  const sanitized = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!UNSAFE_KEYS.has(key)) sanitized[key] = value;
  }
  // Coerce + clamp to safe ranges so a bad UI write can't make the queue toxic.
  if ('enabled' in sanitized) sanitized.enabled = !!sanitized.enabled;
  if ('staggerMs' in sanitized) {
    const n = Number(sanitized.staggerMs);
    sanitized.staggerMs = Number.isFinite(n) ? Math.max(10, Math.min(2000, n)) : 50;
  }
  if ('skipOversizedMB' in sanitized) {
    const n = Number(sanitized.skipOversizedMB);
    sanitized.skipOversizedMB = Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : 80;
  }
  if ('cancelOnUserInput' in sanitized) sanitized.cancelOnUserInput = !!sanitized.cancelOnUserInput;
  config.autoResume = { ...DEFAULT_CONFIG.autoResume, ...(config.autoResume || {}), ...sanitized };
  saveConfig(config);
  return config.autoResume;
}

/**
 * Update iMessage bridge config (merge with sanitize).
 */
export function updateImessageBridge(updates) {
  if (!updates || typeof updates !== 'object') return getImessageBridge();
  const config = loadConfig();
  const sanitized = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!UNSAFE_KEYS.has(key)) sanitized[key] = value;
  }
  config.imessageBridge = { ...DEFAULT_CONFIG.imessageBridge, ...config.imessageBridge, ...sanitized };
  saveConfig(config);
  return config.imessageBridge;
}

/**
 * Get mobile server config (enabled state, port, paired devices).
 */
export function getMobileServerConfig() {
  const config = loadConfig();
  return { ...DEFAULT_CONFIG.mobileServer, ...config.mobileServer };
}

/**
 * Update mobile server config (merge).
 */
export function updateMobileServerConfig(updates) {
  if (!updates || typeof updates !== 'object') return getMobileServerConfig();
  const config = loadConfig();
  const sanitized = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!UNSAFE_KEYS.has(key)) sanitized[key] = value;
  }
  config.mobileServer = { ...DEFAULT_CONFIG.mobileServer, ...config.mobileServer, ...sanitized };
  saveConfig(config);
  return config.mobileServer;
}

/**
 * Get pinned session IDs.
 */
export function getPinnedSessions() {
  const config = loadConfig();
  return config.pinnedSessions || [];
}

/**
 * Set pinned session IDs.
 */
export function setPinnedSessions(sessionIds) {
  const config = loadConfig();
  config.pinnedSessions = sessionIds;
  saveConfig(config);
}

/**
 * Get pinned project paths.
 */
export function getPinnedProjects() {
  const config = loadConfig();
  return config.pinnedProjects || [];
}

/**
 * Set pinned project paths.
 */
export function setPinnedProjects(projectPaths) {
  const config = loadConfig();
  config.pinnedProjects = Array.isArray(projectPaths) ? projectPaths : [];
  saveConfig(config);
}

/**
 * Get manually-added project paths (picked via folder dialog, no session required).
 */
export function getManualProjects() {
  const config = loadConfig();
  return config.manualProjects || [];
}

/**
 * Add a path to the manually-added project list (deduped).
 */
export function addManualProject(projectPath) {
  const config = loadConfig();
  const existing = config.manualProjects || [];
  // Always also clear the hidden marker. Without this, removing then
  // re-adding the same folder left it filtered out of listProjects()
  // permanently with no in-UI way to recover. Codex PR#3 r20 P2.
  const wasHidden = (config.hiddenProjects || []).includes(projectPath);
  if (wasHidden) {
    config.hiddenProjects = (config.hiddenProjects || []).filter((p) => p !== projectPath);
  }
  const alreadyManual = existing.includes(projectPath);
  if (!alreadyManual) {
    config.manualProjects = [...existing, projectPath];
  }
  if (wasHidden || !alreadyManual) {
    saveConfig(config);
  }
}

export function getProjectDisplayNames() {
  return loadConfig().projectDisplayNames || {};
}

export function setProjectDisplayName(projectPath, name) {
  const config = loadConfig();
  if (!config.projectDisplayNames) config.projectDisplayNames = {};
  if (name && name.trim()) {
    config.projectDisplayNames[projectPath] = name.trim();
  } else {
    delete config.projectDisplayNames[projectPath];
  }
  saveConfig(config);
}

export function getHiddenProjects() {
  return loadConfig().hiddenProjects || [];
}

export function addHiddenProject(projectPath) {
  const config = loadConfig();
  const existing = config.hiddenProjects || [];
  if (!existing.includes(projectPath)) {
    config.hiddenProjects = [...existing, projectPath];
    // Also remove from manual projects if present
    config.manualProjects = (config.manualProjects || []).filter((p) => p !== projectPath);
    saveConfig(config);
  }
}

// Session tag colors
const TAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];

/**
 * Get all session tags. Returns map of sessionId → { label, color }.
 */
export function getSessionTags() {
  const config = loadConfig();
  return config.sessionTags || {};
}

/**
 * Set or update a session tag.
 */
export function setSessionTag(sessionId, label, color) {
  if (!sessionId || typeof sessionId !== 'string') return;
  if (UNSAFE_KEYS.has(sessionId)) return;
  if (!label || typeof label !== 'string') return;
  const safeLabel = label.slice(0, 50);
  const safeColor = TAG_COLORS.includes(color) ? color : 'blue';
  const config = loadConfig();
  if (!config.sessionTags || typeof config.sessionTags !== 'object') {
    config.sessionTags = {};
  }
  config.sessionTags[sessionId] = { label: safeLabel, color: safeColor };
  saveConfig(config);
}

/**
 * Remove a session tag.
 */
export function removeSessionTag(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return;
  const config = loadConfig();
  if (config.sessionTags) {
    delete config.sessionTags[sessionId];
    saveConfig(config);
  }
}

// sessionTabMap links a Claude session to the terminal tab it was resumed in,
// so the sidebar can show which tab a session belongs to. Entries older than
// this are pruned on read to bound growth.
const SESSION_TAB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TAB_ID_RE = /^term-.+-\d+$/;

/**
 * Get the sessionId → { tabId, projectPath, capturedAt } map, pruned of
 * entries older than 30 days.
 */
export function getSessionTabMap() {
  const config = loadConfig();
  const map = config.sessionTabMap;
  if (!map || typeof map !== 'object') return {};
  const cutoff = Date.now() - SESSION_TAB_MAX_AGE_MS;
  let pruned = false;
  for (const [sid, entry] of Object.entries(map)) {
    if (!entry || typeof entry.capturedAt !== 'number' || entry.capturedAt < cutoff) {
      delete map[sid];
      pruned = true;
    }
  }
  if (pruned) saveConfig(config);
  // Return a shallow copy so callers can't mutate the live config object.
  return { ...map };
}

/**
 * Link a session to the terminal tab it is running in.
 *
 * @param {'argv'|'fresh'} [resolvedBy] how we know this link is true.
 *   'argv'  the tab's own `claude --resume <id>` command line carries the id.
 *           CERTAIN, and the only kind auto-resume will act on.
 *   'fresh' a bare `claude` with no id in its argv, matched to a transcript by
 *           correlating process start time to file birth time. A HEURISTIC:
 *           the transcript records no pid (checked), so when two claudes in a
 *           project could both have written a file there is no signal that
 *           separates them. Good enough to NAME a tab, never good enough to
 *           TYPE `claude --resume <id>` into a live terminal. See auto-resume.js.
 */
export function setSessionTabLink(sessionId, tabId, projectPath, resolvedBy = 'argv') {
  if (!sessionId || typeof sessionId !== 'string' || UNSAFE_KEYS.has(sessionId)) return;
  if (sessionId.length > 100) return;
  if (!tabId || typeof tabId !== 'string' || !TAB_ID_RE.test(tabId)) return;
  const config = loadConfig();
  if (!config.sessionTabMap || typeof config.sessionTabMap !== 'object') {
    config.sessionTabMap = {};
  }
  config.sessionTabMap[sessionId] = {
    tabId,
    projectPath: typeof projectPath === 'string' ? projectPath : '',
    resolvedBy: resolvedBy === 'fresh' ? 'fresh' : 'argv',
    capturedAt: Date.now(),
    // Freshness stamp: updated every Tier-2 capture tick while the session is
    // ACTIVELY running in the tab. Auto-resume only trusts links whose
    // lastRunningAt is near lastQuitAt, which kills the stale-link class of
    // bug (v1.0.35: 19-28 day old links were auto-resumed into fresh tabs).
    lastRunningAt: Date.now(),
  };
  saveConfig(config);
}

/**
 * Refresh the lastRunningAt stamp on an existing link WITHOUT resetting
 * capturedAt. Called by the Tier-2 capture loop each 15s tick for every
 * session it observes actively running. Cheap no-op if the link is gone.
 */
export function touchSessionTabLink(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || UNSAFE_KEYS.has(sessionId)) return;
  const config = loadConfig();
  const entry = config.sessionTabMap?.[sessionId];
  if (!entry) return;
  entry.lastRunningAt = Date.now();
  saveConfig(config);
}

/**
 * Zero the lastRunningAt stamp when the capture loop observes the session's
 * Claude process has EXITED while the tab stays open. Without this, quitting
 * within the freshness slack after stopping Claude would still auto-resume a
 * session that was not actually running at quit. Codex v1.0.35 r3 P2.
 */
export function clearSessionTabRunning(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || UNSAFE_KEYS.has(sessionId)) return;
  const config = loadConfig();
  const entry = config.sessionTabMap?.[sessionId];
  if (!entry || !entry.lastRunningAt) return;
  entry.lastRunningAt = 0;
  saveConfig(config);
}

/**
 * Remove a session-to-tab link.
 */
export function removeSessionTabLink(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return;
  const config = loadConfig();
  if (config.sessionTabMap) {
    delete config.sessionTabMap[sessionId];
    saveConfig(config);
  }
}

// --- Agent Memory ---

const MEMORY_DEFAULTS = { context: '', journal: [], experience: [], lastUpdated: 0 };
const MAX_CONTEXT_LEN = 5000;
const MAX_JOURNAL = 50;
const MAX_EXPERIENCE = 20;
const MAX_EXPERIENCE_LEN = 200;

/**
 * Get agent memory for a specific agent. Returns default if none exists.
 */
export function getAgentMemory(agentId) {
  if (!agentId || typeof agentId !== 'string' || UNSAFE_KEYS.has(agentId)) {
    return { ...MEMORY_DEFAULTS, journal: [], experience: [] };
  }
  const config = loadConfig();
  const mem = config.agentMemory?.[agentId];
  if (!mem || typeof mem !== 'object') {
    return { ...MEMORY_DEFAULTS, journal: [], experience: [] };
  }
  return {
    context: typeof mem.context === 'string' ? mem.context : '',
    journal: Array.isArray(mem.journal) ? mem.journal : [],
    experience: Array.isArray(mem.experience) ? mem.experience : [],
    lastUpdated: typeof mem.lastUpdated === 'number' ? mem.lastUpdated : 0,
  };
}

/**
 * Set agent memory (full replace with validation).
 */
export function setAgentMemory(agentId, memory) {
  if (!agentId || typeof agentId !== 'string' || UNSAFE_KEYS.has(agentId)) return;
  if (!memory || typeof memory !== 'object') return;
  const config = loadConfig();
  if (!config.agentMemory || typeof config.agentMemory !== 'object') {
    config.agentMemory = {};
  }
  config.agentMemory[agentId] = {
    context: typeof memory.context === 'string' ? memory.context.slice(0, MAX_CONTEXT_LEN) : '',
    journal: Array.isArray(memory.journal) ? memory.journal.slice(-MAX_JOURNAL) : [],
    experience: Array.isArray(memory.experience)
      ? memory.experience.slice(0, MAX_EXPERIENCE).map((e) => String(e).slice(0, MAX_EXPERIENCE_LEN))
      : [],
    lastUpdated: Date.now(),
  };
  saveConfig(config);
}

/**
 * Append a journal entry for an agent (FIFO, max 50).
 */
export function appendJournalEntry(agentId, entry) {
  if (!agentId || typeof agentId !== 'string' || UNSAFE_KEYS.has(agentId)) return;
  if (!entry || typeof entry !== 'object') return;
  const config = loadConfig();
  if (!config.agentMemory || typeof config.agentMemory !== 'object') {
    config.agentMemory = {};
  }
  if (!config.agentMemory[agentId] || typeof config.agentMemory[agentId] !== 'object') {
    config.agentMemory[agentId] = { ...MEMORY_DEFAULTS, journal: [], experience: [] };
  }
  const mem = config.agentMemory[agentId];
  if (!Array.isArray(mem.journal)) mem.journal = [];
  const sanitized = {
    id: typeof entry.id === 'string' ? entry.id.slice(0, 50) : `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
    duration: typeof entry.duration === 'number' ? Math.max(0, entry.duration) : 0,
    projectPath: typeof entry.projectPath === 'string' ? entry.projectPath.slice(0, 500) : '',
    exitCode: typeof entry.exitCode === 'number' ? entry.exitCode : null,
    summary: typeof entry.summary === 'string' ? entry.summary.slice(0, 500) : '',
    linesOutput: typeof entry.linesOutput === 'number' ? Math.max(0, entry.linesOutput) : 0,
  };
  mem.journal.push(sanitized);
  if (mem.journal.length > MAX_JOURNAL) {
    mem.journal = mem.journal.slice(-MAX_JOURNAL);
  }
  mem.lastUpdated = Date.now();
  saveConfig(config);
  // Auto-prune old entries across all agents
  pruneOldMemory(90);
}

/**
 * Prune agent memory entries older than maxAgeDays.
 */
export function pruneOldMemory(maxAgeDays = 90) {
  const config = loadConfig();
  if (!config.agentMemory || typeof config.agentMemory !== 'object') return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const agentId of Object.keys(config.agentMemory)) {
    if (UNSAFE_KEYS.has(agentId)) continue;
    const mem = config.agentMemory[agentId];
    if (!mem || !Array.isArray(mem.journal)) continue;
    const before = mem.journal.length;
    mem.journal = mem.journal.filter((e) => (e.timestamp || 0) > cutoff);
    if (mem.journal.length !== before) changed = true;
  }
  if (changed) saveConfig(config);
}

// --- Orchestration Runs ---

const MAX_ORCHESTRATION_RUNS = 20;
const MAX_SUBTASKS = 5;

/**
 * Get all orchestration runs (max 20).
 */
export function getOrchestrationRuns() {
  const config = loadConfig();
  return Array.isArray(config.orchestrationRuns) ? config.orchestrationRuns : [];
}

/**
 * Get a single orchestration run by ID.
 */
export function getOrchestrationRun(runId) {
  if (!runId || typeof runId !== 'string') return null;
  const runs = getOrchestrationRuns();
  return runs.find((r) => r.id === runId) || null;
}

/**
 * Save (create or update) an orchestration run. FIFO at max 20.
 */
export function saveOrchestrationRun(run) {
  if (!run || typeof run !== 'object' || !run.id || typeof run.id !== 'string') return null;
  if (UNSAFE_KEYS.has(run.id)) return null;
  const config = loadConfig();
  if (!Array.isArray(config.orchestrationRuns)) config.orchestrationRuns = [];

  // Validate and sanitize
  const sanitized = {
    id: run.id.slice(0, 100),
    description: typeof run.description === 'string' ? run.description.slice(0, 2000) : '',
    createdAt: typeof run.createdAt === 'number' ? run.createdAt : Date.now(),
    status: ['planning', 'running', 'completed', 'failed'].includes(run.status) ? run.status : 'planning',
    subtasks: Array.isArray(run.subtasks)
      ? run.subtasks.slice(0, MAX_SUBTASKS).map((st) => ({
          id: typeof st.id === 'string' ? st.id.slice(0, 50) : '',
          title: typeof st.title === 'string' ? st.title.slice(0, 200) : '',
          description: typeof st.description === 'string' ? st.description.slice(0, 2000) : '',
          agentId: (typeof st.agentId === 'string' && st.agentId.length > 0) ? st.agentId.slice(0, 200) : '',
          tabId: typeof st.tabId === 'string' ? st.tabId : null,
          status: ['pending', 'running', 'completed', 'failed'].includes(st.status) ? st.status : 'pending',
          startedAt: typeof st.startedAt === 'number' ? st.startedAt : null,
          completedAt: typeof st.completedAt === 'number' ? st.completedAt : null,
          exitCode: typeof st.exitCode === 'number' ? st.exitCode : null,
          outputSummary: typeof st.outputSummary === 'string' ? st.outputSummary.slice(0, 2000) : null,
        }))
      : [],
    synthesis: typeof run.synthesis === 'string' ? run.synthesis.slice(0, 5000) : null,
    completedAt: typeof run.completedAt === 'number' ? run.completedAt : null,
  };

  const idx = config.orchestrationRuns.findIndex((r) => r.id === sanitized.id);
  if (idx >= 0) {
    config.orchestrationRuns[idx] = sanitized;
  } else {
    config.orchestrationRuns.push(sanitized);
    // FIFO: remove oldest when exceeding limit
    while (config.orchestrationRuns.length > MAX_ORCHESTRATION_RUNS) {
      config.orchestrationRuns.shift();
    }
  }
  saveConfig(config);
  return sanitized;
}

/**
 * Delete an orchestration run by ID.
 */
export function deleteOrchestrationRun(runId) {
  if (!runId || typeof runId !== 'string') return;
  const config = loadConfig();
  if (!Array.isArray(config.orchestrationRuns)) return;
  config.orchestrationRuns = config.orchestrationRuns.filter((r) => r.id !== runId);
  saveConfig(config);
}

// --- Account Management ---

const ACCOUNT_TYPES = new Set(['claude', 'codex']);

export function getAccounts() {
  return loadConfig().accounts || [];
}

export function saveAccount(account) {
  if (!account || typeof account !== 'object') return null;
  const id = account.id || `acct-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (!ACCOUNT_TYPES.has(account.type)) return null;
  // SECURITY: validate claudeJsonPath lives under ~/.claude-profiles. Without
  // this, a crafted accountsSave call could persist an arbitrary path (e.g.
  // /etc/passwd, ~/.ssh/id_rsa) and later activating the account would copy
  // that file over ~/.claude.json. Codex PR#3 r21 P2.
  const profilesRoot = path.join(os.homedir(), '.claude-profiles');
  function safeClaudeJsonPath(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return null;
    const resolved = path.resolve(raw);
    if (resolved !== profilesRoot && !resolved.startsWith(profilesRoot + path.sep)) return null;
    return resolved;
  }
  const claudeJsonPath = account.type === 'claude'
    ? safeClaudeJsonPath(account.claudeJsonPath)
    : null;
  const sanitized = {
    id,
    name: typeof account.name === 'string' ? account.name.slice(0, 100) : 'Unnamed',
    type: account.type,
    ...(claudeJsonPath ? { claudeJsonPath } : {}),
    ...(account.type === 'claude' && account.cliPath
      ? { cliPath: String(account.cliPath).slice(0, 500) }
      : {}),
    ...(account.type === 'codex' && account.apiKey
      ? { apiKey: String(account.apiKey).slice(0, 200) }
      : {}),
  };
  const config = loadConfig();
  if (!Array.isArray(config.accounts)) config.accounts = [];
  const idx = config.accounts.findIndex((a) => a.id === id);
  if (idx >= 0) config.accounts[idx] = sanitized;
  else config.accounts.push(sanitized);
  saveConfig(config);
  return sanitized;
}

export function deleteAccount(accountId) {
  if (!accountId || typeof accountId !== 'string') return;
  const config = loadConfig();
  config.accounts = (config.accounts || []).filter((a) => a.id !== accountId);
  // Remove any project assignments pointing to this account
  if (config.projectAccounts) {
    for (const [k, v] of Object.entries(config.projectAccounts)) {
      if (v === accountId) delete config.projectAccounts[k];
    }
  }
  saveConfig(config);
}

export function getProjectAccount(projectPath) {
  const config = loadConfig();
  const accountId = config.projectAccounts?.[projectPath];
  if (!accountId) return null;
  return (config.accounts || []).find((a) => a.id === accountId) || null;
}

export function setProjectAccount(projectPath, accountId) {
  if (!projectPath || typeof projectPath !== 'string' || UNSAFE_KEYS.has(projectPath)) return;
  const config = loadConfig();
  if (!config.projectAccounts) config.projectAccounts = {};
  if (accountId) config.projectAccounts[projectPath] = accountId;
  else delete config.projectAccounts[projectPath];
  saveConfig(config);
}

/**
 * Flush any pending config save immediately (synchronous, atomic).
 * Call this in before-quit to avoid losing recent changes.
 */
export function getAsanaQueue() {
  const config = loadConfig();
  return {
    ...DEFAULT_CONFIG.asanaQueue,
    ...config.asanaQueue,
    autoMode: { ...DEFAULT_CONFIG.asanaQueue.autoMode, ...(config.asanaQueue?.autoMode || {}) },
  };
}

export function updateAsanaQueue(updates) {
  const config = loadConfig();
  const allowed = ['pat', 'allowedProjects', 'myGid', 'reviewGid', 'docsFolder'];
  const safe = Object.fromEntries(
    Object.entries(updates || {}).filter(([k]) => allowed.includes(k))
  );
  config.asanaQueue = { ...DEFAULT_CONFIG.asanaQueue, ...config.asanaQueue, ...safe };
  saveConfig(config);
}

// Async drain variant — awaits any queued atomicWrite calls before doing
// the sync flush. This is the watertight version: a mid-flight rename
// can't land AFTER a sync flush because we wait for it first.
// Callers in before-quit MUST await this (preventDefault + app.quit()).
export async function flushConfigAsync() {
  // Wait for any pending writes to land BEFORE latching flushed. After this
  // point, any NEW atomicWrite calls will be queued onto a chain that we
  // immediately disarm via the flushed flag.
  try { await writeChain; } catch { /* drain errors are already logged */ }
  return flushConfigSyncTail();
}

/**
 * Non-latching drain. Waits for the current writeChain to settle so an
 * immediately-following `saveConfig` sees a clean chain, but does NOT set
 * the shutdown flag. Use this from RUNTIME code paths (e.g. Auto Mode
 * persisting a seen task gid before the app might crash) that want a
 * synchronization point without breaking future writes.
 * Codex Apple-grade audit v1.0.32 P2 (auto-mode was latching the shutdown
 * flag on every dispatched task, silently killing subsequent config
 * persistence for accounts / tabs / settings until relaunch).
 */
export async function drainConfigWrites() {
  try { await writeChain; } catch { /* drain errors are already logged */ }
}

export function flushConfig() {
  // Legacy sync entrypoint. Does NOT drain the chain — pending async writes
  // CAN still land after this returns (the race Codex called out). Use
  // flushConfigAsync() instead. Kept here for the brief startup paths that
  // still need a non-blocking sync flush.
  return flushConfigSyncTail();
}

function flushConfigSyncTail() {
  flushed = true;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (configCache) {
      try {
        if (!fs.existsSync(CONFIG_DIR)) {
          fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        atomicWriteSync(CONFIG_PATH, JSON.stringify(configCache, null, 2));
      } catch (err) {
        console.warn('[config-manager] Failed to flush config:', err.message);
      }
    }
  }
}
