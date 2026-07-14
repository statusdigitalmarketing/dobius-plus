import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import {
  HISTORY_PATH, STATS_PATH, SETTINGS_PATH, CLAUDE_JSON_PATH, MCP_BRIDGE_CONFIG, PLANS_DIR, SKILLS_DIR, PLUGINS_DIR, PROJECTS_DIR,
  parseJsonl, streamJsonl, timeAgo, pathExists, mapLimit,
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
        // a 24MB transcript no longer pulls 95MB into memory. Read 200 entries
        // (was 5): modern Claude Code transcripts pad the tail with metadata
        // entries (last-prompt, ai-title, mode, permission-mode,
        // queue-operation, attachment, file-history-snapshot, system) and
        // assistant replies. The user's most recent prompt often sits well
        // beyond the last 5 records, so a 5-entry tail found no user message,
        // no parseable timestamp, and returned "No preview available" +
        // timestamp=0 for every recent session (v1.0.34 fix).
        const entries = await parseJsonl(filePath, 200);
        let preview = '';
        let timestamp = 0;
        // lastRole drives the cross-session status dot.
        let lastRole = '';
        // Walk from newest to oldest so the FIRST user message we find is the
        // most recent one, and we stop as soon as we have both preview + a
        // parseable timestamp + a role signal.
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const entry = entries[i];
          const tsMs = typeof entry.timestamp === 'number'
            ? entry.timestamp
            : (entry.timestamp ? new Date(entry.timestamp).getTime() : 0);
          if (tsMs && tsMs > timestamp) timestamp = tsMs;
          const role = (entry.type === 'human' || entry.role === 'user' || entry.message?.role === 'user')
            ? 'user'
            : (entry.type === 'assistant' || entry.role === 'assistant' || entry.message?.role === 'assistant')
              ? 'assistant'
              : '';
          // lastRole is the newest role we saw (tail walk, first match wins).
          if (role && !lastRole) lastRole = role;
          if (!preview && role === 'user') {
            const raw = entry.message?.content !== undefined
              ? entry.message.content
              : (entry.content !== undefined
                ? entry.content
                : (typeof entry.message === 'string' ? entry.message : ''));
            let text = '';
            if (typeof raw === 'string') {
              text = raw;
            } else if (Array.isArray(raw)) {
              // Anthropic content-blocks shape. Keep text-type blocks only,
              // skip tool_use / tool_result / image so the sidebar doesn't
              // preview a base64 blob. Codex-alike shape check.
              text = raw
                .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
                .map((b) => (typeof b.text === 'string' ? b.text : ''))
                .filter(Boolean)
                .join(' ');
            }
            text = String(text).trim();
            if (text) preview = text.slice(0, 200);
          }
          if (preview && timestamp && lastRole) break;
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
/**
 * Per-session size probe used by Cmd+R / tab-map resume to feed the
 * >80MB dead-session guard. Checks both encoder forms (legacy + new).
 * Returns sizeMB as a number, or null if the file can't be found.
 */
export async function getSessionSize(sessionId, projectPath) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  if (!/^[\w-]+$/.test(sessionId)) return null;
  if (!projectPath || typeof projectPath !== 'string') return null;
  const encodings = [encodePathLikeClaude(projectPath), encodePathLikeClaudeLegacy(projectPath)];
  for (const enc of encodings) {
    try {
      const filePath = path.join(PROJECTS_DIR, enc, `${sessionId}.jsonl`);
      const st = await fs.stat(filePath);
      return st.size / (1024 * 1024);
    } catch { /* try next encoding */ }
  }
  return null;
}

