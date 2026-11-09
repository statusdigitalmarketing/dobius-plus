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
import crypto from 'crypto';
import { getAsanaQueue } from './config-manager.js';
import { spawn } from 'child_process';
import { asanaTokenWithSource, claudeSettingsEnv } from './claude-settings-env.js';
import * as pipeline from './task-pipeline.js';

const TASKS_DIR = path.join(os.homedir(), '.claude', 'project-tasks');
const ASANA_BASE = 'app.asana.com';
const ASANA_TIMEOUT_MS = 15_000;
const MAX_TITLE = 500;

// The list file's name for a project, with no side effects (see tasksPath for the legacy move).
function hashedTasksPath(projectPath) {
  const norm = path.resolve(String(projectPath).replace(/^~(?=$|\/)/, os.homedir()));
  const slug = norm.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
  const hash = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8);
  return path.join(TASKS_DIR, `${slug}.${hash}.json`);
}

/**
 * A project's tasks for a count, READ ONLY: never the legacy-name move, the corrupt-file move or a mkdir that
 * listTasks may do. The phone's project picker counts every known project this way, including ones nobody opened, so
 * it must not move a legacy file (two paths can share a legacy name) or touch anything else. null when the project has
 * no list file under its own name, [] when it has one that cannot be read.
 */
export function peekTasks(projectPath) {
  if (!projectPath) return null;
  let raw;
  try { raw = fs.readFileSync(hashedTasksPath(projectPath), 'utf8'); } catch { return null; } // no list of its own yet
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((t) => pipeline.migrate(t)) : [];
  } catch {
    return []; // unreadable: listTasks moves it aside when the project is opened
  }
}

function tasksPath(projectPath) {
  // Normalize so the renderer (store currentProjectPath) and the CLI (which may
  // pass ~, a trailing slash, or a relative cwd) encode to the SAME filename.
  // path.resolve on an already-clean absolute path is a no-op, so existing task
  // files keyed on the renderer's path are unaffected.
  const expanded = String(projectPath).replace(/^~(?=$|\/)/, os.homedir());
  const norm = path.resolve(expanded);
  // Two-part key: slug + 8-char hash of the FULL normalized path. Without
  // the hash, two project paths sharing the same first 120 sanitized
  // characters (deep worktrees, long monorepo paths) collide on the same
  // file and their tasks mix. Codex Apple-grade audit r25 P2.
  const slug = norm.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100);
  const hash = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8);
  const newPath = path.join(TASKS_DIR, `${slug}.${hash}.json`);
  // One-shot legacy migration: if the new file doesn't exist but the old
  // 120-char slug filename DOES, rename it in place so existing tasks
  // carry through. Idempotent (only runs when new is absent + legacy is
  // present); silent failure leaves both alone so a future read still hits
  // the legacy path via the secondary fallback below.
  try {
    if (!fs.existsSync(newPath)) {
      const legacySafe = norm.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
      const legacyPath = path.join(TASKS_DIR, `${legacySafe}.json`);
      if (fs.existsSync(legacyPath)) {
        fs.mkdirSync(TASKS_DIR, { recursive: true });
        fs.renameSync(legacyPath, newPath);
      }
    }
  } catch { /* fall through, the secondary fallback in readTasks covers it */ }
  return newPath;
}

function readTasks(projectPath, { strict = false } = {}) {
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
      // The parser's message can quote the file, and this log can reach an error report: name the failure only.
      console.error(`[tasks-service] Corrupt task file; backed up beside it: ${parseErr.name}`);
      if (strict) throw parseErr; // a sync must not write a fresh list over it
      return [];
    }
    // Normalize legacy (done-only) tasks to the current stage shape on read.
    // The upgraded shape is persisted on the next write.
    return Array.isArray(parsed) ? parsed.map((t) => pipeline.migrate(t)) : [];
  } catch (err) {
    console.error(`[tasks-service] Failed to read a task file: ${err.code || err.name}`);
    // strict: a caller about to write must not replace an unreadable file with [].
    if (strict) throw err;
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

const SOURCES = new Set(['manual', 'asana', 'bot', 'inbox']);
const MAX_NOTES = 4000;

// Preview text and a link for the dropdown. Only an https link survives, and
// it opens through shell:openExternal, never inside Dobius.
function extraFields({ notes, url } = {}) {
  return {
    notes: typeof notes === 'string' && notes.trim() ? notes.slice(0, MAX_NOTES) : null,
    url: typeof url === 'string' && /^https:\/\//i.test(url) ? url.slice(0, 2000) : null,
  };
}

function newTask(clean, { source, dueOn, asanaGid, inboxId, lane, assignee, notes, url }) {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: clean,
    done: false,
    source: SOURCES.has(source) ? source : 'manual',
    dueOn: dueOn || null,
    asanaGid: asanaGid || null,
    inboxId: inboxId || null,    // the Inbox board card it came from
    lane: lane || null,          // 'build' (mine) | 'review' (Sam's)
    assignee: assignee || null,  // display name
    ...extraFields({ notes, url }),
    createdAt: Date.now(),
    ...pipeline.pipelineFields(), // stage, events, runs, stagedAt, sessionId, tabId
  };
}

