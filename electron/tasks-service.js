/**
 * tasks-service.js — per-project to-do list.
 *
 * Tasks are stored as JSON files at:
 *   ~/.claude/project-tasks/<encoded-project-name>.json
 *
 * Each task: { id, title, done, source ('manual'|'asana'|'bot'), dueOn, asanaGid, createdAt }
 *
 * Asana sync uses the existing ASANA_PAT env var + asana-queue REST helper.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { getAsanaQueue } from './config-manager.js';
import * as pipeline from './task-pipeline.js';

const TASKS_DIR = path.join(os.homedir(), '.claude', 'project-tasks');
const ASANA_BASE = 'app.asana.com';
const ASANA_TIMEOUT_MS = 15_000;
const MAX_TITLE = 500;

function tasksPath(projectPath) {
  // Normalize so the renderer (store currentProjectPath) and the CLI (which may
  // pass ~, a trailing slash, or a relative cwd) encode to the SAME filename.
  // path.resolve on an already-clean absolute path is a no-op, so existing task
  // files keyed on the renderer's path are unaffected.
  const expanded = String(projectPath).replace(/^~(?=$|\/)/, os.homedir());
  const norm = path.resolve(expanded);
  const safe = norm.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
  return path.join(TASKS_DIR, `${safe}.json`);
}

function readTasks(projectPath) {
  const p = tasksPath(projectPath);
  try {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      // Corrupt/truncated JSON (e.g. a crash mid-write before this file was made
      // atomic). Do NOT silently return [] — the next writeTasks would then
      // overwrite the file and the data would be lost for good. Move the bad
      // file aside so it's recoverable, and surface the problem.
      const backup = `${p}.corrupt-${Date.now()}`;
      try { fs.renameSync(p, backup); } catch { /* leave the file in place if the move fails */ }
      console.error(`[tasks-service] Corrupt task file for ${projectPath}; backed up to ${backup}: ${parseErr.message}`);
      return [];
    }
    // Normalize legacy (done-only) tasks to the current stage shape on read.
    // The upgraded shape is persisted on the next write.
    return Array.isArray(parsed) ? parsed.map((t) => pipeline.migrate(t)) : [];
  } catch (err) {
    console.error(`[tasks-service] Failed to read tasks for ${projectPath}: ${err.message}`);
    return [];
  }
}