// Encode the project path the OLD way (slash-to-dash only, special chars
// preserved). Claude's encoder changed at some point and a single logical
// project can end up with sessions split across both directory forms.
// Returning both lets getLatestSession + loadAllSessions consider all real
// transcripts even when the new encoder doesn't match the directory Claude
// actually wrote.
function encodePathLikeClaudeLegacy(p) {
  return p.replace(/\//g, '-');
}

// Parse a timestamp value the transcript might store as ISO string OR epoch
// number. Returns 0 if unparseable (so the caller can keep the previous best).
function tsToEpochMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = new Date(v).getTime();
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function getLatestSession(projectPath) {
  try {
    if (!projectPath || typeof projectPath !== 'string') return null;
    // Look in BOTH encoding directories. Codex + resume-audit independently
    // flagged: a project that was once accessed via the old encoder still has
    // transcripts in `-Users-...-Projects (Code)-name`, but the new encoder
    // produces `-Users-...-Projects--Code--name`. Without checking both, Cmd+R
    // can pick the latest from the new dir and miss the actually-newest session
    // in the old dir. Both forms are real on Sam's machine (verified earlier
    // in the session).
    const encodings = [encodePathLikeClaude(projectPath), encodePathLikeClaudeLegacy(projectPath)];
    const seenDirs = new Set();
    const candidates = [];
    for (const enc of encodings) {
      if (seenDirs.has(enc)) continue;
      seenDirs.add(enc);
      const projectDir = path.join(PROJECTS_DIR, enc);
      if (!(await pathExists(projectDir))) continue;
      let files;
      try { files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl')); }
      catch { continue; }
      for (const f of files) {
        candidates.push({ projectDir, file: f });
      }
    }
    if (candidates.length === 0) return null;

    // Get mtime + size for every candidate, AND the newest message timestamp
    // INSIDE each transcript. Sort by the message timestamp (truth) instead of
    // mtime (which any `touch` / rsync / Time Machine restore can lie about).
    // mtime is the fallback only when no parseable timestamp exists in the file.
    const enriched = await Promise.all(candidates.map(async ({ projectDir, file }) => {
      const filePath = path.join(projectDir, file);
      let mtime = 0;
      let size = 0;
      try {
        const st = await fs.stat(filePath);
        mtime = st.mtimeMs;
        size = st.size;
      } catch {
        return null;
      }
      // Read the tail to find the newest message timestamp. parseJsonl with
      // a limit uses readTail under the hood so this stays memory-bounded
      // even on a 100MB transcript. 20 entries is enough to find the last
      // user/assistant message timestamp.
      let msgTs = 0;
      let lastUserPreview = '';
      try {
        const tail = await parseJsonl(filePath, 200);
        for (const e of tail) {
          const t = tsToEpochMs(e.timestamp);
          if (t > msgTs) msgTs = t;
          // Track the LAST user message we see in the tail as a preview.
          if (e.type === 'human' || e.role === 'user' || e.message?.role === 'user') {
            const content = typeof e.message === 'string'
              ? e.message
              : (typeof e.message?.content === 'string' ? e.message.content
                : (typeof e.content === 'string' ? e.content : ''));
            if (content) lastUserPreview = content.slice(0, 200);
          }
        }
      } catch { /* unparseable transcript, fall back to mtime */ }
      return {
        filePath,
        sessionId: file.replace('.jsonl', ''),
        sortKey: msgTs || mtime, // prefer message ts, fall back to mtime
        mtime,
        sizeMB: size / (1024 * 1024),
        preview: lastUserPreview,
      };
    }));

    const valid = enriched.filter((e) => e && e.sortKey > 0);
    if (valid.length === 0) return null;
    valid.sort((a, b) => b.sortKey - a.sortKey);
    const best = valid[0];

    return {
      sessionId: best.sessionId,
      preview: best.preview || 'No preview available',
      timestamp: best.sortKey,
      age: best.sortKey ? timeAgo(best.sortKey) : 'unknown',
      sizeMB: best.sizeMB,
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
 * Delete a session JSONL file. SCOPED to the supplied projectPath: probes
 * both encoder forms (new + legacy slash-to-dash) and deletes the first
 * match. If neither exists, returns an error rather than falling back to a
 * global scan. Codex v1.0.33 P2: the previous global-fallback path could
 * unlink a transcript from a DIFFERENT project when a stale/wrong
 * projectPath came in from the renderer, or when a compromised renderer
 * knew any sessionId. Now the projectPath is a hard scope.
 */
export async function deleteSession(sessionId, projectPath) {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) throw new Error('Invalid sessionId');
  if (typeof projectPath !== 'string' || !projectPath) throw new Error('projectPath required');

  const encodings = [encodePathLikeClaude(projectPath), encodePathLikeClaudeLegacy(projectPath)];
  const seen = new Set();
  for (const enc of encodings) {
    if (seen.has(enc)) continue;
    seen.add(enc);
    const candidate = path.join(PROJECTS_DIR, enc, `${sessionId}.jsonl`);
    if (await pathExists(candidate)) {
      await fs.unlink(candidate);
      return true;
    }
  }

  throw new Error('Session file not found for this project');
}

/**
 * Load a transcript for a specific session.
 */
export async function loadTranscript(sessionId, projectPath) {
  try {
    if (!/^[\w-]+$/.test(sessionId)) return [];
    if (typeof projectPath !== 'string' || !projectPath) return [];

    // Scoped to the supplied project, both encoder forms. The old global
    // fallback scanned EVERY project dir and returned the first sessionId
    // match, so a stale/wrong projectPath could show a transcript from a
    // completely different project (Codex v1.0.35 P1, same class as the
    // deleteSession fix in v1.0.33).
    // Third candidate: the stripped-leading-dash form this function's old
    // naive encoder produced. No such dir exists on any known machine
    // (Claude CLI always writes leading-dash), but probing it is free and
    // closes the theoretical gap Codex flagged when the global fallback
    // was removed. Codex v1.0.35 r4 P2.
    const encodings = [
      encodePathLikeClaude(projectPath),
      encodePathLikeClaudeLegacy(projectPath),
      projectPath.replace(/\//g, '-').replace(/^-/, ''),
    ];
    const seen = new Set();
    for (const enc of encodings) {
      if (!enc || seen.has(enc)) continue;
      seen.add(enc);
      const p = path.join(PROJECTS_DIR, enc, `${sessionId}.jsonl`);
      if (await pathExists(p)) return parseTranscriptFile(p);
    }
    return [];
  } catch (err) {
    console.warn('[data-service] Failed to load transcript:', err.message);
    return [];
  }
}

// Memory-bounded ceilings for the FULL-transcript preview path. The previous
// hard-coded 100-entry + 500-char-per-message caps meant the user could never
// see their actual chat history beyond the last 100 records (with each one
// clipped). For a daily-driver tool that is unacceptable. We stream the file
// line-by-line (flat memory regardless of transcript size) and only stop if
// the total preview payload approaches MAX_PAYLOAD_BYTES so the IPC channel
// stays sane. Each individual message keeps its full content up to
// MAX_MESSAGE_CHARS which is large enough for any real Claude turn.
const MAX_MESSAGE_CHARS = 20_000;
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024; // 12 MB JSON ceiling

/**
 * v1.0.29: get the most recent assistant message from a session's transcript
 * as plain text, suitable for clipboard copy. Returns null if the session is
 * unknown, the transcript is missing, or contains no assistant turns.
 *
 * Walks ONLY the tail of the JSONL (parseJsonl bounded read) so a 50MB
 * transcript doesn't load the whole file. Handles both string and content
 * block array shapes. Strips internal Anthropic markers and tool_use blocks
 * so what lands on the clipboard is what the user actually saw.
 *
 * v1.0.33 merge note: the audit branch's dual-encoding fix (getLatestSession
 * / getSessionSize scan BOTH encoder forms) is applied here too. Without it,
 * copying the last response for a session whose transcript lives in the
 * legacy `(Code)` directory would return null.
 */
export async function getLastAssistantMessage(sessionId, projectPath) {
  if (!sessionId || typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return null;
  // Require an explicit projectPath. Codex v1.0.29 round-1 MED.
  if (typeof projectPath !== 'string' || !projectPath) return null;
  // Try both encoder forms (v1.0.33 merge, matches getLatestSession pattern).
  const encodings = [encodePathLikeClaude(projectPath), encodePathLikeClaudeLegacy(projectPath)];
  let transcriptPath = null;
  for (const enc of encodings) {
    const p = path.join(PROJECTS_DIR, enc, `${sessionId}.jsonl`);
    if (await pathExists(p)) { transcriptPath = p; break; }
  }
  if (!transcriptPath) return null;
  // Long tool/thinking tails can push the last visible text past a 200-entry
  // tail window. 1000 covers realistic agent sessions while still bounded.
  const entries = await parseJsonl(transcriptPath, 1000);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const isAssistant = entry.type === 'assistant'
      || entry.role === 'assistant'
      || entry.message?.role === 'assistant';
    if (!isAssistant) continue;
    const text = extractAssistantText(entry);
    if (text) return text;
  }
  return null;
}

function extractAssistantText(entry) {
  const msg = entry.message ?? entry;
  if (typeof msg === 'string') return msg;
  if (typeof msg.content === 'string') return msg.content;
  if (typeof entry.content === 'string') return entry.content;
  // Array of content blocks (Anthropic API shape): keep text blocks only,
  // skip tool_use / tool_result / thinking, the user never saw those as text.
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n\n')
      .trim() || null;
  }
  return null;
}

async function parseTranscriptFile(filePath) {
  const messages = [];
  let payloadBytes = 0;
  let truncated = false;
  await streamJsonl(filePath, (entry) => {
    if (truncated) return;
    let role = null;
    if (entry.type === 'human' || entry.role === 'user' || entry.message?.role === 'user') role = 'user';
    else if (entry.type === 'assistant' || entry.role === 'assistant' || entry.message?.role === 'assistant') role = 'assistant';
    if (!role) return;
    let content = '';
    const msgContent = entry.message?.content;
    if (typeof msgContent === 'string') {
      content = msgContent;
    } else if (Array.isArray(msgContent)) {
      content = msgContent.map((c) => c.text || c.thinking || '').filter(Boolean).join('\n');
    } else if (typeof entry.message === 'string') {
      content = entry.message;
    } else if (typeof entry.content === 'string') {
      content = entry.content;
    }
    if (!content) return;
    if (content.length > MAX_MESSAGE_CHARS) {
      content = content.slice(0, MAX_MESSAGE_CHARS) + `\n\n[message truncated at ${MAX_MESSAGE_CHARS} chars]`;
    }
    payloadBytes += content.length + 64; // rough overhead for the wrapper object
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      truncated = true;
      messages.push({ role: 'system', content: `[transcript preview truncated: payload exceeded ${MAX_PAYLOAD_BYTES} bytes]`, timestamp: null });
      return;
    }
    messages.push({ role, content, timestamp: entry.timestamp || null });
  });
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

    // Flatten projects + files into one task list and use mapLimit(24).
    // The previous nested Promise.all started parseJsonl(filePath) on every
    // sub-8MB session in every project simultaneously, which saturated file
    // descriptors and main-process memory on machines with hundreds-thousands
    // of sessions. Same OOM class as the v1.0.23 loadAllSessions fix.
    // Codex PR#3 r13 P2.
    const perProject = new Map(); // dirName -> { inputTokens, ..., sessions, modelTotals }
    const fileTasks = [];
    for (const dir of dirents.filter((d) => d.isDirectory())) {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      perProject.set(dir.name, {
        projectDir,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        sessions: 0,
        modelTotals: {},
      });
      try {
        const files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
        for (const f of files) fileTasks.push({ dirName: dir.name, file: f });
      } catch { /* unreadable project dir, skip */ }
    }

    await mapLimit(fileTasks, 24, async ({ dirName, file }) => {
      const acc = perProject.get(dirName);
      if (!acc) return;
      const filePath = path.join(acc.projectDir, file);
      // Stat is cheap and lets us skip unreadable files. The previous 8MB
      // skip dropped large transcripts entirely (the most expensive sessions
      // disappeared from Costs totals), so the totals materially under-
      // reported usage. Switched to streamJsonl which is line-by-line, flat
      // memory, can scan a 100MB transcript without an OOM risk.
      // Codex PR#3 r14 P2.
      try {
        await fs.stat(filePath);
      } catch { return; }
      acc.sessions += 1;
      await streamJsonl(filePath, (entry) => {
        const usage = entry.message?.usage;
        const model = entry.message?.model || 'unknown';
        if (!usage) return;
        const inp = (usage.input_tokens || 0);
        const out = (usage.output_tokens || 0);
        const cr  = (usage.cache_read_input_tokens || 0);
        const cw  = (usage.cache_creation_input_tokens || 0);
        acc.inputTokens += inp;
        acc.outputTokens += out;
        acc.cacheReadTokens += cr;
        acc.cacheWriteTokens += cw;
        if (!acc.modelTotals[model]) acc.modelTotals[model] = { inp: 0, out: 0, cr: 0, cw: 0 };
        acc.modelTotals[model].inp += inp;
        acc.modelTotals[model].out += out;
        acc.modelTotals[model].cr  += cr;
        acc.modelTotals[model].cw  += cw;
      });
    });

    for (const [dirName, acc] of perProject) {
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, sessions, modelTotals } = acc;
      if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) continue;
      const dir = { name: dirName };

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
    }
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

    // v1.0.33 Codex fix: build encodedToReal map the same way loadAllSessions
    // does, so search hits resolve to REAL project paths instead of a
    // fabricated dash-to-slash guess. Previously a click-to-resume on a
    // hit whose project name contained underscores or other encoded chars
    // would `cd '<fabricated path>' && claude --resume ...` and fail.
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
    } catch { /* noop */ }
    for (const manualPath of getManualProjects()) {
      encodedToReal.set(encodePathLikeClaude(manualPath), manualPath);
    }

    const fileTasks = [];
    for (const dir of dirents.filter((d) => d.isDirectory())) {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const realPath = encodedToReal.get(dir.name) || tryReconstructPath(dir.name);
      const projectPath = realPath || ('/' + dir.name.replace(/-/g, '/'));
      const projectName = realPath
        ? realPath.split('/').filter(Boolean).pop()
        : (dir.name.split('-').filter(Boolean).pop() || dir.name);
      try {
        const files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
        for (const f of files) fileTasks.push({ projectDir, projectName, projectPath, file: f });
      } catch { /* skip unreadable project */ }
    }

    await mapLimit(fileTasks, 16, async ({ projectDir, projectName, projectPath, file: f }) => {
      // Cap honored at task-start AND inside the line callback.
      if (matches.length >= 200) return;
      const sessionId = f.replace('.jsonl', '');
      const filePath = path.join(projectDir, f);
      // Capture size so a resume-from-search can hit the >80MB dead-session
      // guard. Without sizeMB on each match, Search bypassed the block and
      // oversized transcripts still hung Claude. Codex PR#3 r22 P2.
      let sizeMB = 0;
      try {
        const st = await fs.stat(filePath);
        sizeMB = st.size / (1024 * 1024);
      } catch { return; }
      // Stream the file line-by-line. The previous version skipped any
      // transcript >5MB entirely, so the most recent long-running sessions
      // were silently unsearchable. streamJsonl scans with flat memory and
      // we honor the result cap with a per-file flag we can flip mid-stream.
      // Codex PR#3 r19 P2.
      let sessionTimestamp = 0;
      let capHit = false;
      const buffered = []; // hold matches until end-of-file to fill in sessionTimestamp fallback
      await streamJsonl(filePath, (entry) => {
        if (capHit) return;
        if (matches.length + buffered.length >= 200) { capHit = true; return; }
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        if (ts > sessionTimestamp) sessionTimestamp = ts;
        let text = '';
        const msgContent = entry.message?.content;
        if (typeof msgContent === 'string') {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent
            .map((c) => c.text || c.thinking || '')
            .filter(Boolean)
            .join(' ');
        } else if (typeof entry.message === 'string') {
          text = entry.message;
        } else if (typeof entry.content === 'string') {
          text = entry.content;
        }
        if (!text || !text.toLowerCase().includes(qLower)) return;

        const idx = text.toLowerCase().indexOf(qLower);
        const start = Math.max(0, idx - 80);
        const end = Math.min(text.length, idx + q.length + 80);
        const excerpt =
          (start > 0 ? '...' : '') +
          text.slice(start, end) +
          (end < text.length ? '...' : '');
        const role = (entry.type === 'human' || entry.type === 'user'
          || entry.role === 'user' || entry.message?.role === 'user')
          ? 'user' : 'assistant';
        buffered.push({
          sessionId, projectName, projectPath, role, excerpt, ts,
        });
      });
      for (const m of buffered) {
        if (matches.length >= 200) break;
        matches.push({
          sessionId: m.sessionId,
          projectName: m.projectName,
          projectPath: m.projectPath,
          role: m.role,
          excerpt: m.excerpt,
          timestamp: m.ts || sessionTimestamp,
          sizeMB, // feeds the resume dead-session guard, Codex PR#3 r22 P2
        });
      }
    });
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
    // Scan BOTH encoder forms (new + legacy slash-to-dash). Without this,
    // any project whose transcripts still live in the legacy `(Code)` dir
    // returned null and the status-bar context % was permanently missing.
    // Same pattern as getLatestSession / loadAllSessions / getSessionSize.
    // Codex Apple-grade audit r26 P2.
    const encodings = [encodePathLikeClaude(projectPath), encodePathLikeClaudeLegacy(projectPath)];
    const seenDirs = new Set();
    const fileStats = [];
    let activeProjectDir = null;
    for (const enc of encodings) {
      if (seenDirs.has(enc)) continue;
      seenDirs.add(enc);
      const projectDir = path.join(PROJECTS_DIR, enc);
      if (!(await pathExists(projectDir))) continue;
      let files;
      try { files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl')); }
      catch { continue; }
      const localStats = await Promise.all(files.map(async (f) => {
        try {
          const stat = await fs.stat(path.join(projectDir, f));
          return { file: f, mtime: stat.mtimeMs, projectDir };
        } catch { return { file: f, mtime: 0, projectDir }; }
      }));
      for (const s of localStats) fileStats.push(s);
      activeProjectDir = projectDir; // last non-empty seen, sort below picks the real latest
    }
    if (fileStats.length === 0) return null;
    const latest = fileStats.reduce((a, b) => b.mtime > a.mtime ? b : a);

    // Use the projectDir attached to the chosen file (its OWN dir), not the
    // last-seen activeProjectDir, so the path resolves even when the newest
    // session lives in a different encoding form than the last one scanned.
    const filePath = path.join(latest.projectDir || activeProjectDir, latest.file);
    // BOUNDED tail read. estimateContextSize fires every 30s while a project
    // window is open. Reading the whole transcript each time stalls or OOMs
    // main on the typical Claude transcript size in this app (20-30MB common).
    // Token usage lives on assistant messages, which only need the most-recent
    // run to estimate context. Last 50 entries is plenty since usage stamps
    // appear every assistant turn. Codex PR#3 r7 P2.
    const entries = await parseJsonl(filePath, 200);

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
