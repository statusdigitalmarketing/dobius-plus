import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import {
  HISTORY_PATH, STATS_PATH, SETTINGS_PATH, CLAUDE_JSON_PATH, MCP_BRIDGE_CONFIG, PLANS_DIR, SKILLS_DIR, PLUGINS_DIR, PROJECTS_DIR,
  parseJsonl, streamJsonl, timeAgo, pathExists, mapLimit,
} from './data-utils.js';
import { listCodexSessions, codexTranscript } from './codex-sessions.js';
import { getSettings, getManualProjects, getProjectDisplayNames, getHiddenProjects, getAllProjectsWithTabs, getSessionTabMap } from './config-manager.js';

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
export async function loadAllSessions(projectFilter, opts = {}) {
  const sources = Array.isArray(opts.sources) && opts.sources.length ? opts.sources : ['claude'];
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

    // Session sources the user hid from history (Sessions tab > Hide). An
    // explicit projectFilter wins: a project window's own sidebar still shows
    // that project's sessions even if it was hidden from the global list.
    let hiddenPaths = new Set();
    try {
      const hp = getSettings().hiddenSessionPaths;
      if (Array.isArray(hp)) hiddenPaths = new Set(hp.filter((p) => typeof p === 'string'));
    } catch { void 0; }

    // Flatten every transcript across every project into one task list, then
    // process it with a bounded worker pool. The previous nested Promise.all
    // fanned out across all projects AND all files at once, opening thousands
    // of file handles simultaneously — combined with the old whole-file read
    // in parseJsonl, that OOM-crashed the main process on dashboards with large
    // ~/.claude histories. A cap of 24 keeps memory and fd usage flat.
    const fileTasks = [];
    // Only scan Claude transcripts when Claude is a requested source. The
    // Codex tab (sources=['codex']) must NOT return Claude sessions (reviewer
    // HIGH: "Codex" and "All" were byte-identical). Empty fileTasks below makes
    // the mapLimit a no-op.
    if (sources.includes('claude')) for (const dir of projectDirs) {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const realPath = encodedToReal.get(dir.name) || tryReconstructPath(dir.name);
      const projectPath = realPath || ('/' + dir.name.replace(/-/g, '/'));
      // Pre-filter by project so the global 500-cap applies to the matching
      // set, not to everything-then-trimmed. Codex PR#3 r8 P2.
      if (projectFilter && projectPath !== projectFilter) continue;
      // Skip user-hidden sources (before any file reads, so 260 headless spam
      // transcripts cost zero I/O). projectFilter above already bypasses this.
      if (!projectFilter && hiddenPaths.has(projectPath)) continue;
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
          let role = (entry.type === 'human' || entry.role === 'user' || entry.message?.role === 'user')
            ? 'user'
            : (entry.type === 'assistant' || entry.role === 'assistant' || entry.message?.role === 'assistant')
              ? 'assistant'
              : '';
          if (role === 'user') {
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
            // System-injected pseudo-user rows (task notifications, system
            // reminders, command echoes, skill bodies) are not turns Sam took:
            // they must not become the preview (v1.0.37) NOR count as "user
            // spoke last", which pinned a finished session's sidebar dot on
            // red 'needs' forever when a notification trailed the real ending
            // (Codex, Medium). Tool-result rows carry no text and keep their
            // role: a trailing tool result genuinely means Claude owes a
            // reply.
            if (text && isSyntheticUserText(text)) {
              role = '';
            } else if (!preview && text) {
              preview = sanitizePreviewText(text).slice(0, 200);
            }
          }
          // lastRole is the newest role we saw (tail walk, first match wins).
          if (role && !lastRole) lastRole = role;
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
          source: 'claude',
        });
      } catch {
        void 0;
      }
    });
  // Codex sessions (v1.0.72). Only scanned when the caller asks for them, so
  // the Claude-default history costs zero Codex I/O. The filter lives in the
  // UI; sources controls what this reads.
  if (sources.includes('codex')) {
    try {
      const codex = await listCodexSessions({
        limit: 60,
        includeExec: !!opts.includeCodexExec,
        projectFilter: projectFilter || null,
        timeAgo,
      });
      for (const it of codex) sessions.push(it);
    } catch (err) {
      console.warn('[data-service] Failed to load codex sessions:', err.message);
    }
  }
  } catch (err) {
    console.warn('[data-service] Failed to load all sessions:', err.message);
    return [];
  }

  return sessions
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 500);
}

/**
 * Cross-window "tabs by project" for the Cmd+B sidebar (Brett task). READ-ONLY
 * and purely additive: it reuses the existing history/session machinery
 * (loadAllSessions) and the existing session<->tab links (getSessionTabMap)
 * without modifying either, and never writes config. Returns
 *   [{ path, name, lastActiveAt, tabs: [{ id, label, kind, url?, sessionId?,
 *      preview?, status?, lastActiveAt }] }]
 * with projects and their tabs sorted most-recent-first. `label` is the tab's
 * own persisted label (identical to the tab bar), so naming can't drift.
 * Assembled from data that survives quit/restart (config.projects[*].tabs +
 * sessionTabMap + transcripts).
 */
/**
 * @param {object} [opts]
 * @param {Set<string>} [opts.liveTabIds] tab ids with a live PTY right now (from
 *   terminal-manager). Used to mark rows `live` so the sidebar focuses the
 *   owning window instead of resuming (which would duplicate the session). H3.
 * @param {Array<{projectPath:string,tabId:string,label?:string}>} [opts.tearOffTabs]
 *   currently-open tear-off windows. Their torn tab is removed from the primary
 *   window's persisted tabs, so without this the aggregate omits it entirely. M4.
 */
