import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import {
  HISTORY_PATH, STATS_PATH, SETTINGS_PATH, CLAUDE_JSON_PATH, MCP_BRIDGE_CONFIG, PLANS_DIR, SKILLS_DIR, PLUGINS_DIR, PROJECTS_DIR,
  parseJsonl, timeAgo, pathExists, mapLimit,
} from './data-utils.js';
import { getSettings, getManualProjects, getProjectDisplayNames, getHiddenProjects } from './config-manager.js';

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
  // v1.0.28: enrich each session with transcriptExists + sizeMB. Filter
  // ghosts BEFORE the 100-session cap so the sidebar never empties out when
  // a user has 100 recent index entries pointing at deleted transcripts.
  // We cap candidates at 400 to keep stat() count bounded; 400 newest-by-
  // index after dedupe is far more than the 100 the sidebar ultimately shows.
  // Codex v1.0.28 round-1 MED.
  const candidatesAll = Array.from(bySession.values())
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 400);

  const enriched = await mapLimit(candidatesAll, 16, async (entry) => {
    let transcriptExists = false;
    let sizeMB = 0;
    if (entry.project) {
      try {
        const encoded = encodePathLikeClaude(entry.project);
        const transcriptPath = path.join(PROJECTS_DIR, encoded, `${entry.sessionId}.jsonl`);
        const stat = await fs.stat(transcriptPath);
        transcriptExists = true;
        sizeMB = stat.size / (1024 * 1024);
      } catch { /* missing file → transcriptExists stays false */ }
    }
    return {
      sessionId: entry.sessionId,
      project: entry.project || '',
      display: entry.display || '',
      timestamp: entry.timestamp || 0,
      age: timeAgo(entry.timestamp || 0),
      transcriptExists,
      sizeMB,
    };
  });

  return enriched
    .filter((s) => s.transcriptExists)
    .slice(0, 100);
}

/**
 * Load ALL sessions across all projects by scanning ~/.claude/projects/.
 * Returns array of { sessionId, projectPath, projectName, preview, timestamp, age, status }
 * sorted by recency, limited to 500. `status` is 'working' | 'needs' | 'done'
 * (same red/yellow/green meaning as the terminal tab dots).
 */
