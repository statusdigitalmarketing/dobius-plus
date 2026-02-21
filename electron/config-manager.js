import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const CONFIG_DIR = path.join(app.getPath('userData'));
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  defaultTheme: 0,
  projects: {},
  pinnedSessions: [],
  launcherBounds: null,
};

let configCache = null;
let saveTimer = null;

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
 * Save config to disk (debounced 500ms).
 */
export function saveConfig(config) {
  configCache = config;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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
 * Set per-project config (merge).
 */
export function setProjectConfig(projectPath, settings) {
  // Guard against prototype pollution
  if (['__proto__', 'constructor', 'prototype'].includes(projectPath)) return;
  const config = loadConfig();
  config.projects[projectPath] = {
    ...(config.projects[projectPath] || {}),
    ...settings,
  };
  saveConfig(config);
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
 * Flush any pending config save immediately (synchronous).
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
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configCache, null, 2));
      } catch (err) {
        console.warn('[config-manager] Failed to flush config:', err.message);
      }
    }
  }
}