export async function getAllProjectTabs({ liveTabIds = null, tearOffTabs = [] } = {}) {
  // Respect the same hidden/removed-project suppression the project list uses, so
  // a project the user deliberately hid doesn't reappear here. Codex.
  const hidden = new Set(getHiddenProjects());
  const projects = getAllProjectsWithTabs().filter((p) => !hidden.has(p.path)); // [{ path, tabs, tabCounter }]
  const tornOffIds = new Set((Array.isArray(tearOffTabs) ? tearOffTabs : []).map((t) => t && t.tabId).filter(Boolean));
  if (projects.length === 0 && tornOffIds.size === 0) return [];
  const displayNames = getProjectDisplayNames() || {};

  // Reverse the sessionTabMap to tabId -> { sessionId, at }. A tab id can be
  // reused across sessions, so keep the most recent link per tab id.
  const tabMap = getSessionTabMap() || {};
  const byTab = new Map();
  for (const [sessionId, link] of Object.entries(tabMap)) {
    if (!link || typeof link !== 'object' || !link.tabId) continue;
    const at = link.lastRunningAt || link.capturedAt || 0;
    const prev = byTab.get(link.tabId);
    if (!prev || at >= prev.at) byTab.set(link.tabId, { sessionId, at });
  }

  // One global session index. Currently-open tabs always link to recent
  // sessions, so the 500 cap can't realistically miss one; a miss degrades
  // gracefully to a label-only row (never an error). Codex design review.
  const sessions = await loadAllSessions();
  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));

  // Shape one output row from a persisted tab (or a synthetic tear-off tab).
  const toRow = (t, tornOff) => {
    const link = t && t.id ? byTab.get(t.id) : null;
    const sess = link ? sessionById.get(link.sessionId) : null;
    const lastActiveAt = sess?.timestamp || link?.at || t?.createdAt || 0;
    return {
      id: t?.id,
      label: t?.label || 'Tab',
      kind: t?.kind || 'terminal',
      url: t?.url || undefined,
      sessionId: link?.sessionId || undefined,
      preview: sess?.preview || undefined,
      status: sess?.status || undefined,
      // live = a PTY is running for this tab id in SOME window. The sidebar uses
      // this to focus the owning window instead of resuming a still-live session
      // (which would spawn a duplicate). H3. Null liveTabIds => unknown => false.
      live: liveTabIds ? liveTabIds.has(t?.id) : false,
      tornOff: !!tornOff,
      lastActiveAt,
    };
  };

  // Group tear-off tabs by their project so they can be appended to the matching
  // project (or seed a project row that has no other persisted tabs). M4.
  const tearsByProject = new Map();
  for (const to of (Array.isArray(tearOffTabs) ? tearOffTabs : [])) {
    if (!to || !to.tabId || !to.projectPath || hidden.has(to.projectPath)) continue;
    if (!tearsByProject.has(to.projectPath)) tearsByProject.set(to.projectPath, []);
    tearsByProject.get(to.projectPath).push(to);
  }

  const knownPaths = new Set(projects.map((p) => p.path));
  const rowsFor = (path, tabs) => {
    const persisted = (Array.isArray(tabs) ? tabs : []).map((t) => toRow(t, tornOffIds.has(t?.id)));
    const seen = new Set(persisted.map((r) => r.id));
    const torn = (tearsByProject.get(path) || [])
      .filter((to) => !seen.has(to.tabId))
      // Pass kind/url/createdAt through: tear-off buckets carry full tab
      // entries, and dropping them rendered a browser tab in a tear-off as a
      // dateless terminal row (Codex integration round, Medium).
      .map((to) => toRow({ id: to.tabId, label: to.label || 'Tab', kind: to.kind || 'terminal', url: to.url, createdAt: to.createdAt }, true));
    return [...persisted, ...torn].filter((t) => t.id).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  };

  const result = projects.map(({ path, tabs }) => {
    const name = displayNames[path] || path.split('/').filter(Boolean).pop() || path;
    const outTabs = rowsFor(path, tabs);
    const projLastActive = outTabs.length ? outTabs[0].lastActiveAt : 0;
    return { path, name, lastActiveAt: projLastActive, tabs: outTabs };
  });

  // A tear-off whose primary project window is closed (path not in `projects`)
  // would otherwise vanish from the aggregate; surface it as its own group. M4.
  for (const [path] of tearsByProject) {
    if (knownPaths.has(path)) continue;
    const name = displayNames[path] || path.split('/').filter(Boolean).pop() || path;
    const outTabs = rowsFor(path, []);
    if (outTabs.length === 0) continue;
    result.push({ path, name, lastActiveAt: outTabs[0].lastActiveAt, tabs: outTabs });
  }

  return result.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

/**
 * Get the most recent session for a given project path.
 * Returns { sessionId, preview, timestamp, age } or null.
 */
/**
 * Resolve the sessionId a FRESH `claude` process is writing to.
 *
 * v1.0.39 (Brett-reported: tabs show no name in the session history). A
 * fresh `claude` (no --resume) generates its session id at runtime, so it
 * never appears in the process argv and the tab could never be linked to a
 * session. Verified on this machine that `lsof` does NOT expose the
 * transcript fd (Claude appends and closes), and the ~/.claude/tasks/<id>/
 * .lock files are advisory and not held, so neither gives an exact mapping.
 *
 * What DOES correlate exactly: the transcript is CREATED moments after the
 * claude process starts. Measured live: process start 21:49:26 -> transcript
 * birthtime 21:49:52 (26s later, Claude booting), while every other
 * transcript in that project was born weeks earlier.
 *
 * So: look ONLY inside the tab's own project dir (scoping is what makes this
 * safe), keep transcripts born in [startedAt - CLOCK_SLACK, startedAt +
 * BOOT_WINDOW], drop any id already claimed by another tab, and take the
 * closest to the process start. Returns null when nothing matches, which is
 * correct and common: a claude sitting at an empty prompt has not written a
 * transcript at all, so there is no session to link.
 *
 * Precision matters more than coverage here because sessionTabMap also feeds
 * auto-resume, which TYPES `claude --resume <id>` into tabs on launch. A miss
 * is harmless (no badge); a mislink would resume the wrong session. Hence the
 * tight window, the project scope, and the claimed-id exclusion.
 *
 * @param {string} projectPath  the tab's cwd-derived project root
 * @param {number} startedAt    epoch ms the claude process started
 * @param {Set<string>} claimed sessionIds already linked to other live tabs
 */
