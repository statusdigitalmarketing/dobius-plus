/**
 * auto-mode.js — hands-off Asana intake.
 *
 * When enabled, polls Asana on an interval and dispatches each NEW task to the
 * Voice Conductor for full-auto processing. Same dispatch primitive as
 * scheduled-tasks.js (write a tagged prompt into the Conductor tab) — the
 * Conductor owns routing, the crack_bot/crack_repair supervisor launch, the
 * verify pipeline, and the two confirmation gates.
 *
 * The ONLY things that ever pause for the human (enforced in the Conductor
 * prompt, "Auto Mode" section):
 *   1. posting anything to Asana
 *   2. any git push / deploy to production
 * Everything up to those gates runs unattended.
 *
 * State lives in config.asanaQueue.autoMode = { enabled, intervalMinutes, lanes, seen[] }.
 * A task GID in `seen` is never dispatched again (capped to the last SEEN_CAP).
 */
import { loadConfig, saveConfig, getAsanaQueue } from './config-manager.js';
import { writeTerminal, listTerminals } from './terminal-manager.js';
import { getVoiceConductorTabId } from './voice-conductor.js';
import { fetchNewTasks, listAllowedProjects } from './asana-queue.js';

const DEFAULT_INTERVAL_MIN = 10;
const MAX_TASKS_PER_TICK = 3;     // cap concurrent autonomous dispatches per poll
const SEEN_CAP = 500;
const CHUNK = 256;                // write in chunks (mirror scheduled-tasks / iMessage bridge)
const FIRST_TICK_DELAY_MS = 20_000; // let the Conductor come up before the first poll

let timer = null;
let firstTick = null;
let isTicking = false;

// --- Public API ----------------------------------------------------------

export function getAutoMode() {
  const q = getAsanaQueue();
  const a = q.autoMode || {};
  return {
    enabled: !!a.enabled,
    intervalMinutes: a.intervalMinutes || DEFAULT_INTERVAL_MIN,
    lanes: Array.isArray(a.lanes) && a.lanes.length ? a.lanes : ['build', 'review'],
    seen: Array.isArray(a.seen) ? a.seen : [],
  };
}

export function setAutoModeEnabled(enabled) {
  mutateAutoMode((a) => { a.enabled = !!enabled; });
  restart();
  return { ok: true, enabled: !!enabled };
}

export function startAutoMode() {
  restart();
}

export function stopAutoMode() {
  if (timer) { clearInterval(timer); timer = null; }
  if (firstTick) { clearTimeout(firstTick); firstTick = null; }
}

// --- Internals -----------------------------------------------------------

function mutateAutoMode(fn) {
  const cfg = loadConfig();
  if (!cfg.asanaQueue || typeof cfg.asanaQueue !== 'object') cfg.asanaQueue = {};
  if (!cfg.asanaQueue.autoMode || typeof cfg.asanaQueue.autoMode !== 'object') cfg.asanaQueue.autoMode = {};
  fn(cfg.asanaQueue.autoMode);
  saveConfig(cfg);
}

function persistSeen(seen) {
  // Union with whatever is currently persisted so a concurrent full-object
  // saveConfig elsewhere can't drop our newly-seen GIDs (re-dispatch guard).
  mutateAutoMode((a) => {
    const merged = new Set([...(Array.isArray(a.seen) ? a.seen : []), ...seen]);
    a.seen = [...merged].slice(-SEEN_CAP);
  });
}

function restart() {
  stopAutoMode();
  const { enabled, intervalMinutes } = getAutoMode();
  if (!enabled) { console.log('[auto-mode] disabled'); return; }
  const ms = Math.max(1, intervalMinutes) * 60_000;
  timer = setInterval(() => { void tick(); }, ms);
  firstTick = setTimeout(() => { void tick(); }, FIRST_TICK_DELAY_MS);
  console.log(`[auto-mode] enabled — polling Asana every ${intervalMinutes}m`);
}

async function tick() {
  if (isTicking) return;
  const { enabled, lanes, seen } = getAutoMode();
  if (!enabled) return;

  const conductorId = getVoiceConductorTabId();
  // getVoiceConductorTabId() returns a constant id — verify the PTY is actually
  // alive, else a dispatch silently no-ops and we'd mark the task seen forever.
  if (!conductorId || !listTerminals().some((t) => t.id === conductorId)) {
    console.log('[auto-mode] Conductor PTY not alive — skipping tick');
    return;
  }

  const projects = listAllowedProjects();
  if (!projects.length) return;

  isTicking = true;
  const seenSet = new Set(seen);
  let dispatched = 0;
  try {
    for (const proj of projects) {
      if (dispatched >= MAX_TASKS_PER_TICK) break;
      const res = await fetchNewTasks({ projectName: proj.name, lanes });
      if (!res.ok) { console.warn(`[auto-mode] fetch ${proj.name}: ${res.error}`); continue; }
      for (const task of res.tasks) {
        if (dispatched >= MAX_TASKS_PER_TICK) break;
        if (seenSet.has(task.gid)) continue;
        dispatchToConductor(conductorId, proj, task);
        seenSet.add(task.gid);
        // Persist this gid IMMEDIATELY, not just in the end-of-loop finally: a
        // crash after dispatch but before that persist would re-dispatch the
        // task on restart (duplicate autonomous build). persistSeen union-merges
        // and caps, so incremental writes are safe and idempotent.
        persistSeen([task.gid]);
        dispatched++;
      }
    }
  } catch (err) {
    console.warn(`[auto-mode] tick error: ${err.message}`);
  } finally {
    if (dispatched > 0) persistSeen([...seenSet]);
    isTicking = false;
  }
}

function dispatchToConductor(conductorId, project, task) {
  const reqId = `auto-${task.gid}`;
  const lane = task.lane === 'review' ? 'review' : 'build';
  // Strip ALL control chars (not just CR/LF) — task names are attacker-controllable
  // third-party content written into a live terminal/prompt.
  const name = (task.name || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
  const laneRule = lane === 'build'
    ? 'build it FULL-AUTO via the project crack_bot/crack_repair supervisor, then run the verify pipeline'
    : "verify Sam's work only (review-audit -> ship-test -> screenshot); do NOT change scope";
  const instruction =
    `[${reqId}] AUTO MODE — new Asana task in ${project.name} (${lane} lane): "${name}". ` +
    `Task: ${task.url}. Process per the Auto Mode rules: do NOT ask me to start; ${laneRule}. ` +
    `Stop and dobius-confirm ONLY before posting to Asana or before any push/deploy.`;
  const text = instruction.slice(0, 2000);
  for (let i = 0; i < text.length; i += CHUNK) writeTerminal(conductorId, text.slice(i, i + CHUNK));
  writeTerminal(conductorId, '\r');
  console.log(`[auto-mode] dispatched ${task.gid} (${lane}) "${name.slice(0, 60)}" -> Conductor`);
}