export function addTask(projectPath, { title, source = 'manual', dueOn = null, asanaGid = null, inboxId = null, lane = null, assignee = null, notes = null, url = null } = {}) {
  if (!projectPath || !title) return { ok: false, error: 'projectPath and title required' };
  const clean = String(title).slice(0, MAX_TITLE).trim();
  if (!clean) return { ok: false, error: 'title empty' };
  const tasks = readTasks(projectPath);
  // Dedupe by asanaGid, and by Inbox card
  if (asanaGid && tasks.some((t) => t.asanaGid === asanaGid)) {
    return { ok: false, error: 'duplicate asanaGid' };
  }
  // Any task, done or not: reopening the old one is the way back, and two
  // tasks for one card would make completeTaskByRef ambiguous.
  if (inboxId && tasks.some((t) => t.inboxId === inboxId)) {
    return { ok: false, error: 'already on this list' };
  }
  const task = newTask(clean, { source, dueOn, asanaGid, inboxId, lane, assignee, notes, url });
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
  // stagedAt is a { [stage]: timestamp } MAP across the rest of the pipeline
  // (see task-pipeline.js advance/unblock). Round-3 wrote it as a bare number,
  // which the next transition or reload then either lost or treated as garbage.
  // Merge the new approval timestamp into the existing map. Codex PR#3 r10 P3.
  const at = Date.now();
  const stagedAt = { ...(t.stagedAt && typeof t.stagedAt === 'object' ? t.stagedAt : {}), approval: at };
  tasks[idx] = { ...t, done: false, stage: 'approval', stagedAt, events };
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

// `deadlineMs`: a hard limit on the whole request (the socket timeout only measures silence, so a trickling answer
// could otherwise hold a request open for minutes). The answer is capped at 8 MB.
function asanaGet(urlPath, token, timeoutMs = ASANA_TIMEOUT_MS, deadlineMs = 60_000) {
  if (!token) return Promise.reject(new Error('Asana PAT not configured'));
  return new Promise((resolve, reject) => {
    // Settles exactly once, whatever happens first: the answer, an error, a connection that closes mid-answer, or
    // the deadline (which rejects itself rather than relying on destroy() to emit).
    let deadline = null;
    let settled = false;
    const done = (fn) => (v) => { if (settled) return; settled = true; clearTimeout(deadline); fn(v); };
    resolve = done(resolve);
    reject = done(reject);
    const req = https.request({
      hostname: ASANA_BASE,
      path: urlPath,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { req.destroy(new Error('Asana answer too large')); return; }
        chunks.push(c);
      });
      res.on('aborted', () => reject(new Error('Asana closed the connection')));
      res.on('error', reject);
      res.on('close', () => reject(new Error('Asana closed the connection'))); // after 'end' this is a no-op
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
        } else {
          const err = new Error(`Asana ${res.statusCode}: ${body.slice(0, 200)}`);
          err.status = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Asana timeout')); });
    deadline = setTimeout(() => { reject(new Error('Asana timeout')); req.destroy(); }, deadlineMs);
    req.end();
  });
}

/**
 * Fetch tasks assigned to the current user across all Asana workspaces,
 * then upsert any not already in the local list.
 * Returns { ok, added, total } or { ok: false, error }.
 */
// One sync per project at a time: a second click joins the running one, so an
// older Asana answer can never land after a newer one and revert it.
const syncing = new Map();
const answering = new Map(); // key -> the raw sync (main only: it can carry the refused key), for {fresh} to wait on

export function syncAsanaTasks(projectPath, { fresh = false } = {}) {
  const key = projectPath ? tasksPath(projectPath) : '';
  if (syncing.has(key)) {
    // Right after a key switch the running sync may still be using the old key: wait for ITS answer from Asana (not
    // the diagnosis of it), then sync again.
    if (fresh) return (answering.get(key) || syncing.get(key)).catch(() => {}).then(() => syncAsanaTasks(projectPath));
    return syncing.get(key);
  }
  const once = syncAsanaTasksOnce(projectPath);
  answering.set(key, once);
  once.finally(() => { if (answering.get(key) === once) answering.delete(key); }).catch(() => {});
  // Everyone who joins gets the DESCRIBED result: the internal one carries the refused key and never leaves here.
  // The lock is released as soon as Asana has answered, before the refusal is looked into, so a sync asked for
  // meanwhile (a key fixed elsewhere) runs with the new key instead of waiting on the diagnosis.
  const run = once.then((r) => (r?.refusedKey ? describeRefusal(r.refusedKey) : r)).catch((err) => ({ ok: false, error: err?.message || 'Sync failed' }));
  once.finally(() => { if (syncing.get(key) === run) syncing.delete(key); }).catch(() => {});
  syncing.set(key, run);
  return run;
}

// --- A refused Asana key (Brett, 2026-11-07, Dobius 2.2.7: "Asana 401 ... my key works outside Dobius") ---
//
// Dobius reads ONE key (asanaTokenWithSource): ~/.claude/settings.json's env first, else an older Dobius-only key,
// else the environment Dobius started with. A key exported in the shell profile counts only in that last case, so a
// stale key in either of the first two places wins over a working one in the shell. On a 401 the person is told
// which key was refused and, when another key on this Mac works, whose account it is, with a one-click switch.
// Keys never leave main: only where each lives, its last four characters and the account it opens.

export const ASANA_KEY_PLACES = {
  settings: 'Settings > Integrations',
  dobius: 'an older Dobius-only setting',
  env: 'the environment Dobius was started with',
  shell: 'your shell profile (ASANA_PAT)',
};
const SHELL_MARK = '__DOBIUS_ASANA__';

/** ASANA_PAT as the person's login shell sets it (not as Dobius inherited it), or null. Never logged. */
function shellAsanaPat({ timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.env.SHELL || '/bin/zsh', ['-ilc', `printf '${SHELL_MARK}%s${SHELL_MARK}' "$ASANA_PAT"`], {
        detached: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: os.homedir(),
        env: { ...process.env, ASANA_PAT: '', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
    } catch { resolve(null); return; }
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const m = out.match(new RegExp(`${SHELL_MARK}(.*?)${SHELL_MARK}`, 's'));
      const v = m ? m[1].trim() : '';
      resolve(v || null);
    };
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } finish(); }, timeoutMs);
    // Once the value is in, the shell is done for us: end it (a slow logout script must not linger).
    child.stdout.on('data', (c) => { out = (out + String(c)).slice(-65536); if (out.split(SHELL_MARK).length >= 3) { finish(); try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } });
    child.on('error', finish);
    child.on('exit', finish);
  });
}

