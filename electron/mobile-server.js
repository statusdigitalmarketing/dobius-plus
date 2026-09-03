/**
 * Mobile server: embedded HTTP + WebSocket server that bridges Dobius+ to a
 * phone PWA over the user's Tailscale tailnet.
 *
 * Phase 1: server lifecycle, Tailscale-only binding, and the pairing flow.
 * The terminal bridge protocol is added in Phase 2.
 *
 * Security model:
 *  - Binds ONLY to the Mac's tailnet IP (100.64.0.0/10), never 0.0.0.0 or LAN.
 *    If there's no tailnet address the server refuses to start.
 *  - A phone pairs once with an ephemeral 6-digit code, then receives a
 *    long-lived device token. The token is required on every WebSocket connect.
 *  - The pairing code is brute-force-limited: 5 bad attempts invalidate it
 *    until the user regenerates it from the desktop.
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { app, powerSaveBlocker } from 'electron';
import { getMobileServerConfig, updateMobileServerConfig, setSessionTabLink, removePushSubscriptionsByToken, getSessionTabMap, getAllProjectsWithTabs, loadConfig } from './config-manager.js';
import {
  listTerminals, subscribeTerminal, writeTerminal, terminalHasDesktopAttached,
  resizeTerminal, killTerminal, createTerminal, getTerminalBuffer,
  liveClaudeSessionIds, claimSessionResume, bindReservationTab, releaseSessionResume,
  addTerminalObserver,
} from './terminal-manager.js';
import { parseSelector, parseSelectorFromScreen, stripAnsi, spinnerVerb } from './selector-parser.js';
import { renderScreenLines } from './screen-render.js';
import { loadAllSessions, loadTranscript, listProjects, getTranscriptSig, findLooseEnds, loadSkills } from './data-service.js';
import { peekReply } from './voice-bridge.js';
import { getVoiceConductorTabId } from './voice-conductor.js';
import { snapshot as terminalStatusSnapshot } from './terminal-status.js';
import { estimateContextForTabId } from './tab-context.js';
import { getMagicDNSName, certPathsFor, hasCertFor } from './tailscale.js';
import { transcribeAudio, transcribeAvailable } from './voice-transcribe.js';
import { getVapidPublicKey, subscribePush, sendPush, hasPushSubscribers } from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The live selector for a tab, via the headless-xterm SCREEN render (v1.0.62).
// The old strip-and-regex path missed Ink's incremental repaints entirely: on
// a multi-question AskUserQuestion, question two never formed complete lines
// in a linear strip, so its popup never appeared on the phone (Sam, 8/14).
// The emulator's verdict is authoritative when it renders (including "no
// selector": it honors the erase sequences that REMOVE answered prompts, so
// it also kills the stale-popup class); the regex path remains only for a
// render failure.
async function liveSelectorForTab(id) {
  const raw = getTerminalBuffer(id) || '';
  const lines = await renderScreenLines(raw.slice(-262144));
  if (lines) return parseSelectorFromScreen(lines);
  return parseSelector(raw);
}

// Push selector popups the moment they appear instead of waiting out the
// phone's 2.5s poll (Sam, 8/16: "did you get rid of the poll latency?").
// A dialog waiting for input is exactly "output went quiet", so a trailing
// debounce on each tab's PTY output fires ~350ms after the drawing stops,
// renders the screen once, and pushes the popup (or its disappearance) to
// every socket authorized for that tab. During continuous streaming the
// timer keeps deferring, so generation costs no renders at all. The client
// poll stays as the reconnect/fallback path.
const SELECTOR_PUSH_QUIET_MS = 350;
const selectorWatch = new Map(); // tabId -> { timer, lastPushedJson }
// Push only for tabs someone is ACTIVELY looking at: an open chat probes
// selectorSnapshot every 2.5s, so fresh interest means an open popup surface.
// Gating on this (not on _authedTabs, which accumulates every tab a socket
// ever touched) keeps N background tabs from queueing render storms through
// the serialized emulator and delaying the active tab (Codex Medium).
const SELECTOR_INTEREST_MS = 10_000;
const selectorInterest = new Map(); // tabId -> last selectorSnapshot epoch ms
let selectorObserverOff = null;

function noteSelectorInterest(id) {
  selectorInterest.set(id, Date.now());
  if (selectorInterest.size > 64) {
    const cutoff = Date.now() - 60_000;
    for (const [k, at] of selectorInterest) { if (at < cutoff) selectorInterest.delete(k); }
    // Still over cap (65+ tabs probed inside 60s): evict oldest-first so the
    // bound is HARD, not advisory (Codex round 2).
    if (selectorInterest.size > 64) {
      const oldestFirst = [...selectorInterest.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of oldestFirst.slice(0, selectorInterest.size - 64)) selectorInterest.delete(k);
    }
  }
}

// A mobile-originated keystroke invalidates the dedupe: the phone clears its
// popup optimistically on tap, so if Claude redraws the IDENTICAL dialog next,
// the "same state already pushed" shortcut would leave the phone cleared until
// its fallback poll (Codex Medium).
function invalidateSelectorPush(id) {
  const w = selectorWatch.get(id);
  if (w) w.lastPushedJson = null;
}

function socketsForTab(id) {
  const out = [];
  // activeSocketsByToken only ever holds sockets that passed auth, so
  // membership IS the authed marker.
  for (const sockets of activeSocketsByToken.values()) {
    for (const s of sockets) {
      if (s.readyState === 1 && s._authedTabs?.has(id)) out.push(s);
    }
  }
  return out;
}

function scheduleSelectorPush(id) {
  const at = selectorInterest.get(id);
  if (!at || Date.now() - at > SELECTOR_INTEREST_MS) return; // no open popup surface
  if (socketsForTab(id).length === 0) return; // nobody is watching this tab
  let w = selectorWatch.get(id);
  if (!w) { w = { timer: null, lastPushedJson: null }; selectorWatch.set(id, w); }
  clearTimeout(w.timer);
  w.timer = setTimeout(async () => {
    w.timer = null;
    const targets = socketsForTab(id);
    if (targets.length === 0) return;
    let sel;
    try { sel = await liveSelectorForTab(id); } catch { sel = null; }
    const j = JSON.stringify(sel || null);
    if (j === w.lastPushedJson) return; // same popup state already pushed
    w.lastPushedJson = j;
    for (const s of targets) wsSend(s, { type: 'selector', id, selector: sel || null });
  }, SELECTOR_PUSH_QUIET_MS);
}

function dropSelectorWatch(id) {
  const w = selectorWatch.get(id);
  if (w) { clearTimeout(w.timer); selectorWatch.delete(id); }
}

const MAX_PAIR_ATTEMPTS = 5;
const PAIR_LOCK_MS = 60000;  // cooldown after MAX_PAIR_ATTEMPTS, then re-arm
const AUTH_TIMEOUT_MS = 5000;
const MAX_INPUT_BYTES = 100 * 1024;   // cap a single input message (paste)
const MAX_WS_PAYLOAD = 1024 * 1024;   // 1MB ws frame ceiling
const MAX_WS_BUFFERED = 8 * 1024 * 1024; // drop a socket whose send buffer exceeds 8MB (dead/half-open phone)
const HEARTBEAT_MS = 30000;           // ping every 30s; a client that misses a pong is terminated
// whisper + ffmpeg are CPU-heavy; only run a couple at once so a retry loop or a
// burst of uploads can't stack processes and starve the Mac. Audit HIGH-4.
const MAX_VOICE_INFLIGHT = 2;

let httpServer = null;
let wss = null;
let pairingCode = null;   // ephemeral, regenerated on each start
let pairAttempts = 0;
let pairLockedUntil = 0;  // epoch ms; refuse pairing until then after a flood
let voiceInFlight = 0;    // concurrent /voice/audio transcriptions

// Power assertion (v1.0.43 resilience): while the mobile server is up, keep the
// Mac from suspending so a phone away from home does not lose the link to a
// sleeping Mac. `prevent-app-suspension` keeps CPU/network alive but still lets
// the DISPLAY sleep (this is a headless-remote scenario). Highest-leverage
// disconnect fix (REMOTE-CONTROL-PLAN resilience section).
let powerBlockerId = null;
function startPowerAssertion() {
  try {
    if (powerBlockerId === null || !powerSaveBlocker.isStarted(powerBlockerId)) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } catch (e) {
    console.warn('[mobile-server] powerSaveBlocker start failed:', e?.message || e);
    powerBlockerId = null;
  }
}
function stopPowerAssertion() {
  try {
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
  } catch { /* best effort */ }
  powerBlockerId = null;
}
let boundAddress = null;  // { host, port }
let serveInfo = null;     // { secure, url }: how clients should reach us (v1.0.43 Phase 4)

