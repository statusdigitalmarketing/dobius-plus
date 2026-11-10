import { parseTabId } from './tab-id-util.js';
import { answersPrompt, submitsInput } from '../shared/prompt-answer.js';
import { baseName } from '../shared/platform.js';
// Main-process terminal STATUS authority (v1.0.43, remote-control Phase 1).
//
// Today the tab status (working / done / needs-input) is derived in the
// RENDERER (useTerminal's OSC 777 handler + useTabActivity's output-flow
// settler). The mobile board needs that same status in the MAIN process so it
// can be sent over the Tailscale bridge without a desktop window open. This
// module reproduces the renderer's logic against the raw PTY data stream:
//
//   - Authoritative: the Claude hook emits `\x1b]777;dobius;<state>\x07` into
//     the PTY (state = working|done|needs). The marker wins and, for
//     working/needs, claims "hook ownership" so a quiet tool call is not
//     settled to done. `done` releases ownership.
//   - Secondary: any output flips a tab to `working` (unless it is `needs`, or
//     hook-owned), and ~1.5s of silence settles a non-hook-owned `working` tab
//     to `done`. Mirrors useTabActivity.
//
// It also keeps a bounded recent-EXIT cache, because terminal-manager deletes a
// terminal on exit (so exit code / project would otherwise be gone before the
// board or a push can use it).
//
// Pure and clock-injectable (now is passed in): timers live in the main.js
// wiring, so this is unit-testable without Electron.

const TAB_STATUS_VALUES = new Set(['working', 'done', 'needs']);
// An optional tag after the state: needs;handoff (a turn that ended handing
// the person a `! command`, shared/handoff.js) and done;idle (Claude idle for
// a minute, which must never clear a red).
// working;background: a turn ended with background work still running.
const MARKER_RE = /\x1b\]777;dobius;(working|done|needs)(?:;(handoff|idle|background))?\x07/g;
const QUIET_MS = 1500;          // silence before a working tab settles to IDLE
const DONE_GUARD_MS = 800;      // after a hook 'done', ignore its own trailing bytes
const TAIL_KEEP = 64;           // bytes retained to catch a marker split across chunks
const MAX_RECENT_EXITS = 50;

// id -> { status, lastActivityAt, hookOwned, doneAt, tail, workingSince, lastWorkMs }
// workingSince: when the current stretch began (entering 'working'; a
// permission prompt inside a turn keeps it, 0 while none has begun).
// lastWorkMs: how long the stretch lasted when the hook reported 'done'.
// Both follow the same status the tab dots show, nothing more: if a hook never
// sends Stop (a crash, an Esc interrupt) the stretch runs on exactly as the
// yellow dot does today. Accepted; there is no reliable signal to end it.
const live = new Map();
// Who wants each authoritative hook state as it lands (the team service tracks what a delivered message led to).
// Called with (id, state, tag, now); state is working | done | needs, or 'exit' when the terminal goes.
const hookListeners = new Set();
export function onHookState(fn) {
  hookListeners.add(fn);
  return () => hookListeners.delete(fn);
}
function emitHook(id, state, tag, now) {
  for (const fn of hookListeners) {
    try { fn(id, state, tag || null, now); } catch (err) { console.error('[terminal-status] hook listener failed:', err?.message || err); }
  }
}
// bounded FIFO of { id, cwd, project, exitCode, signal, status, at }
const recentExits = [];

function projectFromId(id, cwd) {
  // Desktop ids are `term-<projectPath>-<n>` or, for extra windows,
  // `term-<path>~w-<8>-<n>`; phone ids are `term-mobile-<ts>`. Use the shared
  // parser so the extra-window marker is stripped (v1.0.66).
  const parsed = parseTabId(id);
  if (parsed && parsed.projectPath !== 'mobile') {
    const p = parsed.projectPath;
    return { projectPath: p, projectName: baseName(p) || p };
  }
  const p = cwd || 'mobile';
  return { projectPath: p, projectName: baseName(p) || 'mobile' };
}