// (No upper bound on transcript birth: Claude writes it on the first message,
// which may be hours after boot. See the delta check below.)
const FRESH_CLOCK_SLACK_MS = 10 * 1000;     // ps lstart is second-resolution
export async function resolveFreshSessionId(projectPath, startedAt, claimed = new Set(), otherFreshStarts = []) {
  if (!projectPath || typeof projectPath !== 'string') return null;
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const encodings = [encodePathLikeClaude(projectPath), encodePathLikeClaudeLegacy(projectPath)];
  const seenDirs = new Set();
  let best = null;
  for (const enc of encodings) {
    if (seenDirs.has(enc)) continue;
    seenDirs.add(enc);
    const projectDir = path.join(PROJECTS_DIR, enc);
    if (!(await pathExists(projectDir))) continue;
    let files;
    try { files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl')); }
    catch { continue; }
    for (const f of files) {
      const sessionId = f.replace('.jsonl', '');
      if (claimed.has(sessionId)) continue;
      let birth;
      try {
        const st = await fs.stat(path.join(projectDir, f));
        // birthtimeMs is real on APFS. Fall back to ctime if it's absent/0.
        birth = st.birthtimeMs || st.ctimeMs || 0;
      } catch { continue; }
      if (!birth) continue;
      const delta = birth - startedAt;
      // Must be born AFTER this process started (a process cannot write a
      // file before it exists). No upper bound: Claude creates the transcript
      // on the FIRST MESSAGE, not at boot, and the user may sit at an empty
      // prompt for hours. The old fixed 3-minute window rejected exactly
      // those sessions forever. Codex v1.0.39 r4 P2.
      if (delta < -FRESH_CLOCK_SLACK_MS) continue;
      // Earliest transcript born after this process started is the one it
      // created (equivalent to "closest after" once the upper bound is gone).
      if (!best || delta < best.delta) best = { sessionId, delta, birth };
    }
  }
  if (!best) return null;
  // AMBIGUITY GUARD: if any OTHER live fresh claude in this project started at
  // or before this transcript was born, that process could equally have
  // created it, so we cannot tell them apart from (start, birth) alone.
  // Decline rather than guess: a miss just costs a tab badge, but a mislink
  // would make auto-resume TYPE `claude --resume <wrong-id>` into a terminal.
  // Codex v1.0.39 r4 P2.
  //
  // Already-linked sessions are excluded via `claimed` before we get here, so
  // this only declines while two UNLINKED fresh claudes coexist in one
  // project. The 15s tick claims each session as it becomes identifiable, so
  // the pool drains as sessions are started at different times.
  const ambiguous = otherFreshStarts.some((t) => Number.isFinite(t) && t <= best.birth);
  if (ambiguous) return null;
  return best.sessionId;
}

/**
 * Resolve a CONTINUED session: `claude --continue` (and any resume whose id is
 * not in the argv) keeps writing a transcript that ALREADY EXISTED, so
 * resolveFreshSessionId's born-after-start test rejects it and the tab is
 * never linked at all.
 *
 * That is the bug behind Brett's v1.0.56 report: after a reset + update + a
 * desktop resume, his tabs had a live Claude but no link, so the phone showed
 * "No messages yet" on real conversations and offered Start/Resume over a
 * running session. Dobius's own mobile "Resume last session" button sends
 * `claude --continue`, so it created the very state it could not resolve.
 *
 * Evidence used here is a WRITE, not a birth: a transcript in this project
 * whose mtime advanced after the process started is being appended to by
 * something, and on a single-claude project that something is this process.
 * Same conservative posture as the fresh resolver: unclaimed only, and
 * decline outright when another unlinked Claude in the same project could
 * equally be the writer, because a mislink makes auto-resume type
 * `claude --resume <wrong-id>` into a terminal.
 *
 * Accepted residual (Codex round 2, Medium): a HEADLESS `claude -p` run in the
 * same project (SamKnows.app fires one every ~40s, see .dobius/NOTES.md) is
 * not a live tab, so it never enters the ambiguity set, and its transcript can
 * win on mtime. Bounded: the resulting link is tagged 'fresh', which the
 * auto-resume gate does not act on, so the cost is the phone showing the wrong
 * conversation for that tab until the next tick corrects it. Excluding
 * headless runs needs transcript-content inspection (reading entries to spot a
 * one-shot run), which is a bigger change than this fix and is tracked in
 * TODO.md rather than bolted on here.
 */
export async function resolveContinuedSessionId(
  projectPath, startedAt, claimed = new Set(), otherFreshStarts = [],
) {
  if (!projectPath || typeof projectPath !== 'string') return null;
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  // Any other unlinked Claude in this project could be the writer instead.
  // Unlike the birth test there is no per-candidate discriminator to fall back
  // on, so decline as soon as a rival exists at all.
  if (otherFreshStarts.some((t) => Number.isFinite(t))) return null;
  const encodings = [encodePathLikeClaude(projectPath), encodePathLikeClaudeLegacy(projectPath)];
  const seenDirs = new Set();
  let best = null;
  for (const enc of encodings) {
    if (seenDirs.has(enc)) continue;
    seenDirs.add(enc);
    const projectDir = path.join(PROJECTS_DIR, enc);
    if (!(await pathExists(projectDir))) continue;
    let files;
    try { files = (await fs.readdir(projectDir)).filter((f) => f.endsWith('.jsonl')); }
    catch { continue; }
    for (const f of files) {
      const sessionId = f.replace('.jsonl', '');
      if (claimed.has(sessionId)) continue;
      let st;
      try { st = await fs.stat(path.join(projectDir, f)); } catch { continue; }
      const mtime = st.mtimeMs || 0;
      // Written AFTER this process started: that write is the evidence. A
      // transcript last touched before the process existed cannot be its work.
      if (!mtime || mtime < startedAt - FRESH_CLOCK_SLACK_MS) continue;
      // Empty files are not a conversation; linking one reproduces the exact
      // "No messages yet" dead end this fix exists to remove.
      if (!st.size) continue;
      if (!best || mtime > best.mtime) best = { sessionId, mtime };
    }
  }
  return best ? best.sessionId : null;
}

/**
 * Birth time (epoch ms) of a session's transcript within a project, checking
 * both encoder forms. 0 when the file is not found under either.
 */
async function sessionTranscriptBirth(projectPath, sessionId) {
  if (!projectPath || !sessionId) return 0;
  const seen = new Set();
  for (const enc of [encodePathLikeClaude(projectPath), encodePathLikeClaudeLegacy(projectPath)]) {
    if (seen.has(enc)) continue;
    seen.add(enc);
    try {
      const st = await fs.stat(path.join(PROJECTS_DIR, enc, `${sessionId}.jsonl`));
      const b = st.birthtimeMs || st.ctimeMs || 0;
      if (b) return b;
    } catch { /* try the other encoding */ }
  }
  return 0;
}

/**
 * Resolve the FRESH (bare `claude`, no --resume) session running in each tab.
 *
 * Shared by the 15s capture tick and the Phase-2 quit reconcile in main.js.
 * Those two hand-rolled separate copies of this and drifted apart twice (Codex
 * v1.0.39 r3 and r5, each a real mislink), so there is now exactly one copy.
 * It lives here, next to resolveFreshSessionId, because it takes the process
 * probe results as plain arguments and so is pure and directly testable, which
 * main.js (which imports electron) is not.
 *
 * @param {Array<{id: string, cwd: string}>} liveTabs terminals to consider
 * @param {Map<string, {sessionId: string|null, startedAt: number|null}|null>} infoByTab
 * @param {Map<string, string>} cwdByTab   cwd per tab, only for fresh-claude tabs
 * @param {Map<string, string>} tabToSessionId  tabId -> currently linked sessionId
 * @param {Set<string>} claimedIds  sessionIds linked to SOME tab. MUTATED: a
 *                                  resolved id is added so a later tab in the
 *                                  same pass cannot claim the same transcript.
 * @param {() => boolean} [isAborted]  checked between tabs (quit has a 2s cap)
 * @returns {Promise<Map<string, string>>} tabId -> resolved sessionId
 */
export async function resolveFreshSessionsForTabs(
  liveTabs, infoByTab, cwdByTab, tabToSessionId, claimedIds, isAborted,
) {
  const out = new Map();
  // Claim every id a LIVE tab names in its OWN argv before any inference runs.
  // Callers seed claimedIds from the persisted map only, so a tab running
  // `claude --resume X` whose link is not written yet leaves X unclaimed, and
  // an inferring tab in the same project could take it: a mislink that points
  // the phone at someone else's conversation and can make auto-resume type
  // `--resume X` into the wrong terminal. Done HERE, not in the callers, so
  // the periodic tick and the quit-time reconcile cannot drift apart.
  // Codex High (Brett v1.0.56 follow-up).
  const argvByTab = new Map();
  for (const t of liveTabs) {
    const argvSid = infoByTab.get(t.id)?.sessionId;
    if (argvSid) { claimedIds.add(argvSid); argvByTab.set(t.id, argvSid); }
  }
  // Ids named in the argv of every live tab EXCEPT the given one.
  const argvOwnedByOthers = (tabId) => {
    const s = new Set();
    for (const [id, sid] of argvByTab) if (id !== tabId) s.add(sid);
    return s;
  };
  // Earliest-started first. The earliest bare `claude` in a project owns the
  // earliest unclaimed transcript, so resolving in start order lets each link
  // drop that tab out of the NEXT tab's ambiguity set. That ordering is what
  // makes a second bare `claude` in the same project resolvable in a single
  // pass, which matters at quit because there is no next tick to converge on.
  const freshTabs = liveTabs
    .filter((t) => cwdByTab.has(t.id) && Number.isFinite(infoByTab.get(t.id)?.startedAt))
    .sort((a, b) => infoByTab.get(a.id).startedAt - infoByTab.get(b.id).startedAt);
  // Fresh tabs whose CURRENT process is already accounted for by a link.
  //
  // Having a link is not enough: a tab mapped to an old session that has since
  // started a bare `claude` still has an UNRESOLVED transcript, so it remains a
  // rival claimant and must stay in everyone's ambiguity set. Treating it as
  // linked let another fresh tab claim a transcript this one may have created,
  // which auto-resume would then type into the wrong terminal.
  // Codex v1.0.39 r7 P2.
  //
  // The test: a link belongs to THIS process only if the linked transcript was
  // born after the process started. A transcript that predates the process
  // cannot have been written by it.
  const linkedTabs = new Set();
  for (const t of freshTabs) {
    const sid = tabToSessionId.get(t.id);
    if (!sid) continue;
    const birth = await sessionTranscriptBirth(cwdByTab.get(t.id), sid);
    if (birth && birth >= infoByTab.get(t.id).startedAt - FRESH_CLOCK_SLACK_MS) {
      linkedTabs.add(t.id);
    }
  }
  for (const t of freshTabs) {
    if (isAborted?.()) return out;
    const cwd = cwdByTab.get(t.id);
    const info = infoByTab.get(t.id);
    // Exclude only OTHER tabs' claims. claimedIds is seeded from the whole map,
    // which includes THIS tab's own link from a previous tick; leaving it in
    // made the resolver skip the tab's own transcript and return null, so the
    // idle branch zeroed the stamp and every fresh session died after one tick.
    // Codex v1.0.39 r2 P2.
    const ownSid = tabToSessionId.get(t.id);
    const claimedByOthers = new Set(claimedIds);
    // Un-claim this tab's own mapped id so it can re-resolve its own
    // transcript, BUT never when another live tab names that id in its argv:
    // a stale map entry pointing this tab at X while tab B actually runs
    // `--resume X` would otherwise re-expose X and hand B's conversation to
    // this tab. Codex round 2 (mislink class).
    if (ownSid && !argvOwnedByOthers(t.id).has(ownSid)) claimedByOthers.delete(ownSid);
    // Ambiguity set: ONLY the other fresh claudes in this same project that are
    // not yet linked. An already-linked one owns its own transcript and so
    // cannot also own this candidate. Counting it (as we did) declined every
    // later bare `claude` in a project for as long as an older one kept
    // running, which is the normal multi-tab case, not an edge case.
    // Codex v1.0.39 r6 P2.
    const otherFreshStarts = [];
    for (const o of freshTabs) {
      if (o.id === t.id || linkedTabs.has(o.id) || cwdByTab.get(o.id) !== cwd) continue;
      otherFreshStarts.push(infoByTab.get(o.id).startedAt);
    }
    let sid = await resolveFreshSessionId(cwd, info.startedAt, claimedByOthers, otherFreshStarts);
    // Nothing born after this process started: it is very likely a CONTINUED
    // session (`claude --continue`), which appends to a transcript that
    // already existed. Fall back to write evidence. Brett v1.0.56.
    if (!sid) {
      sid = await resolveContinuedSessionId(cwd, info.startedAt, claimedByOthers, otherFreshStarts);
    }
    if (sid) {
      out.set(t.id, sid);
      claimedIds.add(sid);
      linkedTabs.add(t.id);
    }
  }
  return out;
}

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
// Claude Code records several SYSTEM-INJECTED messages with role:'user' that
// the human never typed: background task notifications, system reminders,
// slash-command echoes, local-command output, and the compaction preamble.
// The sidebar preview walks backward for the newest user message, so without
// this filter the most recent entry is almost always a `<task-notification>`
// XML blob instead of the actual prompt (v1.0.37, Sam-reported: "this session
// history looks weird" with every row showing "<task-notification> <task-id>b...").
// Tool results are already excluded upstream by the text-block-only filter.
const SYNTHETIC_USER_PREFIXES = [
  '<task-notification',
  '<system-reminder',
  '<local-command-stdout',
  '<local-command-caveat',
  '<command-name',
  '<command-message',
  '<command-args',
  '<user-prompt-submit-hook',
  'Caveat: The messages below were generated by the user while running local commands',
  'This session is being continued from a previous conversation',
  // Skill invocations inject the skill body as a bare user message with no
  // XML marker; the first line is always this. Without it, a session whose
  // last entry is a /skill expansion reads as "you asked and Claude never
  // answered" in loose ends, and the sidebar previews a wall of skill text.
  'Base directory for this skill:',
];
function isSyntheticUserText(text) {
  if (!text) return true;
  const t = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((p) => t.startsWith(p));
}

// A pasted image is saved by terminal:saveClipboardImage to
// <temp>/dobius-clipboard/clipboard-<ts>.<ext> and that PATH is typed into the
// terminal, so Claude records it as the user message and the sidebar previewed
// the raw temp path ("this session is being called like clipboard-….png").
// Same leak class as the v1.0.37 synthetic-message filter, different source.
// Replace any such path with "[image]" so a paste reads as an image, keeping
// whatever real text the user typed alongside it. v1.0.40 (Sam-reported).
const CLIPBOARD_IMG_RE = /\S*dobius-clipboard[/\\]clipboard-\d+\.[A-Za-z0-9]+/g;
export function sanitizePreviewText(text) {
  if (!text) return text;
  return text.replace(CLIPBOARD_IMG_RE, '[image]').replace(/\s+/g, ' ').trim();
}

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
      let mtime;
      let size;
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
            // Same synthetic-user filter as loadAllSessions: never preview a
            // task-notification / system-reminder blob as the user's prompt
            // (v1.0.37), and turn a pasted-image temp path into "[image]"
            // rather than clipboard-….png (v1.0.40).
            if (content && !isSyntheticUserText(content)) lastUserPreview = sanitizePreviewText(content).slice(0, 200);
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
    const parsed = JSON.parse(content);
    // Use the CLI's cache only if it actually carries activity. Current Claude
    // Code no longer writes ~/.claude/stats-cache.json, so an empty/absent cache
    // must fall through to history-derived stats instead of leaving the Stats +
    // Overview tabs blank (audit finding: both were BROKEN).
    if (parsed && Array.isArray(parsed.dailyActivity) && parsed.dailyActivity.length > 0) {
      return parsed;
    }
  } catch { /* no cache present, derive from history below */ }
  return computeStatsFromHistory();
}

