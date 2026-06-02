/**
 * voice-conductor.js — auto-launch and lifecycle for the Voice Conductor.
 *
 * The Voice Conductor is a long-running Claude Opus session that lives in its
 * own background PTY. It receives voice transcripts (from /voice/intent on
 * the mobile server) as stdin, reasons about them, and dispatches via the
 * dobius-send CLI + standard Claude Code tools (Bash, MCP, etc).
 *
 * The PTY runs without an attached BrowserWindow — its output goes to the
 * rolling output buffer that mobile/voice subscribers can read. You can also
 * attach a desktop window to it later by listing terminals.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { createTerminal, writeTerminal, listTerminals, subscribeTerminal } from './terminal-manager.js';

const CONDUCTOR_TAB_ID = 'term-voice-conductor-1';
const CONDUCTOR_DIR = path.join(os.homedir(), 'dobius-voice-conductor');
const PROMPT_FILE = path.join(app.getPath('temp'), 'dobius-voice-conductor-prompt.txt');
// claude-opus-4-8 is the most recent Opus at time of writing; bump as new
// versions ship. The Conductor needs Opus-class reasoning to disambiguate
// fuzzy transcripts ("be to be portal" => "B2B Portal").
const CONDUCTOR_MODEL = 'claude-opus-4-8';

let launchedThisSession = false;
let cachedSystemPrompt = '';

/**
 * Return the tab id used for the Voice Conductor's PTY. Callers (mobile
 * server's /voice/intent handler) use this to know where to write transcripts.
 */
export function getVoiceConductorTabId() {
  return CONDUCTOR_TAB_ID;
}

/**
 * If the conductor PTY isn't already alive, spawn it and launch Claude inside
 * it with the conductor system prompt. Idempotent across reloads.
 */
export function ensureVoiceConductor(systemPrompt) {
  if (systemPrompt) cachedSystemPrompt = systemPrompt;
  // Already running this Dobius+ session? Done.
  if (listTerminals().some((t) => t.id === CONDUCTOR_TAB_ID)) return;

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

  // Subscribe so we get a callback if the PTY exits (claude crashed, user
  // killed it, etc.) — then auto-respawn after a short backoff. Capturing
  // unsubscribe and calling it before respawn is critical: without it, each
  // exit→respawn cycle leaves a stale onExit listener attached, and after N
  // cycles a single exit triggers N respawns at once.
  const sub = subscribeTerminal(CONDUCTOR_TAB_ID, {
    onExit: () => {
      try { sub.unsubscribe(); } catch { /* noop */ }
      console.log('[voice-conductor] PTY exited, will respawn in 3s');
      setTimeout(() => ensureVoiceConductor(), 3000);
    },
  });

  // Give the shell a beat to come up, then launch Claude. The Opus model
  // override gives the Conductor the brain it needs for ambiguous routing.
  setTimeout(() => {
    const safePromptPath = PROMPT_FILE.replace(/'/g, "'\\''");
    const cmd = `claude --system-prompt-file '${safePromptPath}' --model ${CONDUCTOR_MODEL}\r`;
    writeTerminal(CONDUCTOR_TAB_ID, cmd);
    launchedThisSession = true;
    console.log(`[voice-conductor] launched in tab ${CONDUCTOR_TAB_ID}`);
  }, 800);
}

/**
 * Has the conductor been launched in this Dobius+ session?
 */
export function isVoiceConductorLaunched() {
  return launchedThisSession;
}
