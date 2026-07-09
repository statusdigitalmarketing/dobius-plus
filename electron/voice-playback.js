/**
 * voice-playback.js, v1.0.32.
 *
 * "Read out Claude's last response" TTS via the macOS `say` command.
 * Called from the TopBar Speak button. Resolves the active tab's linked
 * sessionId via sessionTabMap, loads the transcript, finds the LAST
 * assistant message, strips markdown/code fences, then spawns `say`
 * at the requested speed. A second call cancels the previous playback.
 *
 * The user asked for 1x / 1.5x / 2x speeds; macOS `say` uses words-per-
 * minute. Default is ~175. We map:
 *   1x   -> 175 wpm (natural)
 *   1.5x -> 260 wpm
 *   2x   -> 350 wpm
 */
import { spawn } from 'child_process';
import { getSessionTabMap } from './config-manager.js';
import { loadTranscript } from './data-service.js';

const SPEED_WPM = { '1x': 175, '1.5x': 260, '2x': 350 };
let current = null; // { child, tabId, startedAt }

/**
 * Strip markdown formatting + code blocks so `say` reads clean prose
 * instead of literal backticks and asterisks. Also caps the read length
 * so a runaway huge message doesn't lock up the speaker for 20 minutes.
 */
function textForSay(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw
    // Fenced code blocks: replaced by a short marker so the reader knows
    // "there was code here" without reading every backtick and symbol.
    .replace(/```[\s\S]*?```/g, ' [code block] ')
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Bold / italic markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Links: keep the text, drop the URL
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Headings: drop the leading #s
    .replace(/^#{1,6}\s+/gm, '')
    // Bullet markers
    .replace(/^\s*[-*+]\s+/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
  // Hard cap: 6000 chars is about 5-10 min at 350 wpm; more than enough
  // for any real Claude reply.
  const MAX = 6000;
  if (s.length > MAX) s = s.slice(0, MAX) + ' ... message truncated.';
  return s;
}

/**
 * Stop any in-flight `say` process.
 */
export function stopVoicePlayback() {
  if (current?.child) {
    try { current.child.kill('SIGTERM'); } catch { /* noop */ }
  }
  current = null;
  return { ok: true };
}

/**
 * Speak the last assistant response for the given tab.
 * Returns { ok, error, chars }.
 */
export async function speakLastResponse({ tabId, speed = '1x' } = {}) {
  if (!tabId || typeof tabId !== 'string') {
    return { ok: false, error: 'tabId required' };
  }
  const wpm = SPEED_WPM[speed] || SPEED_WPM['1x'];

  // Resolve sessionId from sessionTabMap. Pick the most recently captured
  // entry for this tabId (same logic Cmd+R uses).
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

  // Load the transcript. loadTranscript returns messages { role, content, timestamp }
  // capped by parseTranscriptFile's payload cap. Walk from the end for the last
  // assistant message.
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
  const text = textForSay(lastAssistant.content);
  if (!text) {
    return { ok: false, error: 'response has no readable text after stripping formatting' };
  }

  // Cancel any in-flight playback so a second click restarts fresh
  // (either the same tab at a new speed, or a different tab).
  stopVoicePlayback();

  const child = spawn('/usr/bin/say', ['-r', String(wpm)], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => { current = null; });
  child.on('close', () => { if (current?.child === child) current = null; });
  child.stdin.write(text);
  child.stdin.end();
  current = { child, tabId, startedAt: Date.now() };
  return { ok: true, chars: text.length, speed };
}

/**
 * Are we currently reading anything? Used by the button to switch icon
 * state between "Speak" and "Stop".
 */
export function isVoicePlaybackActive() {
  return !!(current?.child && !current.child.killed);
}
