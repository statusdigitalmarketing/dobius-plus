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
      configCache = { ...DEFAULT_CONFIG, ...JSON.parse(content) };
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
