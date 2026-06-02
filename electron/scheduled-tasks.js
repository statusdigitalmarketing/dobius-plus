/**
 * scheduled-tasks.js — Phase 5.
 *
 * Cron-style proactive tasks that fire synthetic iMessage commands into the
 * Voice Conductor without Sam asking. Lives in config.scheduledTasks[], all
 * disabled by default. Each task entry:
 *   {
 *     id: 'morning-brief',
 *     enabled: false,
 *     schedule: { type: 'daily', hour: 8, minute: 0 } | { type: 'interval', everyMinutes: 120, businessHoursOnly: true },
 *     prompt: 'Tell me yesterday's shipped commits + today's Asana queue',
 *     lastFiredAt: 0,
 *   }
 *
 * Architecture: ONE setInterval at the main process ticks every 60s. For each
 * enabled entry, evaluates "should this fire now" (via cron-ish math). If yes
 * and lastFiredAt was more than 5 minutes ago (debounce against drift), it
 * dispatches into the Conductor's tab using the SAME tagged input format the
 * iMessage bridge uses ([req-XXXX] prefix). The Conductor's reply lands back
 * in Sam's iMessage via the existing reply-callback pipeline.
 *
 * No new persistence — config.scheduledTasks is the source of truth; lastFiredAt
 * is updated via updateScheduledTask after each firing.
 */
import crypto from 'crypto';
import { loadConfig, saveConfig } from './config-manager.js';
import { writeTerminal } from './terminal-manager.js';
import { getVoiceConductorTabId } from './voice-conductor.js';
import { sendImessageToSelf } from './imessage-bridge.js';
import { subscribeReply } from './voice-bridge.js';

const TICK_MS = 60_000;             // check schedule once per minute
const FIRE_DEBOUNCE_MS = 5 * 60_000; // prevent double-fires from drift
const REPLY_TIMEOUT_MS = 90_000;    // mirror iMessage bridge

let timer = null;
let isFiring = false;

// --- Public API ----------------------------------------------------------

export function startScheduledTasks() {
  if (timer) return;
  // Seed defaults on first run if config has none.
  const cfg = loadConfig();
  if (!Array.isArray(cfg.scheduledTasks) || cfg.scheduledTasks.length === 0) {
    cfg.scheduledTasks = DEFAULTS.slice();
    saveConfig(cfg);
  }
  timer = setInterval(() => { void tick(); }, TICK_MS);
  console.log('[scheduled-tasks] started');
}

export function stopScheduledTasks() {
  if (timer) { clearInterval(timer); timer = null; }
}

export function listScheduledTasks() {
  const cfg = loadConfig();
  return Array.isArray(cfg.scheduledTasks) ? cfg.scheduledTasks : [];
}

export function updateScheduledTask(id, patch) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'id required' };
  const cfg = loadConfig();
  const list = Array.isArray(cfg.scheduledTasks) ? cfg.scheduledTasks.slice() : [];
  const idx = list.findIndex((t) => t.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  list[idx] = { ...list[idx], ...patch };
  cfg.scheduledTasks = list;
  saveConfig(cfg);
  return { ok: true, task: list[idx] };
}

// --- Defaults: all off, Sam enables what he wants -----------------------

const DEFAULTS = [
  {
    id: 'morning-brief',
    enabled: false,
    schedule: { type: 'daily', hour: 8, minute: 0 },
    prompt: 'Morning brief: what shipped yesterday, what is on today\'s Asana queue, anything stalled.',
    lastFiredAt: 0,
  },
  {
    id: 'end-of-day',
    enabled: false,
    schedule: { type: 'daily', hour: 18, minute: 0 },
    prompt: 'End-of-day report: shipped today, open work, tomorrow\'s queue.',
    lastFiredAt: 0,
  },
  {
    id: 'stalled-check',
    enabled: false,
    schedule: { type: 'interval', everyMinutes: 120, businessHoursOnly: true },
    prompt: 'Check for stalled work — any tracked tab idle 90+ minutes? Report which.',
    lastFiredAt: 0,
  },
];

// --- Tick + dispatch -----------------------------------------------------

async function tick() {
  if (isFiring) return;
  const tasks = listScheduledTasks();
  const due = tasks.filter((t) => t.enabled && shouldFire(t));
  if (due.length === 0) return;
  isFiring = true;
  try {
    for (const t of due) {
      await fireTask(t);
    }
  } catch (err) {
    console.warn(`[scheduled-tasks] tick error: ${err.message}`);
  } finally {
    isFiring = false;
  }
}

function shouldFire(task) {
  const now = Date.now();
  if (task.lastFiredAt && (now - task.lastFiredAt) < FIRE_DEBOUNCE_MS) return false;
  const s = task.schedule || {};
  if (s.type === 'daily') {
    const d = new Date(now);
    const hourOk = d.getHours() === (s.hour ?? -1);
    const minOk = Math.abs(d.getMinutes() - (s.minute ?? 0)) <= 1; // within a minute of target
    return hourOk && minOk;
  }
  if (s.type === 'interval') {
    if (s.businessHoursOnly) {
      const d = new Date(now);
      const h = d.getHours();
      const day = d.getDay();
      if (day === 0 || day === 6) return false;          // skip weekends
      if (h < 8 || h >= 19) return false;                 // 8am-7pm only
    }
    const intervalMs = (s.everyMinutes || 60) * 60_000;
    if (!task.lastFiredAt) return true;
    return (now - task.lastFiredAt) >= intervalMs;
  }
  return false;
}

async function fireTask(task) {
  const requestId = `req-sched-${crypto.randomBytes(4).toString('hex')}`;
  const conductorId = getVoiceConductorTabId();
  const tagged = `[${requestId}] ${task.prompt.replace(/[\r\n]+/g, ' ').slice(0, 2000)}`;
  console.log(`[scheduled-tasks] firing ${task.id} as ${requestId}`);
  updateScheduledTask(task.id, { lastFiredAt: Date.now() });
  // Subscribe BEFORE writing so we never miss a fast reply.
  const replyPromise = subscribeReply(requestId, REPLY_TIMEOUT_MS);
  const CHUNK = 256;
  for (let i = 0; i < tagged.length; i += CHUNK) {
    writeTerminal(conductorId, tagged.slice(i, i + CHUNK));
  }
  writeTerminal(conductorId, '\r');
  const reply = await replyPromise;
  if (reply?.message) {
    try { await sendImessageToSelf(`⏰ ${task.id}: ${reply.message}`.slice(0, 1000)); }
    catch (err) { console.warn(`[scheduled-tasks] iMessage send failed: ${err.message}`); }
  }
}
