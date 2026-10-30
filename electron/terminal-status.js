import { parseTabId } from './tab-id-util.js';
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
const MARKER_RE = /\x1b\]777;dobius;(working|done|needs)\x07/g;
const QUIET_MS = 1500;          // silence before a working tab settles to IDLE
const DONE_GUARD_MS = 800;      // after a hook 'done', ignore its own trailing bytes
const TAIL_KEEP = 64;           // bytes retained to catch a marker split across chunks
const MAX_RECENT_EXITS = 50;

// id -> { status, lastActivityAt, hookOwned, doneAt, tail, workingSince,
//        turnStartedAt, lastTurnMs, turnEndedAt }
// A TURN runs from the hook's first 'working' marker to its 'done' marker
// ('needs' in between is part of the same turn). workingSince is the start of
// the current non-hook output stretch (a plain shell build). Both live here,
// keyed by PTY id, so they survive a tab switch, a tear-off and a reload.
// Accepted: an interrupt (Esc) fires no Stop, so a prompt sent before Claude's
// idle notification (about a minute) continues the interrupted turn's clock.
const live = new Map();
// bounded FIFO of { id, cwd, project, exitCode, signal, status, at }
const recentExits = [];

function projectFromId(id, cwd) {
  // Desktop ids are `term-<projectPath>-<n>` or, for extra windows,
  // `term-<path>~w-<8>-<n>`; phone ids are `term-mobile-<ts>`. Use the shared
  // parser so the extra-window marker is stripped (v1.0.66).
  const parsed = parseTabId(id);
  if (parsed && parsed.projectPath !== 'mobile') {
    const p = parsed.projectPath;
    return { projectPath: p, projectName: p.split('/').filter(Boolean).pop() || p };
  }
  const p = cwd || 'mobile';
  return { projectPath: p, projectName: p.split('/').filter(Boolean).pop() || 'mobile' };
}

/** Feed a raw PTY data chunk for a terminal. Returns the tab's current status. */
export function ingest(id, data, now = Date.now()) {
  if (!id || typeof data !== 'string') return null;
  let st = live.get(id);
  if (!st) {
    st = {
      status: 'working', lastActivityAt: now, hookOwned: false, doneAt: 0, tail: '',
      workingSince: now, turnStartedAt: 0, lastTurnMs: 0, turnEndedAt: 0, lastMarkerAt: 0,
    };
    live.set(id, st);
  }
  const prev = st.status;
  st.lastActivityAt = now;

  const combined = st.tail + data;
  MARKER_RE.lastIndex = 0;
  let lastMatch = null;
  let m;
  // Every marker in order, not just the last: a chunk can carry one turn's
  // 'done' and the next turn's 'working', and the turn bookkeeping must see
  // both. The status itself ends up as the last marker's, as before.
  while ((m = MARKER_RE.exec(combined)) !== null) {
    lastMatch = m;
    const state = m[1];
    st.lastMarkerAt = now;
    if (state === 'done') {
      // Only a running turn ends here; Claude's idle-prompt re-send of 'done'
      // must not move the end (the length is measured back from it).
      if (st.turnStartedAt) {
        st.lastTurnMs = Math.max(0, now - st.turnStartedAt);
        st.turnEndedAt = now;
      }
      st.turnStartedAt = 0;
    } else if (!st.turnStartedAt) {
      st.turnStartedAt = now;
    }
  }

  if (lastMatch) {
    // The marker is authoritative for this chunk.
    const state = lastMatch[1];
    st.status = state;
    st.hookOwned = state !== 'done'; // working/needs own; done releases
    st.doneAt = state === 'done' ? now : 0; // stamp so trailing bytes don't clobber green
    // Keep only what follows the processed marker so it is not re-matched.
    st.tail = combined.slice(lastMatch.index + lastMatch[0].length).slice(-TAIL_KEEP);
  } else {
    // Output flowing with no marker -> working, unless the tab is needs-input,
    // a hook currently owns the state (a long quiet tool call stays working), OR
    // a managed 'done' was just set and this is its own trailing output (guard,
    // so a finished Claude turn stays green instead of settling to idle).
    // Mirrors useTabActivity + the recentHookDone guard on the desktop.
    const recentlyDone = st.status === 'done' && st.doneAt && now - st.doneAt < DONE_GUARD_MS;
    if (st.status !== 'needs' && !st.hookOwned && !recentlyDone) st.status = 'working';
    st.tail = combined.slice(-TAIL_KEEP);
  }
  if (st.status === 'working' && prev !== 'working') st.workingSince = now;
  return st.status;
}

/** Settle tick: a non-hook-owned working tab (a plain shell) goes IDLE (gray)
 * after QUIET_MS of silence, matching the desktop. Green ('done') only ever
 * comes from a managed Claude/Codex hook marker, never from settling. */
export function settle(now = Date.now()) {
  for (const st of live.values()) {
    if (st.status === 'working' && !st.hookOwned && now - st.lastActivityAt > QUIET_MS) {
      st.status = 'idle';
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
}

/**
 * Timing for one live terminal's sidebar label. `since` is when the current
 * working stretch began: the hook turn's start while a turn runs (a 'needs'
 * inside the turn keeps it), else the plain-output stretch's. `lastTurnMs` and
 * `turnEndedAt` describe the last turn the hook finished (0 when none, which
 * also means no hook has ever reported for this PTY).
 */
export function activityFor(id) {
  const st = live.get(id);
  if (!st) return null;
  const inStretch = st.status === 'working' || st.status === 'needs';
  return {
    status: st.status,
    hookOwned: st.hookOwned,
    since: inStretch ? (st.turnStartedAt || (st.status === 'working' ? st.workingSince : 0) || null) : null,
    lastTurnMs: st.lastTurnMs || 0,
    turnEndedAt: st.turnEndedAt || 0,
    lastMarkerAt: st.lastMarkerAt || 0,
  };
}

/** A new PTY under this id (a respawn): nothing from the old one carries over. */
export function forget(id) {
  live.delete(id);
}

/** Current status for one live terminal, or null. */
export function statusFor(id) {
  const st = live.get(id);
  if (!st) return null;
  return { status: st.status, lastActivityAt: st.lastActivityAt, hookOwned: st.hookOwned };
}

/** Snapshot of all live statuses + the recent-exit cache. */
export function snapshot() {
  const liveOut = {};
  for (const [id, st] of live) {
    liveOut[id] = { status: st.status, lastActivityAt: st.lastActivityAt, hookOwned: st.hookOwned };
  }
  return { live: liveOut, recentExits: recentExits.slice() };
}

/** Test/reset helper. */
export function _reset() {
  live.clear();
  recentExits.length = 0;
}

export { QUIET_MS, TAB_STATUS_VALUES };
