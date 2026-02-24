import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const CONFIG_DIR = path.join(app.getPath('userData'));
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const CONFIG_TMP = path.join(CONFIG_DIR, 'config.json.tmp');

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DEFAULT_CONFIG = {
  defaultTheme: 0,
  projects: {},
  pinnedSessions: [],
  launcherBounds: null,
  settings: {
    projectScanDir: '',
    scrollbackLines: 1000,
    terminalFontSize: 13,
    sidebarDefaultOpen: false,
  },
};

let configCache = null;
let saveTimer = null;

/**
 * Atomic write — write to tmp then rename (prevents corruption on crash).
 */
function atomicWriteSync(filePath, data) {
  fs.writeFileSync(CONFIG_TMP, data);
  fs.renameSync(CONFIG_TMP, filePath);
}

/**
 * Load config from disk or return defaults.
 */
export function loadConfig() {
  if (configCache) return configCache;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const loaded = JSON.parse(content);
      // Sanitize unsafe keys from nested objects (prototype pollution guard)
      for (const topKey of ['agentMemory', 'sessionTags', 'projects']) {
        if (loaded[topKey] && typeof loaded[topKey] === 'object') {
          for (const key of UNSAFE_KEYS) delete loaded[topKey][key];
        }
      }
      configCache = { ...DEFAULT_CONFIG, ...loaded };
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
 * Save config to disk (debounced 500ms, atomic write).
 */
export function saveConfig(config) {
  configCache = config;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      atomicWriteSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (err) {
      console.warn('[config-manager] Failed to save config:', err.message);
    }
  }, 500);
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

/**
 * Flush any pending config save immediately (synchronous, atomic).
 * Call this in before-quit to avoid losing recent changes.
 */
export function flushConfig() {
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
