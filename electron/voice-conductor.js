/**
 * voice-conductor.js: auto-launch and lifecycle for the Voice Conductor.
 *
 * The Voice Conductor is a long-running Claude Opus session that lives in its
 * own background PTY. It receives voice transcripts (from /voice/intent on
 * the mobile server) as stdin, reasons about them, and dispatches via the
 * dobius-send CLI + standard Claude Code tools (Bash, MCP, etc).
 *
 * MEMORY (v1.0.65, Sam 8/24 + crash-log analysis): a single claude session
 * left running for hours grows its V8 heap until it hits the ~4GB default cap
 * and aborts with FatalProcessOutOfMemory. 23 such crashes in 7 days, every
 * ~2h of uptime, and the memory pressure was taking the whole Mac down ("you
 * can't open the application because it is not responding", then a reboot).
 * Two defenses:
 *   1. It is OPT-IN now (config.settings.voiceConductorEnabled, default off).
 *      An always-on background Opus session nobody is using was pure downside.
 *   2. When on, it RECYCLES on a timer well under the crash cadence: a clean
 *      exit + respawn every RECYCLE_MS, so the heap is reclaimed long before
 *      the cap. Respawns are also bounded so a startup crash-loop cannot
 *      hammer.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { createTerminal, writeTerminal, listTerminals, subscribeTerminal, killTerminal } from './terminal-manager.js';

const CONDUCTOR_TAB_ID = 'term-voice-conductor-1';
const CONDUCTOR_DIR = path.join(os.homedir(), 'dobius-voice-conductor');
const PROMPT_FILE = path.join(app.getPath('temp'), 'dobius-voice-conductor-prompt.txt');
// claude-opus-4-8 is the most recent Opus at time of writing; bump as new
// versions ship. The Conductor needs Opus-class reasoning to disambiguate
// fuzzy transcripts ("be to be portal" into "B2B Portal").
const CONDUCTOR_MODEL = 'claude-opus-4-8';

// Recycle every 90 minutes: comfortably under the observed ~2h OOM cadence,
// so the session is torn down and rebuilt with a fresh heap before it can
// grow into the cap.
const RECYCLE_MS = 90 * 60 * 1000;
// A crashing session must not respawn forever. After this many exits inside
// the window, stop and let the recycle timer (or a restart) try later.
const MAX_RESPAWNS = 5;
const RESPAWN_WINDOW_MS = 5 * 60 * 1000;

let launchedThisSession = false;
let cachedSystemPrompt = '';
let recycleTimer = null;
let currentSub = null;
let respawnTimes = [];
let stoppedForCrashLoop = false;
// Generation token: bumped by stopVoiceConductor and recycle. Every DELAYED
// callback (respawn setTimeout, the 800ms launch write, the recycle respawn)
// captures the generation it was scheduled in and no-ops if the generation
// has moved on. Without this a toggle-off during a pending timer, or a
// rapid off/on, would spawn an unwanted session or write two claude launches
// into one PTY (Codex High + Medium).
let generation = 0;
let enabled = false;

/**
 * Return the tab id used for the Voice Conductor's PTY. Callers (mobile
 * server's /voice/intent handler) use this to know where to write transcripts.
 */
export function getVoiceConductorTabId() {
  return CONDUCTOR_TAB_ID;
}

/** Pure: given recent respawn timestamps + now, is this a crash loop? */
export function isCrashLooping(times, now, windowMs = RESPAWN_WINDOW_MS, max = MAX_RESPAWNS) {
  const recent = times.filter((t) => now - t < windowMs);
  return recent.length >= max;
}

function clearCurrentSub() {
  if (currentSub) { try { currentSub.unsubscribe(); } catch { /* noop */ } currentSub = null; }
}