/**
 * Derive dashboard stats from ~/.claude/history.jsonl (each line is one user
 * prompt: { display, timestamp, project, sessionId }). Gives real
 * messages/sessions per day and hour-of-day distribution. Model usage and
 * tool-call counts live only in the per-session transcripts (GBs across all
 * projects), too heavy to parse on a dashboard open, so those stay empty and
 * their sections render their graceful hidden/empty state. Replaces the vanished
 * stats-cache.json as the source. Main-process only.
 */
async function computeStatsFromHistory() {
  const empty = { version: 2, dailyActivity: [], modelUsage: {}, hourCounts: {}, derived: true };
  let entries;
  try { entries = await parseJsonl(HISTORY_PATH); } catch { return empty; }
  if (!Array.isArray(entries) || entries.length === 0) return empty;
  const byDay = new Map(); // 'YYYY-MM-DD' -> { messageCount, sessions:Set }
  const hourCounts = {};
  const projects = new Set();
  for (const e of entries) {
    const ts = typeof e?.timestamp === 'number' ? e.timestamp : 0;
    if (!ts) continue;
    const d = new Date(ts);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let day = byDay.get(date);
    if (!day) { day = { messageCount: 0, sessions: new Set() }; byDay.set(date, day); }
    day.messageCount += 1;
    if (e.sessionId) day.sessions.add(e.sessionId);
    if (e.project) projects.add(e.project);
    hourCounts[d.getHours()] = (hourCounts[d.getHours()] || 0) + 1;
  }
  const dailyActivity = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0])) // chronological; chart slices last 14
    .map(([date, v]) => ({ date, messageCount: v.messageCount, sessionCount: v.sessions.size, toolCallCount: 0 }));
  // projectCount is a real derived metric the Overview shows in place of the
  // (transcript-only, unavailable) Tool Calls total when stats are derived.
  return { version: 2, dailyActivity, modelUsage: {}, hourCounts, projectCount: projects.size, derived: true };
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
    if (!/^[\w\s-]+$/.test(planName)) return '';
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
  } catch { /* optional file absent */ }

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
/**
 * Resolve a session's transcript file path, scoped to the supplied project and
 * probing both encoder forms. The old global fallback scanned EVERY project
 * dir and returned the first sessionId match, so a stale/wrong projectPath
 * could show a transcript from a completely different project (Codex v1.0.35
 * P1, same class as the deleteSession fix in v1.0.33).
 * Third candidate: the stripped-leading-dash form this function's old naive
 * encoder produced. No such dir exists on any known machine (Claude CLI always
 * writes leading-dash), but probing it is free and closes the theoretical gap
 * Codex flagged when the global fallback was removed. Codex v1.0.35 r4 P2.
 *
 * NOTE (r8 false-positive proof): probe #3 ALSO exactly round-trips the lossy
 * fallback projectPath loadAllSessions emits for UNRESOLVED dirs
 * ('/'+dir.replace(/-/g,'/')): dashes->slashes->dashes restores dir.name and
 * .replace(/^-/,'') strips the doubled leading dash. Verified for new-encoding,
 * legacy-(Code), and deleted-project dir names, so previews for sessions of
 * deleted/unscanned projects still load.
 */