// Atomic write: write to a unique temp file then rename over the target, so a
// crash mid-write leaves the previous file intact instead of a truncated/corrupt
// one. Mirrors config-manager's atomicWriteSync. Throws on failure (callers
// translate the throw into { ok:false } so the IPC contract never rejects).
function writeTasks(projectPath, tasks) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const filePath = tasksPath(projectPath);
  const tmp = `${filePath}.${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

export function listTasks(projectPath) {
  if (!projectPath) return [];
  return readTasks(projectPath);
}

export function addTask(projectPath, { title, source = 'manual', dueOn = null, asanaGid = null, lane = null, assignee = null } = {}) {
  if (!projectPath || !title) return { ok: false, error: 'projectPath and title required' };
  const clean = String(title).slice(0, MAX_TITLE).trim();
  if (!clean) return { ok: false, error: 'title empty' };
  const tasks = readTasks(projectPath);
  // Dedupe by asanaGid
  if (asanaGid && tasks.some((t) => t.asanaGid === asanaGid)) {
    return { ok: false, error: 'duplicate asanaGid' };
  }
  const task = {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: clean,
    done: false,
    source,
    dueOn: dueOn || null,
    asanaGid: asanaGid || null,
    lane: lane || null,          // 'build' (mine) | 'review' (Sam's)
    assignee: assignee || null,  // display name
    createdAt: Date.now(),
    ...pipeline.pipelineFields(), // stage, events, runs, stagedAt, sessionId, tabId
  };
  tasks.push(task);
  try {
    writeTasks(projectPath, tasks);
  } catch (err) {
    return { ok: false, error: `failed to save task: ${err.message}` };
  }
  return { ok: true, task };
}

export function updateTask(projectPath, taskId, patch) {
  if (!projectPath || !taskId) return { ok: false, error: 'projectPath and taskId required' };
  const tasks = readTasks(projectPath);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return { ok: false, error: 'task not found' };
  // Benign metadata only. `stage`/`events`/`runs`/`stagedAt` are intentionally
  // NOT patchable here — stage changes must go through advanceTask/blockTask so
  // the transition rules are enforced. (Without this allow-list, any new field
  // a caller passes would be silently dropped — see the architect review.)
  const allowed = ['done', 'title', 'dueOn', 'sessionId', 'tabId'];
  const safe = Object.fromEntries(
    Object.entries(patch || {})
      .filter(([k]) => allowed.includes(k))
      .map(([k, v]) => [k, k === 'title' ? String(v).slice(0, MAX_TITLE) : v])
  );
  tasks[idx] = { ...tasks[idx], ...safe };
  try {
    writeTasks(projectPath, tasks);
  } catch (err) {
    return { ok: false, error: `failed to save task: ${err.message}` };
  }
  return { ok: true, task: tasks[idx] };
}

/**
 * Reopen a completed pipeline task. The pipeline makes `done` a terminal
 * stage, so advanceTask from 'done' is rejected. The Tasks dropdown lets a
 * user uncheck a completed task, so we need an explicit reverse path that
 * writes both `done: false` AND moves stage back to 'approval' atomically,
 * with an event log entry recording the reopen. Codex PR#3 r3 P2.
 */
export function reopenTask(projectPath, taskId, { actor = 'human', note = null } = {}) {
  if (!projectPath || !taskId) return { ok: false, error: 'projectPath and taskId required' };
  const tasks = readTasks(projectPath);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return { ok: false, error: 'task not found' };
  const t = tasks[idx];
  if (!t.done && t.stage !== 'done') {
    return { ok: false, error: 'task is not completed' };
  }
  const events = Array.isArray(t.events) ? t.events.slice() : [];
  events.push({
    at: Date.now(),
    actor,
    kind: 'reopened',
    fromStage: 'done',
    toStage: 'approval',
    note: note || null,
  });
  tasks[idx] = { ...t, done: false, stage: 'approval', stagedAt: Date.now(), events };
  try {
    writeTasks(projectPath, tasks);
  } catch (err) {
    return { ok: false, error: `failed to save task: ${err.message}` };
  }
  return { ok: true, task: tasks[idx] };
}

// --- Validated stage transitions (delegate to the pure pipeline module) -----

function mutateTask(projectPath, taskId, fn) {
  if (!projectPath || !taskId) return { ok: false, error: 'projectPath and taskId required' };
  const tasks = readTasks(projectPath);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return { ok: false, error: 'task not found' };
  try {
    tasks[idx] = fn(tasks[idx]);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    writeTasks(projectPath, tasks);
  } catch (err) {
    return { ok: false, error: `failed to save task: ${err.message}` };
  }
  return { ok: true, task: tasks[idx] };
}

/** Advance a task to a stage, enforcing the transition table. actor: 'system'|'human'. */
export function advanceTask(projectPath, taskId, toStage, { note = null, actor = 'system' } = {}) {
  return mutateTask(projectPath, taskId, (t) => pipeline.advance(t, toStage, { note, actor }));
}

/** Move a task to blocked with a reason. */
export function blockTask(projectPath, taskId, reason, { actor = 'system' } = {}) {
  return mutateTask(projectPath, taskId, (t) => pipeline.block(t, reason, { actor }));
}

/** Leave blocked, returning to the origin stage (or an explicit target). */
export function unblockTask(projectPath, taskId, { toStage = null, note = null, actor = 'system' } = {}) {
  return mutateTask(projectPath, taskId, (t) => pipeline.unblock(t, { toStage, note, actor }));
}

export function deleteTask(projectPath, taskId) {
  if (!projectPath || !taskId) return { ok: false, error: 'projectPath and taskId required' };
  const tasks = readTasks(projectPath);
  const next = tasks.filter((t) => t.id !== taskId);
  try {
    writeTasks(projectPath, next);
  } catch (err) {
    return { ok: false, error: `failed to delete task: ${err.message}` };
  }
  return { ok: true };
}

/**
 * Resolve a single pending task by reference and mark it done. The reference
 * is whatever Claude knows about the task it just finished: its internal id,
 * its Asana gid, or a substring of its title (case-insensitive).
 *
 * Resolution is deliberately conservative — it only ever flips a task that is
 * still pending, and a title match must resolve to exactly ONE pending task.
 * On ambiguity it returns the candidates instead of guessing, so we never
 * check off the wrong thing.
 *
 * This is LOCAL ONLY. It never calls the Asana API — completing an Asana task
 * is a human decision (house rule: never auto-close Asana tasks).
 *
 * Returns { ok:true, task } | { ok:false, error, candidates? }.
 */
/**
 * Resolve a task reference (id / asanaGid / conservative fuzzy title) to a
 * single task, WITHOUT mutating anything. Shared by completeTaskByRef
 * (dobius-task-done) and the /stage bridge route (dobius-stage) so both resolve
 * references identically.
 *
 * - Exact id or asanaGid match wins (returns the task even if already done).
 * - Otherwise a case-insensitive title match restricted to PENDING tasks, with
 *   the reverse direction (ref contains a >=6-char title) as a fallback. An
 *   ambiguous title returns { candidates } instead of guessing.
 *
 * Returns { ok:true, task } | { ok:false, error, candidates? }.
 */
export function resolveTaskRef(projectPath, ref) {
  if (!projectPath) return { ok: false, error: 'projectPath required' };
  const needle = String(ref || '').trim();
  if (!needle) return { ok: false, error: 'task reference required' };

  const tasks = readTasks(projectPath);
  if (!tasks.length) return { ok: false, error: 'no tasks for this project' };

  // 1. Exact id or asanaGid match (may be already done — that's fine, idempotent).
  const exact = tasks.find((t) => t.id === needle || t.asanaGid === needle);
  if (exact) return { ok: true, task: exact };

  // 2. Fuzzy title match, restricted to PENDING tasks only.
  const pending = tasks.filter((t) => !t.done);
  const low = needle.toLowerCase();
  let matches = pending.filter((t) => (t.title || '').toLowerCase().includes(low));

  // Fall back to the reverse direction: ref contains the title (a caller may pass
  // a longer sentence than the stored title). Only consider titles of >= 6 chars
  // so a trivially short title ("fix", "test", "deploy") can't match an unrelated
  // sentence that merely happens to contain that word.
  if (matches.length === 0) {
    matches = pending.filter((t) => {
      const title = (t.title || '').toLowerCase();
      return title.length >= 6 && low.includes(title);
    });
  }

  if (matches.length === 0) {
    return { ok: false, error: `no pending task matching "${needle}"` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `"${needle}" matches ${matches.length} pending tasks — be more specific`,
      candidates: matches.map((t) => ({ id: t.id, title: t.title })),
    };
  }
  return { ok: true, task: matches[0] };
}

/**
 * Resolve a task reference and mark it done (the explicit human force-complete
 * path behind dobius-task-done). See resolveTaskRef for the resolution rules.
 * LOCAL ONLY — never calls the Asana API (house rule: never auto-close Asana).
 * Returns { ok:true, task, already } | { ok:false, error, candidates? }.
 */
export function completeTaskByRef(projectPath, ref) {
  const resolved = resolveTaskRef(projectPath, ref);
  if (!resolved.ok) return resolved;
  const tasks = readTasks(projectPath);
  return markTaskDone(projectPath, tasks, resolved.task);
}

function markTaskDone(projectPath, tasks, target) {
  const idx = tasks.findIndex((t) => t.id === target.id);
  if (idx === -1) return { ok: false, error: 'task not found' };
  const already = tasks[idx].done === true;
  // complete() is the explicit human force-done path (works from any stage) and
  // keeps stage + done + the event log consistent.
  tasks[idx] = pipeline.complete(tasks[idx], { actor: 'human' });
  if (!already) writeTasks(projectPath, tasks);
  return { ok: true, task: tasks[idx], already };
}

// --- Asana sync -----------------------------------------------------------

function asanaGet(urlPath, token) {
  if (!token) return Promise.reject(new Error('Asana PAT not configured'));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ASANA_BASE,
      path: urlPath,
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
          catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
        } else {
          reject(new Error(`Asana ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Asana timeout')); });
    req.end();
  });
}