function spawnConductor() {
  try {
    fs.mkdirSync(CONDUCTOR_DIR, { recursive: true });
  } catch (err) {
    console.warn(`[voice-conductor] could not create dir: ${err.message}`);
    return;
  }
  // Persist the system prompt so we can launch with --system-prompt-file
  // (Claude refuses to inline very long prompts on the command line cleanly).
  try {
    fs.writeFileSync(PROMPT_FILE, cachedSystemPrompt, 'utf8');
  } catch (err) {
    console.warn(`[voice-conductor] could not write prompt file: ${err.message}`);
    return;
  }
  try {
    createTerminal(CONDUCTOR_TAB_ID, CONDUCTOR_DIR, null);
  } catch (err) {
    console.warn(`[voice-conductor] createTerminal failed: ${err.message}`);
    return;
  }

  // Auto-respawn on unexpected exit (claude crashed / OOM'd / user killed),
  // bounded so a startup crash-loop cannot hammer. Unsubscribing before the
  // respawn is critical: without it each cycle leaks a listener and after N
  // cycles one exit fires N respawns at once.
  clearCurrentSub();
  currentSub = subscribeTerminal(CONDUCTOR_TAB_ID, {
    onExit: () => {
      clearCurrentSub();
      const now = Date.now();
      respawnTimes = respawnTimes.filter((t) => now - t < RESPAWN_WINDOW_MS);
      respawnTimes.push(now);
      if (isCrashLooping(respawnTimes, now)) {
        stoppedForCrashLoop = true;
        console.warn(`[voice-conductor] ${MAX_RESPAWNS} exits in ${RESPAWN_WINDOW_MS / 60000}min; stopping respawns until the next recycle`);
        return;
      }
      console.log('[voice-conductor] PTY exited, respawning in 3s');
      const gen = generation;
      setTimeout(() => {
        if (gen !== generation || !enabled) return; // toggled off / recycled since
        if (!listTerminals().some((t) => t.id === CONDUCTOR_TAB_ID)) spawnConductor();
      }, 3000);
    },
  });

  // Give the shell a beat to come up, then launch Claude. Guard the delayed
  // write against a toggle-off or a newer generation, or a stale timer would
  // write a claude launch into a PTY that was stopped or reused (Codex).
  const gen = generation;
  setTimeout(() => {
    if (gen !== generation || !enabled) return;
    if (!listTerminals().some((t) => t.id === CONDUCTOR_TAB_ID)) return;
    const safePromptPath = PROMPT_FILE.replace(/'/g, "'\\''");
    const cmd = `claude --system-prompt-file '${safePromptPath}' --model ${CONDUCTOR_MODEL}\r`;
    writeTerminal(CONDUCTOR_TAB_ID, cmd);
    launchedThisSession = true;
    console.log(`[voice-conductor] launched in tab ${CONDUCTOR_TAB_ID}`);
  }, 800);
}

/**
 * Proactive recycle: cleanly exit the current session and start a fresh one,
 * reclaiming the heap before it approaches the OOM cap. A recycle also resets
 * the crash-loop breaker, so a session that had been stopped gets another try.
 */
function recycleConductor() {
  if (!enabled) return;
  console.log('[voice-conductor] scheduled recycle (heap hygiene)');
  respawnTimes = [];
  stoppedForCrashLoop = false;
  clearCurrentSub(); // do NOT let the exit handler respawn; we respawn ourselves
  generation += 1; // invalidate any in-flight respawn/launch timers
  const gen = generation;
  try { killTerminal(CONDUCTOR_TAB_ID); } catch { /* may already be gone */ }
  setTimeout(() => { if (gen === generation && enabled) spawnConductor(); }, 1500);
}

/**
 * If the conductor PTY isn't already alive, spawn it and launch Claude inside
 * it with the conductor system prompt. Idempotent across reloads. Also arms
 * the recycle timer (once).
 */
export function ensureVoiceConductor(systemPrompt) {
  if (systemPrompt) cachedSystemPrompt = systemPrompt;
  enabled = true;
  if (listTerminals().some((t) => t.id === CONDUCTOR_TAB_ID)) return;
  spawnConductor();
  if (!recycleTimer) {
    recycleTimer = setInterval(recycleConductor, RECYCLE_MS);
    if (recycleTimer.unref) recycleTimer.unref(); // never keep the app alive for this
  }
}

/** Stop the conductor and disarm its timers (Settings toggle to off, quit). */
export function stopVoiceConductor() {
  enabled = false;
  generation += 1; // any pending respawn/launch/recycle timer now no-ops
  if (recycleTimer) { clearInterval(recycleTimer); recycleTimer = null; }
  clearCurrentSub();
  respawnTimes = [];
  stoppedForCrashLoop = false;
  try { killTerminal(CONDUCTOR_TAB_ID); } catch { /* may already be gone */ }
}

/**
 * Has the conductor been launched in this Dobius+ session?
 */
export function isVoiceConductorLaunched() {
  return launchedThisSession;
}
