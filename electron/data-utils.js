import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const HISTORY_PATH = path.join(CLAUDE_DIR, 'history.jsonl');
export const STATS_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
export const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
export const CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json');
export const MCP_BRIDGE_CONFIG = path.join(CLAUDE_DIR, 'mcp-bridge.json');
export const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');
export const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/**
 * Parse a JSONL file asynchronously, skipping malformed lines.
 */
export async function parseJsonl(filePath, limit = 0) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const parsedLines = [];
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    if (limit > 0) {
      return parsedLines.slice(-limit);
    }
    return parsedLines;
  } catch (err) {
    console.warn(`[data-utils] Failed to parse ${filePath}:`, err.message);
    return [];
  }
}

/**
 * Calculate time ago string from timestamp.
 */
export function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Check if a path exists (async).
 */
export async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