async function resolveTranscriptPath(sessionId, projectPath) {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  if (typeof projectPath !== 'string' || !projectPath) return null;
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
    if (await pathExists(p)) return p;
  }
  return null;
}

/**
 * Cheap change-signature (mtime + size) for a session's transcript file, so a
 * poller (mobile Chat view) can skip the tail-read + parse when nothing has
 * changed. Returns null if the file can't be resolved. Audit M3.
 */
export async function getTranscriptSig(sessionId, projectPath) {
  try {
    const p = await resolveTranscriptPath(sessionId, projectPath);
    if (!p) return null;
    const st = await fs.stat(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export async function loadTranscript(sessionId, projectPath, limit, source) {
  try {
    if (source === 'codex') {
      // Codex transcripts live in ~/.codex/sessions, not ~/.claude/projects,
      // so resolveTranscriptPath can't find them (reviewer MEDIUM: codex cards
      // were tappable but showed "No messages"). codexTranscript finds the
      // rollout by uuid and returns the same {role, content} shape.
      return await codexTranscript(sessionId, { limit: typeof limit === 'number' ? limit : 0 });
    }
    const p = await resolveTranscriptPath(sessionId, projectPath);
    if (!p) return [];
    // A positive limit does a cheap tail read (mobile Chat poll); no limit
    // streams the full transcript (History view). Codex.
    return (typeof limit === 'number' && limit > 0) ? parseTranscriptTail(p, limit) : parseTranscriptFile(p);
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

// Map ONE raw JSONL entry to a { role, content } chat message, or null if it is
// not a user/assistant text turn (tool calls, meta, empty). Shared by the full
// stream and the bounded tail so the two can never diverge.
// A slash-command or skill invocation is recorded as a USER turn carrying
// either raw <command-*> tags or an entire skill markdown body ("Base
// directory for this skill: ..."). Rendering that verbatim buried the mobile
// chat under pages of skill text on every invocation (Sam's report). Collapse
// to the one-liner the user actually typed; local-command stdout keeps only
// its inner text. Returns null when the text is not a command shape.
export function collapseCommandContent(text) {
  const t0 = text.trimStart();
  // Anchor to the wrapper shape: genuine command turns START with the tags
  // (Codex corpus check: 3,295 real command turns, zero with leading prose;
  // either <command-name> first or <command-message> before it). A user
  // PASTING a transcript excerpt mid-message must not get their whole
  // message collapsed to the command one-liner.
  const anchored = t0.startsWith('<command-name>') || t0.startsWith('<command-message>');
  const nameM = anchored ? text.match(/<command-name>([\s\S]*?)<\/command-name>/) : null;
  if (nameM) {
    // Second discriminator (Codex round 3): a paste can START with the tags
    // too. In a GENUINE command turn, what remains after removing the tag
    // blocks is either nothing or the skill body; trailing prose means the
    // user pasted an excerpt, so leave their message alone.
    const remainder = text
      .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, '')
      .trim();
    if (remainder === '' || remainder.startsWith('Base directory for this skill:')) {
      const name = nameM[1].trim();
      const argsM = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
      const args = argsM ? argsM[1].trim() : '';
      const slash = name.startsWith('/') ? name : `/${name}`;
      return args ? `${slash} ${args}` : slash;
    }
    return null;
  }
  if (t0.startsWith('Base directory for this skill:')) {
    const nl = t0.indexOf('\n');
    const firstLine = nl === -1 ? t0 : t0.slice(0, nl);
    const base = firstLine.split('/').filter(Boolean).pop() || 'skill';
    return `/${base.trim()} (skill)`;
  }
  const stdoutM = text.match(/^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/);
  // Strip ANSI: real rows carry bold/reset escapes ("Set model to \x1b[1mFable
  // 5\x1b[22m...") which rendered as garbage glyphs in the chat bubble.
  if (stdoutM) return stripAnsiText(stdoutM[1]).trim();
  // A `!` bash command from the composer. The transcript wraps it as
  // <bash-input>cmd</bash-input>, so the chat both rendered raw XML (Sam:
  // "I still see bash commands... I wouldn't normally see") AND the mobile
  // echo pruner never matched what was typed, leaving "sending…" stuck on a
  // command that already ran. Collapse to the exact composer form `! cmd`.
  const bashIn = text.match(/^\s*<bash-input>([\s\S]*?)<\/bash-input>\s*$/);
  if (bashIn) return `! ${stripAnsiText(bashIn[1]).trim()}`;
  // Its output rows: show the output itself (the user ran the command on
  // purpose), stripped of tags and escapes. stderr appended after stdout.
  if (/^\s*<bash-(stdout|stderr)>/.test(text)) {
    const out = [];
    const so = text.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/);
    const se = text.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/);
    if (so && so[1].trim()) out.push(stripAnsiText(so[1]).trim());
    if (se && se[1].trim()) out.push(stripAnsiText(se[1]).trim());
    return out.join('\n');
  }
  return null;
}

// Minimal ANSI escape strip for chat text (CSI + OSC + single ESC forms).
// The transcript records what the terminal PRINTED, escapes included; a chat
// bubble is not a terminal.
function stripAnsiText(s) {
  return String(s)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b./g, '');
}

export function entryToMessage(entry) {
  // A message sent while Claude is mid-turn is recorded as a queue-operation
  // enqueue, NOT as a user message, until the turn ends and it is actually
  // submitted. Surfacing it (flagged `queued`) is what makes a mid-turn send
  // from the phone show up in the mobile Chat instead of vanishing (Sam's
  // v1.0.53 report). dedupeQueuedMessages drops it once the real user message
  // lands in the transcript.
  if (entry.type === 'queue-operation') {
    let content = typeof entry.content === 'string' ? entry.content : '';
    if (content.length > MAX_MESSAGE_CHARS) content = content.slice(0, MAX_MESSAGE_CHARS) + `\n\n[message truncated at ${MAX_MESSAGE_CHARS} chars]`;
    if (entry.operation === 'enqueue') {
      return content.trim() ? { role: 'user', content, queued: true } : null;
    }
    // remove/dequeue: a marker row (never rendered) that clears a pending
    // enqueue during replay. Without this, a prompt the user deleted from the
    // TUI queue rendered as "queued" forever (Codex P2). REAL transcripts
    // usually emit these WITHOUT content (only type/operation/timestamp), so
    // an empty-content marker is meaningful: the queue is FIFO, it clears the
    // oldest pending row (Codex round 2, real repro in pocket-cologne 530/531).
    if (entry.operation === 'remove' || entry.operation === 'dequeue') {
      return { role: 'user', content, queueRemove: true };
    }
    // popAll (and any future queue op we don't know): the whole queue flushed,
    // clear EVERY pending row. Ignoring popAll left a stale pending row that
    // made a later contentless dequeue clear the WRONG entry (Codex round 3,
    // pocket-cologne 28520/28521 + 31314/31315). Over-clearing merely hides a
    // "queued" chip early; under-clearing is the recurring stale-row bug.
    return { role: 'user', content, queueClearAll: true };
  }
  let role = null;
  if (entry.type === 'human' || entry.role === 'user' || entry.message?.role === 'user') role = 'user';
  else if (entry.type === 'assistant' || entry.role === 'assistant' || entry.message?.role === 'assistant') role = 'assistant';
  if (!role) return null;
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
  if (!content) return null;
  if (role === 'user') {
    // Harness plumbing recorded as user turns (background-task notifications)
    // is not conversation: hide it entirely instead of rendering raw XML.
    const tp = content.trimStart();
    if (tp.startsWith('<task-notification>') || tp.startsWith('[SYSTEM NOTIFICATION')) return null;
    // System-injected reminder blocks (skill listings, hook chatter) are the
    // "breakdowns of things I traditionally wouldn't see" leaking into the
    // phone chat: the human never typed them, the terminal never shows them.
    if (tp.startsWith('<system-reminder>')) return null;
    const collapsed = collapseCommandContent(content);
    if (collapsed !== null) {
      // Empty after collapse (e.g. blank command stdout): nothing to render.
      return collapsed ? { role, content: collapsed, command: true } : null;
    }
  }
  if (content.length > MAX_MESSAGE_CHARS) {
    content = content.slice(0, MAX_MESSAGE_CHARS) + `\n\n[message truncated at ${MAX_MESSAGE_CHARS} chars]`;
  }
  return { role, content };
}

// Queue replay: an enqueue makes a pending `queued` row; a LATER real user
// message with the same text (the queue flushed) or a remove/dequeue marker
// (the user deleted it from the TUI queue) clears the OLDEST matching pending
// row. Marker rows themselves never render. A still-pending enqueue keeps its
// row, which is honest: it is sitting in the TUI's queue right now.
export function dedupeQueuedMessages(messages) {
  const pending = []; // indices of queued rows not yet cleared, in order
  const drop = new Set();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.queued) { pending.push(i); continue; }
    if (m.queueClearAll) {
      drop.add(i);
      for (const p of pending) drop.add(p);
      pending.length = 0;
      continue;
    }
    const isRemove = !!m.queueRemove;
    if (isRemove) drop.add(i); // markers are bookkeeping, never displayed
    if (isRemove || m.role === 'user') {
      const t = m.content.trim();
      // Contentless remove/dequeue (the common real shape) clears the OLDEST
      // pending row (FIFO queue); contentful ones and real user messages clear
      // the oldest row with MATCHING text.
      const idx = (isRemove && !t)
        ? (pending.length ? 0 : -1)
        : pending.findIndex((p) => messages[p].content.trim() === t);
      if (idx !== -1) { drop.add(pending[idx]); pending.splice(idx, 1); }
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (drop.has(i)) messages.splice(i, 1);
  }
  return messages;
}