export async function loadAllSessions(projectFilter) {
  // projectFilter (optional): when provided, restrict the scan to JSONL files
  // whose resolved projectPath matches this string. Critical for project-scoped
  // sidebar: without filtering BEFORE the global 500-cap, an older project on
  // a machine with more than 500 newer cross-project sessions would appear
  // empty in its own sidebar even though its transcripts exist on disk.
  // Codex PR#3 r8 P2.
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

    // Also seed manually-added projects so they resolve correctly
    for (const manualPath of getManualProjects()) {
      encodedToReal.set(encodePathLikeClaude(manualPath), manualPath);
    }

    // Flatten every transcript across every project into one task list, then
    // process it with a bounded worker pool. The previous nested Promise.all
    // fanned out across all projects AND all files at once, opening thousands
    // of file handles simultaneously — combined with the old whole-file read
    // in parseJsonl, that OOM-crashed the main process on dashboards with large
    // ~/.claude histories. A cap of 24 keeps memory and fd usage flat.
    const fileTasks = [];
    for (const dir of projectDirs) {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const realPath = encodedToReal.get(dir.name) || tryReconstructPath(dir.name);
      const projectPath = realPath || ('/' + dir.name.replace(/-/g, '/'));
      // Pre-filter by project so the global 500-cap applies to the matching
      // set, not to everything-then-trimmed. Codex PR#3 r8 P2.
      if (projectFilter && projectPath !== projectFilter) continue;
      const projectName = realPath
        ? realPath.split('/').filter(Boolean).pop()
        : dir.name.split('-').filter(Boolean).pop() || dir.name;
      let files = [];
      try {
        files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        fileTasks.push({ projectDir, projectPath, projectName, file: f });
      }
    }

    await mapLimit(fileTasks, 24, async ({ projectDir, projectPath, projectName, file }) => {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectDir, file);
      try {
        // Capture file size so the resume dead-session guard (>80MB blocks the
        // resume) still works after the sidebar moved off the history-based
        // source. Without this, double-clicking a 100MB transcript from the
        // sidebar would hang Claude. Codex PR#3 r6 P2.
        let sizeMB = 0;
        try {
          const st = await fs.stat(filePath);
          sizeMB = st.size / (1024 * 1024);
        } catch { /* file vanished between readdir + stat, leave 0 */ }
        // parseJsonl is bounded since v1.0.23, uses readTail under the hood so
        // a 24MB transcript no longer pulls 95MB into memory. The status fields
        // here ride on top of that bounded read; we never re-read the file.
        const entries = await parseJsonl(filePath, 5);
        let preview = '';
        let timestamp = 0;
        // lastRole drives the cross-session status dot.
        let lastRole = '';

        for (const entry of entries) {
          // Transcript timestamps are ISO 8601 strings — parse to epoch ms so
          // recency math + the 'working' check use real milliseconds.
          const tsMs = typeof entry.timestamp === 'number'
            ? entry.timestamp
            : (entry.timestamp ? new Date(entry.timestamp).getTime() : 0);
          if (tsMs && tsMs > timestamp) {
            timestamp = tsMs;
          }
          const role = (entry.type === 'human' || entry.role === 'user' || entry.message?.role === 'user')
            ? 'user'
            : (entry.type === 'assistant' || entry.role === 'assistant' || entry.message?.role === 'assistant')
              ? 'assistant'
              : '';
          if (role) lastRole = role; // array is oldest→newest, so the final wins
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

        // Cross-session status — same red/yellow/green meaning as terminal tabs:
        //   yellow 'working' = Claude is actively streaming (recent activity + Claude spoke last)
        //   red    'needs'   = user spoke last and Claude hasn't replied yet
        //   green  'done'    = Claude finished its turn cleanly
        //
        // 120s window (was 45s during PR review) + lastRole gate: 45s falsely
        // flipped streaming sessions to 'done' during slow tool calls, AND a
        // bare recency check labeled "user just spoke" as 'working' even when
        // Claude hadn't started. Both flagged independently by review agents.
        // The live terminal tab dot still overrides this for the active tab.
        const recent = timestamp && (Date.now() - timestamp < 120_000);
        let status = 'done';
        if (recent && lastRole === 'assistant') status = 'working';
        else if (lastRole === 'user') status = 'needs';

        sessions.push({
          sessionId,
          projectPath,
          projectName,
          preview: preview || 'No preview available',
          timestamp,
          age: timestamp ? timeAgo(timestamp) : 'unknown',
          status,
          sizeMB, // for the resume dead-session guard, Codex PR#3 r6 P2
        });
      } catch {
        void 0;
      }
    });
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

async function readSkillDescription(skillDir) {
  // Check skill.json first (Claude Code standard format)
  const skillJson = path.join(skillDir, 'skill.json');
  try {
    const raw = await fs.readFile(skillJson, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.description) return parsed.description;
  } catch {}

  // Fallback: SKILL.md frontmatter
  const skillMd = path.join(skillDir, 'SKILL.md');
  try {
    const content = await fs.readFile(skillMd, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('description:')) {
        return line.replace('description:', '').trim().replace(/^["']|["']$/g, '');
      }
    }
    return lines.find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---')) || '';
  } catch {
    return '';
  }
}

async function collectSkillsFromDir(dir, source) {
  if (!(await pathExists(dir))) return [];
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  return Promise.all(
    dirents.filter((d) => d.isDirectory()).map(async (d) => {
      const skillDir = path.join(dir, d.name);
      const description = await readSkillDescription(skillDir);
      return { name: d.name, path: skillDir, description: description.trim(), source };
    })
  );
}

/**
 * Load installed skills from ~/.claude/skills/ and ~/.claude/plugins/ (all marketplaces).
 */
export async function loadSkills() {
  try {
    const results = await Promise.allSettled([
      // Custom user skills
      collectSkillsFromDir(SKILLS_DIR, 'custom'),
      // Plugin skills: scan each marketplace → each plugin → skills/
      (async () => {
        if (!(await pathExists(PLUGINS_DIR))) return [];
        const marketplacesDir = path.join(PLUGINS_DIR, 'marketplaces');
        if (!(await pathExists(marketplacesDir))) return [];
        const marketplaces = (await fs.readdir(marketplacesDir, { withFileTypes: true }))
          .filter((d) => d.isDirectory()).map((d) => d.name);
        const allPluginSkills = await Promise.all(marketplaces.map(async (marketplace) => {
          const pluginsDir = path.join(marketplacesDir, marketplace, 'plugins');
          if (!(await pathExists(pluginsDir))) return [];
          const plugins = (await fs.readdir(pluginsDir, { withFileTypes: true }))
            .filter((d) => d.isDirectory());
          return Promise.all(plugins.map(async (plugin) => {
            const skillsDir = path.join(pluginsDir, plugin.name, 'skills');
            return collectSkillsFromDir(skillsDir, plugin.name);
          }));
        }));
        return allPluginSkills.flat(2);
      })(),
    ]);
    const all = results.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
    // Deduplicate by name+source
    const seen = new Set();
    return all.filter((s) => {
      const key = `${s.source}:${s.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (err) {
    console.warn('[data-service] Failed to load skills:', err.message);
    return [];
  }
}

/**
 * Delete a session JSONL file. Searches the encoded project dir first,
 * then falls back to scanning all project dirs for the session ID.
 */
export async function deleteSession(sessionId, projectPath) {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) throw new Error('Invalid sessionId');

  // Try primary path via encoded projectPath
  if (projectPath) {
    const encodedProject = projectPath.replace(/\//g, '-').replace(/^-/, '');
    const primary = path.join(PROJECTS_DIR, encodedProject, `${sessionId}.jsonl`);
    if (await pathExists(primary)) {
      await fs.unlink(primary);
      return true;
    }
  }

  // Fallback: scan all project dirs
  if (await pathExists(PROJECTS_DIR)) {
    const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    for (const dir of dirents.filter((d) => d.isDirectory())) {
      const candidate = path.join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
      if (await pathExists(candidate)) {
        await fs.unlink(candidate);
        return true;
      }
    }
  }

  throw new Error('Session file not found');
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

  // 0. Seed manually-added projects (picked via folder dialog, may have no sessions yet)
  for (const manualPath of getManualProjects()) {
    if (!projectMap.has(manualPath)) {
      const encoded = encodePathLikeClaude(manualPath);
      encodedToReal.set(encoded, manualPath);
      let latestTimestamp = 0;
      try {
        const s = await fs.stat(manualPath);
        latestTimestamp = s.mtimeMs;
      } catch { void 0; }
      projectMap.set(manualPath, {
        encodedPath: null,
        decodedPath: manualPath,
        displayName: manualPath.split('/').pop(),
        sessionCount: 0,
        latestTimestamp,
        age: latestTimestamp ? timeAgo(latestTimestamp) : 'unknown',
      });
    }
  }

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

  const hidden = new Set(getHiddenProjects());
  const displayNames = getProjectDisplayNames();

  return Array.from(projectMap.values())
    .filter((p) => !p.decodedPath || !hidden.has(p.decodedPath))
    .map((p) => ({
      ...p,
      displayName: (p.decodedPath && displayNames[p.decodedPath]) || p.displayName,
    }))
    .sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}

// Pricing per 1M tokens (USD) — keyed by model name substring
const MODEL_PRICING = [
  { pattern: 'opus',   input: 15,   output: 75,   cacheRead: 1.5,   cacheWrite: 3.75 },
  { pattern: 'sonnet', input: 3,    output: 15,   cacheRead: 0.3,   cacheWrite: 0.375 },
  { pattern: 'haiku',  input: 0.80, output: 4,    cacheRead: 0.08,  cacheWrite: 0.10 },
];

function getPricing(model) {
  const m = (model || '').toLowerCase();
  return MODEL_PRICING.find((p) => m.includes(p.pattern)) || MODEL_PRICING[1];
}

/**
 * Scan all projects' transcripts and aggregate token usage + estimated cost per project.
 */
export async function loadProjectTokens() {
  const results = {};
  try {
    if (!(await pathExists(PROJECTS_DIR))) return results;
    const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });

    await Promise.all(dirents.filter((d) => d.isDirectory()).map(async (dir) => {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
      let sessions = 0;
      const modelTotals = {};

      try {
        const files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
        await Promise.all(files.map(async (f) => {
          const filePath = path.join(projectDir, f);
          try {
            const stat = await fs.stat(filePath);
            if (stat.size > 8 * 1024 * 1024) return; // skip files > 8MB
          } catch { return; }
          // Only count sessions we actually scanned — skipped (too large) or
          // unreadable files must not inflate the Costs "sessions" metric.
          sessions++;
          const entries = await parseJsonl(filePath);
          for (const entry of entries) {
            const usage = entry.message?.usage;
            const model = entry.message?.model || 'unknown';
            if (!usage) continue;
            const inp = (usage.input_tokens || 0);
            const out = (usage.output_tokens || 0);
            const cr  = (usage.cache_read_input_tokens || 0);
            const cw  = (usage.cache_creation_input_tokens || 0);
            inputTokens += inp;
            outputTokens += out;
            cacheReadTokens += cr;
            cacheWriteTokens += cw;
            if (!modelTotals[model]) modelTotals[model] = { inp: 0, out: 0, cr: 0, cw: 0 };
            modelTotals[model].inp += inp;
            modelTotals[model].out += out;
            modelTotals[model].cr  += cr;
            modelTotals[model].cw  += cw;
          }
        }));
      } catch {
        return;
      }

      if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return;

      // Compute estimated cost per model
      let estimatedCostUsd = 0;
      for (const [model, t] of Object.entries(modelTotals)) {
        const p = getPricing(model);
        estimatedCostUsd +=
          (t.inp / 1e6) * p.input +
          (t.out / 1e6) * p.output +
          (t.cr  / 1e6) * p.cacheRead +
          (t.cw  / 1e6) * p.cacheWrite;
      }

      const displayName = dir.name.split('-').filter(Boolean).pop() || dir.name;
      results[dir.name] = {
        projectName: displayName,
        encodedPath: dir.name,
        sessions,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        models: Object.keys(modelTotals),
        estimatedCostUsd,
      };
    }));
  } catch (err) {
    console.warn('[data-service] Failed to load project tokens:', err.message);
  }
  return results;
}

/**
 * Full-text search across all session JSONL files.
 * Returns up to 100 matches sorted by recency.
 */
export async function searchTranscripts(query) {
  if (!query || typeof query !== 'string') return [];
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const qLower = q.toLowerCase();
  const matches = [];

  try {
    if (!(await pathExists(PROJECTS_DIR))) return [];
    const dirents = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });

    await Promise.all(dirents.filter((d) => d.isDirectory()).map(async (dir) => {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const projectName = dir.name.split('-').filter(Boolean).pop() || dir.name;
      // Use tryReconstructPath (probes the filesystem) instead of a naive
      // dash-to-slash replace. The naive version mangles double-dash encodings
      // like `-Users-foo-Projects--Code--dobius-plus` into garbage paths like
      // `/Users/foo/Projects//Code//dobius/plus`. Search hits then pass that
      // broken path to resumeSession which cd's into a non-existent dir.
      // Codex PR#3 r5 P2. Falls back to the naive form only if reconstruction
      // can't find a real path on disk (better wrong than missing).
      const projectPath = tryReconstructPath(dir.name) || ('/' + dir.name.replace(/-/g, '/'));

      try {
        const files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
        await Promise.all(files.map(async (f) => {
          if (matches.length >= 200) return;
          const sessionId = f.replace('.jsonl', '');
          const filePath = path.join(projectDir, f);
          try {
            const stat = await fs.stat(filePath);
            if (stat.size > 5 * 1024 * 1024) return; // skip very large sessions
          } catch { return; }

          const entries = await parseJsonl(filePath);
          let sessionTimestamp = 0;

          for (const entry of entries) {
            const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
            if (ts > sessionTimestamp) sessionTimestamp = ts;

            // Extract searchable text
            let text = '';
            const msgContent = entry.message?.content;
            if (typeof msgContent === 'string') {
              text = msgContent;
            } else if (Array.isArray(msgContent)) {
              text = msgContent
                .map((c) => c.text || c.thinking || '')
                .filter(Boolean)
                .join(' ');
            }

            if (!text || !text.toLowerCase().includes(qLower)) continue;

            const idx = text.toLowerCase().indexOf(qLower);
            const start = Math.max(0, idx - 80);
            const end = Math.min(text.length, idx + q.length + 80);
            const excerpt =
              (start > 0 ? '…' : '') +
              text.slice(start, end) +
              (end < text.length ? '…' : '');

            // Normalize roles the way the other parsers in this file do: older
            // transcripts use type 'human' for the user, which must not render
            // as Claude. Anything that isn't a user message is the assistant.
            const role = (entry.type === 'human' || entry.type === 'user'
              || entry.role === 'user' || entry.message?.role === 'user')
              ? 'user' : 'assistant';
            matches.push({
              sessionId,
              projectName,
              projectPath,
              role,
              excerpt,
              timestamp: ts || sessionTimestamp,
            });

            if (matches.length >= 200) return;
          }
        }));
      } catch {
        void 0;
      }
    }));
  } catch (err) {
    console.warn('[data-service] Failed to search transcripts:', err.message);
  }

  return matches.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
}

/**
 * Estimate context window usage for the most recent session of a project.
 * Returns { tokens, maxTokens, model } or null.
 */
export async function estimateContextSize(projectPath) {
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
    const latest = fileStats.reduce((a, b) => b.mtime > a.mtime ? b : a);

    const filePath = path.join(projectDir, latest.file);
    // BOUNDED tail read. estimateContextSize fires every 30s while a project
    // window is open. Reading the whole transcript each time stalls or OOMs
    // main on the typical Claude transcript size in this app (20-30MB common).
    // Token usage lives on assistant messages, which only need the most-recent
    // run to estimate context. Last 50 entries is plenty since usage stamps
    // appear every assistant turn. Codex PR#3 r7 P2.
    const entries = await parseJsonl(filePath, 50);

    let lastInputTokens = 0;
    let lastModel = '';
    for (const entry of entries) {
      const usage = entry.message?.usage;
      if (!usage) continue;
      const total =
        (usage.input_tokens || 0) +
        (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0);
      if (total > lastInputTokens) {
        lastInputTokens = total;
        if (entry.message?.model) lastModel = entry.message.model;
      }
    }

    if (!lastInputTokens) return null;
    return { tokens: lastInputTokens, maxTokens: 200000, model: lastModel };
  } catch (err) {
    console.warn('[data-service] Failed to estimate context size:', err.message);
    return null;
  }
}
