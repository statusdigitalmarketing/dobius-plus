// Commands, the project to-do list and Asana tasks for the phone, over the phone server's authed WebSocket. main.js
// hands in the SAME functions the desktop Tasks dropdown uses (setTasksBridge), so the phone has no second path to the
// handed-back commands, the Run start or the task files. Docs: docs/mobile-ws-protocol.md ("Commands, To-do and Asana").
//
// Command text (and what Claude wrote around it) goes only to the phone that asked, as the reply to its own request.
// Nothing here logs a message body or an error message: a failure answers a fixed code.

import crypto from 'crypto';
import os from 'os';
import { commandPlaceholder } from '../shared/handoff.js';
import { baseName } from '../shared/platform.js';

const baseNameOf = (p) => (typeof p === 'string' && p ? str(baseName(p), 120) || null : null);

const MAX_REQ_ID = 64;
const MAX_ID = 200;
const MAX_PATH = 4096;
const MAX_TITLE = 500;
const MAX_EDITED = 2000;

// The reply type for each request, also what a failure answers with.
const REPLY = {
  commandsList: 'commands', commandsDismiss: 'commandResult', commandsRun: 'commandResult',
  tasksProjects: 'tasksProjects', projectTasksRead: 'projectTasks', projectTaskAct: 'projectTaskResult',
  projectTaskAdd: 'projectTaskResult', asanaSync: 'asanaSyncResult',
};

let bridge = null;
export function setTasksBridge(b) { bridge = b || null; }

const reqIdOf = (msg) => (typeof msg.reqId === 'string' && msg.reqId.length <= MAX_REQ_ID ? msg.reqId : null);
const idOk = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID;
// A desktop tab id carries its project's whole path (term-<path>-<n>), so it is as long as a path can be.
const tabIdOk = (id) => typeof id === 'string' && id.startsWith('term-') && id.length <= MAX_PATH + 64 && !/[\x00-\x1f\x7f]/.test(id);
const pathOk = (p) => typeof p === 'string' && p.startsWith('/') && p.length <= MAX_PATH && !/[\x00-\x1f\x7f]/.test(p);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

/** What the phone saw of a task: a change to any of it (on the Mac, another phone) means it looks again before acting. */
export function taskPrint(t) {
  const seen = [t?.title, t?.done === true, t?.stage, t?.notes, t?.dueOn, t?.source, t?.url];
  return crypto.createHash('sha256').update(JSON.stringify(seen)).digest('hex').slice(0, 24);
}

/** One task as the phone shows it: no event log, runs or session links. */
export function taskForPhone(t) {
  return {
    id: str(t?.id, MAX_ID),
    title: str(t?.title, MAX_TITLE) || '',
    done: t?.done === true,
    source: str(t?.source, 20) || 'manual',
    dueOn: typeof t?.dueOn === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.dueOn) ? t.dueOn.slice(0, 10) : null,
    lane: t?.lane === 'build' || t?.lane === 'review' ? t.lane : null,
    assignee: str(t?.assignee, 120),
    notes: str(t?.notes, 4000),
    url: typeof t?.url === 'string' && /^https:\/\//i.test(t.url) ? t.url.slice(0, 2000) : null,
    stage: str(t?.stage, 30),
    createdAt: Number.isFinite(t?.createdAt) ? t.createdAt : 0,
    print: taskPrint(t),
  };
}

/** A handed-back command list entry as the phone shows it (handoffCommands.list() already dropped what must not go). */
// isLive(termId): whether that terminal is still there, so the phone offers "Open terminal" only for one it can open.
// home: this Mac's home folder, so the phone shortens only that one to ~ (never /Users/Shared or another person's home).
export function commandsForPhone(entries, labelOf = () => null, isLive = () => false, home = os.homedir()) {
  return (Array.isArray(entries) ? entries : []).map((e) => {
    const label = labelOf(e.tabId) || {};
    return {
      tabId: e.tabId,
      home: str(home, MAX_PATH),
      tabLabel: str(label.label, 80) || 'A tab',
      // The folder the commands were captured in (Claude's own, which may differ from where the tab started), never the
      // tab's starting folder: the card must name where Run will act (Codex, phone tasks round 3).
      project: baseNameOf(e.projectPath) || str(label.project, 120) || null,
      projectPath: str(e.projectPath, MAX_PATH),
      cwd: str(e.cwd, MAX_PATH),
      at: Number.isFinite(e.at) ? e.at : null,
      commands: (e.commands || []).map((c) => ({
        id: c.id,
        text: c.text,
        why: str(c.why, 600) || '',
        state: c.state,
        // The Mac's own placeholder check, for a phone whose browser cannot run it (iOS before 16.4).
        hole: c.state === 'waiting' ? commandPlaceholder(c.text) || null : null,
        cwd: str(c.cwd, MAX_PATH),
        reply: str(c.reply, 6000) || '',
        at: Number.isFinite(c.at) ? c.at : null,
        edited: c.edited === true,
        exit: Number.isInteger(c.exit) ? c.exit : null,
        startedAt: Number.isFinite(c.startedAt) ? c.startedAt : null,
        endedAt: Number.isFinite(c.endedAt) ? c.endedAt : null,
        runTabId: str(c.runTabId, MAX_PATH + 64),
        runLive: typeof c.runTabId === 'string' && !!isLive(c.runTabId),
      })),
    };
  });
}

