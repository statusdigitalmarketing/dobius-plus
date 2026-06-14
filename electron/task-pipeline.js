/**
 * task-pipeline.js — the task state machine (Epic 7, task 7.1).
 *
 * PURE module: no fs, no Electron, no I/O. Every function takes a task object
 * and returns a NEW task object (never mutates the input), so it is trivially
 * unit-testable and safe to call from either the main process or a test script.
 *
 * The stage machine mirrors the Dobius+ Done Bar, not Hermes's generic states:
 *
 *   intake -> queued -> building -> review -> shiptest -> approval -> done
 *                building/review/shiptest/approval ──> blocked ──(unblock)──> prior
 *
 * Persistence + transition WIRING live in tasks-service.js; this file owns the
 * RULES only. The voice-bridge `/stage` route (task 7.4) will call the
 * tasks-service wrappers, which delegate here.
 */

/** Canonical stage order (also the column order on the board). */
export const STAGES = [
  'intake', 'queued', 'building', 'review', 'shiptest', 'approval', 'done', 'blocked',
];

/**
 * Allowed forward transitions, `from` -> [allowed `to`].
 * Review lane skips `building` (intake/queued -> review). `blocked` is reached
 * from any active stage and is left only via unblock(). `done` is terminal.
 */
export const TRANSITIONS = {
  intake:   ['queued', 'building', 'review', 'blocked'],
  queued:   ['building', 'review', 'blocked'],
  building: ['review', 'blocked'],
  review:   ['shiptest', 'blocked'],
  shiptest: ['approval', 'blocked'],
  approval: ['done', 'blocked'],
  done:     [],
  blocked:  [],
};

/**
 * Transitions that ONLY a human may perform (encoded in the table, not just
 * prose — per the architect review). A system/automated caller advancing one
 * of these throws. `advance(task, 'done', { actor: 'human' })` is the only way
 * a task reaches `done`. (force-complete via complete() is a separate explicit
 * human path used by dobius-task-done.)
 */
export const HUMAN_ONLY = new Set(['approval>done']);

const MAX_EVENTS = 100; // keep the per-task JSON from growing unbounded
const MAX_RUNS = 10;

export function isValidStage(stage) {
  return STAGES.includes(stage);
}

/** Stage of a task, tolerating legacy tasks that only have `done`. */
export function currentStage(task) {
  if (task && isValidStage(task.stage)) return task.stage;
  return task && task.done ? 'done' : 'intake';
}

export function canAdvance(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

function cap(arr, max) {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

function event(kind, from, to, note, actor, at) {
  return { kind, from, to, at, note: note || null, actor: actor || 'system' };
}

/**
 * Advance a task to `toStage`. Throws on an illegal transition or a human-only
 * transition attempted by a non-human actor. Returns a NEW task.
 */
export function advance(task, toStage, { note = null, actor = 'system', at = Date.now() } = {}) {
  const from = currentStage(task);
  if (!isValidStage(toStage)) throw new Error(`unknown stage: ${toStage}`);
  if (from === toStage) return task; // idempotent no-op
  if (!canAdvance(from, toStage)) throw new Error(`illegal transition ${from} -> ${toStage}`);
  if (HUMAN_ONLY.has(`${from}>${toStage}`) && actor !== 'human') {
    throw new Error(`transition ${from} -> ${toStage} requires a human actor`);
  }
  const events = cap([...(task.events || []), event(toStage, from, toStage, note, actor, at)], MAX_EVENTS);
  const stagedAt = { ...(task.stagedAt || {}), [toStage]: at };
  return {
    ...task,
    stage: toStage,
    events,
    stagedAt,
    blockedFrom: null,
    ...(toStage === 'done' ? { done: true } : {}),
  };
}

/** Move a task to `blocked`, remembering the stage it came from. Returns a NEW task. */
export function block(task, reason, { actor = 'system', at = Date.now() } = {}) {
  const from = currentStage(task);
  // Re-blocking an already-blocked task keeps the original origin stage.
  const blockedFrom = from === 'blocked' ? (task.blockedFrom || 'queued') : from;
  const events = cap([...(task.events || []), event('blocked', from, 'blocked', reason, actor, at)], MAX_EVENTS);
  return { ...task, stage: 'blocked', blockedFrom, events };
}

/**
 * Leave `blocked`, returning to the origin stage (or an explicit target).
 * Throws if the task is not blocked. Returns a NEW task.
 */
export function unblock(task, { toStage = null, note = null, actor = 'system', at = Date.now() } = {}) {
  if (currentStage(task) !== 'blocked') throw new Error('task is not blocked');
  const target = toStage || task.blockedFrom || 'queued';
  if (!isValidStage(target) || target === 'blocked') throw new Error(`bad unblock target: ${target}`);
  const events = cap([...(task.events || []), event('unblocked', 'blocked', target, note, actor, at)], MAX_EVENTS);
  const stagedAt = { ...(task.stagedAt || {}), [target]: at };
  return { ...task, stage: target, blockedFrom: null, events, stagedAt };
}

/**
 * Explicit human force-complete (used by dobius-task-done). Bypasses the
 * transition table on purpose: ticking a task off the panel must work from any
 * stage. Sets done + stage='done' and records an event. Returns a NEW task.
 */
export function complete(task, { actor = 'human', note = null, at = Date.now() } = {}) {
  const from = currentStage(task);
  if (from === 'done' && task.done === true) return task; // already done, idempotent
  const events = cap([...(task.events || []), event('done', from, 'done', note, actor, at)], MAX_EVENTS);
  const stagedAt = { ...(task.stagedAt || {}), done: at };
  return { ...task, stage: 'done', done: true, blockedFrom: null, events, stagedAt };
}

/** Append a run-attempt record (Epic 8 circuit breaker / attempt history). Returns a NEW task. */
export function addRun(task, run, { at = Date.now() } = {}) {
  const runs = cap([...(task.runs || []), { ...run, at }], MAX_RUNS);
  return { ...task, runs };
}

/** Fields a brand-new task gets (spread into addTask). */
export function pipelineFields({ at = Date.now() } = {}) {
  return {
    stage: 'intake',
    events: [event('created', null, 'intake', null, 'system', at)],
    runs: [],
    stagedAt: { intake: at },
    sessionId: null,
    tabId: null,
    blockedFrom: null,
  };
}

/**
 * Bring a legacy task (only `done`) up to the current shape, idempotently.
 * Never mutates the input. Cheap enough to run on every read.
 */
export function migrate(task, { at = Date.now() } = {}) {
  if (!task || typeof task !== 'object') return task;
  if (isValidStage(task.stage) && Array.isArray(task.events)) return task; // already current
  const stage = isValidStage(task.stage) ? task.stage : (task.done ? 'done' : 'intake');
  const createdAt = task.createdAt || at;
  return {
    ...task,
    stage,
    events: Array.isArray(task.events) && task.events.length
      ? task.events
      : [event('created', null, stage, null, 'system', createdAt)],
    runs: Array.isArray(task.runs) ? task.runs : [],
    stagedAt: task.stagedAt && typeof task.stagedAt === 'object' ? task.stagedAt : { [stage]: createdAt },
    sessionId: task.sessionId ?? null,
    tabId: task.tabId ?? null,
    blockedFrom: task.blockedFrom ?? null,
  };
}
