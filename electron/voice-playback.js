/**
 * voice-playback.js, v1.0.80.
 *
 * "Read out Claude's last response" TTS. Called from the TopBar Speak button.
 * Resolves the active tab's linked sessionId via sessionTabMap, loads the
 * transcript, finds the LAST assistant message, strips markdown/code fences,
 * then speaks it.
 *
 * Two engines, auto-selected by availability. Kokoro is preferred because it
 * sounds like a real person; macOS `say` is kept as a fallback so the Speak
 * button never silently breaks when the venv has not been set up:
 *
 *   kokoro (preferred): a Python venv at ~/.dobius-tts-venv/ with kokoro-onnx
 *     installed, running the scripts/kokoro-tts.py wrapper. Pipes 24 kHz
 *     mono PCM WAV to `afplay -` as it comes out of the model. Natural voice.
 *
 *   say (fallback): the macOS say command at the requested wpm. Robotic but
 *     always available, zero install, zero dependency.
 *
 * Speed is 1x / 1.5x / 2x in both engines. Kokoro's `--speed` is a direct
 * float; `say` uses words-per-minute (default is ~175 wpm, so 1x maps there).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { app } from 'electron';
import { getSessionTabMap } from './config-manager.js';
import { loadTranscript } from './data-service.js';

const SPEED_WPM = { '1x': 175, '1.5x': 260, '2x': 350 };
const SPEED_FLOAT = { '1x': 1.0, '1.5x': 1.5, '2x': 2.0 };

const VENV_PY = path.join(os.homedir(), '.dobius-tts-venv', 'bin', 'python');
// scripts/kokoro-tts.py sits beside this file's parent dir when running from
// source. Use fileURLToPath so a repo path containing spaces (e.g. the actual
// "Projects (Code)" directory this ships from) does not land here as %20.
// Packaging note: scripts/ needs an asarUnpack entry in electron-builder.yml
// because python reads the script from disk, not via Electron's asar reader.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOKORO_SCRIPT_SOURCE = path.join(__dirname, '..', 'scripts', 'kokoro-tts.py');
// When packaged, scripts/ lives under app.asar.unpacked (added below). Prefer
// the unpacked path if present so we don't try to spawn a script path that
// resolves inside app.asar (python cannot read from asar directly).
const UNPACKED_SCRIPTS = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'scripts', 'kokoro-tts.py');
const KOKORO_SCRIPT = fs.existsSync(UNPACKED_SCRIPTS) ? UNPACKED_SCRIPTS : KOKORO_SCRIPT_SOURCE;
const KOKORO_MODEL = path.join(os.homedir(), '.samknows', 'models', 'kokoro', 'kokoro-v1.0.onnx');
const KOKORO_VOICES = path.join(os.homedir(), '.samknows', 'models', 'kokoro', 'voices-v1.0.bin');
const AFPLAY = '/usr/bin/afplay';
const SAY = '/usr/bin/say';

let current = null; // { children: Child[], tabId, startedAt, engine }
// Track every scratch WAV we have on disk from active or recent runs so an
// app quit can purge them synchronously (Codex r3 P2-3); keyed by path so
// repeated adds dedupe and the normal close handler can also remove its own.
const liveScratchFiles = new Set();

function fileExists(p) {
  try { return fs.statSync(p).size >= 0; } catch { return false; }
}

/** Which engine will we use for a Speak press right now? Exported for the
 *  Settings view, which shows "Voice: Kokoro (af_bella)" vs "Voice: System (say)". */
export function activeEngine() {
  if (fileExists(VENV_PY) && fileExists(KOKORO_SCRIPT) && fileExists(KOKORO_MODEL) && fileExists(KOKORO_VOICES)) {
    return 'kokoro';
  }
  return 'say';
}

/**
 * Strip markdown formatting + code blocks so the TTS reads clean prose
 * instead of literal backticks and asterisks. Also caps the read length
 * so a runaway huge message doesn't lock up the speaker for 20 minutes.
 */
function textForTTS(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw
    .replace(/```[\s\S]*?```/g, ' [code block] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Hard cap: 6000 chars is about 5-10 min at 350 wpm with `say`, and about
  // 3-5 min with Kokoro. Enough for any real Claude reply.
  const MAX = 6000;
  if (s.length > MAX) s = s.slice(0, MAX) + ' ... message truncated.';
  return s;
}

function killAll(children) {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch { /* noop */ }
  }
}

/** Stop any in-flight playback (either engine). Kills both pipeline stages
 *  (python synth + afplay) if the Kokoro pipeline is mid-run; killing python
 *  mid-synth causes its close handler to see a non-zero exit and skip the
 *  play step without clearing a now-newer current. (Codex r2 P2-4) */
export function stopVoicePlayback() {
  if (current?.children) killAll(current.children);
  current = null;
  return { ok: true };
}

