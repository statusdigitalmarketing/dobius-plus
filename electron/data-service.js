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
 * Load ALL sessions across all projects by scanning ~/.claude/projects/.
 * Returns array of { sessionId, projectPath, projectName, preview, timestamp, age }
 * sorted by recency, limited to 500.
 */
export async function loadAllSessions() {
  const sessions = [];
  try {
    if (!(await pathExists(PROJECTS_DIR))) return [];
    const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    const projectDirs = dirents.filter((d) => d.isDirectory());

    // Build encoded→real path map using same logic as listProjects()
    const encodedToReal = new Map();
    try {
      const settings = getSettings();
      let scanDir = settings.projectScanDir;
      if (scanDir) {
        scanDir = scanDir.replace(/^~/, os.homedir());
        if (await pathExists(scanDir)) {
          const scanDirents = await fs.readdir(scanDir, { withFileTypes: true });
          for (const d of scanDirents) {
            if (!d.isDirectory() || d.name.startsWith('.')) continue;
            const fullPath = path.join(scanDir, d.name);
            encodedToReal.set(encodePathLikeClaude(fullPath), fullPath);
          }
        }
      }
    } catch {
      void 0;
    }

    await Promise.all(projectDirs.map(async (dir) => {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const realPath = encodedToReal.get(dir.name);
      const projectPath = realPath || ('/' + dir.name.replace(/-/g, '/'));
      const projectName = realPath
        ? realPath.split('/').filter(Boolean).pop()
        : dir.name.split('-').filter(Boolean).pop() || dir.name;

      try {
        const files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
        await Promise.all(files.map(async (f) => {
          const sessionId = f.replace('.jsonl', '');
          const filePath = path.join(projectDir, f);
          try {
            const entries = await parseJsonl(filePath, 5);
            let preview = '';
            let timestamp = 0;

            for (const entry of entries) {
              if (entry.timestamp && entry.timestamp > timestamp) {
                timestamp = entry.timestamp;
              }
              if (!preview && (entry.type === 'human' || entry.role === 'user')) {
                const content = typeof entry.message === 'string'
                  ? entry.message
                  : entry.message?.content || entry.content || '';
                if (content) {
                  preview = content.slice(0, 200);
                }
              }
            }

            if (!timestamp) {
              try {
                const stat = await fs.stat(filePath);
                timestamp = stat.mtimeMs;
              } catch {
                void 0;
              }
            }

            sessions.push({
              sessionId,
              projectPath,
              projectName,
              preview: preview || 'No preview available',
              timestamp,
              age: timestamp ? timeAgo(timestamp) : 'unknown',
            });
          } catch {
            void 0;
          }
        }));
      } catch {
        void 0;
      }
    }));
  } catch (err) {
    console.warn('[data-service] Failed to load all sessions:', err.message);
    return [];
  }

  return sessions
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 500);
}

/**
 * Get the most recent session for a given project path.
 * Returns { sessionId, preview, timestamp, age } or null.
 */
export async function getLatestSession(projectPath) {
  try {
    if (!projectPath || typeof projectPath !== 'string') return null;
    const encoded = encodePathLikeClaude(projectPath);
    const projectDir = path.join(PROJECTS_DIR, encoded);
    if (!(await pathExists(projectDir))) return null;

    const files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) return null;

    const fileStats = await Promise.all(files.map(async (f) => {
      try {
        const stat = await fs.stat(path.join(projectDir, f));
        return { file: f, mtime: stat.mtimeMs };
      } catch {
        return { file: f, mtime: 0 };
      }
    }));

    const latest = fileStats.reduce((best, cur) => cur.mtime > best.mtime ? cur : best);
    if (!latest || latest.mtime === 0) return null;
    const latestFile = latest.file;
    const latestMtime = latest.mtime;

    const sessionId = latestFile.replace('.jsonl', '');
    const filePath = path.join(projectDir, latestFile);
    const entries = await parseJsonl(filePath, 5);

    let preview = '';
    let timestamp = latestMtime;
    for (const entry of entries) {
      if (entry.timestamp && entry.timestamp > timestamp) {
        timestamp = entry.timestamp;
      }
      if (!preview && (entry.type === 'human' || entry.role === 'user')) {
        const content = typeof entry.message === 'string'
          ? entry.message
          : entry.message?.content || entry.content || '';
        if (content) {
          preview = content.slice(0, 200);
        }
      }
    }

    return {
      sessionId,
      preview: preview || 'No preview available',
      timestamp,
      age: timestamp ? timeAgo(timestamp) : 'unknown',
    };
  } catch (err) {
    console.warn('[data-service] Failed to get latest session:', err.message);
    return null;
  }
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
 * Encode a filesystem path the same way Claude Code does for ~/.claude/projects/ dir names.
 * Every non-alphanumeric character (except . and -) becomes a dash.
 */
