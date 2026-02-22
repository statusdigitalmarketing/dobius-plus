import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import {
  HISTORY_PATH, STATS_PATH, SETTINGS_PATH, CLAUDE_JSON_PATH, MCP_BRIDGE_CONFIG, PLANS_DIR, SKILLS_DIR, PROJECTS_DIR,
  parseJsonl, timeAgo, pathExists,
} from './data-utils.js';
import { getSettings } from './config-manager.js';

/**
 * Load session history from ~/.claude/history.jsonl
 * Returns array of sessions, deduped by sessionId, sorted by timestamp desc, limited to 100.
 */
export async function loadHistory() {
  const entries = await parseJsonl(HISTORY_PATH);
  const bySession = new Map();
  for (const entry of entries) {
    if (entry.sessionId) {
      const existing = bySession.get(entry.sessionId);
      if (!existing || (entry.timestamp && entry.timestamp >= existing.timestamp)) {
        bySession.set(entry.sessionId, entry);
      }
    }
  }
  return Array.from(bySession.values())
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 100)
    .map((entry) => ({
      sessionId: entry.sessionId,
      project: entry.project || '',
      display: entry.display || '',
      timestamp: entry.timestamp || 0,
      age: timeAgo(entry.timestamp || 0),
    }));
}

/**
 * Load stats from ~/.claude/stats-cache.json
 */
export async function loadStats() {
  try {
    const content = await fs.readFile(STATS_PATH, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.warn('[data-service] Failed to load stats:', err.message);
    return { version: 2, dailyActivity: [], modelUsage: {}, hourCounts: {} };
  }
}

/**
 * Load settings from ~/.claude/settings.json + ~/.claude.json (user-scope MCP servers)
 */
export async function loadSettings() {
  let hooks = {};
  let mcpServers = {};
  let enabledPlugins = [];

  // Read ~/.claude/settings.json
  try {
    const content = await fs.readFile(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(content);
    hooks = settings.hooks || {};
    mcpServers = { ...mcpServers, ...(settings.mcpServers || {}) };
    enabledPlugins = settings.enabledPlugins || [];
  } catch {
    void 0;
  }

  // Read ~/.claude.json (user-scope servers from `claude mcp add -s user`)
  try {
    const content = await fs.readFile(CLAUDE_JSON_PATH, 'utf8');
    const claudeJson = JSON.parse(content);
    if (claudeJson.mcpServers) {
      mcpServers = { ...mcpServers, ...claudeJson.mcpServers };
    }
    // Also check project-scoped servers
    if (claudeJson.projects) {
      for (const proj of Object.values(claudeJson.projects)) {
        if (proj.mcpServers) {
          mcpServers = { ...mcpServers, ...proj.mcpServers };
        }
      }
    }
  } catch {
    void 0;
  }

  return { hooks, mcpServers, enabledPlugins };
}

/**
 * Load bridge servers from ~/.claude/mcp-bridge.json
 */
export async function loadBridgeServers() {
  try {
    const content = await fs.readFile(MCP_BRIDGE_CONFIG, 'utf8');
    const config = JSON.parse(content);
    return config.servers || {};
  } catch {
    return {};
  }
}

/**
 * Load plan files from ~/.claude/plans/
 */
export async function loadPlans() {
  try {
    if (!(await pathExists(PLANS_DIR))) return [];
    const files = (await fs.readdir(PLANS_DIR)).filter((f) => f.endsWith('.md'));
    const plans = await Promise.all(files.map(async (f) => {
      const filePath = path.join(PLANS_DIR, f);
      const stat = await fs.stat(filePath);
      return {
        name: f.replace('.md', ''),
        path: filePath,
        modifiedTime: stat.mtime.toISOString(),
      };
    }));
    return plans.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  } catch (err) {
    console.warn('[data-service] Failed to load plans:', err.message);
    return [];
  }
}

/**
 * Read a plan file's content by name.
 */
export async function readPlanFile(planName) {
  try {
    if (!/^[\w\s\-]+$/.test(planName)) return '';
    const filePath = path.join(PLANS_DIR, `${planName}.md`);
    // Ensure resolved path stays within PLANS_DIR (prevent traversal)
    if (!path.resolve(filePath).startsWith(path.resolve(PLANS_DIR))) return '';
    if (!(await pathExists(filePath))) return '';
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    console.warn('[data-service] Failed to read plan file:', err.message);
    return '';
  }
}

/**
 * Load installed skills from ~/.claude/skills/
 */
export async function loadSkills() {
  try {
    if (!(await pathExists(SKILLS_DIR))) return [];
    const dirents = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    const dirs = dirents.filter((d) => d.isDirectory());
    return Promise.all(dirs.map(async (d) => {
      const skillDir = path.join(SKILLS_DIR, d.name);
      const skillMd = path.join(skillDir, 'SKILL.md');
      let description = '';
      try {
        const content = await fs.readFile(skillMd, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.startsWith('description:')) {
            description = line.replace('description:', '').trim().replace(/^["']|["']$/g, '');
            break;
          }
        }
        if (!description && lines.length > 0) {
          description = lines.find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---')) || '';
        }
      } catch {
        void 0;
      }
      return { name: d.name, path: skillDir, description: description.trim() };
    }));
  } catch (err) {
    console.warn('[data-service] Failed to load skills:', err.message);
    return [];
  }
}

/**
 * Load a transcript for a specific session.
 */
export async function loadTranscript(sessionId, projectPath) {
  try {
    if (!/^[\w-]+$/.test(sessionId)) return [];

    const encodedProject = projectPath.replace(/\//g, '-').replace(/^-/, '');
    const transcriptPath = path.join(PROJECTS_DIR, encodedProject, `${sessionId}.jsonl`);

    if (!(await pathExists(transcriptPath))) {
      if (await pathExists(PROJECTS_DIR)) {
        const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
        for (const dir of dirents.filter((d) => d.isDirectory())) {
          const altPath = path.join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
          if (await pathExists(altPath)) {
            return parseTranscriptFile(altPath);
          }
        }
      }
      return [];
    }

    return parseTranscriptFile(transcriptPath);
  } catch (err) {
    console.warn('[data-service] Failed to load transcript:', err.message);
    return [];
  }
}

async function parseTranscriptFile(filePath) {
  const entries = await parseJsonl(filePath, 100);
  const messages = [];
  for (const entry of entries) {
    if (entry.type === 'human' || entry.role === 'user') {
      const content = typeof entry.message === 'string'
        ? entry.message
        : entry.message?.content || entry.content || '';
      if (content) {
        messages.push({ role: 'user', content: content.slice(0, 500), timestamp: entry.timestamp });
      }
    } else if (entry.type === 'assistant' || entry.role === 'assistant') {
      const content = typeof entry.message === 'string'
        ? entry.message
        : entry.message?.content || entry.content || '';
      if (content) {
        messages.push({ role: 'assistant', content: content.slice(0, 500), timestamp: entry.timestamp });
      }
    }
  }
  return messages;
}

/**
 * Get active Claude processes using execFile (safe — no shell injection).
 */
export function getActiveProcesses() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-lf', 'claude'], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve([]);
        return;
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      resolve(lines.map((line) => {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx === -1) return null;
        return {
          pid: line.slice(0, spaceIdx),
          command: line.slice(spaceIdx + 1),
        };
      }).filter(Boolean));
    });
  });
}

