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
import { loadConfig, saveConfig, getAsanaQueue } from './config-manager.js';

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

// Prefer the env var (Sam's global env per CLAUDE.md); fall back to the Settings
// PAT so a GUI-launched app works even when shell exports don't reach it.
function asanaToken() {
  return process.env.ASANA_PAT || getAsanaQueue().pat || null;
}

function asanaGet(path) {
  return asanaRequest('GET', path);
}

// Single request helper. `body` (object) is sent as JSON for write methods.
function asanaRequest(method, path, body) {
  const token = asanaToken();
  if (!token) return Promise.reject(new Error('ASANA_PAT not set (env or Settings)'));
  const payload = body ? JSON.stringify({ data: body }) : null;
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = https.request({ hostname: ASANA_BASE, path, method, headers, timeout: ASANA_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const respBody = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(respBody ? JSON.parse(respBody) : {}); }
          catch (err) { reject(new Error(`bad JSON from Asana: ${err.message}`)); }
        } else {
          reject(new Error(`Asana HTTP ${res.statusCode}: ${respBody.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Asana timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Mark an Asana task complete. This is the ONLY Asana WRITE in the app and it
 * must only ever be called after explicit human approval (see the Conductor
 * review-lane prompt + dobius-asana-complete CLI). Never call autonomously.
 */
export async function markTaskComplete(taskGid) {
  if (!/^\d{6,30}$/.test(String(taskGid))) return { ok: false, error: 'task gid malformed' };
  try {
    await asanaRequest('PUT', `/api/1.0/tasks/${taskGid}`, { completed: true });
    return { ok: true, gid: taskGid };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

const FIELDS = ['gid', 'name', 'permalink_url', 'modified_at', 'due_on', 'notes', 'assignee', 'completed', 'completed_at'].join(',');

// Review lane surfaces Sam's tasks COMPLETED within this window — we review what
// he actually did, not work in progress.
const REVIEW_COMPLETED_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_COMMENTS_PER_TASK = 8;
const MAX_ATTACHMENTS_PER_TASK = 8;

// Sam's comment stories (what he wrote about what he did). Best-effort: returns
// [] on any error so a comment fetch can't break the whole poll.
async function fetchTaskComments(gid) {
  try {
    const data = await asanaGet(`/api/1.0/tasks/${gid}/stories?opt_fields=text,created_at,created_by.name,resource_subtype`);
    return (data?.data || [])
      .filter((s) => s.resource_subtype === 'comment_added' && s.text)
      .slice(-MAX_COMMENTS_PER_TASK)
      .map((s) => ({ at: s.created_at, by: s.created_by?.name || 'unknown', text: String(s.text).slice(0, 500) }));
  } catch { return []; }
}

// Sam's attachments (screenshots etc.) with view URLs the reviewer can open.
async function fetchTaskAttachments(gid) {
  try {
    const data = await asanaGet(`/api/1.0/attachments?parent=${gid}&opt_fields=name,download_url,view_url,resource_subtype`);
    return (data?.data || [])
      .slice(0, MAX_ATTACHMENTS_PER_TASK)
      .map((a) => ({ name: a.name || 'attachment', url: a.view_url || a.download_url || null }))
      .filter((a) => a.url);
  } catch { return []; }
}

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
      // build lane = Carson's INCOMPLETE tasks (to build). review lane = Sam's
      // tasks COMPLETED in the recent window (to review what he actually did).
      const completedSince = lane === 'review'
        ? new Date(Date.now() - REVIEW_COMPLETED_WINDOW_MS).toISOString()
        : 'now';
      // Asana rejects project + assignee in the same query ("Must specify
      // exactly one of project, tag, section, user task list, or assignee +
      // workspace"). Query by project, then filter to the lane assignee
      // client-side (FIELDS includes the compact assignee record).
      // PAGINATION (Codex PR#3 r11 P2): Asana applies the per-page limit
      // BEFORE we can filter by assignee, so a busy project's later pages
      // hid eligible tasks. Loop through next_page until either exhausted or
      // a hard ceiling is hit (200 tasks per project per lane = 2 round-trips
      // at limit=100, well above the typical case). limit=100 is Asana's max.
      const PAGE_LIMIT = 100;
      const HARD_CEILING = 200;
      let collected = [];
      let cursor = `/api/1.0/tasks?project=${project.gid}&completed_since=${encodeURIComponent(completedSince)}&limit=${PAGE_LIMIT}&opt_fields=${FIELDS}`;
      while (cursor && collected.length < HARD_CEILING) {
        const page = await asanaGet(cursor);
        collected = collected.concat(page?.data || []);
        // Asana returns next_page.path when there are more results.
        cursor = page?.next_page?.path || null;
      }
      const data = { data: collected };
      for (const t of (data?.data || [])) {
        if (t.assignee?.gid !== gid) continue;   // only this lane's assignee
        if (seen.has(t.gid)) continue;     // a task can't be in both lanes, but guard anyway
        // Review only finished work: `completed_since=<ts>` also returns
        // incomplete tasks, so drop those.
        if (lane === 'review' && !t.completed) continue;
        seen.add(t.gid);
        // For review, pull what Sam wrote + the screenshots he attached.
        const [comments, attachments] = lane === 'review'
          ? await Promise.all([fetchTaskComments(t.gid), fetchTaskAttachments(t.gid)])
          : [[], []];
        tasks.push({
          gid: t.gid,
          name: t.name || '(untitled)',
          url: t.permalink_url || `https://app.asana.com/0/${project.gid}/${t.gid}`,
          modifiedAt: t.modified_at,
          completedAt: t.completed_at || null,
          dueOn: t.due_on,
          notesPreview: (t.notes || '').slice(0, 200),
          comments,
          attachments,
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
