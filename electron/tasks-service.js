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

const TASKS_DIR = path.join(os.homedir(), '.claude', 'project-tasks');
const ASANA_BASE = 'app.asana.com';
const ASANA_TIMEOUT_MS = 15_000;
const MAX_TITLE = 500;

function tasksPath(projectPath) {
  const safe = String(projectPath).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
  return path.join(TASKS_DIR, `${safe}.json`);
}

function readTasks(projectPath) {
  try {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    const p = tasksPath(projectPath);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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

export function addTask(projectPath, { title, source = 'manual', dueOn = null, asanaGid = null } = {}) {
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
    createdAt: Date.now(),
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
  const allowed = ['done', 'title', 'dueOn'];
  const safe = Object.fromEntries(
    Object.entries(patch || {})
      .filter(([k]) => allowed.includes(k))
      .map(([k, v]) => [k, k === 'title' ? String(v).slice(0, MAX_TITLE) : v])
  );
  tasks[idx] = { ...tasks[idx], ...safe };
  writeTasks(projectPath, tasks);
  return { ok: true, task: tasks[idx] };
}

export function deleteTask(projectPath, taskId) {
  if (!projectPath || !taskId) return { ok: false, error: 'projectPath and taskId required' };
  const tasks = readTasks(projectPath);
  const next = tasks.filter((t) => t.id !== taskId);
  writeTasks(projectPath, next);
  return { ok: true };
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
    // Get current user gid + workspaces in one call
    const me = await asanaGet('/api/1.0/users/me?opt_fields=gid,workspaces', token);
    const assigneeGid = me?.data?.gid;
    const workspaces = me?.data?.workspaces || [];
    if (!assigneeGid) return { ok: false, error: 'Could not get Asana user GID' };
    if (!workspaces.length) return { ok: false, error: 'No Asana workspaces found' };

    // Fetch incomplete tasks across all workspaces
    const fields = 'gid,name,due_on,completed,notes,permalink_url';
    const allTasks = [];
    for (const ws of workspaces) {
      const data = await asanaGet(
        `/api/1.0/tasks?assignee=${assigneeGid}&workspace=${ws.gid}&completed_since=now&limit=50&opt_fields=${fields}`,
        token
      );
      allTasks.push(...(data?.data || []));
    }

    const asanaTasks = allTasks;
    let added = 0;

    for (const t of asanaTasks) {
      if (!t.gid || !t.name) continue;
      const result = addTask(projectPath, {
        title: t.name,
        source: 'asana',
        dueOn: t.due_on || null,
        asanaGid: t.gid,
      });
      if (result.ok) added++;
    }

    return { ok: true, added, total: asanaTasks.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