/** Find the Mac's Tailscale (CGNAT 100.64.0.0/10) IPv4 address, or null. */
function getTailnetIp() {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) {
        const [o1, o2] = a.address.split('.').map(Number);
        if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
      }
    }
  }
  return null;
}

function genPairingCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function knownToken(token) {
  if (!token || typeof token !== 'string') return false;
  return getMobileServerConfig().devices.some((d) => d.token === token);
}

// Compute the public-facing opaque deviceId for a device. Stored deviceId
// wins (post-v1.0.28 devices). Legacy entries without one get a deterministic
// SHA-256-derived id so the UI/removal path agrees with listDevices on the
// same value. Single source of truth: BOTH listDevices AND removeMobileDevice
// must use this helper or removal silently no-ops on legacy entries.
// Codex v1.0.28 round-1 HIGH.
export function deriveDeviceId(device) {
  if (device?.deviceId) return device.deviceId;
  if (!device?.token) return null;
  return `legacy-${crypto.createHash('sha256').update(device.token).digest('hex').slice(0, 16)}`;
}

// Active authenticated WebSocket sessions, keyed by token, so removeMobileDevice
// can forcibly close every live socket for a revoked device instead of leaving
// pre-revocation connections authorized until they disconnect on their own.
// Codex v1.0.28 HIGH (mobile-server.js:400).
const activeSocketsByToken = new Map(); // token -> Set<WebSocket>

/** Send a JSON message on a WebSocket if it's still open. */
function wsSend(socket, obj) {
  if (socket.readyState !== 1) return;
  // Backpressure: a half-open phone (network dropped, socket still OPEN) never
  // drains, so PTY output would queue in main-process memory unbounded. Once the
  // send buffer exceeds the cap, terminate the socket instead of buffering more.
  // Audit Medium (cost-reliability).
  if (socket.bufferedAmount > MAX_WS_BUFFERED) {
    try { socket.terminate(); } catch { /* noop */ }
    return;
  }
  try { socket.send(JSON.stringify(obj)); } catch { /* noop */ }
}

/**
 * Handle a message from an authenticated phone client. The terminal bridge:
 * the phone attaches to live PTYs, streams their output, and writes input
 * back to the same shells the desktop uses.
 *
 * Access policy: input/resize/kill require the socket to have first interacted
 * with the terminal id (attach, createTerminal, or a Chat-view loadTranscript /
 * selectorSnapshot for that tab), tracked in socket._authedTabs. A paired but
 * leaked/stale token therefore can't blind-write to or kill a terminal in a
 * project it never touched. Audit Medium (security).
 */
// Parse a terminal id into a friendly project + tab label (mirrors the mobile
// Terminal.jsx parser and terminal-status.projectFromId).
// The USER'S tab labels (renames like "Email" / "refund commish") live in
// config.projects[*].tabs, not in the terminal id. Id-derived "Tab <counter>"
// made every renamed tab unrecognizable on the phone, which read as "my tabs
// aren't popping up" (Asana 1217257328849820: all six desktop tabs WERE
// listed, as Tab 104/109/...). Map tab id -> persisted label; callers fall
// back to the id-derived label when a tab has no (or a blank) rename.
function configTabLabels() {
  const labelByTabId = new Map();
  const take = (id, label) => {
    if (typeof id === 'string' && typeof label === 'string' && label.trim()) labelByTabId.set(id, label);
  };
  try {
    for (const proj of getAllProjectsWithTabs()) {
      for (const tab of (Array.isArray(proj.tabs) ? proj.tabs : [])) take(tab?.id, tab?.label);
    }
    // Tabs living in TEAR-OFF windows are absent from config.projects[*].tabs:
    // their labels come from the tear-off tab bucket (when present) and from
    // lastTearOffs (the torn tab's label survives there even without a bucket).
    const cfg = loadConfig();
    for (const st of Object.values(cfg?.tearOffWindows || {})) {
      for (const tab of (Array.isArray(st?.tabs) ? st.tabs : [])) take(tab?.id, tab?.label);
    }
    for (const t of (Array.isArray(cfg?.lastTearOffs) ? cfg.lastTearOffs : [])) {
      if (!labelByTabId.has(t?.tabId)) take(t?.tabId, t?.label);
    }
  } catch { /* config unavailable; id-derived labels still work */ }
  return labelByTabId;
}

// Chrome that only Claude Code's interactive TUI draws at the bottom of the
// screen. Presence in the PTY tail means a Claude is LIVE in that tab right
// now, independent of whether a session link exists in config.
// Distinctive footer strings Claude draws while its TUI owns the screen. Kept
// tight on purpose: a FALSE positive hides the Start/Resume launcher on a
// genuinely sessionless tab, which is the v1.0.51 dead end returning. The
// shortcuts/mode hints are LINE-ANCHORED (Claude renders them as their own
// footer row) so ordinary prose like "press ? for shortcuts" or "see docs for
// shortcuts" scrolling past in a shell cannot trip them (Codex, Medium).
const CLAUDE_TUI_RE = new RegExp([
  'esc to interrupt',
  'shift\\+tab to cycle',
  'Press up to edit queued messages',
  '^\\s*\\? for shortcuts',
  '^\\s*(?:>>\\s*)?(?:auto-accept edits|bypass permissions|plan mode) on\\b',
].join('|'), 'im');

/**
 * Is a Claude TUI on screen in this tab? Cheap tail sniff (last ~4KB of the
 * rolling buffer, stripped). Brett's v1.0.56 report: the phone decided a tab
 * was "sessionless" purely from the session link, and when that link was
 * missing/stale it showed the Start/Resume launcher over a RUNNING Claude, so
 * tapping Resume typed `claude --continue` into Claude's own prompt box.
 * Never trust the link alone: the PTY is the ground truth.
 */