/** Feed a raw PTY data chunk for a terminal. Returns the tab's current status. */
export function ingest(id, data, now = Date.now()) {
  if (!id || typeof data !== 'string') return null;
  let st = live.get(id);
  if (!st) {
    // timingStatus starts 'idle' so this very chunk's status (plain output, or
    // a marker such as a lone 'needs') decides whether a stretch begins.
    st = {
      status: 'working', lastActivityAt: now, hookOwned: false, doneAt: 0, tail: '',
      timingStatus: 'idle', workingSince: 0, lastWorkMs: 0,
    };
    live.set(id, st);
  }
  st.lastActivityAt = now;

  const combined = st.tail + data;
  MARKER_RE.lastIndex = 0;
  let lastMatch = null;
  let m;
  // Every marker in order: one chunk can carry a turn's 'done' and the next
  // turn's 'working', and the stretch timing must see both.
  while ((m = MARKER_RE.exec(combined)) !== null) {
    lastMatch = m;
    if (skipsRed(st, m[1], m[2])) continue;
    enterStatus(st, m[1], now);
    applyHookState(st, m[1], now, m[2]);
    emitHook(id, m[1], m[2], now);
  }

  if (lastMatch) {
    // The markers were authoritative for this chunk (applied above, in order).
    // Keep only what follows the processed marker so it is not re-matched.
    st.tail = combined.slice(lastMatch.index + lastMatch[0].length).slice(-TAIL_KEEP);
  } else {
    // Output flowing with no marker -> working, unless the tab is needs-input,
    // a hook currently owns the state (a long quiet tool call stays working), OR
    // a managed 'done' was just set and this is its own trailing output (guard,
    // so a finished Claude turn stays green instead of settling to idle).
    // Mirrors useTabActivity + the recentHookDone guard on the desktop.
    const recentlyDone = st.status === 'done' && (st.doneSticky || (st.doneAt && now - st.doneAt < DONE_GUARD_MS));
    if (st.status !== 'needs' && !st.hookOwned && !recentlyDone) {
      enterStatus(st, 'working', now);
      st.status = 'working';
    }
    st.tail = combined.slice(-TAIL_KEEP);
  }
  return st.status;
}

// A hook state is authoritative: working/needs claim the tab, done releases it
// and is stamped so its own trailing bytes don't clobber green.
// A hook 'done' also stays green against later output (an agent's TUI
// repaints when the window is resized) until Enter is next typed in the tab
// (releaseDone): a finished turn is finished until somebody does something.
function applyHookState(st, state, now, tag) {
  st.status = state;
  st.hookOwned = state !== 'done';
  st.doneAt = state === 'done' ? now : 0;
  st.doneSticky = state === 'done';
  st.needsKind = state === 'needs' ? (tag === 'handoff' ? 'handoff' : 'prompt') : null;
  // What a working tab is waiting on: 'background' once a turn ended with
  // background work running; any other hook state clears it.
  st.waiting = state === 'working' && tag === 'background' ? 'background' : null;
  st.handoffAt = st.needsKind === 'handoff' ? now : 0;
}

// Claude's idle-for-a-minute 'done' while the tab is red: the person still
// owes an answer, so it changes nothing.
function skipsRed(st, state, tag) {
  // Nor while a turn's background work runs: Claude sits at its prompt, so
  // its idle notification fires, but the work has not come back yet.
  return state === 'done' && tag === 'idle' && (st.status === 'needs' || (st.status === 'working' && st.waiting === 'background'));
}

/** A hook state delivered out of band (Codex hooks reach main over the bridge,
 * not as a marker in the PTY stream; electron/codex-status.js). Same effect as
 * the marker in ingest. Returns true when the terminal is known. */
export function noteHookStatus(id, state, now = Date.now(), tag = undefined) {
  const st = live.get(id);
  if (!st || !TAB_STATUS_VALUES.has(state)) return false;
  if (skipsRed(st, state, tag)) return false;
  enterStatus(st, state, now);
  applyHookState(st, state, now, tag);
  // Not passed to hook listeners: these are Codex's, and the team lifecycle follows Claude's own markers only.
  return true;
}

/** The person has seen a handed-back command (its tab sat on screen in a
 * focused window): a handoff red has done its job and becomes a finished,
 * green turn. A permission prompt's red is NOT cleared by seeing it: Claude
 * is stuck until it is answered. Returns true when it changed. */
export function clearHandoff(id, shownSince = Infinity, now = Date.now()) {
  const st = live.get(id);
  if (!st || st.status !== 'needs' || st.needsKind !== 'handoff') return false;
  // Only a red that was already there when the person started looking: a new
  // handoff that landed after that (a new turn) has not been seen yet.
  if (!(st.handoffAt <= shownSince)) return false;
  enterStatus(st, 'done', now);
  applyHookState(st, 'done', now);
  return true;
}

/** Whether a tab is waiting on a turn's background work (working;background). */
export function waitingOnBackground(id) {
  const st = live.get(id);
  return !!st && st.status === 'working' && st.waiting === 'background';
}

/** End a background wait: Claude is gone from the tab (killed mid-wait), so
 * nothing will report the work's end. Output and quiet drive the dot again.
 * Returns true when it released. */
export function releaseWait(id, now = Date.now()) {
  const st = live.get(id);
  if (!st || st.waiting !== 'background') return false;
  st.waiting = null;
  st.hookOwned = false;
  st.lastActivityAt = now;
  return true;
}

/** Input written INTO a terminal: Enter on a tab a hook left green lets output
 * drive its dot again (a shell command typed after the agent exited, say).
 * Returns true when it released. */
export function releaseDone(id, data, now = Date.now()) {
  const st = live.get(id);
  // A carriage return inside a paste is a line of the paste, not Enter.
  if (!st || !st.doneSticky || typeof data !== 'string' || !data.includes('\r') || data.includes('\x1b[200~')) return false;
  st.doneSticky = false;
  st.doneAt = 0; // and the trailing-bytes guard: output after Enter is new work
  // Enter is activity: working now, idle after the usual quiet, so nothing
  // depends on output arriving after the release to move the dot.
  enterStatus(st, 'working', now);
  st.status = 'working';
  st.lastActivityAt = now;
  return true;
}