async function parseTranscriptFile(filePath) {
  const messages = [];
  let payloadBytes = 0;
  let truncated = false;
  await streamJsonl(filePath, (entry) => {
    if (truncated) return;
    const m = entryToMessage(entry);
    if (!m) return;
    payloadBytes += m.content.length + 64; // rough overhead for the wrapper object
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      truncated = true;
      messages.push({ role: 'system', content: `[transcript preview truncated: payload exceeded ${MAX_PAYLOAD_BYTES} bytes]`, timestamp: null });
      return;
    }
    messages.push({ ...m, timestamp: entry.timestamp || null });
  });
  return dedupeQueuedMessages(messages);
}

// Bounded tail read for the mobile Chat poll: reads only the tail of the JSONL
// (parseJsonl uses readTail), so re-polling every few seconds stays cheap even on
// a 100MB transcript. `messageLimit` is the number of VISIBLE user/assistant
// messages to return; we OVERSCAN raw lines because an agentic run's tail can be
// mostly tool/meta records, so limiting raw lines before filtering could return
// few or zero messages (Codex). The same aggregate payload cap as the full path
// is enforced by trimming oldest-first, so a tail of huge pasted turns can't blow
// past MAX_PAYLOAD_BYTES per poll (Codex).
async function parseTranscriptTail(filePath, messageLimit) {
  const want = Math.max(1, Math.min(messageLimit, 500));
  const rawBudget = Math.min(want * 8, 8000); // overscan raw lines to find enough visible turns
  const entries = await parseJsonl(filePath, rawBudget);
  const msgs = [];
  for (const entry of entries) {
    const m = entryToMessage(entry);
    if (m) msgs.push({ ...m, timestamp: entry.timestamp || null });
  }
  dedupeQueuedMessages(msgs);
  let tail = msgs.slice(-want);
  let bytes = tail.reduce((n, m) => n + m.content.length + 64, 0);
  while (tail.length > 1 && bytes > MAX_PAYLOAD_BYTES) {
    bytes -= tail[0].content.length + 64;
    tail = tail.slice(1);
  }
  return tail;
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
  return p.replace(/[^a-zA-Z0-9.-]/g, '-');
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
      let sizeMB;
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
/**
 * Estimate context usage from ONE transcript file.
 *
 * BOUNDED tail read. The status-bar ctx bar fires every 30s (and on every tab
 * switch), and a Claude transcript in this app is commonly 20-30MB, so reading
 * the whole file each time stalls or OOMs main. Token usage lives on assistant
 * messages and only the most-recent run matters for "how full is the window",
 * so the last 200 entries is plenty. Codex PR#3 r7 P2.
 *
 * Returns { tokens, maxTokens, model } or null if the file carries no usage.
 */
// Context-window size by model. The old hardcoded 200000 pinned the meter at
// 100% for every Fable session (real probe: 696k input tokens / 200k = 348%,
// clamped), which read as "the context checker doesn't work at all" (Sam,
// v1.0.55). Per current Anthropic model specs: the whole Claude 5 family
// (fable/mythos/opus-5/sonnet-5) AND opus-4.6+/sonnet-4.6 are 1M-context;
// haiku-4.5, sonnet-4.5, and older are 200k (Codex round 2 vs the docs).
// Self-calibrating: if OBSERVED tokens exceed the assumed window, snap up to
// the next standard size, so an unknown future model can degrade the estimate
// but never pin the meter.
const WIDE_WINDOW_RE = /fable|mythos|opus-(?:5|4-[6-9])|sonnet-(?:5|4-[6-9])/i;
const STANDARD_WINDOWS = [200_000, 500_000, 1_000_000, 2_000_000];
export function windowForModel(model, observedTokens = 0) {
  let win = WIDE_WINDOW_RE.test(String(model || '')) ? 1_000_000 : 200_000;
  if (observedTokens > win) {
    win = STANDARD_WINDOWS.find((w) => w >= observedTokens) || observedTokens;
  }
  return win;
}

async function estimateContextFromFile(filePath) {
  const entries = await parseJsonl(filePath, 200); // chronological (readTail): oldest -> newest
  let lastInputTokens = 0;
  let lastModel = '';
  // A compact that happened AFTER the newest turn. Between /compact and the
  // next reply there is no fresh usage entry, so "latest usage" kept showing
  // the pre-compact figure, for 17 minutes on this session's own 2026-08-10
  // compact (886,585 shown while the real context was ~34k), and forever if
  // you compact and walk away (Sam-reported: "the context tracker doesn't
  // reset upon compact"). The boundary row Claude Code writes carries the
  // answer: compactMetadata.postTokens is the surviving context, measured by
  // the CLI itself (preTokens 887,235 -> postTokens 34,526 on that compact).
  let pendingCompactTokens = 0;
  // Use the MOST RECENT usage-bearing message's total, NOT the max over the tail.
  // The max stuck at a historical peak: after a /compact (or /clear) the live
  // context drops but the earlier peak, often ~100%, remained, so the bar was
  // pinned at 100% for a tab that was no longer full (Sam-reported). The latest
  // assistant turn's input total IS the current window occupancy.
  for (const entry of entries) {
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const post = entry.compactMetadata?.postTokens;
      // Older CLIs wrote boundaries without postTokens (this session's
      // 2026-05-25 boundary has none); those keep the old stale-until-next-
      // turn behavior rather than guessing.
      pendingCompactTokens = Number.isFinite(post) && post > 0 ? post : 0;
      continue;
    }
    const usage = entry.message?.usage;
    if (!usage) continue;
    const total =
      (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0);
    if (total > 0) {
      lastInputTokens = total; // last assignment wins = newest turn
      pendingCompactTokens = 0; // a real turn after the boundary supersedes it
      // Only a REAL model id updates the badge. Claude Code stamps some turns
      // `<synthetic>` (its own internal messages, e.g. an interrupt notice),
      // and those carry usage like any other, so taking the last model
      // verbatim rendered the status bar as the literal string "<synthetic>".
      // Measured on this Mac: 8 of 112 recent sessions ended that way, so it
      // is roughly a 1-in-14 chance of the badge reading as broken. A
      // synthetic turn is not a model change; keep the last real one, which
      // also gives windowForModel the right context window to size against.
      const m = entry.message?.model;
      if (typeof m === 'string' && m.startsWith('claude-')) lastModel = m;
    }
  }
  // The boundary is newer than every turn: the CLI's own post-compact count
  // is the truth right now. Slightly under the next turn's reading (the next
  // prompt re-adds CLAUDE.md, reminders, skills), but 3% honest beats 89%
  // stale, and the first real turn corrects it.
  if (pendingCompactTokens > 0) lastInputTokens = pendingCompactTokens;
  if (!lastInputTokens) return null;
  return { tokens: lastInputTokens, maxTokens: windowForModel(lastModel, lastInputTokens), model: lastModel };
}