// A returned shell prompt as the LAST thing on screen. Claude's TUI keeps its
// input box + footer pinned to the bottom, so a trailing prompt means the
// shell has control even if Claude chrome scrolled past above (Codex round 2:
// `claude --help`, a pager showing Claude docs, or catting this repo's source
// would otherwise read as live and hide the launcher).
// Prompt SHAPE, not just a trailing symbol: it must carry a host/path marker
// (@, ~ or /) as well. Testing only the final character false-negatived a live
// Claude whose own bottom line ended in `$` (e.g. an `echo $` in its input
// box), which would put the launcher back over a running session (Codex
// round 3, Medium). Matches "bigfuckingdog@Mac dobius-plus % ".
//
// Accepted residual (Codex round 4, Medium): a LIVE Claude whose bottom line
// both carries a path marker and ends in a shell symbol ("cd ~/project $")
// still reads as a returned prompt, so the launcher can reappear over it.
// Tightening further (demanding a user@host shape) would false-negative real
// prompts on other shell configs, and the failure is bounded: it needs an
// unlinked session AND that exact bottom line, and the worst outcome is text
// landing in Claude's input box, which is where v1.0.56 put it unconditionally.
const SHELL_PROMPT_TAIL_RE = /[@~/][^\s]*.*[%$#]\s*$/;

export function claudeTuiPresent(text) {
  // STRIP FIRST, then window. Slicing raw bytes and stripping after left only
  // a line or two of visible text on a repainting TUI (a single Claude frame
  // is many KB of escapes), so the footer fell outside the window and a
  // plainly-running Claude read as dead. Caught in the live harness, not by
  // the plain-text unit tests. The raw cap bounds the per-tick strip cost.
  const tail = stripAnsi(String(text || '').slice(-262144)).slice(-4096);
  if (!CLAUDE_TUI_RE.test(tail)) return false;
  const lines = tail.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const last = lines[lines.length - 1] || '';
  return !SHELL_PROMPT_TAIL_RE.test(last);
}

function claudeIsLive(id) {
  try {
    return claudeTuiPresent(getTerminalBuffer(id));
  } catch { return false; }
}

function parseTermLabel(id, cwd) {
  const m = typeof id === 'string' && id.match(/^term-(.+)-(\d+)$/);
  if (m && m[1] !== 'mobile') {
    // Extra primary windows encode their windowKey as `<path>~w-<8>` (v1.0.66,
    // Brett: ~4 windows on one folder). Right-anchor on the fixed marker so a
    // `~` inside a real folder name is never mistaken for it. Split it out so
    // all of a project's windows GROUP under the real project on the phone,
    // each tab labelled with its window so they stay distinguishable.
    const extra = id.match(/^term-(.+)~(w-[a-z0-9]{8})-(\d+)$/);
    const projectPath = extra ? extra[1] : m[1];
    const windowTag = extra ? extra[2].slice(2) : '';
    const num = extra ? extra[3] : m[2];
    const label = windowTag ? `Tab ${num} (win ${windowTag.slice(0, 4)})` : `Tab ${num}`;
    return { projectPath, projectName: projectPath.split('/').filter(Boolean).pop() || projectPath, label };
  }
  const projectPath = cwd || 'mobile';
  return { projectPath, projectName: projectPath.split('/').filter(Boolean).pop() || 'mobile', label: 'new' };
}

// Per-tab context (model + ctx%) cache, refreshed on a slow debounce because it
// is transcript-file derived, not PTY-evented. v1.0.43 Phase 3b.
const tabContextCache = new Map(); // id -> { model, ctxPct }
let contextRefreshTimer = null;
async function refreshTabContexts() {
  try {
    const live = listTerminals();
    const liveIds = new Set(live.map((t) => t.id));
    for (const id of [...tabContextCache.keys()]) {
      if (!liveIds.has(id)) tabContextCache.delete(id);
    }
    for (const t of live) {
      const ctx = await estimateContextForTabId(t.id);
      if (ctx && ctx.maxTokens > 0) {
        tabContextCache.set(t.id, {
          model: shortModel(ctx.model),
          ctxPct: Math.min(100, Math.round((ctx.tokens / ctx.maxTokens) * 100)),
        });
      } else {
        tabContextCache.delete(t.id);
      }
    }
  } catch { /* best effort */ }
}

// Short, human model label (claude-opus-4-8 -> "opus", claude-sonnet-5 -> "sonnet").
function shortModel(model) {
  if (typeof model !== 'string') return '';
  const m = model.match(/(opus|sonnet|haiku|fable)/i);
  return m ? m[1].toLowerCase() : '';
}

// The status-rich terminals payload for the mobile board: live terminals merged
// with the main-process status authority + the context cache + the recent-exit
// cache. v1.0.43.
function buildTerminalsPayload() {
  const snap = terminalStatusSnapshot();
  // Reverse the session<->tab map (cheap, sync) so each tab carries its linked
  // session. The mobile Chat view loads that session's transcript to show a
  // responsive conversation instead of the width-locked raw terminal mirror.
  const tabMap = getSessionTabMap() || {};
  const sessionByTab = new Map();
  for (const [sid, link] of Object.entries(tabMap)) {
    if (!link || typeof link !== 'object' || !link.tabId) continue;
    const at = link.lastRunningAt || link.capturedAt || 0;
    const prev = sessionByTab.get(link.tabId);
    if (!prev || at >= prev.at) sessionByTab.set(link.tabId, { sessionId: sid, projectPath: link.projectPath, at });
  }
  const labelByTabId = configTabLabels();
  const list = listTerminals().map((t) => {
    const meta = parseTermLabel(t.id, t.cwd);
    const st = snap.live[t.id];
    const ctx = tabContextCache.get(t.id);
    const link = sessionByTab.get(t.id);
    return {
      id: t.id,
      pid: t.pid,
      cwd: t.cwd,
      projectPath: meta.projectPath,
      projectName: meta.projectName,
      label: labelByTabId.get(t.id) || meta.label,
      status: st?.status || 'idle',
      // The spinner's whimsical gerund ("Flibbertigibbeting"), Sam-requested:
      // it is the most alive thing on the desktop screen and the phone showed
      // a flat "working" instead. Only read for tabs that are actually
      // working; one strip of a 4KB tail per working tab per push is cheap.
      verb: st?.status === 'working' ? spinnerVerb(getTerminalBuffer(t.id)) : '',
      lastActivityAt: st?.lastActivityAt || 0,
      model: ctx?.model || '',
      ctxPct: typeof ctx?.ctxPct === 'number' ? ctx.ctxPct : null,
      sessionId: link?.sessionId || null,
      // Ground truth from the PTY, not from the session link (Brett v1.0.56).
      claudeLive: claudeIsLive(t.id),
      sessionProject: link?.projectPath || null,
    };
  });
  return { type: 'terminals', list, recentExits: snap.recentExits };
}

// A signature capturing what the BOARD cares about (which tabs exist, their
// status, recent exits) but NOT lastActivityAt, so an actively-printing tab
// does not trigger a push every second. We only push when this changes.
// Codex remote-plan #2 (send deltas only when serialized status changes).
function terminalsSignature(payload) {
  // Bucket ctx% to 5% so a slowly-growing context does not push every refresh,
  // but a meaningful move (and model changes) still updates the ring.
  const tabs = payload.list
    .map((t) => `${t.id}:${t.label}:${t.status}:${t.verb}:${t.model}:${t.sessionId || ''}:${t.claudeLive ? 1 : 0}:${t.ctxPct == null ? '' : Math.round(t.ctxPct / 5)}`)
    .sort().join('|');
  const exits = payload.recentExits.map((e) => `${e.id}:${e.exitCode}:${e.at}`).join('|');
  return `${tabs}#${exits}`;
}

let statusBroadcastTimer = null;
let heartbeatTimer = null;
let lastTerminalsSig = null;
const prevStatusById = new Map(); // id -> last status, for push transitions
const notifiedExits = new Set();  // `${id}:${at}` already push-notified
const NOTIFIED_EXITS_CAP = 200;   // > MAX_RECENT_EXITS (50) so cached exits never evict

// Fire push notifications for the moments worth pulling Sam back: a session
// starts needing input, or a session exits nonzero. Runs even with no phone
// connected (that is the point of push), but only when there are subscribers.
// v1.0.43 Phase 5b.
function firePushForEvents(payload) {
  if (!hasPushSubscribers()) {
    // Still track state so we don't blast a backlog the moment someone subscribes.
    for (const t of payload.list) prevStatusById.set(t.id, t.status);
    return;
  }
  const seen = new Set();
  for (const t of payload.list) {
    seen.add(t.id);
    const prev = prevStatusById.get(t.id);
    if (t.status === 'needs' && prev !== 'needs') {
      // url carries ?open=<id> so tapping the notification deep-links straight to
      // the session that needs input, not just whatever screen was last open.
      // Audit MED-12.
      sendPush({
        title: t.projectName || 'Dobius+',
        body: `${t.label} needs your input`,
        tag: `needs:${t.id}`,
        url: `./?open=${encodeURIComponent(t.id)}`,
      });
    } else if (t.status === 'done' && prev === 'working') {
      // Finished-a-turn push (Sam's v1.0.53 ask). Only on the working->done
      // transition (hook-driven), and tagged per tab so rapid turns replace
      // the previous banner instead of stacking.
      sendPush({
        title: t.projectName || 'Dobius+',
        body: `${t.label} finished its turn`,
        tag: `done:${t.id}`,
        url: `./?open=${encodeURIComponent(t.id)}`,
      });
    }
    prevStatusById.set(t.id, t.status);
  }
  for (const id of [...prevStatusById.keys()]) if (!seen.has(id)) prevStatusById.delete(id);
  for (const e of payload.recentExits) {
    if (typeof e.exitCode === 'number' && e.exitCode !== 0) {
      const key = `${e.id}:${e.at}`;
      if (!notifiedExits.has(key)) {
        notifiedExits.add(key);
        sendPush({ title: e.projectName || 'Dobius+', body: `session failed (exit ${e.exitCode})`, tag: `exit:${key}` });
      }
    }
  }
  // Bound notifiedExits WITHOUT dropping keys still present in recentExits: a
  // full .clear() emptied the dedup set while terminal-status.recentExits (a
  // 50-entry FIFO) still held those exits, so the next tick re-fired up to 50
  // duplicate "session failed" pushes. Set is insertion-ordered, so evict oldest
  // first and keep a window well above MAX_RECENT_EXITS (50), which guarantees
  // the still-cached exits are never among the evicted. Audit MED-7.
  while (notifiedExits.size > NOTIFIED_EXITS_CAP) {
    notifiedExits.delete(notifiedExits.values().next().value);
  }
}

// Seed the push dedup state from the CURRENT status snapshot so a server
// (re)start does not re-notify sessions that already need input or already
// exited. prevStatusById/notifiedExits are cleared on stop, but
// terminal-status.recentExits (module-level, 50-entry FIFO) survives, so without
// this the first tick after a restart (bind-mode change, cert provision) blasted
// stale "session failed" + "needs input" pushes. Audit MED-6.
function seedPushBaseline() {
  const payload = buildTerminalsPayload();
  prevStatusById.clear();
  notifiedExits.clear();
  for (const t of payload.list) prevStatusById.set(t.id, t.status);
  for (const e of payload.recentExits) {
    if (typeof e.exitCode === 'number' && e.exitCode !== 0) notifiedExits.add(`${e.id}:${e.at}`);
  }
}

function pollStatusTick() {
  const payload = buildTerminalsPayload();
  // Push events fire regardless of connected sockets (phone may be closed).
  try { firePushForEvents(payload); } catch { /* best effort */ }
  // WS broadcast only when a phone is connected and the board-relevant state moved.
  if (activeSocketsByToken.size === 0) return;
  const sig = terminalsSignature(payload);
  if (sig === lastTerminalsSig) return;
  lastTerminalsSig = sig;
  for (const set of activeSocketsByToken.values()) {
    for (const s of set) { try { wsSend(s, payload); } catch { /* dropped socket */ } }
  }
}

// Known projects the phone may spawn a terminal in: manual + session-bearing
// projects (via listProjects().decodedPath). Used for the picker AND as the
// createTerminal allowlist, so a paired token cannot spawn a shell in an
// arbitrary cwd. Codex remote-plan #5.
async function knownProjectList() {
  try {
    const projs = await listProjects();
    return (projs || [])
      .map((p) => p.decodedPath)
      .filter((pth) => typeof pth === 'string' && pth)
      .map((pth) => ({ path: pth, name: pth.split('/').filter(Boolean).pop() || pth }));
  } catch {
    return [];
  }
}
async function isKnownProjectPath(pth) {
  if (typeof pth !== 'string' || !pth) return false;
  return (await knownProjectList()).some((p) => p.path === pth);
}

// The ONLY non-path cwd values that map to the home dir: the desktop main tab
// and phone-tab sentinels (and empty = no project). Everything else that is not
// a known absolute project path is rejected, so `.`, `~`, `foo`, etc. cannot
// get a home shell. Codex Phase 3a P2 (tightened from "any non-absolute").
const HOME_SENTINELS = new Set(['', 'main', 'mobile']);
async function resolveCreateCwd(cwd) {
  const v = typeof cwd === 'string' ? cwd : '';
  if (HOME_SENTINELS.has(v)) return os.homedir();
  if (v.startsWith('/') && (await isKnownProjectPath(v))) return v;
  return null;
}

// Route a transcript to the Voice Conductor, tagged with a per-request id so
// /voice/reply can match the spoken reply. Returns the requestId, or null if
// the Conductor is offline. Shared by /voice/intent and /voice/audio.
function routeToConductor(transcript) {
  const conductorId = getVoiceConductorTabId();
  if (!conductorId || !listTerminals().some((t) => t.id === conductorId)) return null;
  const requestId = `req-${crypto.randomBytes(6).toString('hex')}`;
  const tagged = `[${requestId}] ${transcript.slice(0, 4000).replace(/[\r\n]+/g, ' ')}`;
  const CHUNK = 256;
  for (let i = 0; i < tagged.length; i += CHUNK) writeTerminal(conductorId, tagged.slice(i, i + CHUNK));
  writeTerminal(conductorId, '\r');
  return requestId;
}

// Monotonic per-session counter for phone-spawned terminal ids. Must stay the
// shape `term-mobile-<n>` (a single trailing digit run) because every parser
// (parseTermLabel, terminal-status.projectFromId, mobile/Terminal.jsx) matches
// `/^term-(.+)-(\d+)$/` and treats the terminal as mobile ONLY when the middle
// group is exactly "mobile" (a `term-mobile-<ts>-<n>` shape would break that,
// grouping it under a fake project). A plain incrementing counter is unique
// within a session (PTYs never survive a restart) and never reuses an id, which
// fixes the `Date.now()` collision that let two same-millisecond spawns kill
// each other's PTY. Audit MED-10 + Codex.
let mobileTermCounter = 0;
function mobileTermId() {
  mobileTermCounter += 1;
  return `term-mobile-${mobileTermCounter}`;
}

function handleAuthedMessage(socket, msg, subs) {
  switch (msg.type) {
    case 'ping':
      wsSend(socket, { type: 'pong' });
      break;

    case 'listTerminals':
      wsSend(socket, buildTerminalsPayload());
      break;

    case 'authorizeTab':
      // The client is actively viewing this tab (e.g. the Chat view, including a
      // sessionless tab that never loads a transcript, or the Stop button). Mark
      // it interacted-with so input/resize/kill are allowed. Audit Medium.
      if (typeof msg.id === 'string') socket._authedTabs.add(msg.id);
      break;

    case 'attach': {
      const id = msg.id;
      if (typeof id !== 'string' || subs.has(id)) break;
      const sink = {
        onData: (tid, data) => wsSend(socket, { type: 'output', id: tid, data }),
        onExit: (tid, code, signal) => {
          // onExit can fire after the socket already closed (close cleanup
          // ran first). wsSend's readyState guard makes that a safe no-op.
          wsSend(socket, { type: 'exit', id: tid, code, signal });
          const u = subs.get(tid);
          if (u) { u(); subs.delete(tid); }
        },
      };
      const { ok, unsubscribe, buffer } = subscribeTerminal(id, sink);
      if (!ok) {
        // The terminal exited between the board listing it and this attach. Tell
        // the phone so it refreshes its list instead of showing a live-looking
        // blank terminal that silently swallows keystrokes. Audit MED-9.
        wsSend(socket, { type: 'terminalMissing', id });
        break;
      }
      subs.set(id, unsubscribe);
      socket._authedTabs.add(id); // attaching authorizes input/resize/kill. Audit Medium.
      // Replay recent output so the phone sees the current screen, not a blank.
      if (buffer) wsSend(socket, { type: 'output', id, data: buffer, replay: true });
      wsSend(socket, { type: 'attached', id });
      break;
    }

    case 'detach': {
      const u = subs.get(msg.id);
      if (u) { u(); subs.delete(msg.id); }
      break;
    }

    case 'input':
      if (typeof msg.id === 'string' && socket._authedTabs.has(msg.id)
          && typeof msg.data === 'string' && msg.data.length <= MAX_INPUT_BYTES) {
        writeTerminal(msg.id, msg.data);
        invalidateSelectorPush(msg.id); // the phone cleared its popup on tap
        // A short write is how the Chat view answers a selector (a bare option
        // digit). Re-parse after the TUI repaints and push the (likely cleared)
        // selector state so the phone's buttons drop off immediately instead of
        // waiting out the 2.5s probe. v1.0.51 mobile kinks.
        if (msg.data.length <= 4) {
          const id = msg.id;
          setTimeout(async () => {
            wsSend(socket, { type: 'selector', id, selector: await liveSelectorForTab(id) || null });
          }, 700);
        }
      }
      break;

    case 'submitPrompt': {
      // Type a chat message into the tab the way a human would. The old client
      // path sent `text\r` in ONE chunk; Claude's Ink TUI treats a fast chunk
      // as a paste, so the trailing \r became a newline INSIDE the input box
      // and the message sat there unsubmitted (Sam's v1.0.51 mobile bug 3).
      // Bracketed-paste the text, then press Enter as a DISCRETE keypress after
      // the paste settles. Works at a bare shell prompt too (zsh honors
      // bracketed paste + delayed CR), which is how "Start Claude" launches.
      if (typeof msg.id !== 'string' || !socket._authedTabs.has(msg.id)) break;
      if (typeof msg.text !== 'string' || !msg.text.trim()
          || Buffer.byteLength(msg.text, 'utf8') > MAX_INPUT_BYTES) break; // real BYTE cap (Codex: .length undercounts multibyte)
      // Strip control chars except \t and \n (multi-line paste is legitimate);
      // \r is stripped so the only Enter is the discrete one we send.
      const text = msg.text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
      const id = msg.id;
      invalidateSelectorPush(id); // the phone may have cleared a popup for this
      writeTerminal(id, `\x1b[200~${text}\x1b[201~`);
      setTimeout(() => { writeTerminal(id, '\r'); }, 250);
      // If this answered a selector (or started Claude), refresh selector state.
      setTimeout(async () => {
        wsSend(socket, { type: 'selector', id, selector: await liveSelectorForTab(id) || null });
      }, 900);
      break;
    }

    case 'selectorSnapshot': {
      // The mobile Chat view renders transcript text, which can't show Claude's
      // interactive selection prompts (they're live TUI overlays, not in the
      // transcript). Parse the tab's live PTY buffer for a numbered selector so
      // the Chat view can surface tappable option buttons. Cheap (strip + regex
      // over the rolling tail); returns selector=null when none is showing.
      if (typeof msg.id !== 'string') break;
      socket._authedTabs.add(msg.id); // the Chat view probes its own tab. Audit Medium.
      noteSelectorInterest(msg.id); // fresh probe = an open popup surface: enable pushes
      liveSelectorForTab(msg.id)
        .then((selector) => wsSend(socket, { type: 'selector', id: msg.id, selector: selector || null }))
        .catch(() => wsSend(socket, { type: 'selector', id: msg.id, selector: null }));
      break;
    }

    case 'terminalText': {
      // Sessionless tabs (plain shells, or tabs whose Claude was reset) have no
      // transcript for the Chat view to render. Return a plain-text tail of the
      // live PTY buffer so the phone can at least SHOW what the terminal says
      // (Asana 1217257328849820: "some tabs are just terminals... at least see
      // what the text is"). Read-only, same auth posture as selectorSnapshot.
      if (typeof msg.id !== 'string') break;
      socket._authedTabs.add(msg.id);
      const raw = stripAnsi(getTerminalBuffer(msg.id) || '');
      // Trim trailing blank padding per line, drop the all-blank tail, keep the
      // last ~60 lines so the payload stays small on a 1s-ish poll.
      const lines = raw.split('\n').map((l) => l.replace(/\s+$/, ''));
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      wsSend(socket, { type: 'terminalText', id: msg.id, text: lines.slice(-60).join('\n') });
      break;
    }

    case 'resize':
      if (typeof msg.id === 'string'
          && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
          && msg.cols > 0 && msg.rows > 0) {
        // If a desktop window is driving this PTY, ignore phone-side resize.
        // Reshaping the PTY to phone dimensions makes TUI apps repaint at the
        // smaller geometry, which mangles the desktop xterm. Phone-only PTYs
        // (e.g. ones created via `createTerminal` from mobile) still get
        // resized normally.
        if (socket._authedTabs.has(msg.id) && !terminalHasDesktopAttached(msg.id)) {
          resizeTerminal(msg.id, msg.cols, msg.rows);
        }
      }
      break;

    case 'kill':
      if (typeof msg.id === 'string' && socket._authedTabs.has(msg.id)) killTerminal(msg.id);
      break;

    case 'listProjects':
      knownProjectList()
        .then((list) => wsSend(socket, { type: 'projects', list }))
        .catch(() => wsSend(socket, { type: 'projects', list: [] }));
      break;

    case 'createTerminal': {
      // Phone-spawned PTY (no desktop tab; labeled remote-only on the board).
      // The cwd MUST be a known project (allowlist), never an arbitrary path,
      // so a paired token cannot open a shell anywhere on disk. Codex #5.
      // Echo the client's nonce (bounded) so the Board can tell THIS create's
      // error apart from unrelated errors on the shared socket: an
      // uncorrelated error used to release the double-tap guard and let a
      // second tap spawn a second PTY (Codex Medium).
      const crNonce = typeof msg.nonce === 'string' ? msg.nonce.slice(0, 64) : undefined;
      resolveCreateCwd(msg.cwd).then((resolved) => {
        if (resolved === null) {
          wsSend(socket, { type: 'error', message: 'Unknown project', nonce: crNonce });
          return;
        }
        const id = mobileTermId();
        try {
          createTerminal(id, resolved, null);
          socket._authedTabs.add(id); // the creator may drive its own PTY. Audit Medium.
          wsSend(socket, { type: 'terminalCreated', id, nonce: crNonce });
        } catch (err) {
          wsSend(socket, { type: 'error', message: String(err?.message || err), nonce: crNonce });
        }
      });
      break;
    }

    // Skill catalog for the chat composer's `/` autocomplete (v1.0.62, Sam:
    // "when I type / I wanna see the preview of my skills ... click and
    // autofill"). Names + descriptions only; paths stay on the Mac.
    case 'listSkills':
      loadSkills()
        .then((list) => wsSend(socket, {
          type: 'skills',
          list: (list || [])
            // Underscore-prefixed dirs (_shared and friends) are skill
            // plumbing, not invokable skills; they are noise in a picker.
            .filter((sk) => sk.name && !sk.name.startsWith('_'))
            .map((sk) => ({ name: sk.name, description: sk.description || '', source: sk.source || '' })),
        }))
        .catch(() => wsSend(socket, { type: 'skills', list: [] }));
      break;

    case 'listSessions':
      loadAllSessions()
        .then((list) => wsSend(socket, { type: 'sessions', list: list || [] }))
        .catch((err) => wsSend(socket, { type: 'error', message: String(err?.message || err) }));
      break;

    // Work abandoned mid-flight. The board re-issues this on every re-auth
    // (iOS kills the socket whenever the PWA backgrounds), so it has to be
    // cheap: measured at 36-87ms over the real 21-day history on this Mac,
    // which is why there is no cache here.
    case 'listLooseEnds':
      liveClaudeSessionIds()
        .then((excludeSessionIds) => findLooseEnds({ maxAgeDays: 30, limit: 25, excludeSessionIds }))
        .then((list) => wsSend(socket, { type: 'looseEnds', list: list || [] }))
        // A failed scan must not leave the phone stuck on "Loading": send an
        // empty list, matching how listSessions/listProjects degrade.
        .catch(() => wsSend(socket, { type: 'looseEnds', list: [] }));
      break;

    case 'loadTranscript': {
      const { sessionId, projectPath } = msg;
      if (typeof sessionId !== 'string' || typeof projectPath !== 'string') break;
      // The Chat view is working with this tab and sends input to it without a
      // raw 'attach', so authorize it here. Audit Medium.
      if (typeof msg.tabId === 'string') socket._authedTabs.add(msg.tabId);
      // A positive limit makes the server do a cheap tail read (the Chat view
      // polls this every few seconds); History omits it for the full transcript.
      const limit = typeof msg.limit === 'number' && msg.limit > 0 ? Math.min(msg.limit, 2000) : undefined;
      // Audit M3: the Chat view polls this every ~3.5s. Skip the tail-read +
      // parse when the transcript file is byte-identical to what we last sent
      // this socket (same mtime + size), and just re-send the cached entries so
      // the client still gets a response (and a fresh mount still loads). Keyed
      // per (sessionId + projectPath + limit): two projects can hold the same
      // sessionId (and could coincidentally share an mtime+size signature), and
      // History's no-limit full read must not be served a limited cache. Codex.
      const cacheKey = `${sessionId}:${projectPath}:${limit || 0}`;
      const txCache = socket._txCache || (socket._txCache = new Map());
      getTranscriptSig(sessionId, projectPath)
        .then(async (sig) => {
          // The client echoes back the sig of the payload it already holds.
          // When the file has not changed, reply with a ~100-byte "unchanged"
          // instead of re-shipping the full message payload: a chat sitting
          // open used to receive (and JSON.parse) up to several MB every
          // 3.5s poll, which is what made the phone UI crawl on big live
          // transcripts (observed 8/15). Honor the claim only when THIS
          // socket's cache has independently parsed that sig: a fresh
          // connection (server restart, reconnect) always re-ships once, so
          // a client sig from a previous life can never pin stale content
          // the server never verified (Codex Medium).
          const hit = txCache.get(cacheKey);
          if (sig && typeof msg.sig === 'string' && msg.sig === sig && hit && hit.sig === sig) {
            wsSend(socket, { type: 'transcript', sessionId, projectPath, sig, unchanged: true });
            return null;
          }
          if (sig && hit && hit.sig === sig) return { entries: hit.entries, sig };
          const entries = (await loadTranscript(sessionId, projectPath, limit)) || [];
          if (sig) txCache.set(cacheKey, { sig, entries });
          return { entries, sig };
        })
        .then((res) => {
          if (!res) return; // unchanged reply already sent
          wsSend(socket, { type: 'transcript', sessionId, projectPath, sig: res.sig || null, entries: res.entries || [] });
        })
        .catch((err) => wsSend(socket, { type: 'error', message: String(err?.message || err) }));
      break;
    }

    case 'resumeSession': {
      // Open a phone terminal in the session's project and resume Claude there.
      const { sessionId, projectPath } = msg;
      if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) break;
      // Route the cwd through the SAME allowlist createTerminal uses. Without
      // this, resumeSession took projectPath verbatim and spawned a login shell
      // in any directory the phone named (audit HIGH-2), and an unknown path
      // silently fell back to a home-dir shell + a blind `claude --resume` in
      // the wrong place. Unknown project -> error, no shell.
      resolveCreateCwd(projectPath).then(async (cwd) => {
        if (cwd === null) {
          wsSend(socket, { type: 'error', message: 'Unknown project' });
          return;
        }
        // Refuse a session that is ALREADY running somewhere. The phone's list
        // can be minutes stale (the desktop can resume from its own Loose Ends
        // tab or the sidebar in between), and two `claude --resume` processes
        // appending to one transcript corrupts the user's own history. Checked
        // here rather than in the client because this is the one place every
        // phone-initiated resume passes through. Codex Critical.
        //
        // claim, not a bare check: the resume below is only visible in the
        // process table a second or two later, so a plain check leaves a
        // window where a second surface also gets "not running".
        let claimed = true;
        try { claimed = await claimSessionResume(sessionId); }
        catch { /* if we cannot tell, fall through and resume */ }
        if (!claimed) {
          wsSend(socket, { type: 'error', message: 'That session is already running on your Mac' });
          return;
        }
        const id = mobileTermId();
        try {
          createTerminal(id, cwd, null);
          wsSend(socket, { type: 'terminalCreated', id });
          // Attach the tab to the claim we already hold, so the reservation
          // lives as long as the tab does instead of lapsing while a slow shell
          // profile and claude start up. Kill the tab and the session is free
          // again. A bind cannot TAKE a session, only annotate our own.
          bindReservationTab(sessionId, id);
          // Link the session to this tab so the sidebar shows where it resumed.
          setSessionTabLink(sessionId, id, cwd);
          // Give the shell a beat to print its prompt before sending the command.
          setTimeout(() => writeTerminal(id, `claude --resume ${sessionId}\r`), 700);
        } catch (err) {
          // The claim was taken before the terminal existed, so a failed spawn
          // has to hand it back. Otherwise a resume that never happened leaves
          // the session looking busy, and the next attempt is refused. Try the
          // tab-bound form first (createTerminal may have succeeded and a later
          // line thrown), then the placeholder. Release is ownership-checked,
          // so the wrong one is simply a no-op and neither can touch somebody
          // else's claim.
          if (!releaseSessionResume(sessionId, id)) releaseSessionResume(sessionId);
          wsSend(socket, { type: 'error', message: String(err?.message || err) });
        }
      });
      break;
    }

    default:
      break;
  }
}