/** Input written INTO a terminal: an answer to a red tab's prompt turns it back
 * to working (shared/prompt-answer.js). Returns true when it changed. */
export function noteInput(id, data, now = Date.now()) {
  const st = live.get(id);
  if (!st || st.status !== 'needs' || !answersPrompt(data)) return false;
  const handoff = st.needsKind === 'handoff';
  // A handed-back command is answered by running it: Enter, never a digit
  // typed while copying it (`gh pr merge 12`), a paste's line breaks, or
  // Option+Enter (a newline in the prompt).
  if (handoff && !submitsInput(data)) return false;
  enterStatus(st, 'working', now);
  st.status = 'working';
  st.needsKind = null;
  st.lastActivityAt = now;
  // An answered permission prompt: still Claude's turn, so quiet output must
  // not settle it. An answered handoff (the `!` command was run): the turn
  // had ended, so no hook may follow; output flow settles it.
  st.hookOwned = !handoff;
  return handoff ? 'handoff' : 'prompt';
}

// Stretch bookkeeping on a status change (the status itself is set by ingest).
function enterStatus(st, next, now) {
  const prev = st.timingStatus || st.status;
  // The timer starts on entering 'working'; a permission prompt inside a turn
  // (working <-> needs) keeps it. A 'needs' from outside a stretch clears it,
  // so the 'working' after it starts a new one rather than reusing an old.
  const inStretch = (s) => s === 'working' || s === 'needs';
  if (next === 'needs' && !inStretch(prev)) st.workingSince = 0;
  if (next === 'working' && (!inStretch(prev) || !st.workingSince)) st.workingSince = now;
  if (next === 'done' && inStretch(prev)) {
    st.lastWorkMs = st.workingSince ? Math.max(0, now - st.workingSince) : 0;
  }
  st.timingStatus = next;
}

/** Settle tick: a non-hook-owned working tab (a plain shell) goes IDLE (gray)
 * after QUIET_MS of silence, matching the desktop. Green ('done') only ever
 * comes from a managed Claude/Codex hook marker, never from settling. */
export function settle(now = Date.now()) {
  for (const st of live.values()) {
    if (st.status === 'working' && !st.hookOwned && now - st.lastActivityAt > QUIET_MS) {
      st.status = 'idle';
      st.timingStatus = 'idle';
    }
  }
}

/** Record a terminal exit into the bounded recent-exit cache and drop it live. */
export function noteExit(id, info = {}, now = Date.now()) {
  if (!id) return;
  const st = live.get(id);
  const { projectPath, projectName } = projectFromId(id, info.cwd);
  recentExits.push({
    id,
    projectPath,
    projectName,
    cwd: info.cwd || '',
    exitCode: typeof info.exitCode === 'number' ? info.exitCode : null,
    signal: info.signal || null,
    status: st?.status || 'done',
    at: now,
  });
  while (recentExits.length > MAX_RECENT_EXITS) recentExits.shift();
  live.delete(id);
  emitHook(id, 'exit', null, now);
}

/**
 * Sidebar timing for one live terminal: its status, when the current working
 * stretch began (null unless working or needs), and how long the last one
 * the hook ended with 'done' lasted.
 */
export function activityFor(id) {
  const st = live.get(id);
  if (!st) return null;
  const inStretch = st.status === 'working' || st.status === 'needs';
  return {
    status: st.status,
    hookOwned: st.hookOwned,
    since: inStretch ? st.workingSince || null : null,
    lastWorkMs: st.lastWorkMs || 0,
    doneAt: st.status === 'done' ? st.doneAt || 0 : 0,
    // 'background': the turn ended with background work still running.
    waiting: st.status === 'working' ? st.waiting || null : null,
  };
}

/** A new PTY under this id (a respawn): nothing from the old one carries over. */
export function forget(id) {
  // A respawned or killed PTY: whatever ran in it is gone (the team lifecycle stops following a message there).
  const had = live.delete(id);
  if (had) emitHook(id, 'exit', null, Date.now());
}

/** Current status for one live terminal, or null. */
export function statusFor(id) {
  const st = live.get(id);
  if (!st) return null;
  return { status: st.status, lastActivityAt: st.lastActivityAt, hookOwned: st.hookOwned, waiting: st.waiting || null, needsKind: st.needsKind || null };
}

/** Snapshot of all live statuses + the recent-exit cache. */
export function snapshot() {
  const liveOut = {};
  for (const [id, st] of live) {
    liveOut[id] = { status: st.status, lastActivityAt: st.lastActivityAt, hookOwned: st.hookOwned, waiting: st.waiting || null };
  }
  return { live: liveOut, recentExits: recentExits.slice() };
}

/** Test/reset helper. */
export function _reset() {
  live.clear();
  recentExits.length = 0;
}

export { QUIET_MS, TAB_STATUS_VALUES };