/**
 * Handle one phone message if it is ours. Returns true when handled. `send` writes to that one socket. Every reply
 * carries the request's reqId. ctx: { knownProjects() -> Promise<[{path,name}]>, newTerminalId(), authorizeTab(id) }.
 */
export function handleTasksMessage(msg, send, stillOk = () => true, ctx = {}) {
  const type = msg?.type;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(REPLY, type)) return false;
  const reqId = reqIdOf(msg);
  const fail = (extra) => send({ type: REPLY[type], reqId, ok: false, ...extra });
  if (!bridge) { fail({ error: 'unavailable' }); return true; }
  // A revoked phone's queued messages can still be read after its socket was told to close: every request here checks
  // the pairing first, and every write checks it again right before it changes anything.
  if (!stillOk()) { fail({ error: 'unavailable' }); return true; }
  const knownProject = async (p) => {
    if (!pathOk(p) || typeof ctx.knownProjects !== 'function') return false;
    const list = await ctx.knownProjects();
    return Array.isArray(list) && list.some((x) => x?.path === p);
  };
  const run = async () => {
    switch (type) {
      case 'commandsList':
        return send({ type: 'commands', reqId, ok: true, list: bridge.listCommands() });
      case 'commandsDismiss': {
        if (!tabIdOk(msg.tabId) || !idOk(msg.id)) return fail({ op: 'dismiss', error: 'bad-request' });
        if (!stillOk()) return fail({ op: 'dismiss', error: 'unavailable' });
        return send({ type: 'commandResult', reqId, op: 'dismiss', id: msg.id, ok: !!bridge.dismissCommand(msg.tabId, msg.id) });
      }
      case 'commandsRun': {
        if (!tabIdOk(msg.tabId) || !idOk(msg.id)) return fail({ op: 'run', error: 'bad-request' });
        let edited;
        if (msg.edited !== undefined && msg.edited !== null) {
          if (typeof msg.edited !== 'string' || msg.edited.length > MAX_EDITED) return fail({ op: 'run', id: msg.id, error: 'bad-request' });
          edited = msg.edited;
        }
        // Synchronous from here to the spawn (main re-checks the pairing and the command right before it): a second
        // tap on Run finds the command already running and is refused.
        const r = bridge.runCommand({ tabId: msg.tabId, id: msg.id, edited, asIs: msg.asIs === true }, stillOk, {
          newTerminalId: ctx.newTerminalId, authorizeTab: ctx.authorizeTab,
        });
        if (!r?.ok) return fail({ op: 'run', id: msg.id, error: typeof r?.error === 'string' ? r.error.slice(0, 200) : 'failed' });
        return send({ type: 'commandResult', reqId, op: 'run', id: msg.id, ok: true, termId: r.termId });
      }
      case 'tasksProjects': {
        const list = typeof ctx.knownProjects === 'function' ? await ctx.knownProjects() : [];
        if (!stillOk()) return fail({ error: 'unavailable' });
        return send({ type: 'tasksProjects', reqId, ok: true, list: bridge.projectSummaries(Array.isArray(list) ? list : []) });
      }
      case 'projectTasksRead': {
        if (!(await knownProject(msg.project))) return fail({ project: str(msg.project, MAX_PATH), error: 'unknown-project' });
        if (bridge.legacyListWaiting?.(msg.project)) return fail({ project: str(msg.project, MAX_PATH), error: 'open-on-mac' });
        // Reading can move a legacy or corrupt list file aside: not for a phone unpaired while the project was looked up.
        if (!stillOk()) return fail({ error: 'unavailable' });
        const tasks = bridge.listTasks(msg.project);
        return send({ type: 'projectTasks', reqId, ok: true, project: msg.project, tasks: (Array.isArray(tasks) ? tasks : []).map(taskForPhone) });
      }
      case 'projectTaskAct': {
        if (!['complete', 'reopen', 'delete'].includes(msg.kind) || !idOk(msg.id) || typeof msg.print !== 'string' || msg.print.length > 64) return fail({ op: msg.kind, error: 'bad-request' });
        if (!(await knownProject(msg.project))) return fail({ op: msg.kind, id: msg.id, error: 'unknown-project' });
        if (bridge.legacyListWaiting?.(msg.project)) return fail({ op: msg.kind, id: msg.id, error: 'open-on-mac' });
        const r = bridge.actOnTask({ project: msg.project, id: msg.id, kind: msg.kind, print: msg.print }, stillOk);
        return send({ type: 'projectTaskResult', reqId, op: msg.kind, id: msg.id, ok: !!r?.ok, error: r?.ok ? undefined : (r?.error || 'failed') });
      }
      case 'projectTaskAdd': {
        const title = typeof msg.title === 'string' ? msg.title.trim() : '';
        if (!title || title.length > MAX_TITLE || /[\x00-\x08\x0b-\x1f\x7f]/.test(title)) return fail({ op: 'add', error: 'bad-request' });
        if (!(await knownProject(msg.project))) return fail({ op: 'add', error: 'unknown-project' });
        if (bridge.legacyListWaiting?.(msg.project)) return fail({ op: 'add', error: 'open-on-mac' });
        const r = bridge.addTask(msg.project, title, stillOk);
        return send({ type: 'projectTaskResult', reqId, op: 'add', ok: !!r?.ok, id: r?.ok ? r.id : undefined, error: r?.ok ? undefined : (r?.error || 'failed') });
      }
      case 'asanaSync': {
        if (!(await knownProject(msg.project))) return fail({ error: 'unknown-project' });
        if (bridge.legacyListWaiting?.(msg.project)) return fail({ error: 'open-on-mac' });
        const r = await bridge.syncAsana(msg.project, stillOk);
        return send({ type: 'asanaSyncResult', reqId, ok: !!r?.ok, added: r?.ok && Number.isInteger(r.added) ? r.added : undefined, error: r?.ok ? undefined : (r?.error || 'failed') });
      }
      default:
        return undefined;
    }
  };
  run().catch(() => fail({ error: 'failed' }));
  return true;
}