/** Current server status, safe to expose to the renderer. */
export function getMobileServerStatus() {
  return {
    running: !!httpServer,
    tailnetIp: getTailnetIp(),
    address: boundAddress,
    secure: serveInfo?.secure || false,
    url: serveInfo?.url || null,
    pairingCode: httpServer ? pairingCode : null,
    deviceCount: getMobileServerConfig().devices.length,
  };
}

/** Start the server. Resolves to a status object (with `error` set on failure). */
export async function startMobileServer() {
  if (httpServer) return getMobileServerStatus();

  const cfg = getMobileServerConfig();
  // Tailscale-only: bind to the 100.x tailnet IP so the server is reachable
  // ONLY from tailnet peers (never the local subnet) and all traffic rides the
  // WireGuard tunnel. This is what keeps the bearer token off the wire in the
  // clear. LAN/plaintext mode was removed in v1.0.43 (it was an RCE path).
  const ip = getTailnetIp();
  if (!ip) {
    return {
      running: false,
      error: 'No Tailscale connection found. Open Tailscale, sign in, then try again.',
    };
  }
  const port = cfg.port || 8420;

  const expApp = express();

  // POST /upload?name=<filename>  (raw file body; Bearer auth). v1.0.53.
  // Registered BEFORE the json middleware: a JSON-typed file (someone attaches
  // a package.json) must reach the raw parser, not get consumed/413'd by
  // express.json (Codex). Phone screenshots / files land as temp files on the
  // Mac; the returned absolute path gets typed into Claude's prompt (same
  // contract as the desktop dobius-clipboard flow). Files live in
  // tmpdir/dobius-mobile-uploads; entries older than 24h are pruned on the
  // next upload, so the dir never grows unbounded. bearerOk hoists.
  const UPLOAD_DIR = path.join(os.tmpdir(), 'dobius-mobile-uploads');
  const MAX_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;
  expApp.post('/upload', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
    if (!bearerOk(req)) return res.status(401).json({ ok: false, error: 'auth' });
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    if (!body || body.length === 0) return res.status(400).json({ ok: false, error: 'empty upload' });
    // Basename-only, control/separator chars stripped, length-capped. The
    // unique prefix guarantees no collision/overwrite regardless of the name.
    const rawName = typeof req.query.name === 'string' ? req.query.name : 'upload';
    const safeName = path.basename(rawName).replace(/[^\w.@-]+/g, '_').slice(0, 80) || 'upload';
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      // Best-effort prune of stale uploads (cheap: one readdir per upload).
      try {
        const now = Date.now();
        for (const f of fs.readdirSync(UPLOAD_DIR)) {
          const fp = path.join(UPLOAD_DIR, f);
          try { if (now - fs.statSync(fp).mtimeMs > MAX_UPLOAD_AGE_MS) fs.rmSync(fp, { force: true }); } catch { /* raced */ }
        }
      } catch { /* prune is best-effort */ }
      const dest = path.join(UPLOAD_DIR, `up-${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName}`);
      fs.writeFileSync(dest, body);
      res.json({ ok: true, path: dest, size: body.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.code || 'write failed' });
    }
  });

  expApp.use(express.json({ limit: '64kb' }));

  expApp.get('/health', (_req, res) => {
    res.json({ ok: true, app: 'dobius-plus', version: app.getVersion() });
  });

  expApp.post('/pair', (req, res) => {
    // Time-boxed cooldown after a wrong-guess flood, NOT a permanent lockout. The
    // old code nulled pairingCode on the 5th miss, so any unauthenticated caller
    // who could reach the server could deny pairing forever (and re-lock right
    // after a manual regenerate). Now the code stays valid and we just refuse
    // attempts for PAIR_LOCK_MS, then re-arm, so a flood can only stall pairing
    // for a minute at a time. Audit MED-8.
    const now = Date.now();
    if (pairLockedUntil > now) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a minute.' });
    }
    if (!pairingCode) {
      return res.status(403).json({ ok: false, error: 'Pairing is locked. Regenerate the code on the desktop.' });
    }
    const { code, deviceName } = req.body || {};
    if (code !== pairingCode) {
      pairAttempts += 1;
      if (pairAttempts >= MAX_PAIR_ATTEMPTS) {
        // Cooldown (rate limit) AND rotate the code. The rate limit caps guesses
        // to 5/min; rotating a fresh code each cycle means those guesses can't
        // accumulate against one fixed target (which would eventually be brute-
        // forced), while pairing still works with the current desktop-shown code
        // once the cooldown passes. Not a permanent lockout. Audit MED-8 + Codex.
        pairLockedUntil = now + PAIR_LOCK_MS;
        pairAttempts = 0;
        pairingCode = genPairingCode();
      }
      return res.status(403).json({ ok: false, error: 'Invalid pairing code.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    // Stable opaque device id used by the UI for listing + removal targeting.
    // Tokens stay server-side only — Codex v1.0.28 HIGH (main.js:987).
    const deviceId = crypto.randomBytes(8).toString('hex');
    const cfg = getMobileServerConfig();
    const devices = [...cfg.devices, {
      token,
      deviceId,
      name: typeof deviceName === 'string' && deviceName.trim() ? deviceName.trim().slice(0, 60) : 'Phone',
      pairedAt: Date.now(),
    }];
    updateMobileServerConfig({ devices });
    // Consume the code after a successful pair so it can't be reused.
    pairingCode = genPairingCode();
    pairAttempts = 0;
    pairLockedUntil = 0;
    res.json({ ok: true, token });
  });

  // ----- Voice Conductor endpoints (Siri / glasses entry point) -----
  // Auth: Bearer token in the Authorization header, same token issued at /pair.
  function bearerOk(req) {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+([0-9a-f]{64})$/i);
    return m && knownToken(m[1]);
  }
  // The validated bearer token (or null), so push subscriptions can be bound to
  // the paired device. Only call after bearerOk(req) has passed.
  function bearerToken(req) {
    const m = (req.headers.authorization || '').match(/^Bearer\s+([0-9a-f]{64})$/i);
    return m ? m[1] : null;
  }

  // POST /voice/intent  { transcript: string, tabId?: string }
  // Two modes:
  //   1. Conductor (default): omit tabId. Routes through the Voice Conductor
  //      (Opus) which decides what to do. Smart but slower (~3-5s).
  //   2. Direct: pass tabId of any live Dobius+ terminal tab. The transcript
  //      is typed straight into that tab — no Conductor involved, no req-id
  //      tagging, no reply expected. Fast and dumb. Useful when you already
  //      know exactly which tab you want to talk to.
  expApp.post('/voice/intent', (req, res) => {
    if (!bearerOk(req)) return res.status(401).json({ ok: false, error: 'auth' });
    const transcript = req.body?.transcript;
    const directTabId = req.body?.tabId;
    if (typeof transcript !== 'string' || !transcript.trim()) {
      return res.status(400).json({ ok: false, error: 'transcript required' });
    }
    // Direct mode — write straight into the named tab, skip Conductor.
    if (typeof directTabId === 'string' && directTabId) {
      if (!/^term-.+-\d+$/.test(directTabId)) {
        return res.status(400).json({ ok: false, error: 'tabId malformed' });
      }
      if (!listTerminals().some((t) => t.id === directTabId)) {
        return res.status(404).json({ ok: false, error: 'tabId not alive' });
      }
      const text = transcript.slice(0, 4000).replace(/[\r\n]+/g, ' ');
      const CHUNK = 256;
      for (let i = 0; i < text.length; i += CHUNK) writeTerminal(directTabId, text.slice(i, i + CHUNK));
      writeTerminal(directTabId, '\r');
      // No requestId for direct mode — there's no Conductor to reply.
      return res.json({ ok: true, mode: 'direct', tabId: directTabId });
    }
    // Conductor mode (default): route via the shared helper, tagged with a
    // per-request id so /voice/reply can match the reply. 503 if offline.
    const requestId = routeToConductor(transcript);
    if (!requestId) return res.status(503).json({ ok: false, error: 'conductor offline' });
    res.json({ ok: true, mode: 'conductor', requestId });
  });

  // POST /voice/audio  (raw recorded audio body; Bearer auth)
  // The in-app voice path (v1.0.43 Phase 5): the phone records a command, uploads
  // it here, the Mac transcribes locally with whisper.cpp, and the text routes to
  // the Voice Conductor. Returns the transcript (so the phone shows what was
  // heard) plus a requestId to poll /voice/reply. Audio never leaves the Mac.
  expApp.post('/voice/audio', express.raw({ type: () => true, limit: '8mb' }), async (req, res) => {
    if (!bearerOk(req)) return res.status(401).json({ ok: false, error: 'auth' });
    if (!transcribeAvailable()) {
      return res.status(503).json({ ok: false, error: 'Local transcription is not set up on the Mac (whisper-cli / ffmpeg missing).' });
    }
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    if (!audio || audio.length === 0) return res.status(400).json({ ok: false, error: 'no audio' });
    // Concurrency cap: reject rather than stack CPU-heavy transcriptions (audit HIGH-4).
    if (voiceInFlight >= MAX_VOICE_INFLIGHT) {
      return res.status(429).json({ ok: false, error: 'Busy transcribing, try again in a moment.' });
    }
    voiceInFlight += 1;
    // Abort ffmpeg/whisper if the phone drops the request mid-transcription, so
    // orphaned children don't keep burning CPU + holding temp files (audit HIGH-4).
    const ac = new AbortController();
    const onClose = () => { if (!res.writableEnded) ac.abort(); };
    res.on('close', onClose);
    try {
      const result = await transcribeAudio(audio, req.headers['content-type'], ac.signal);
      if (ac.signal.aborted) return; // client already gone; nothing to send
      if (result.error) return res.status(422).json({ ok: false, error: result.error });
      const requestId = routeToConductor(result.text); // null if Conductor offline
      // Transcription succeeded either way, but be honest about whether the
      // command was actually routed, so the phone doesn't imply it was handled
      // when the Conductor is down. Codex Phase 5a P2.
      res.json({ ok: true, transcript: result.text, requestId, routed: !!requestId });
    } finally {
      voiceInFlight -= 1;
      res.off('close', onClose);
    }
  });

  // GET /push/vapid -> { publicKey }  (Bearer). The phone needs this to
  // subscribe to Web Push. v1.0.43 Phase 5b.
  expApp.get('/push/vapid', (req, res) => {
    if (!bearerOk(req)) return res.status(401).json({ ok: false, error: 'auth' });
    res.json({ ok: true, publicKey: getVapidPublicKey() });
  });

  // POST /push/subscribe { subscription }  (Bearer). Stores the phone's
  // PushSubscription so the Mac can notify it when a session needs input / fails.
  expApp.post('/push/subscribe', (req, res) => {
    if (!bearerOk(req)) return res.status(401).json({ ok: false, error: 'auth' });
    const entry = subscribePush(req.body?.subscription, bearerToken(req));
    if (!entry) return res.status(400).json({ ok: false, error: 'invalid subscription' });
    res.json({ ok: true });
  });

  // GET /voice/tabs
  // Returns the live Dobius+ terminal tab list for the iPhone Shortcut's
  // "Choose From List" step when the user wants direct-to-tab mode.
  expApp.get('/voice/tabs', (req, res) => {
    if (!bearerOk(req)) return res.status(401).json({ ok: false, error: 'auth' });
    // Friendly names for the Shortcut list: the user's renamed desktop label
    // when one exists (Codex round 2), else project + tab number from the id.
    const configLabels = configTabLabels();
    const tabs = listTerminals().map((t) => {
      // Reuse the shared parser so extra-window ids (`<path>~<wk>`) yield a
      // clean project name here too (v1.0.66).
      const meta = parseTermLabel(t.id, t.cwd);
      const projName = meta.projectName || 'unknown';
      const renamed = configLabels.get(t.id);
      return { id: t.id, label: renamed ? `${projName} / ${renamed}` : `${projName} • ${meta.label}`, cwd: t.cwd };
    });
    res.json({ ok: true, tabs });
  });

  // POST /voice/reply  { requestId: string, timeoutMs?: number }
  // Long-polls (up to timeoutMs, default 25s) for the Conductor's reply to
  // the specific requestId. Returns the spoken message when it lands.
  expApp.post('/voice/reply', async (req, res) => {
    if (!bearerOk(req)) return res.status(401).json({ ok: false, error: 'auth' });
    const requestId = req.body?.requestId;
    if (typeof requestId !== 'string') {
      return res.status(400).json({ ok: false, error: 'requestId required' });
    }
    const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs) || 25000, 1000), 60000);
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const r = peekReply(requestId);
      if (r) return res.json({ ok: true, reply: r.message, ts: r.ts });
      if (Date.now() >= deadline) return res.json({ ok: false, reason: 'timeout' });
      setTimeout(tick, 200);
    };
    tick();
  });

  // Serve the mobile PWA build if present (added in Phase 3), else a placeholder.
  const mobileDist = path.join(__dirname, '..', 'dist-mobile');
  if (fs.existsSync(path.join(mobileDist, 'index.html'))) {
    expApp.use(express.static(mobileDist));
  } else {
    expApp.get('/', (_req, res) => {
      res.type('html').send(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<body style="font-family:-apple-system;background:#0D1117;color:#E6EDF3;padding:2rem">'
        + '<h2>Dobius+ Mobile</h2><p>Server is running. The mobile app ships in a later update.</p></body>'
      );
    });
  }

  // HTTPS when a tailnet cert exists for our MagicDNS name (Phase 4): required
  // for service-worker install + Web Push (a browser secure context). The client
  // then uses the https MagicDNS URL (which resolves via MagicDNS to this tailnet
  // IP). Without a cert we fall back to plain HTTP, which is terminal-only (no
  // push/install). That HTTP fallback is safe here BECAUSE it rides the tailnet:
  // WireGuard already encrypts the transport, so the bearer token is not exposed
  // to a same-subnet sniffer the way the removed LAN/plaintext mode exposed it.
  let magicName;
  let secure = false;
  magicName = await getMagicDNSName();
  if (magicName && hasCertFor(magicName)) {
    const cp = certPathsFor(magicName);
    try {
      httpServer = https.createServer(
        { cert: fs.readFileSync(cp.certFile), key: fs.readFileSync(cp.keyFile) },
        expApp,
      );
      secure = true;
    } catch (e) {
      console.warn('[mobile-server] cert unreadable, falling back to HTTP:', e?.message || e);
    }
  }
  if (!httpServer) httpServer = http.createServer(expApp);
  const pendingServeInfo = {
    secure,
    url: secure ? `https://${magicName}:${port}/` : `http://${ip}:${port}/`,
  };

  wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_WS_PAYLOAD });
  // Heartbeat: ping every client every HEARTBEAT_MS; a client that hasn't ponged
  // since the last ping is a dead/half-open socket (network dropped while OPEN)
  // and is terminated, so it stops accumulating a send buffer and its cleanup
  // runs. Audit Medium (cost-reliability).
  heartbeatTimer = setInterval(() => {
    for (const s of wss.clients) {
      if (s.isAlive === false) { try { s.terminate(); } catch { /* noop */ } continue; }
      s.isAlive = false;
      try { s.ping(); } catch { /* noop */ }
    }
  }, HEARTBEAT_MS);
  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    let authed = false;
    let authedToken = null; // remembered so cleanup + revocation lookup work
    const subs = new Map(); // terminalId -> unsubscribe fn
    // Terminal ids this socket has legitimately interacted with (attached,
    // created, or loaded/probed for the Chat view). input/resize/kill require
    // the id to be in here, so a paired-but-leaked token can't write to or kill
    // a terminal in a project it never touched. Audit Medium (security).
    socket._authedTabs = new Set();
    const authTimer = setTimeout(() => { if (!authed) socket.close(4001, 'auth timeout'); }, AUTH_TIMEOUT_MS);

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // Reject non-object frames BEFORE touching msg.type. JSON.parse('null')
      // (a valid 4-byte frame) returns null, and any primitive would throw on
      // property access here, pre-auth, crashing the whole app (uncaughtException
      // -> process.exit). Audit Critical.
      if (!msg || typeof msg !== 'object') return;
      if (!authed) {
        if (msg.type === 'auth' && knownToken(msg.token)) {
          authed = true;
          authedToken = msg.token;
          clearTimeout(authTimer);
          // Register so removeMobileDevice can force-disconnect us if revoked.
          let set = activeSocketsByToken.get(authedToken);
          if (!set) { set = new Set(); activeSocketsByToken.set(authedToken, set); }
          set.add(socket);
          wsSend(socket, { type: 'authed', version: app.getVersion() });
        } else {
          socket.close(4003, 'unauthorized');
        }
        return;
      }
      handleAuthedMessage(socket, msg, subs);
    });

    const cleanup = () => {
      clearTimeout(authTimer);
      for (const unsubscribe of subs.values()) {
        try { unsubscribe(); } catch { /* noop */ }
      }
      subs.clear();
      if (authedToken) {
        const set = activeSocketsByToken.get(authedToken);
        if (set) {
          set.delete(socket);
          if (set.size === 0) activeSocketsByToken.delete(authedToken);
        }
      }
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  pairingCode = genPairingCode();
  pairAttempts = 0;
  pairLockedUntil = 0;

  return new Promise((resolve) => {
    const onError = (err) => {
      httpServer = null;
      wss = null;
      boundAddress = null;
      serveInfo = null;
      pairingCode = null;
      resolve({ running: false, error: String(err?.message || err) });
    };
    httpServer.once('error', onError);
    httpServer.listen(port, ip, () => {
      httpServer.removeListener('error', onError);
      // Permanent handler so a later runtime socket error logs instead of crashing.
      httpServer.on('error', (err) => console.warn('[mobile-server]', err?.message || err));
      boundAddress = { host: ip, port };
      serveInfo = pendingServeInfo;
      // Push status changes to connected phones (change-driven, 1s poll of the
      // status authority; only sends when the board-relevant signature moves).
      lastTerminalsSig = null;
      // Seed dedup state from the current snapshot so a (re)start does not blast
      // stale needs/exit pushes for sessions that were already in that state
      // before the server came up. Audit MED-6.
      seedPushBaseline();
      statusBroadcastTimer = setInterval(pollStatusTick, 1000);
      // Context (model + ctx%) is transcript-derived, so recompute on a slow
      // debounce, not every status tick. Runs once now, then every 20s.
      refreshTabContexts();
      contextRefreshTimer = setInterval(refreshTabContexts, 20000);
      startPowerAssertion(); // keep the Mac awake for remote work while up
      // Instant selector popups: watch every PTY's output and push the
      // dialog when the drawing goes quiet, instead of waiting out the
      // phone's poll.
      selectorObserverOff = addTerminalObserver({
        onData: (tid) => scheduleSelectorPush(tid),
        onExit: (tid) => dropSelectorWatch(tid),
      });
      updateMobileServerConfig({ enabled: true });
      resolve(getMobileServerStatus());
    });
  });
}