/** Every Asana key on this Mac, by place, without duplicates (first place wins). */
async function asanaKeyCandidates({ dedupe = true } = {}) {
  const legacy = typeof getAsanaQueue().pat === 'string' ? getAsanaQueue().pat.trim() : '';
  const list = [
    { source: 'settings', token: claudeSettingsEnv('ASANA_PAT') },
    { source: 'dobius', token: legacy || null },
    { source: 'env', token: (process.env.ASANA_PAT || '').trim() || null },
    { source: 'shell', token: await shellAsanaPat() },
  ];
  if (!dedupe) return list.filter((c) => c.token);
  const seen = new Set();
  return list.filter((c) => c.token && !seen.has(c.token) && seen.add(c.token));
}

/** Whose key is this? { ok, email, name } when Asana accepts it, else { ok:false, refused } (refused: a 401). */
async function asanaWhoIs(token) {
  try {
    // 6 seconds for the whole request, which is then aborted (not just stopped waiting for).
    const me = await asanaGet('/api/1.0/users/me?opt_fields=email,name', token, 6000, 6000);
    return { ok: true, email: me?.data?.email || null, name: me?.data?.name || null };
  } catch (err) {
    return { ok: false, refused: err?.status === 401 || err?.status === 403 };
  }
}

/** After a 401: which key was refused, and the first other key here that works (with whose account it opens). */
async function diagnoseRefusedKey(used) {
  // All asked at once (each capped at 6s), the first place in order that works wins.
  const others = (await asanaKeyCandidates()).filter((c) => c.token !== used.token);
  const answers = await Promise.all(others.map((c) => asanaWhoIs(c.token)));
  const i = answers.findIndex((a) => a.ok);
  const c = others[i];
  const alternative = i >= 0 ? { source: c.source, place: ASANA_KEY_PLACES[c.source], hint: c.token.slice(-4), email: answers[i].email, name: answers[i].name } : null;
  return { refused: { source: used.source, place: ASANA_KEY_PLACES[used.source] || 'Dobius', hint: used.token.slice(-4) }, alternative };
}

