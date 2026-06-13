/**
 * asana-queue.js — Phase 4.
 *
 * Fetches Asana tasks assigned to Sam from allowlisted projects so the
 * Voice Conductor can batch-process them via iMessage. Three pieces:
 *
 *   - Project allowlist (config.asanaQueue.allowedProjects) — only projects
 *     in this list can be auto-processed. Default empty. Sam adds via the
 *     iMessage command "d: allow autoprocess for slimject" which the
 *     Conductor turns into dobius-asana-allow.
 *
 *   - Asana REST fetch using ASANA_PAT (already in Sam's global env per
 *     CLAUDE.md). No MCP dependency here — main process can't easily
 *     reach the Claude session's MCP layer.
 *
 *   - Returns the list of incomplete tasks for the Conductor to:
 *     1. Format into an iMessage summary
 *     2. Ask Sam to approve via dobius-ask
 *     3. Dispatch each approved task into a tracked work item
 *
 * The dispatch loop itself stays in the Conductor's prompt — it's the
 * thing that knows how to map "fix the lifestyle 03 typo" to a sensible
 * dispatch target tab.
 */
import https from 'https';
import { loadConfig, saveConfig } from './config-manager.js';

const ASANA_BASE = 'app.asana.com';
const ASANA_TIMEOUT_MS = 10_000;
const MAX_TASKS_PER_FETCH = 25;

// --- Allowlist -----------------------------------------------------------

export function listAllowedProjects() {
  const cfg = loadConfig();
  return cfg.asanaQueue?.allowedProjects || [];
}

export function addAllowedProject({ name, gid }) {
  if (!name || !gid) return { ok: false, error: 'name + gid required' };
  if (!/^[\d]{6,30}$/.test(String(gid))) return { ok: false, error: 'gid malformed' };
  const cfg = loadConfig();
  if (!cfg.asanaQueue || typeof cfg.asanaQueue !== 'object') cfg.asanaQueue = {};
  if (!Array.isArray(cfg.asanaQueue.allowedProjects)) cfg.asanaQueue.allowedProjects = [];
  const safeName = String(name).slice(0, 100);
  const existing = cfg.asanaQueue.allowedProjects.findIndex((p) => p.gid === gid);
  if (existing >= 0) cfg.asanaQueue.allowedProjects[existing] = { name: safeName, gid };
  else cfg.asanaQueue.allowedProjects.push({ name: safeName, gid });
  saveConfig(cfg);
  return { ok: true, count: cfg.asanaQueue.allowedProjects.length };
}

export function removeAllowedProject(gid) {
  const cfg = loadConfig();
  const list = cfg.asanaQueue?.allowedProjects || [];
  const next = list.filter((p) => p.gid !== gid);
  if (!cfg.asanaQueue) cfg.asanaQueue = {};
  cfg.asanaQueue.allowedProjects = next;
  saveConfig(cfg);
  return { ok: true, count: next.length };
}

// --- Asana REST ---------------------------------------------------------

function asanaGet(path) {
  const token = process.env.ASANA_PAT;
  if (!token) return Promise.reject(new Error('ASANA_PAT not set in env'));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ASANA_BASE,
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeout: ASANA_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (err) { reject(new Error(`bad JSON from Asana: ${err.message}`)); }
        } else {
          reject(new Error(`Asana HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Asana timeout')); });
    req.end();
  });
}

/**
 * Find an allowlisted project by fuzzy name (case-insensitive substring).
 * Returns { name, gid } or null.
 */
export function resolveProjectByName(query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  const list = listAllowedProjects();
  return list.find((p) => p.name.toLowerCase() === q)
      || list.find((p) => p.name.toLowerCase().includes(q))
      || null;
}

/**
 * Two assignee lanes (configurable; defaults in config-manager DEFAULT_CONFIG):
 *   - build  → tasks assigned to me (Carson). Get the FULL pipeline:
 *              build via the routed skill, then review + audit + ship-test.
 *   - review → tasks assigned to Sam. We only double-check his work
 *              (review + audit + ship-test); we never build these.
 * Returns [{ gid, lane }].
 */
function getLaneAssignees() {
  const q = getAsanaQueue();
  return [
    { gid: q.myGid || '1215600517617968', lane: 'build' },
    { gid: q.reviewGid || '1213473231797717', lane: 'review' },
  ];
}

const FIELDS = ['gid', 'name', 'permalink_url', 'modified_at', 'due_on', 'notes', 'assignee'].join(',');

/**
 * Fetch incomplete tasks for an allowlisted project across both lanes.
 * Each task is tagged with its `lane` ('build' | 'review') and `assigneeGid`
 * so the Conductor knows whether to build-then-verify or only verify.
 *
 * `lanes` lets a caller restrict to one lane (e.g. ['build']); defaults to both.
 */
export async function fetchNewTasks({ projectName, lanes }) {
  const project = resolveProjectByName(projectName);
  if (!project) {
    return { ok: false, error: `project not allowlisted: "${projectName}"` };
  }
  const wanted = getLaneAssignees().filter((a) => !lanes || lanes.includes(a.lane));
  const seen = new Set();
  const tasks = [];
  try {
    for (const { gid, lane } of wanted) {
      const path = `/api/1.0/tasks?project=${project.gid}&assignee=${gid}&completed_since=now&limit=${MAX_TASKS_PER_FETCH}&opt_fields=${FIELDS}`;
      const data = await asanaGet(path);
      for (const t of (data?.data || [])) {
        if (seen.has(t.gid)) continue;     // a task can't be in both lanes, but guard anyway
        seen.add(t.gid);
        tasks.push({
          gid: t.gid,
          name: t.name || '(untitled)',
          url: t.permalink_url || `https://app.asana.com/0/${project.gid}/${t.gid}`,
          modifiedAt: t.modified_at,
          dueOn: t.due_on,
          notesPreview: (t.notes || '').slice(0, 200),
          lane,
          assigneeGid: gid,
        });
      }
    }
    return { ok: true, project, tasks };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Format a task list as a short iMessage-friendly summary (<800 chars).
 * Each line is prefixed with its lane so Sam-review vs build-mine is obvious.
 */
export function formatTaskList(tasks) {
  if (!tasks || tasks.length === 0) return 'no new tasks';
  const icon = (lane) => (lane === 'review' ? '🔍' : '🔨');
  const lines = tasks.slice(0, 5).map((t, i) =>
    `${i + 1}. ${icon(t.lane)} ${t.name.slice(0, 78)}${t.dueOn ? ` (due ${t.dueOn})` : ''}`);
  if (tasks.length > 5) lines.push(`...and ${tasks.length - 5} more`);
  return `🔨 build (mine)  •  🔍 review (Sam's)\n${lines.join('\n')}`;
}