function encodePathLikeClaude(p) {
  return p.replace(/[^a-zA-Z0-9.\-]/g, '-');
}

/**
 * Try to reconstruct a real filesystem path from a Claude-encoded dir name.
 * Checks common path patterns and verifies they exist on disk.
 * Returns the real path if found, or null.
 */
function tryReconstructPath(encodedName) {
  // Known prefix: -Users-<user>-...
  // Try to rebuild by replacing dashes back, checking if result exists
  const home = os.homedir();
  const homeEncoded = encodePathLikeClaude(home); // e.g. -Users-statusmacbook2024

  if (!encodedName.startsWith(homeEncoded)) return null;

  // Strip home prefix, try to reconstruct the rest
  const rest = encodedName.slice(homeEncoded.length); // e.g. -Projects--Code--dobius-plus
  if (!rest) return home;

  // Try the path as-is by checking if it exists under common parent dirs
  // The encoded rest starts with - (from the / separator)
  const segments = rest.split('-').filter(Boolean);
  if (segments.length === 0) return null;

  // Try progressively joining segments to find existing paths
  // This handles "Projects--Code--thing" → "Projects (Code)/thing"
  let current = home;
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    const candidate = path.join(current, seg);
    try {
      const stat = fsSync.statSync(candidate);
      if (stat.isDirectory()) {
        current = candidate;
        i++;
        continue;
      }
    } catch { /* doesn't exist as-is */ }

    // Try joining with next segment(s) using common separators: space, (, ), -, .
    let found = false;
    for (let j = i + 1; j <= Math.min(i + 4, segments.length); j++) {
      const joined = segments.slice(i, j).join('-');
      // Also try with spaces and parens: "Projects--Code" → "Projects (Code)"
      const variants = [
        joined,
        segments.slice(i, j).join(' '),
      ];
      // Special: try to reconstruct "(X)" patterns from empty-segment gaps
      // "Projects--Code-" in segments becomes ["Projects", "", "Code", ""]
      // which after filter(Boolean) is ["Projects", "Code"]
      if (j === i + 2) {
        variants.push(segments[i] + ' (' + segments[i + 1] + ')');
        variants.push(segments[i] + '(' + segments[i + 1] + ')');
      }
      for (const v of variants) {
        const c = path.join(current, v);
        try {
          if (fsSync.statSync(c).isDirectory()) {
            current = c;
            i = j;
            found = true;
            break;
          }
        } catch { /* nope */ }
      }
      if (found) break;
    }
    if (!found) return null; // Can't reconstruct further
  }
  return current;
}

/**
 * Extract a readable display name from a Claude-encoded dir name.
 * Uses the last meaningful path segment rather than just the last dash-segment.
 */
function extractDisplayName(encodedName) {
  // Remove common prefixes to get the project-specific part
  const home = os.homedir();
  const homeEncoded = encodePathLikeClaude(home);
  let rest = encodedName;
  if (rest.startsWith(homeEncoded)) {
    rest = rest.slice(homeEncoded.length);
  }
  // Remove common dir prefixes like -Projects--Code-
  rest = rest.replace(/^-Projects--Code--?/, '').replace(/^-/, '');
  // Take the full remaining string, replace dashes with spaces for readability
  // But keep consecutive dashes as path separators
  if (!rest) return encodedName;
  // Split on double-dash (path separator) and take the last segment
  const parts = rest.split(/--+/).filter(Boolean);
  return parts.length > 0 ? parts.join('/') : rest;
}