/** Stop the server. Resolves to a status object. */
export function stopMobileServer({ persistDisabled = false } = {}) {
  // Close every authenticated client socket explicitly. wss.close() rejects
  // new connections but leaves existing ones alive until they drop on their
  // own — phones could keep streaming PTY data after stopMobileServer.
  // Codex v1.0.28 round-1 MED.
  for (const sockets of activeSocketsByToken.values()) {
    for (const s of sockets) {
      try { s.close(1001, 'server stopped'); } catch { /* noop */ }
    }
  }
  activeSocketsByToken.clear();
  if (statusBroadcastTimer) { clearInterval(statusBroadcastTimer); statusBroadcastTimer = null; }
  if (contextRefreshTimer) { clearInterval(contextRefreshTimer); contextRefreshTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (selectorObserverOff) { selectorObserverOff(); selectorObserverOff = null; }
  for (const id of [...selectorWatch.keys()]) dropSelectorWatch(id);
  selectorInterest.clear();
  tabContextCache.clear();
  lastTerminalsSig = null;
  prevStatusById.clear();
  notifiedExits.clear();
  stopPowerAssertion();
  if (wss) { try { wss.close(); } catch { /* noop */ } wss = null; }
  // Capture the server so we can AWAIT its close before a caller restarts on the
  // same port. Sockets + wss are already closed above, so close() completes
  // promptly rather than waiting on live connections. Codex v1.0.43 Phase 4 P2.
  const server = httpServer;
  httpServer = null;
  boundAddress = null;
  serveInfo = null;
  pairingCode = null;
  pairAttempts = 0;
  pairLockedUntil = 0;
  // Persist enabled:false ONLY on an explicit user "turn off" (Settings toggle).
  // Quit / update / restart teardown must NOT persist it, or mobile auto-start
  // would be permanently disabled after the first session. Audit High.
  if (persistDisabled) updateMobileServerConfig({ enabled: false });
  return new Promise((resolve) => {
    if (!server) return resolve(getMobileServerStatus());
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer); // don't leave a live timer after close
      resolve(getMobileServerStatus());
    };
    try { server.close(finish); } catch { finish(); }
    // Safety net if close stalls; unref so it never keeps the process alive.
    timer = setTimeout(finish, 3000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

/** Regenerate the pairing code (only meaningful while running). */
export function regeneratePairingCode() {
  if (!httpServer) return null;
  pairingCode = genPairingCode();
  pairAttempts = 0;
  pairLockedUntil = 0; // a manual regenerate should unblock pairing immediately
  return pairingCode;
}

/**
 * Remove a paired device by its opaque deviceId. Closes every authenticated
 * WebSocket associated with the revoked device's token so a pre-revocation
 * connection can't keep terminal access. Falls back to token-matching for
 * pre-v1.0.28 callers (legacy UI passed the raw token); new UI passes deviceId.
 * Codex v1.0.28 HIGHs (main.js:987 + mobile-server.js:400).
 */
export function removeMobileDevice(idOrToken) {
  const cfg = getMobileServerConfig();
  // Match by stored deviceId, the derived legacy deviceId, OR raw token
  // (last is a back-compat path; current UI passes deviceId only).
  const removed = cfg.devices.find((d) =>
    d.deviceId === idOrToken
    || deriveDeviceId(d) === idOrToken
    || d.token === idOrToken);
  if (!removed) return getMobileServerStatus();
  updateMobileServerConfig({ devices: cfg.devices.filter((d) => d !== removed) });
  // Force-close every authenticated socket bound to the revoked token.
  const sockets = activeSocketsByToken.get(removed.token);
  if (sockets) {
    for (const s of sockets) {
      try { s.close(4003, 'revoked'); } catch { /* noop */ }
    }
    activeSocketsByToken.delete(removed.token);
  }
  // Revoke push too, so the removed phone stops getting notifications. Codex P1.
  removePushSubscriptionsByToken(removed.token);
  return getMobileServerStatus();
}

/** Start on launch if the user previously enabled it. */
export async function maybeAutoStartMobileServer() {
  if (getMobileServerConfig().enabled) {
    return startMobileServer();
  }
  return getMobileServerStatus();
}
