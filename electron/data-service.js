import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { watch } from 'chokidar';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HISTORY_PATH = path.join(CLAUDE_DIR, 'history.jsonl');
const STATS_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/**
 * Parse a JSONL file, skipping malformed lines.
 */
function parseJsonl(filePath, limit = 0) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const parsedLines = [];
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line));
      } catch {
        // Skip malformed JSONL lines — this is expected for partial writes
        continue;
      }
    }
    if (limit > 0) {
      return parsedLines.slice(-limit);
    }
    return parsedLines;
  } catch (err) {
    console.warn(`[data-service] Failed to parse ${filePath}:`, err.message);
    return [];
  }
}

/**
 * Calculate time ago string from timestamp.
 */
function timeAgo(timestamp) {
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
 * Load session history from ~/.claude/history.jsonl
 * Returns array of sessions, deduped by sessionId, sorted by timestamp desc, limited to 100.
 */
export function loadHistory() {
  const entries = parseJsonl(HISTORY_PATH);
  // Dedupe by sessionId (keep latest)
  const bySession = new Map();
  for (const entry of entries) {
    if (entry.sessionId) {
      const existing = bySession.get(entry.sessionId);
      if (!existing || (entry.timestamp && entry.timestamp > existing.timestamp)) {
        bySession.set(entry.sessionId, entry);
      }
    }
  }
  // Sort by timestamp desc, limit 100
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
export function loadStats() {
  try {
    const content = fs.readFileSync(STATS_PATH, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.warn('[data-service] Failed to load stats:', err.message);
    return { version: 2, dailyActivity: [], modelUsage: {}, hourCounts: {} };
  }
}

/**
 * Load settings from ~/.claude/settings.json
 */
export function loadSettings() {
  try {
    const content = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(content);
    return {
      hooks: settings.hooks || {},
      mcpServers: settings.mcpServers || {},
      enabledPlugins: settings.enabledPlugins || [],
    };
  } catch (err) {
    console.warn('[data-service] Failed to load settings:', err.message);
    return { hooks: {}, mcpServers: {}, enabledPlugins: [] };
  }
}

/**
 * Load plan files from ~/.claude/plans/
 */
export function loadPlans() {
  try {
    if (!fs.existsSync(PLANS_DIR)) return [];
    const files = fs.readdirSync(PLANS_DIR).filter((f) => f.endsWith('.md'));
    return files.map((f) => {
      const filePath = path.join(PLANS_DIR, f);
      const stat = fs.statSync(filePath);
      return {
        name: f.replace('.md', ''),
        path: filePath,
        modifiedTime: stat.mtime.toISOString(),
      };
    }).sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  } catch (err) {
    console.warn('[data-service] Failed to load plans:', err.message);
    return [];
  }
}

/**
 * Read a plan file's content by name.
 */
export function readPlanFile(planName) {
  try {
    // Validate planName: only allow alphanumeric, hyphens, underscores, dots, spaces
    if (!/^[\w\s\-\.]+$/.test(planName)) return '';
    const filePath = path.join(PLANS_DIR, `${planName}.md`);
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.warn('[data-service] Failed to read plan file:', err.message);
    return '';
  }
}

/**
 * Load installed skills from ~/.claude/skills/
 */
export function loadSkills() {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    return dirs.map((d) => {
      const skillDir = path.join(SKILLS_DIR, d.name);
      const skillMd = path.join(skillDir, 'SKILL.md');
      let description = '';
      try {
        const content = fs.readFileSync(skillMd, 'utf8');
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
        // No SKILL.md — not an error worth logging
        void 0;
      }
      return { name: d.name, path: skillDir, description: description.trim() };
    });
  } catch (err) {
    console.warn('[data-service] Failed to load skills:', err.message);
    return [];
  }
}

/**
 * Load a transcript for a specific session.
 * Reads from ~/.claude/projects/<encodedProject>/<sessionId>.jsonl
 */
export function loadTranscript(sessionId, projectPath) {
  try {
    // Validate sessionId to prevent path traversal (allow UUID-like format)
    if (!/^[\w-]+$/.test(sessionId)) return [];

    // Encode the project path the same way Claude does
    const encodedProject = projectPath.replace(/\//g, '-').replace(/^-/, '');
    const transcriptDir = path.join(PROJECTS_DIR, encodedProject);
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) {
      // Try scanning all project directories for this session
      if (fs.existsSync(PROJECTS_DIR)) {
        const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
          .filter((d) => d.isDirectory());
        for (const dir of projectDirs) {
          const altPath = path.join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
          if (fs.existsSync(altPath)) {
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

function parseTranscriptFile(filePath) {
  const entries = parseJsonl(filePath, 100);
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
export function listProjects() {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    return dirs.map((d) => {
      const projectDir = path.join(PROJECTS_DIR, d.name);
      // Decode the directory name back to a path
      const decodedPath = '/' + d.name.replace(/-/g, '/');

      // Count sessions and find latest timestamp
      let sessionCount = 0;
      let latestTimestamp = 0;
      try {
        const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
        sessionCount = files.length;
        for (const f of files) {
          const stat = fs.statSync(path.join(projectDir, f));
          if (stat.mtimeMs > latestTimestamp) {
            latestTimestamp = stat.mtimeMs;
          }
        }
      } catch {
        // Skip unreadable directories
        void 0;
      }

      // Extract a display name from the path
      const displayName = decodedPath.split('/').filter(Boolean).pop() || d.name;

      return {
        encodedPath: d.name,
        decodedPath,
        displayName,
        sessionCount,
        latestTimestamp,
        age: latestTimestamp ? timeAgo(latestTimestamp) : 'unknown',
      };
    })
      .filter((p) => p.sessionCount > 0)
      .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  } catch (err) {
    console.warn('[data-service] Failed to list projects:', err.message);
    return [];
  }
}

/**
 * Watch key ~/.claude/ files for changes and notify the renderer.
 * Uses a per-window watcher map so multiple windows all receive updates.
 */
const watchers = new Map();

export function watchFiles(webContents) {
  const wcId = webContents.id;

  // Close existing watcher for this window if any
  if (watchers.has(wcId)) {
    watchers.get(wcId).close();
  }

  const watchPaths = [HISTORY_PATH, STATS_PATH].filter((p) => fs.existsSync(p));
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

  // Auto-cleanup when webContents is destroyed
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