/**
 * List all projects — merges filesystem scan with Claude session data.
 * Filesystem paths are canonical; Claude session dirs are matched by encoded name.
 */
export async function listProjects() {
  const projectMap = new Map(); // realPath → project object
  const encodedToReal = new Map(); // Claude-encoded name → real filesystem path

  // 1. Scan filesystem projectScanDir FIRST so we have real paths for matching
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
          const encoded = encodePathLikeClaude(fullPath);
          encodedToReal.set(encoded, fullPath);

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

  // 2. Scan ~/.claude/projects/ for session counts, merge into filesystem entries
  try {
    if (await pathExists(PROJECTS_DIR)) {
      const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
      const dirs = dirents.filter((d) => d.isDirectory());

      await Promise.all(dirs.map(async (d) => {
        const projectDir = path.join(PROJECTS_DIR, d.name);

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

        if (sessionCount === 0) return;

        // Try to resolve the encoded dir name to a real filesystem path
        const realPath = encodedToReal.get(d.name);

        if (realPath && projectMap.has(realPath)) {
          // Merge session data into existing filesystem entry
          const existing = projectMap.get(realPath);
          existing.encodedPath = d.name;
          existing.sessionCount += sessionCount;
          if (latestTimestamp > existing.latestTimestamp) {
            existing.latestTimestamp = latestTimestamp;
            existing.age = timeAgo(latestTimestamp);
          }
        } else {
          // Not in filesystem scan — try to reconstruct real path
          const reconstructed = tryReconstructPath(d.name);

          if (reconstructed && projectMap.has(reconstructed)) {
            // Exact match — merge sessions into existing entry
            const existing = projectMap.get(reconstructed);
            existing.encodedPath = existing.encodedPath || d.name;
            existing.sessionCount += sessionCount;
            if (latestTimestamp > existing.latestTimestamp) {
              existing.latestTimestamp = latestTimestamp;
              existing.age = timeAgo(latestTimestamp);
            }
          } else if (reconstructed) {
            // Check if this is a subdirectory of an existing project — merge into parent
            let mergedIntoParent = false;
            for (const [key, existing] of projectMap) {
              if (reconstructed.startsWith(key + '/')) {
                existing.sessionCount += sessionCount;
                if (latestTimestamp > existing.latestTimestamp) {
                  existing.latestTimestamp = latestTimestamp;
                  existing.age = timeAgo(latestTimestamp);
                }
                mergedIntoParent = true;
                break;
              }
            }
            if (!mergedIntoParent) {
              // Valid path on disk, not a subdir of known project — add as its own entry
              const displayName = path.basename(reconstructed);
              projectMap.set(reconstructed, {
                encodedPath: d.name,
                decodedPath: reconstructed,
                displayName,
                sessionCount,
                latestTimestamp,
                age: latestTimestamp ? timeAgo(latestTimestamp) : 'unknown',
              });
            }
          } else {
            // Can't reconstruct — use readable display name, skip garbage paths
            const displayName = extractDisplayName(d.name);
            // Check if this is a subdirectory of a known project (by prefix match)
            let merged = false;
            for (const [key, existing] of projectMap) {
              const existingEncoded = existing.encodedPath || encodePathLikeClaude(key);
              if (d.name.startsWith(existingEncoded + '-') && d.name !== existingEncoded) {
                existing.sessionCount += sessionCount;
                if (latestTimestamp > existing.latestTimestamp) {
                  existing.latestTimestamp = latestTimestamp;
                  existing.age = timeAgo(latestTimestamp);
                }
                merged = true;
                break;
              }
            }
            if (!merged) {
              projectMap.set(d.name, {
                encodedPath: d.name,
                decodedPath: null, // no valid path — can't open terminal here
                displayName,
                sessionCount,
                latestTimestamp,
                age: latestTimestamp ? timeAgo(latestTimestamp) : 'unknown',
              });
            }
          }
        }
      }));
    }
  } catch (err) {
    console.warn('[data-service] Failed to scan Claude projects:', err.message);
  }

  return Array.from(projectMap.values())
    .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}