/** The 401 result the popup shows: which key was refused and, when there is one, the key that works. */
async function describeRefusal(used) {
  const d = await diagnoseRefusedKey(used);
  const alt = d.alternative ? ` The key in ${d.alternative.place} (ending ${d.alternative.hint}) works${d.alternative.email ? `, as ${d.alternative.email}` : ''}.` : '';
  return {
    ok: false,
    unauthorized: true,
    ...d,
    error: `Asana turned down the key Dobius uses: the one in ${d.refused.place}, ending ${d.refused.hint} (expired, revoked or mistyped).${alt}`,
  };
}

/**
 * The working key from `source`, checked again right now, for Settings to save. Main calls this; the key itself
 * never reaches the renderer. { ok, token, email } or { ok:false, error }.
 */
export async function workingAsanaKeyFrom(source, { expectHint, expectEmail } = {}) {
  if (!Object.hasOwn(ASANA_KEY_PLACES, source)) return { ok: false, error: 'Unknown place.' };
  const c = (await asanaKeyCandidates({ dedupe: false })).find((k) => k.source === source);
  if (!c) return { ok: false, error: 'That key is no longer there. Press Asana to check again.', stale: true };
  // The person agreed to THE key they were shown: same last four, same account. If either changed since (a profile
  // edited, another person's key), nothing is saved.
  if (!expectHint || c.token.slice(-4) !== expectHint) {
    return { ok: false, error: 'That key changed since Dobius looked. Press Asana to check again.', stale: true };
  }
  const who = await asanaWhoIs(c.token);
  if (!who.ok) {
    return who.refused
      ? { ok: false, error: 'Asana turned that key down too. Paste a new key in Settings.', stale: true }
      : { ok: false, error: 'Asana did not answer (busy or offline). Try again in a moment.' };
  }
  if (typeof expectEmail === 'string' && expectEmail && String(who.email || '').toLowerCase() !== expectEmail.toLowerCase()) {
    return { ok: false, error: `That key now opens ${who.email || 'a different account'}, not ${expectEmail}. Nothing was changed. Press Asana to check again.`, stale: true };
  }
  return { ok: true, token: c.token, email: who.email };
}

async function syncAsanaTasksOnce(projectPath) {
  if (!projectPath) return { ok: false, error: 'projectPath required' };
  const { pat } = getAsanaQueue();
  const used = asanaTokenWithSource(pat); // the shared spot decides (claude-settings-env.js)
  const token = used.token;
  if (!token) return { ok: false, error: 'No Asana key yet. Add your Asana personal access token in Settings > Integrations.', noKey: true };

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
    const fetched = [];
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
          fetched.push({ t, lane, assignee });
        }
      }
    }

    // One read and one write, with no await between them, so a task completed
    // from a terminal while Asana was answering is not overwritten. A task
    // already here gets its due date, notes and link refreshed; its title,
    // stage and done state stay as they are.
    const tasks = readTasks(projectPath, { strict: true });
    const byGid = new Map(tasks.filter((x) => x.asanaGid).map((x) => [x.asanaGid, x]));
    let added = 0;
    let changed = false;
    for (const { t, lane, assignee } of fetched) {
      const extra = { dueOn: t.due_on || null, ...extraFields({ notes: t.notes, url: t.permalink_url }) };
      const have = byGid.get(t.gid);
      if (have) {
        for (const [k, v] of Object.entries(extra)) {
          if (have[k] !== v) { have[k] = v; changed = true; }
        }
        continue;
      }
      const clean = String(t.name).slice(0, MAX_TITLE).trim();
      if (!clean) continue;
      const task = newTask(clean, { source: 'asana', asanaGid: t.gid, lane, assignee, notes: t.notes, url: t.permalink_url, dueOn: t.due_on });
      tasks.push(task);
      byGid.set(t.gid, task);
      added++;
      changed = true;
    }
    if (changed) writeTasks(projectPath, tasks);
    return { ok: true, added, total: fetched.length };
  } catch (err) {
    // Described by syncAsanaTasks once the lock is free; `refusedKey` never leaves main (describeRefusal replaces it).
    if (err?.status === 401) return { ok: false, refusedKey: used };
    return { ok: false, error: err.message };
  }
}