/**
 * Fetch tasks assigned to the current user across all Asana workspaces,
 * then upsert any not already in the local list.
 * Returns { ok, added, total } or { ok: false, error }.
 */
export async function syncAsanaTasks(projectPath) {
  if (!projectPath) return { ok: false, error: 'projectPath required' };
  const { pat } = getAsanaQueue();
  const token = pat || process.env.ASANA_PAT;
  if (!token) return { ok: false, error: 'No Asana PAT configured. Add it in Settings > Integrations.' };

  try {
    const q = getAsanaQueue();
    // Get current user gid + workspaces in one call
    const me = await asanaGet('/api/1.0/users/me?opt_fields=gid,workspaces', token);
    const myGid = q.myGid || me?.data?.gid;
    const workspaces = me?.data?.workspaces || [];
    if (!myGid) return { ok: false, error: 'Could not get Asana user GID' };
    if (!workspaces.length) return { ok: false, error: 'No Asana workspaces found' };

    // Two lanes: my tasks (build, mine) and Sam's (review, double-check his work).
    const lanes = [
      { gid: myGid, lane: 'build', assignee: 'Me' },
      { gid: q.reviewGid || '1213473231797717', lane: 'review', assignee: "Sam" },
    ];

    const fields = 'gid,name,due_on,completed,notes,permalink_url';
    // Sam's review lane: recently COMPLETED tasks (last 48h) so he can
    // double-check shipped work. The previous query used `completed_since=now`
    // which Asana interprets as "return tasks NOT completed since now" (i.e.
    // incomplete tasks), so the review lane was filling with in-progress
    // tasks while missing the completed ones it was supposed to surface.
    // Codex PR#3 r5 P2. For the build lane, keep the original incomplete-only
    // filter (`completed_since=now`).
    const sinceISO = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let added = 0;
    let total = 0;
    for (const { gid, lane, assignee } of lanes) {
      for (const ws of workspaces) {
        const isReview = lane === 'review';
        const completedFilter = isReview
          ? `&completed_since=${sinceISO}`
          : '&completed_since=now';
        const data = await asanaGet(
          `/api/1.0/tasks?assignee=${gid}&workspace=${ws.gid}${completedFilter}&limit=50&opt_fields=${fields}`,
          token
        );
        for (const t of (data?.data || [])) {
          if (!t.gid || !t.name) continue;
          // Review lane: keep only the actually-completed ones (Asana's
          // completed_since=<iso> returns tasks "completed since OR still open
          // and modified since", so we still have to filter).
          if (isReview && !t.completed) continue;
          total++;
          const result = addTask(projectPath, {
            title: t.name,
            source: 'asana',
            dueOn: t.due_on || null,
            asanaGid: t.gid,
            lane,
            assignee,
          });
          if (result.ok) added++;
        }
      }
    }

    return { ok: true, added, total };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