function spawnKokoroPipeline(text, speed) {
  // Sequential pipeline, NOT piped: afplay on macOS 26 does not accept `-`
  // for stdin. So:
  //   1. spawn python, pipe its stdout to a scratch WAV
  //   2. wait for BOTH python 'close' AND sink 'finish' before trusting the
  //      file size (Codex r3 P2-1: python exits before the fs write has
  //      necessarily flushed, so inspecting the file at py.close could see 0
  //      bytes)
  //   3. spawn afplay <scratch>
  //   4. on afplay close, delete the scratch file
  const scratch = path.join(os.tmpdir(), `dobius-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  liveScratchFiles.add(scratch);
  const py = spawn(VENV_PY, [KOKORO_SCRIPT, '--voice', 'af_bella', '--speed', String(SPEED_FLOAT[speed] || 1.0)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sink = fs.createWriteStream(scratch);
  py.stdout.pipe(sink);
  let pyErr = '';
  let sinkError = null;
  py.stderr.on('data', (b) => { pyErr = (pyErr + b.toString('utf8')).slice(-512); });
  py.on('error', () => {});
  py.stdin.on('error', () => {}); // EPIPE if we SIGTERM mid-write
  // Codex r3 P2-2: a sink error (ENOSPC, EACCES, etc.) unpipes the destination
  // and leaves python's stdout buffer unread, so python's final flush blocks
  // forever and 'close' never fires. Kill python explicitly on sink error.
  sink.on('error', (e) => {
    sinkError = e;
    try { py.kill('SIGTERM'); } catch { /* noop */ }
  });
  py.stdin.write(text);
  py.stdin.end();

  const children = [py];
  const cleanupScratch = () => {
    liveScratchFiles.delete(scratch);
    try { fs.unlinkSync(scratch); } catch { /* best effort */ }
  };

  let pyClosed = false;
  let sinkFinished = false;
  let pyExitCode = null;
  const onBothDone = () => {
    if (!(pyClosed && (sinkFinished || sinkError))) return;
    children.splice(children.indexOf(py), 1);
    if (sinkError || pyExitCode !== 0) {
      if (sinkError) console.warn(`[voice-playback] kokoro sink error: ${sinkError.code || sinkError.message}`);
      if (pyErr) console.warn(`[voice-playback] kokoro python exit ${pyExitCode}: ${pyErr.trim()}`);
      cleanupScratch();
      if (current?.children === children) current = null;
      return;
    }
    // If the user hit Stop while synth was running, our local children was
    // swapped out of current; skip play.
    if (current?.children !== children) { cleanupScratch(); return; }
    let sz = 0;
    try { sz = fs.statSync(scratch).size; } catch { /* missing */ }
    if (sz < 44) { // smaller than a WAV header
      console.warn(`[voice-playback] kokoro produced ${sz} bytes; falling back to say for this press`);
      cleanupScratch();
      current = null;
      const fb = spawnSayPipeline(text, speed);
      current = { children: fb, tabId: null, startedAt: Date.now(), engine: 'say' };
      return;
    }
    const player = spawn(AFPLAY, [scratch], { stdio: ['ignore', 'ignore', 'ignore'] });
    player.on('error', () => {});
    children.push(player);
    player.on('close', () => {
      children.splice(children.indexOf(player), 1);
      cleanupScratch();
      if (current?.children === children) current = null;
    });
  };

  py.on('close', (code) => { pyClosed = true; pyExitCode = code; onBothDone(); });
  sink.on('finish', () => { sinkFinished = true; onBothDone(); });

  return children;
}

function spawnSayPipeline(text, speed) {
  const wpm = SPEED_WPM[speed] || SPEED_WPM['1x'];
  const child = spawn(SAY, ['-r', String(wpm)], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {});
  child.stdin.write(text);
  child.stdin.end();
  const children = [child];
  child.on('close', () => { if (current?.children === children) current = null; });
  return children;
}

/**
 * Speak the last assistant response for the given tab.
 * Returns { ok, error, chars, engine }.
 */
export async function speakLastResponse({ tabId, speed = '1x' } = {}) {
  if (!tabId || typeof tabId !== 'string') {
    return { ok: false, error: 'tabId required' };
  }

  const map = getSessionTabMap() || {};
  let best = null;
  for (const [sid, entry] of Object.entries(map)) {
    if (entry?.tabId === tabId && (!best || (entry.capturedAt || 0) > best.capturedAt)) {
      best = { sessionId: sid, projectPath: entry.projectPath, capturedAt: entry.capturedAt || 0 };
    }
  }
  if (!best?.sessionId) {
    return { ok: false, error: 'no linked Claude session for this tab yet, resume one first' };
  }

  let messages;
  try {
    messages = await loadTranscript(best.sessionId, best.projectPath);
  } catch (err) {
    return { ok: false, error: `failed to load transcript: ${err.message}` };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'transcript is empty' };
  }
  let lastAssistant = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant' && messages[i].content) {
      lastAssistant = messages[i];
      break;
    }
  }
  if (!lastAssistant) {
    return { ok: false, error: 'no assistant response yet' };
  }
  const text = textForTTS(lastAssistant.content);
  if (!text) {
    return { ok: false, error: 'response has no readable text after stripping formatting' };
  }

  // Cancel any in-flight playback so a second click restarts fresh.
  stopVoicePlayback();

  const engine = activeEngine();
  const children = engine === 'kokoro'
    ? spawnKokoroPipeline(text, speed)
    : spawnSayPipeline(text, speed);
  current = { children, tabId, startedAt: Date.now(), engine };
  return { ok: true, chars: text.length, speed, engine };
}

/** Are we currently reading anything? Used by the button to switch icon
 *  state between "Speak" and "Stop". */
export function isVoicePlaybackActive() {
  if (!current?.children) return false;
  return current.children.some((c) => !c.killed && c.exitCode === null);
}

// Codex r3 P2-3: close handlers may not fire before Electron's app.exit, so
// also purge every known scratch file synchronously at will-quit.
try {
  app?.on?.('will-quit', () => {
    stopVoicePlayback();
    for (const p of liveScratchFiles) {
      try { fs.unlinkSync(p); } catch { /* best effort */ }
    }
    liveScratchFiles.clear();
  });
} catch { /* noop */ }