/** Asana's own words never go to the phone: a sync failure becomes one of three codes. */
export function syncErrorCode(r) {
  if (r?.ok) return undefined;
  if (r?.noKey) return 'no-key';
  if (r?.unauthorized) return 'unauthorized';
  return 'failed';
}

/**
 * One change the phone asked for on a project's list, through the same tasks-service functions the Mac's Tasks dropdown
 * uses. Only a task with exactly this id (completeTaskById, never completeTaskByRef, which trims and falls back to a title match), only the version
 * the phone showed (`print`), and only while the phone is still paired, checked right before the write. Marking done is
 * LOCAL ONLY, as on the Mac: nothing here calls Asana. svc: { listTasks, completeTaskById, reopenTask, updateTask,
 * deleteTask, changed(project) }.
 */
export function actOnProjectTask({ project, id, kind, print }, stillOk, svc) {
  // Before the read too: reading can move a legacy or corrupt list file aside. Nothing below awaits.
  if (!stillOk()) return { ok: false, error: 'unavailable' };
  const tasks = svc.listTasks(project);
  const t = Array.isArray(tasks) ? tasks.find((x) => x?.id === id) : null;
  if (!t) return { ok: false, error: 'not-found' };
  if (taskPrint(t) !== print) return { ok: false, error: 'changed' };
  if (!stillOk()) return { ok: false, error: 'unavailable' };
  let r;
  if (kind === 'complete') r = t.done ? { ok: true } : svc.completeTaskById(project, t.id);
  else if (kind === 'reopen') {
    // The Mac's checkbox: a task the pipeline marked done reopens through reopenTask (stage and done together).
    if (!t.done && t.stage !== 'done') r = { ok: true };
    else r = t.stage === 'done' ? svc.reopenTask(project, t.id, { note: 'unchecked from the phone' }) : svc.updateTask(project, t.id, { done: false });
  } else if (kind === 'delete') r = svc.deleteTask(project, t.id);
  else return { ok: false, error: 'bad-request' };
  if (r?.ok) svc.changed(project);
  return r?.ok ? { ok: true } : { ok: false, error: 'failed' };
}

/** Add a plain to-do from the phone (the Mac's "Add a task"), while still paired. */
export function addProjectTask(project, title, stillOk, svc) {
  if (!stillOk()) return { ok: false, error: 'unavailable' };
  const r = svc.addTask(project, { title });
  if (!r?.ok) return { ok: false, error: 'failed' };
  svc.changed(project);
  return { ok: true, id: r.task?.id };
}

/**
 * Each known project with its open counts, busiest first; projects with no tasks keep their order at the end.
 * `hasList`: the project has a list file of its own. The phone opens one of those by itself, never a project without
 * one: reading that one would run tasks-service's legacy-name move, which two folders can share (the person can still
 * pick it, as opening it on the Mac does).
 */
export function projectSummaries(projects, peek) {
  const rows = projects.filter((p) => pathOk(p?.path)).map((p, i) => {
    let tasks;
    try { tasks = peek(p.path); } catch { tasks = null; }
    // Only real task objects: one bad entry (`null`, a number) must not fail the whole picker (Codex round 6).
    const open = (Array.isArray(tasks) ? tasks : []).filter((t) => t && typeof t === 'object' && !t.done);
    return { path: p.path, name: str(p.name, 120) || p.path, pending: open.filter((t) => t.source !== 'asana').length, asana: open.filter((t) => t.source === 'asana').length, hasList: Array.isArray(tasks), i };
  });
  rows.sort((a, b) => (b.pending + b.asana) - (a.pending + a.asana) || a.i - b.i);
  return rows.map(({ i: _i, ...r }) => r);
}
