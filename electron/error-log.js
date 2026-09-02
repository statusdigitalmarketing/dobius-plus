// Thorough runtime error logging (v1.0.65). Sam (8/24): "i wish it had like
// thorough error logging etc so you could fix things at least from my
// system." Everything diagnosable lands in ONE rolling file that a debugging
// session (human or Claude) can read from the live machine:
//
//   <userData>/logs/error.log      (current)
//   <userData>/logs/error.log.1    (previous rotation)
//
// Captured: main-process console.error/warn (which is how every module in
// this app reports trouble), uncaught exceptions + unhandled rejections
// (forwarded from crash logging, which keeps its exit-decision role),
// renderer console errors from EVERY window with url:line, renderer/child
// process crashes, and preload failures. Each line carries a timestamp and
// the app version, because "which version did this" is the first question.
//
// Deliberately NOT captured: terminal output, transcripts, tokens, or
// anything content-shaped. This is a fault log, not surveillance.

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const MAX_BYTES = 2 * 1024 * 1024; // rotate at 2MB; one rotation kept (~4MB cap)
const MAX_LINES_PER_MIN = 500;     // a crash loop must not eat the disk

let logDir = null;
let logFile = null;
let appVersion = '0.0.0';
let installed = false;

// Simple per-minute throttle so an error storm degrades to a note.
let windowStart = 0;
let windowCount = 0;
let throttledNoted = false;

/** Pure: one formatted log line. Multi-line details keep their newlines but
 * get a two-space continuation indent so entries stay visually grouped. */
export function formatLine(kind, detail, version = appVersion, ts = new Date()) {
  const body = String(detail ?? '').replace(/\r/g, '').split('\n').join('\n  ');
  return `[${ts.toISOString()}] [v${version}] ${kind}: ${body}\n`;
}

/** Pure: rotation decision. */
export function shouldRotate(sizeBytes) {
  return sizeBytes >= MAX_BYTES;
}

/** Pure-ish throttle check; exported for tests via injectable now. */
export function throttleCheck(state, now) {
  if (now - state.windowStart >= 60_000) {
    state.windowStart = now;
    state.windowCount = 0;
    state.throttledNoted = false;
  }
  state.windowCount += 1;
  if (state.windowCount <= MAX_LINES_PER_MIN) return 'write';
  if (!state.throttledNoted) {
    state.throttledNoted = true;
    return 'note';
  }
  return 'drop';
}

const throttleState = {
  get windowStart() { return windowStart; },
  set windowStart(v) { windowStart = v; },
  get windowCount() { return windowCount; },
  set windowCount(v) { windowCount = v; },
  get throttledNoted() { return throttledNoted; },
  set throttledNoted(v) { throttledNoted = v; },
};

function rotateIfNeeded() {
  try {
    const st = fs.statSync(logFile);
    if (shouldRotate(st.size)) {
      fs.renameSync(logFile, `${logFile}.1`); // clobbers the previous .1
    }
  } catch { /* no file yet */ }
}

// Fatal/crash/process-gone events must ALWAYS be recorded: a noisy renderer
// console loop could otherwise exhaust the per-minute budget right before the
// crash it was meant to preserve (Codex Medium). These kinds bypass the
// throttle (they are rare and are the whole point of the log).
const PRIORITY_RE = /^(crash\.|renderer\.gone|child\.gone|renderer\.preload-error)/;
export function isPriorityKind(kind) {
  return PRIORITY_RE.test(String(kind || ''));
}

/** Append one entry. Never throws; logging must never take the app down. */
export function logLine(kind, detail) {
  if (!logFile) return;
  try {
    if (isPriorityKind(kind)) {
      rotateIfNeeded();
      fs.appendFileSync(logFile, formatLine(kind, detail));
      return;
    }
    const verdict = throttleCheck(throttleState, Date.now());
    if (verdict === 'drop') return;
    rotateIfNeeded();
    if (verdict === 'note') {
      fs.appendFileSync(logFile, formatLine('error-log', `throttled: more than ${MAX_LINES_PER_MIN} entries this minute; dropping the rest of the minute`));
      return;
    }
    fs.appendFileSync(logFile, formatLine(kind, detail));
  } catch { /* never throw */ }
}

export function errorLogPath() {
  return logFile;
}

/**
 * Install all capture points. Call once, early in app startup.
 */
export function installErrorLog() {
  if (installed) return;
  installed = true;
  try {
    appVersion = app.getVersion();
    logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'error.log');
  } catch {
    return; // no dir, no logging; the app must still run
  }

  logLine('app', `started (electron ${process.versions.electron}, node ${process.versions.node})`);

  // Tee main-process console.error/warn: this is how every module here
  // reports trouble ([gws-accounts], [mobile-server], [data-service], ...).
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args) => {
    try { logLine('main.error', args.map(String).join(' ')); } catch { /* noop */ }
    origError(...args);
  };
  console.warn = (...args) => {
    try { logLine('main.warn', args.map(String).join(' ')); } catch { /* noop */ }
    origWarn(...args);
  };

  // Renderer coverage for EVERY window, present and future.
  app.on('web-contents-created', (_event, wc) => {
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      // Electron levels: 0 verbose, 1 info, 2 warning, 3 error.
      if (level >= 3) logLine('renderer.error', `${message} (${sourceId}:${line})`);
    });
    wc.on('render-process-gone', (_e, details) => {
      logLine('renderer.gone', `reason=${details?.reason} exitCode=${details?.exitCode}`);
    });
    wc.on('preload-error', (_e, preloadPath, error) => {
      logLine('renderer.preload-error', `${preloadPath}: ${error?.stack || error}`);
    });
    wc.on('unresponsive', () => logLine('renderer.unresponsive', wc.getURL?.() || ''));
  });

  app.on('child-process-gone', (_event, details) => {
    logLine('child.gone', `type=${details?.type} reason=${details?.reason} exitCode=${details?.exitCode}`);
  });
}
