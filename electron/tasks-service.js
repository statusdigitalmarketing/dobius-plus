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
  try {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    const p = tasksPath(projectPath);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    // Normalize legacy (done-only) tasks to the current stage shape on read.
    // migrate() is a cheap no-op for already-current tasks; the upgraded shape
    // is persisted on the next write.
    return Array.isArray(parsed) ? parsed.map((t) => pipeline.migrate(t)) : [];
  } catch {
    return [];
  }
}

function writeTasks(projectPath, tasks) {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(tasksPath(projectPath), JSON.stringify(tasks, null, 2), 'utf8');
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
  writeTasks(projectPath, tasks);
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
  writeTasks(projectPath, tasks);
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
  writeTasks(projectPath, tasks);
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
  writeTasks(projectPath, next);
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
export function completeTaskByRef(projectPath, ref) {
  if (!projectPath) return { ok: false, error: 'projectPath required' };
  const needle = String(ref || '').trim();
  if (!needle) return { ok: false, error: 'task reference required' };

  const tasks = readTasks(projectPath);
  if (!tasks.length) return { ok: false, error: 'no tasks for this project' };

  // 1. Exact id or asanaGid match (may be already done — that's fine, idempotent).
  const exact = tasks.find((t) => t.id === needle || t.asanaGid === needle);
  if (exact) return markTaskDone(projectPath, tasks, exact);

  // 2. Fuzzy title match, restricted to PENDING tasks only.
  const pending = tasks.filter((t) => !t.done);
  const low = needle.toLowerCase();
  let matches = pending.filter((t) => (t.title || '').toLowerCase().includes(low));

  // Fall back to the reverse direction: ref contains the title (Claude may pass
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
  return markTaskDone(projectPath, tasks, matches[0]);
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
    // Sam's review lane: only his tasks touched in the last 48 hours.
    const sinceISO = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let added = 0;
    let total = 0;
    for (const { gid, lane, assignee } of lanes) {
      for (const ws of workspaces) {
        const recent = lane === 'review' ? `&modified_since=${sinceISO}` : '';
        const data = await asanaGet(
          `/api/1.0/tasks?assignee=${gid}&workspace=${ws.gid}&completed_since=now&limit=50&opt_fields=${fields}${recent}`,
          token
        );
        for (const t of (data?.data || [])) {
          if (!t.gid || !t.name) continue;
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