/**
 * List all projects from ~/.claude/projects/
 */
export async function listProjects() {
  const projectMap = new Map(); // decodedPath → project object

  // 1. Scan ~/.claude/projects/ for projects with Claude sessions
  try {
    if (await pathExists(PROJECTS_DIR)) {
      const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
      const dirs = dirents.filter((d) => d.isDirectory());

      await Promise.all(dirs.map(async (d) => {
        const projectDir = path.join(PROJECTS_DIR, d.name);
        const decodedPath = '/' + d.name.replace(/-/g, '/');

        let sessionCount = 0;
        let latestTimestamp = 0;
        try {
          const files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
          sessionCount = files.length;
          const stats = await Promise.all(
            files.map((f) => fs.stat(path.join(projectDir, f)))
          );
          for (const stat of stats) {
            if (stat.mtimeMs > latestTimestamp) {
              latestTimestamp = stat.mtimeMs;
            }
          }
        } catch {
          void 0;
        }

        if (sessionCount > 0) {
          const displayName = decodedPath.split('/').filter(Boolean).pop() || d.name;
          projectMap.set(decodedPath, {
            encodedPath: d.name,
            decodedPath,
            displayName,
            sessionCount,
            latestTimestamp,
            age: latestTimestamp ? timeAgo(latestTimestamp) : 'unknown',
          });
        }
      }));
    }
  } catch (err) {
    console.warn('[data-service] Failed to scan Claude projects:', err.message);
  }

  // 2. Scan filesystem projectScanDir for all project folders
  try {
    const settings = getSettings();
    let scanDir = settings.projectScanDir;
    if (scanDir) {
      scanDir = scanDir.replace(/^~/, os.homedir());
      if (await pathExists(scanDir)) {
        const dirents = await fs.readdir(scanDir, { withFileTypes: true });
        for (const d of dirents) {
          if (!d.isDirectory() || d.name.startsWith('.')) continue;
          const fullPath = path.join(scanDir, d.name);
          if (projectMap.has(fullPath)) continue; // already found via Claude sessions

          let latestTimestamp = 0;
          try {
            const stat = await fs.stat(fullPath);
            latestTimestamp = stat.mtimeMs;
          } catch { void 0; }

          projectMap.set(fullPath, {
            encodedPath: null,
            decodedPath: fullPath,
            displayName: d.name,
            sessionCount: 0,
            latestTimestamp,
            age: latestTimestamp ? timeAgo(latestTimestamp) : 'unknown',
          });
        }
      }
    }
  } catch (err) {
    console.warn('[data-service] Failed to scan project directory:', err.message);
  }

  return Array.from(projectMap.values())
    .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}