/**
 * Estimate context usage for ONE SPECIFIC session, by id, in a project.
 *
 * This is the per-TAB context bar (v1.0.40). It replaced a project-level
 * estimator that picked the project's newest-mtime transcript, so with several
 * tabs open in one project the bar showed whichever session was written last,
 * not the tab you were looking at. The status bar now resolves the active tab's
 * own session (via argv or the tab-session map) and calls this. Probes both
 * encoder forms, same as getSessionSize. Returns null when the transcript is
 * missing or carries no usage yet (a brand-new session), rendered as "--".
 */
export async function estimateContextForSession(sessionId, projectPath) {
  try {
    if (!sessionId || typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return null;
    if (!projectPath || typeof projectPath !== 'string') return null;
    const seen = new Set();
    for (const enc of [encodePathLikeClaude(projectPath), encodePathLikeClaudeLegacy(projectPath)]) {
      if (seen.has(enc)) continue;
      seen.add(enc);
      const filePath = path.join(PROJECTS_DIR, enc, `${sessionId}.jsonl`);
      if (!(await pathExists(filePath))) continue;
      return await estimateContextFromFile(filePath);
    }
    return null;
  } catch (err) {
    console.warn('[data-service] Failed to estimate context for session:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Loose ends (v1.0.61): work you started and never came back to.
//
// Grounded in a read-only analysis of this Mac's own ~/.claude history rather
// than intuition. Two things that analysis established:
//   - ZERO of 102 substantive sessions in 21 days ended with Claude asking an
//     unanswered question, so "which tab is waiting on an answer" is NOT the
//     real attention problem, despite being the obvious guess.
//   - 15 of those sessions died mid-flight instead: either an explicit
//     "[Request interrupted by user]" or a turn cut off during tool use. Some
//     were 12 to 20 days stale, and nothing in the app ever surfaced them.
// That is the gap this fills: the app should remember what you abandoned.
// ---------------------------------------------------------------------------

const LOOSE_END_TAIL_BYTES = 64 * 1024; // enough for the closing turns
const INTERRUPT_RE = /\[Request interrupted by user/i;

/**
 * The last entry that is a real conversational turn, ignoring meta rows AND
 * system-injected user text (task notifications, system reminders, command
 * echoes, skill bodies). Those arrive AFTER the real ending and were masking
 * it: an interrupted session with a trailing <task-notification> read as
 * 'unknown' and was silently dropped from loose ends. Tool results are NOT
 * synthetic here; a trailing tool_result is the mid-tool signal itself.
 */
function lastConversationalEntry(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    const role = e?.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (role === 'user' && !contentTypes(e).has('tool_result') && isSyntheticUserText(entryText(e))) continue;
    return e;
  }
  return null;
}

/** Plain text of a message, ignoring tool blocks. */
function entryText(entry) {
  const c = entry?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  return '';
}

function contentTypes(entry) {
  const c = entry?.message?.content;
  if (!Array.isArray(c)) return new Set(typeof c === 'string' ? ['text'] : []);
  return new Set(c.map((b) => b && b.type).filter(Boolean));
}

/**
 * Classify how a session ENDED. Exported for tests.
 *   'interrupted'  you stopped it (Esc / interrupt marker)
 *   'mid-tool'     cut off while a tool call was in flight
 *   'unanswered'   the last thing in the file is something YOU typed, and no
 *                  reply ever followed
 *   'delivered'    Claude finished its turn normally
 *   'unknown'      nothing conversational to judge
 * The first three are loose ends; 'delivered' is a finished thought and must
 * never be nagged about, or the feature becomes noise.
 *
 * 'unanswered' comes from auditing the real history for what the first
 * version silently skipped: 5 idle sessions in the 30-day window ended on a
 * bare user message and were classified 'unknown'. One was plainly lost work
 * ("wait ask that again i didnt get to read it", 12 days old, never seen
 * again). Synthetic user text does not count: lastConversationalEntry already
 * skips notifications/skill bodies, so only a prompt the human typed lands
 * here.
 */
export function classifySessionEnding(entries) {
  const last = lastConversationalEntry(entries);
  if (!last) return 'unknown';
  const role = last.message.role;
  const types = contentTypes(last);
  const text = entryText(last);
  if (INTERRUPT_RE.test(text)) return 'interrupted';
  if (role === 'assistant' && types.has('tool_use')) return 'mid-tool';
  // A trailing tool_result means the tool answered but Claude never spoke
  // again: the turn was killed between the result and the reply.
  if (role === 'user' && types.has('tool_result') && !types.has('text')) return 'mid-tool';
  if (role === 'assistant') return 'delivered';
  if (role === 'user' && text.trim()) return 'unanswered';
  return 'unknown';
}

/** The last thing Claude actually SAID, so the user recognises the thread. */
function lastAssistantSnippet(entries, max = 220) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e?.message?.role !== 'assistant') continue;
    const t = entryText(e).trim();
    if (!t || INTERRUPT_RE.test(t)) continue;
    const oneLine = t.replace(/\s+/g, ' ');
    return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
  }
  return '';
}

/**
 * Sessions you walked away from, newest first.
 * Read-only, tail-reads only, and skips hidden sources (the Sessions "Hide"
 * list) because 84% of the transcript store on this Mac is headless
 * `claude -p` noise from another app; without that filter every derived
 * feature learns from garbage.
 */
export async function findLooseEnds({
  maxAgeDays = 30, limit = 20, minBytes = 20_000,
  // A session touched moments ago is not abandoned, it is IN PLAY. Scanning
  // live work found this session itself mid-tool-call and called it a loose
  // end. Nothing counts until it has gone quiet.
  minIdleMinutes = 45,
  // Sessions the caller knows are attached to a live Claude right now. main.js
  // passes these from the terminal manager, which data-service cannot see.
  excludeSessionIds = [],
} = {}) {
  const now = Date.now();
  const cutoff = now - maxAgeDays * 86400_000;
  const idleBefore = now - minIdleMinutes * 60_000;
  const excluded = new Set(excludeSessionIds);
  let hidden = new Set();
  try {
    const hp = getSettings().hiddenSessionPaths;
    if (Array.isArray(hp)) hidden = new Set(hp.filter((p) => typeof p === 'string'));
  } catch { void 0; }

  let dirs;
  try { dirs = await fs.readdir(PROJECTS_DIR); } catch { return []; }

  const candidates = [];
  for (const dir of dirs) {
    const projectPath = tryReconstructPath(dir) || dir;
    if (hidden.has(projectPath)) continue;
    let names;
    try { names = await fs.readdir(path.join(PROJECTS_DIR, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(PROJECTS_DIR, dir, name);
      try {
        const st = await fs.stat(full);
        if (st.mtimeMs < cutoff || st.mtimeMs > idleBefore || st.size < minBytes) continue;
        const sessionId = name.replace(/\.jsonl$/, '');
        if (excluded.has(sessionId)) continue;
        candidates.push({ full, projectPath, sessionId, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* vanished mid-scan */ }
    }
  }
  // Newest first, and cap the work: this runs on a dashboard refresh.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const scanned = candidates.slice(0, 200);

  const out = [];
  for (const c of scanned) {
    let entries = [];
    try {
      const handle = await fs.open(c.full, 'r');
      try {
        const st = await handle.stat();
        const start = Math.max(0, st.size - LOOSE_END_TAIL_BYTES);
        const buf = Buffer.alloc(Math.min(st.size, LOOSE_END_TAIL_BYTES));
        await handle.read(buf, 0, buf.length, start);
        const text = buf.toString('utf8');
        // Drop the first fragment: a mid-line seek almost always splits one.
        const lines = text.split('\n').slice(start > 0 ? 1 : 0);
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try { entries.push(JSON.parse(t)); } catch { /* partial line */ }
        }
      } finally { await handle.close(); }
    } catch { continue; }

    const ending = classifySessionEnding(entries);
    if (ending !== 'interrupted' && ending !== 'mid-tool' && ending !== 'unanswered') continue;
    // An unanswered prompt only matters when a conversation was actually
    // underway: ".login" typed into a fresh session and abandoned is not work
    // worth resurfacing, a question hanging at the end of a long thread is.
    if (ending === 'unanswered' && !entries.some((e) => e?.message?.role === 'assistant')) continue;

    // A session whose conversation CONTINUED in another file is not abandoned,
    // whatever its own tail says. When Claude Code forks a continuation (the
    // "This session is being continued from a previous conversation" flow),
    // the new file's first user entry carries a parentUuid naming the leaf
    // message of the old one; verified against the real store, that uuid
    // resolves to exactly one parent file. The leaf is by definition in the
    // tail we already parsed, so the check is a set lookup.
    const contUuids = await continuationParentUuids(path.dirname(c.full));
    if (contUuids.size > 0 && entries.some((e) => e?.uuid && contUuids.has(e.uuid))) continue;

    out.push({
      sessionId: c.sessionId,
      projectPath: c.projectPath,
      projectName: c.projectPath.split('/').filter(Boolean).pop() || c.projectPath,
      ending,
      lastActivityAt: c.mtimeMs,
      ageHours: Math.round((now - c.mtimeMs) / 3600_000),
      // For an unanswered ending the recognisable thing is what YOU typed,
      // not whatever Claude last said before it.
      snippet: ending === 'unanswered' ? lastUserSnippet(entries) : lastAssistantSnippet(entries),
      sizeMB: +(c.size / 1e6).toFixed(1),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** The unanswered prompt itself, one line, so the user recognises it. */
function lastUserSnippet(entries, max = 220) {
  const last = lastConversationalEntry(entries);
  if (!last || last.message.role !== 'user') return '';
  const oneLine = entryText(last).trim().replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

// Continuation parent uuids for a project dir, only computed for dirs that
// actually have loose-end candidates. Cached PER FILE keyed on size+mtime:
// keying the whole dir on its filename list went stale the moment an existing
// file gained its preamble (a fork's snapshot rows land before the first user
// message, and no filename changes), which left the parent nagged about until
// restart. Both Codex lenses found that one independently. A file whose stat
// is unchanged is never re-read; a fork verdict follows the file's content.
const forkScanCache = new Map(); // filePath -> { size, mtimeMs, uuid }
// One entry per transcript ever scanned; this store holds thousands, so the
// cache is bounded. Eviction drops the OLDEST HALF (Map iteration = insertion
// order), never everything: a wholesale clear() thrashed when a single
// monster dir alone exceeded the cap, rescanning every unchanged file on
// every refresh (Codex release gate, Medium). Half-eviction keeps the newest
// half warm, so even the pathological dir rescans at most half per call.
const FORK_SCAN_CACHE_MAX = 20_000;
function evictForkScanCache() {
  if (forkScanCache.size <= FORK_SCAN_CACHE_MAX) return;
  let toDrop = Math.floor(forkScanCache.size / 2);
  for (const key of forkScanCache.keys()) {
    if (toDrop <= 0) break;
    forkScanCache.delete(key);
    toDrop -= 1;
  }
}
async function continuationParentUuids(dir) {
  evictForkScanCache();
  let names;
  try { names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl')); } catch { return new Set(); }
  const uuids = new Set();
  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try { st = await fs.stat(full); } catch { continue; }
    const hit = forkScanCache.get(full);
    let uuid;
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      uuid = hit.uuid;
    } else {
      uuid = await forkParentUuid(full);
      forkScanCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, uuid });
    }
    if (uuid) uuids.add(uuid);
  }
  return uuids;
}

/**
 * If this transcript is a continuation FORK (its first real user message is
 * the "This session is being continued..." preamble), return the parentUuid
 * that names the parent's leaf message; else null.
 *
 * Streams from the start rather than reading a fixed head: in the real store
 * the preamble sits 227KB and 513KB deep (file-history-snapshot entries come
 * first and they embed file contents), so any byte-window approach misses
 * every real fork; the test caught a 16KB window doing exactly that. For
 * ordinary sessions the original prompt arrives within a few KB and the
 * stream stops there, so the deep read only happens for actual forks. Capped
 * so one corrupt file cannot stall the dashboard.
 *
 * Only the FIRST real user message decides: in-place compaction writes the
 * same preamble mid-file (30 of 32 marker hits in the real store) and its
 * parentUuid points inside the SAME file, so reading any later occurrence
 * would make sessions exclude themselves.
 */
// 32MB: the cap only exists so one corrupt file cannot stall the dashboard.
// The real forks' preambles sit 227KB-513KB deep, but a single
// file-history-snapshot line embeds file contents and can run to several MB,
// so a tight cap risks never reaching a real preamble (Codex, Medium).
const FORK_SCAN_MAX_BYTES = 32 * 1024 * 1024;
async function forkParentUuid(filePath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { stream.destroy(); } catch { /* closed */ } resolve(v); } };
    let stream;
    try {
      stream = fsSync.createReadStream(filePath, { encoding: 'utf8', end: FORK_SCAN_MAX_BYTES });
    } catch { resolve(null); return; }
    let carry = '';
    stream.on('data', (chunk) => {
      carry += chunk;
      const lines = carry.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        // Cheap prefilter: snapshot/meta lines vastly outnumber user entries
        // and can be hundreds of KB each; skip the JSON.parse for anything
        // that cannot be a user turn.
        if (!line.includes('"role":"user"') && !line.includes('"role": "user"')) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e?.message?.role !== 'user') continue;
        // ACCEPTED (Codex, Medium): a first user row carrying BOTH a
        // tool_result and preamble text would be read as "conversation
        // underway". That row cannot exist in a real fork (a tool_result
        // answers a tool_use earlier in the SAME file, and the preamble is
        // the file's first message); checking preamble first instead would
        // let a tool output QUOTING a continuation summary forge parent
        // linkage, which is the worse failure.
        if (contentTypes(e).has('tool_result')) { done(null); return; } // conversation underway
        const text = entryText(e);
        if (!text.trim()) continue;
        if (text.trimStart().startsWith('This session is being continued from a previous conversation')
          && typeof e.parentUuid === 'string') { done(e.parentUuid); return; }
        // Injected user rows (system reminders, hook output, command echoes)
        // can precede the preamble in a fork; they are not the human speaking,
        // so keep looking rather than deciding on them (Codex, High). Note the
        // order: the preamble check above runs FIRST, because the preamble
        // itself is on the synthetic-prefix list.
        if (isSyntheticUserText(text)) continue;
        done(null); return; // first HUMAN user message decides either way
      }
      // A single line larger than the cap: give up rather than buffer forever.
      if (carry.length > FORK_SCAN_MAX_BYTES) done(null);
    });
    stream.on('end', () => done(null));
    stream.on('error', () => done(null));
  });
}
