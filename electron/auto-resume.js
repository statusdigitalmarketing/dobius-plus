/**
 * auto-resume.js, v1.0.30.
 *
 * On app launch, after every project window has restored and its tabs have
 * been recreated, walk every live terminal and re-engage the Claude session
 * that was running in it at quit time. Staggered so 14 PTYs don't spawn
 * `claude --resume <id>` simultaneously and overwhelm the API / SSD / Mac.
 *
 * Data sources:
 *   - sessionTabMap (config) records every {sessionId -> tabId, projectPath}
 *     link, captured by store.resumeSession AND by setupSessionTabCapture's
 *     15s background scan in main.js. So a tab the user resumed once gets
 *     its mapping persisted across quit.
 *   - listTerminals() (terminal-manager) reports which PTYs are alive in
 *     the new launch.
 *   - getSessionSize(sessionId, projectPath) (data-service) probes both
 *     encoder forms of the project dir and stats the transcript file.
 *
 * Per-tab status flows on the existing tabStatus channel:
 *   'queued'  -> dot is purple, scheduled but not yet sent
 *   'working' -> set when the `claude --resume` write fires
 *   The 'done' / 'needs' transitions are owned by the OSC hook in
 *   useTabActivity once Claude responds, so we don't push them here.
 *
 * Cancellation:
 *   - Per-tab: cancelTabIfPending(tabId) called from terminal:write IPC
 *     when the user types BEFORE the scheduled write fires.
 *   - Global: cancelAll() called from a Cmd+Shift+R IPC.
 *   - Window close: caller invokes cancelTabsForProject(projectPath).
 */

import { getAutoResume, getSessionTabMap, loadConfig, clearSessionTabUncertain, getPreviousLaunchAt } from './config-manager.js';
import {
  listTerminals, writeTerminal, releaseSessionResume, claimSessionResume,
  getTerminalWebContentsId,
  terminalInputSeq, terminalBusy,
} from './terminal-manager.js';
import { getSessionSize } from './data-service.js';
import { BrowserWindow } from 'electron';
import { projectPathFromTabId } from './tab-id-util.js';
import { logLine } from './error-log.js';
import { dockingTabs } from './docking-state.js';
import { isAbsPath } from '../shared/platform.js';
import { cdThen, toolCommand } from '../shared/sh-quote.js';

// Per-tab queue entry: tabId -> { sessionId, projectPath, timer }
// `timer` is the setTimeout handle so we can cancel before it fires.
const queue = new Map();
let started = false;
// The launch pass has finished deciding (resumeRestoredTab waits for it).
let startupDone = false;
// The sessions that were running at the last quit, as decided AT LAUNCH: the
// periodic capture later rewrites links and clears idle stamps, so a tab
// restored later is judged by this snapshot (Codex design review).
let launchEligible = new Map();
// Tabs already resumed, queued, skipped or cancelled this launch: a later
// restore of the same tab never types into it again.
const handled = new Set();
// Bumped by cancelAll (Cmd+Shift+R): a resume still being prepared when it is
// pressed (a transcript lookup, a claim) is dropped too (Codex).
let cancelGen = 0;
// Restored tabs that came up while the launch pass was still deciding (a
// window opened from the launcher in the first seconds): looked at once it
// is done, unless that pass took them (the harness caught the gap).
const restoredDuringStartup = new Set();
// Resumes this launch still owes, so the 15s capture does not read "no Claude in this tab yet" as "its Claude stopped"
// and clear the running stamp (bug report 2026-11-14: the capture cleared the stamps of tabs still waiting their turn,
// nothing re-stamped them before the quit, and 28 tabs came back as bare shells on the next launch). A resume is owed
// from the launch decision until its Claude is first seen running in the tab, it is dropped, or RESUME_SIGHT_MS passes.
// preparing: decided, not yet queued (a transcript size lookup, a claim). typed: written, its Claude not yet seen.
const preparing = new Set();
const typed = new Map(); // tabId -> { sessionId, at, seq }
// Bounded: a resume whose Claude never shows up (the shell failed it) stops protecting the stamp after this.
const RESUME_SIGHT_MS = 10 * 60_000;
function finishStartup() {
  startupDone = true;
  for (const tabId of restoredDuringStartup) {
    // A tab the launch pass already took is its outcome to log, not this path's (Codex, PR 7: two lines per tab).
    if (handled.has(tabId)) continue;
    resumeRestoredTab(tabId).catch((err) => console.warn('[auto-resume] restored tab:', err?.message || err));
  }
  restoredDuringStartup.clear();
}

/**
 * Push a tabStatus update to every open window so the dot reflects the
 * current state. Renderer Zustand store reacts to 'tab:status' on the
 * existing channel (see useTabActivity's setTabStatus path).
 */
function broadcastStatus(tabId, status) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('tab:status', { tabId, status });
  }
}

/**
 * Build a shell-safe `cd '<project>' && claude --resume <id>\r` command.
 * Single-quote escape the project path; abort if the path or sessionId
 * smell wrong. Matches the shape the renderer's store.resumeSession uses.
 */
function buildResumeCommand(projectPath, sessionId, tabId) {
  if (!projectPath || !isAbsPath(projectPath)) return null;
  if (/[\x00-\x1F\x7F]/.test(projectPath)) return null;
  if (!sessionId || !/^[a-zA-Z0-9][\w-]*$/.test(sessionId)) return null;
  // Same-project resume: bare `claude --resume`, no cd. The restored tab's
  // PTY spawns at its own project root already, and cd'ing yanks the user
  // out of any worktree/subdir their shell profile lands them in
  // (Sam-reported v1.0.35). cd only for cross-project links, where the
  // tab's project genuinely differs from the session's.
  // Shared parser so an extra-window id (term-<path>~w-<8>-<n>) yields the real
  // project path; the legacy regex left the ~w- marker in and broke the
  // same-project bare-resume shortcut (Codex).
  const tabProject = projectPathFromTabId(tabId);
  if (tabProject && tabProject === projectPath) {
    return `${toolCommand('claude', `--resume ${sessionId}`, process.platform)}\r`;
  }
  return `${cdThen(projectPath, toolCommand('claude', `--resume ${sessionId}`, process.platform), process.platform)}\r`;
}

/**
 * Pure: which session each tab was running at the last quit, from the saved links. Exported for tests.
 * tabMap: config.sessionTabMap; lastQuitAt: config.lastQuitAt (0 when unknown); now: Date.now(); prevLaunchAt: when the
 * run before this one started (0 when unknown).
 */
export function pickLaunchSessions(tabMap, lastQuitAt, now, prevLaunchAt = 0) {
  const RUNNING_AT_QUIT_SLACK_MS = 20 * 60 * 1000;
  // A stamp kept through failed checks (uncertainSince) counts only if the checks had been failing for a short time
  // when the app quit: transient timeouts on a loaded Mac, not a session that may have been stopped minutes before
  // (Codex, PR 7).
  const UNCERTAIN_MAX_MS = 2 * 60 * 1000;
  let skippedUncertain = 0;
  const uncertainTabs = [];
  const tabToBest = new Map();
  let skippedStale = 0;
  let skippedHeuristic = 0;
  for (const [sid, entry] of Object.entries(tabMap)) {
    if (!entry?.tabId || !entry?.projectPath) continue;
    // HEURISTIC GATE (v1.0.39): never auto-resume a link we INFERRED.
    //
    // 'fresh' links come from correlating a bare `claude`'s process start time
    // to a transcript's birth time, because a bare `claude` carries no session
    // id in its argv. That correlation cannot be made sound: transcripts record
    // no pid, so when two claudes in one project could both have written a file
    // (a second bare `claude`, a `/clear` that starts a new transcript in an
    // already-linked tab, a `claude` run outside Dobius entirely) nothing
    // distinguishes them. Codex found a fresh case every round for six rounds,
    // each fix trading one misattribution for another. It is not a bug left to
    // fix, it is the ceiling of the available signal.
    //
    // So the inference names tabs and nothing more. A wrong badge is cosmetic
    // and self-corrects on the next 15s tick; a wrong auto-resume TYPES
    // `claude --resume <wrong-id>` into a live terminal, which is the exact
    // failure ("random ass shit popped up that I was not just using") this file
    // exists to prevent. 'argv' links stay eligible and are certain, so this
    // gives up nothing that worked before v1.0.39: fresh sessions were not
    // linked at all then, so they were never auto-resumed either.
    //
    // ponytail: fresh sessions do not auto-resume. Ceiling is the missing pid.
    // A bare `claude` whose own sessions/<pid>.json names its id links as
    // 'presence', which is identity rather than timing and does pass this gate;
    // only Claude versions without that file stay 'fresh'.
    if (entry.resolvedBy === 'fresh') { skippedHeuristic += 1; continue; }
    // Shape sanity only (term-/abs/path-N). Do NOT require the tab's project
    // to equal entry.projectPath: a supported flow is resuming a project-A
    // session from a tab living in project B's window (store.resumeSession
    // cd's to A first), and that link legitimately has tabId=term-B-N with
    // projectPath=A. The freshness gate below is the real staleness guard.
    // Codex v1.0.35 r2 P2.
    if (!/^term-(\/|[A-Za-z]:\\).+-\d+$/.test(entry.tabId)) { skippedStale += 1; continue; }
    const ranAt = typeof entry.lastRunningAt === 'number' ? entry.lastRunningAt : 0;
    // Fresh if the session was running near the last CLEAN quit, OR near
    // "now" (covers a crash: lastQuitAt is stale from an older clean quit,
    // but the Tier-2 stamp kept updating until the crash, so a quick
    // relaunch still sees a recent lastRunningAt). Codex v1.0.35 r1 P2.
    const freshVsQuit = lastQuitAt > 0 && Math.abs(lastQuitAt - ranAt) <= RUNNING_AT_QUIT_SLACK_MS;
    const freshVsNow = (now - ranAt) <= RUNNING_AT_QUIT_SLACK_MS;
    if (!ranAt || (!freshVsQuit && !freshVsNow)) {
      skippedStale += 1;
      continue;
    }
    // The uncertainty ends at the quit only when that quit came after it began; an older quit (a crash since) is not its
    // end, so it runs to now (Codex, PR 7: an earlier quit gave a negative duration and let a long uncertainty through).
    // Nor is a quit from before the run that just ended: that run started later and crashed, so its doubt (carried in
    // from before, or a launch that was cancelled) also runs to now (Codex, PR 7).
    const quitEndedLastRun = lastQuitAt >= prevLaunchAt;
    const uncertainEnd = typeof entry.uncertainSince === 'number' && quitEndedLastRun && lastQuitAt >= entry.uncertainSince ? lastQuitAt : now;
    const longUncertain = typeof entry.uncertainSince === 'number' && (uncertainEnd - entry.uncertainSince) > UNCERTAIN_MAX_MS;
    const prev = tabToBest.get(entry.tabId);
    if (!prev || ranAt > prev.lastRunningAt) {
      tabToBest.set(entry.tabId, {
        sessionId: sid,
        projectPath: entry.projectPath,
        capturedAt: entry.capturedAt || 0,
        lastRunningAt: ranAt,
        longUncertain,
      });
    }
  }
  // Each tab's NEWEST link decides it. A long uncertainty on that one rules the tab out; it never falls back to an
  // older session there (Codex, PR 7: the session the person stopped before starting the newer one came back).
  for (const [tabId, best] of tabToBest) {
    const { longUncertain, ...rest } = best;
    if (longUncertain) { tabToBest.delete(tabId); skippedUncertain += 1; uncertainTabs.push(tabId); } else tabToBest.set(tabId, rest);
  }
  return { tabToBest, skippedStale, skippedHeuristic, skippedUncertain, uncertainTabs };
}

/**
 * The session this tab's launch resume is still on its way to, or null. While one is, the tab showing no Claude is
 * expected and says nothing about whether that session stopped. Read by the capture tick and the quit check (main.js).
 */
export function resumeOwedFor(tabId, now = Date.now()) {
  const e = launchEligible.get(tabId);
  if (!e) return null;
  const t = typed.get(tabId);
  if (t) {
    // Anything typed into the tab after the resume (a Ctrl+C, another command, from the window or the phone) ends it:
    // the person may have stopped that Claude before the capture ever saw it (Codex P1, PR 13).
    if (now - t.at < RESUME_SIGHT_MS && terminalInputSeq(tabId) === t.seq) return t.sessionId;
    typed.delete(tabId);
    return null;
  }
  if (queue.has(tabId)) return queue.get(tabId).sessionId;
  if (preparing.has(tabId)) return e.sessionId;
  // Not decided yet: the launch pass is still looking for its terminal, or its window has not been opened.
  if (!handled.has(tabId) && cancelGen === 0) return e.sessionId;
  return null;
}

/** The capture saw a Claude running in this tab: whatever resume was owed there is over. */
export function noteTabClaudeSeen(tabId) {
  typed.delete(tabId);
}

/**
 * Entry point. Wait `startupDelayMs` so windows have fully mounted and
 * the renderer's terminal mounts have settled, then resolve every live
 * tab's prior session and schedule a staggered write for each.
 * Idempotent: only runs once per app launch.
 */
export async function startAutoResume({ startupDelayMs = 1500 } = {}) {
  if (started) return;
  started = true;

  const cfg = getAutoResume();
  if (!cfg.enabled) {
    console.log('[auto-resume] disabled in config, skipping');
    finishStartup();
    return;
  }

  // Build the target tabId -> best-session map ONCE upfront (sessionTabMap
  // is stable across the poll window since we haven't started resuming yet).
  //
  // FRESHNESS GATE (v1.0.35): only links whose session was ACTUALLY RUNNING
  // at last quit are eligible. Tab ids are deterministic per-project counters
  // (`term-<path>-1` is always tab 1), so after a restart a fresh tab matches
  // ANY link ever captured for that slot, up to the map's 30-day retention.
  // Without this gate, 19-28 day old sessions were auto-resumed into Sam's
  // tabs ("random ass shit popped up that I was not just using").
  //   - entry.lastRunningAt must exist (links from before v1.0.35 have none
  //     and are skipped outright), AND
  //   - it must fall within RUNNING_AT_QUIT_SLACK_MS of lastQuitAt. The
  //     Tier-2 capture stamps it every 15s while the session runs, so a
  //     session live at quit reads within ~15s + one save debounce of
  //     lastQuitAt. 20 minutes of slack also covers a crash (no lastQuitAt
  //     write) followed by a quick relaunch.
  //   - the tab id only needs SHAPE sanity (cross-project links are a
  //     supported flow, see r2 note below); freshness is the staleness guard.
  const cfgAll = loadConfig();
  const lastQuitAt = typeof cfgAll.lastQuitAt === 'number' ? cfgAll.lastQuitAt : 0;
  const { tabToBest, skippedStale, skippedHeuristic, skippedUncertain, uncertainTabs } = pickLaunchSessions(getSessionTabMap() || {}, lastQuitAt, Date.now(), getPreviousLaunchAt());
  // Decided here, so neither the launch pass nor a window opening later logs these tabs again (Codex, PR 7).
  for (const tabId of uncertainTabs) { handled.add(tabId); noteResume(tabId, 'not resumed: its Claude could not be checked for over 2 minutes before the quit'); }
  if (skippedHeuristic > 0) {
    console.log(`[auto-resume] skipped ${skippedHeuristic} heuristically-linked (bare \`claude\`) session(s): named only, never auto-resumed`);
  }
  if (skippedStale > 0) {
    console.log(`[auto-resume] skipped ${skippedStale} stale/mismatched link(s); ${tabToBest.size} fresh candidate(s)`);
  }
  launchEligible = tabToBest;
  // One line a person can send: how many sessions this launch will try, and why the rest are out.
  logLine('diag.resume', `launch: ${tabToBest.size} session(s) were running at the last quit; ${skippedStale} link(s) not running then, ${skippedHeuristic} named only (bare claude), ${skippedUncertain} not checkable before the quit`);
  if (tabToBest.size === 0) {
    console.log('[auto-resume] no sessions were running at last quit, nothing to resume');
    finishStartup();
    return;
  }

  // Poll for terminals: with many restored project windows / slow PTY init,
  // a single fixed delay can miss late-mounting tabs and permanently skip
  // their resume. Retry until either we see EVERY mapped tab alive, we hit
  // a stable count (no new mounts for one full interval), or we exhaust
  // the total budget. Codex v1.0.33 P2.
  const POLL_INTERVAL_MS = Math.max(500, startupDelayMs);
  const TOTAL_BUDGET_MS = 15_000;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let candidates = [];
  // The PTY each tab had when it was FIRST seen, kept across polls: a later
  // poll must not adopt a shell that replaced it (Codex P1, round 2). The
  // cancel generation is the one this launch pass STARTED with: a Cmd+Shift+R
  // at any point during it, even before a tab's first poll, cancels that tab
  // (Codex P1, round 4).
  const firstSeen = new Map();
  const launchGen = cancelGen;
  let lastCount = -1;
  let stableTicks = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const live = listTerminals();
    const liveIds = new Set(live.map((t) => t.id));
    candidates = [];
    for (const [tabId, info] of tabToBest) {
      // The shell this resume is for, pinned the moment it is seen: every
      // later check compares against THIS PTY (Codex).
      if (!liveIds.has(tabId)) continue;
      // Closed (and maybe reopened) since launch: never this pass's to resume
      // (Codex, restore round 6).
      if (handled.has(tabId) && !firstSeen.has(tabId)) continue;
      if (!firstSeen.has(tabId)) firstSeen.set(tabId, { pidAt: live.find((t) => t.id === tabId)?.pid ?? null, gen: launchGen });
      candidates.push({ tabId, ...info, ...firstSeen.get(tabId) });
    }
    // Done: every mapped tab is now alive.
    if (candidates.length === tabToBest.size) break;
    // Stable: count hasn't changed for 2 ticks, no more late mounts expected.
    if (candidates.length === lastCount) {
      stableTicks += 1;
      if (stableTicks >= 2 && candidates.length > 0) break;
    } else {
      stableTicks = 0;
      lastCount = candidates.length;
    }
  }

  // Every tab seen during the polls is the launch pass's to decide (one seen,
  // cancelled and closed before the last poll included: Codex P1, round 3);
  // the rest wait for their window to be opened (resumeRestoredTab).
  for (const tabId of firstSeen.keys()) handled.add(tabId);
  for (const c of candidates) preparing.add(c.tabId);
  finishStartup();
  const waiting = tabToBest.size - candidates.length;
  if (waiting > 0) console.log(`[auto-resume] ${waiting} session(s) wait for their window to be opened`);
  // Each of those gets its own line, so a window that never opens still leaves a reason (Codex, PR 7).
  for (const tabId of tabToBest.keys()) if (!handled.has(tabId)) noteResume(tabId, 'waiting: its window was not open at launch; it resumes when that window opens');
  // Seen, then closed before the last poll: the launch pass took it but nothing below visits it.
  const inCandidates = new Set(candidates.map((c) => c.tabId));
  for (const tabId of firstSeen.keys()) if (!inCandidates.has(tabId)) noteResume(tabId, 'not resumed: its tab closed before the resume was queued');
  // Closed before the first poll saw it (forgetClosedTab marked it handled): it gets a line too (Codex, PR 7).
  for (const tabId of tabToBest.keys()) if (handled.has(tabId) && !firstSeen.has(tabId) && !uncertainTabs.includes(tabId)) noteResume(tabId, 'not resumed: its tab closed before the launch reached it');
  if (candidates.length === 0) {
    preparing.clear();
    console.log('[auto-resume] no live tabs with mapped sessions after 15s budget, nothing to do');
    return;
  }

  // Validate each: transcript must exist and be under size cap.
  const eligible = [];
  for (const c of candidates) {
    const sizeMB = await getSessionSize(c.sessionId, c.projectPath);
    if (sizeMB == null) {
      preparing.delete(c.tabId);
      noteResume(c.tabId, 'not resumed: transcript not found');
      console.log(`[auto-resume] skip ${c.tabId}: transcript not found for ${c.sessionId}`);
      continue;
    }
    if (sizeMB > cfg.skipOversizedMB) {
      preparing.delete(c.tabId);
      noteResume(c.tabId, 'not resumed: transcript over the size cap');
      console.log(`[auto-resume] skip ${c.tabId}: transcript ${sizeMB.toFixed(0)}MB > ${cfg.skipOversizedMB}MB cap`);
      continue;
    }
    eligible.push({ ...c, sizeMB });
  }

  if (eligible.length === 0) {
    preparing.clear();
    console.log('[auto-resume] no eligible sessions after validation');
    return;
  }

  console.log(`[auto-resume] queueing ${eligible.length} session(s) with ${cfg.staggerMs}ms stagger`);

  // Space the writes by SIZE, not a flat tick. The old 80MB cap hid this by
  // skipping big transcripts outright; now that they resume (a 725MB one in
  // 10s), a flat 50ms would fire two dozen heavy `claude --resume` processes
  // inside about a second (Codex Medium). Tiny sessions still go at full
  // speed; only the expensive ones buy extra room.
  let cumulativeMs = 0;
  for (const e of eligible) {
    const delayMs = cumulativeMs;
    cumulativeMs += cfg.staggerMs + Math.round(Math.min(e.sizeMB || 0, 2000) * 2);
    await queueResume(e, delayMs);
  }
  // Every one is queued or dropped by now (queueResume clears its own; this covers a throw).
  for (const c of candidates) preparing.delete(c.tabId);
}

/**
 * Schedule one tab's `claude --resume`, with every guard: a claim at queue
 * time and again at write time, the same PTY at write time as at queue time,
 * and cancellation by input, the user, or the tab closing. Shared by the
 * launch-time pass and a tab restored later (resumeRestoredTab).
 */
async function queueResume(e, delayMs) {
  preparing.add(e.tabId);
  try { await queueResumeNow(e, delayMs); } finally { preparing.delete(e.tabId); }
}

async function queueResumeNow(e, delayMs) {
  handled.add(e.tabId);
  // A resume only ever goes into the shell it was decided for (pinned when
  // the tab was first seen: e.pidAt) and only while nothing at all has been
  // typed into that shell since it started, since a restored shell starts
  // with an input count of 0. Anything typed while this was being prepared
  // (a transcript lookup, a claim) found no queue entry to cancel; this
  // catches it (Codex, design review and round 1).
  // And the session is still this tab's: resumed in another tab meanwhile
  // (and maybe stopped there), its link names that tab now (Codex, restore
  // round 7). The running stamp is NOT asked here: the 15s capture zeroes it
  // for a fresh shell that is only waiting for this very resume.
  const untouched = () => cancelGen === e.gen
    && (listTerminals().find((t) => t.id === e.tabId)?.pid ?? null) === e.pidAt && e.pidAt !== null
    && terminalInputSeq(e.tabId) === 0
    && (getSessionTabMap() || {})[e.sessionId]?.tabId === e.tabId;
  if (!untouched()) {
    noteResume(e.tabId, 'not resumed: the tab was in use, replaced or cancelled first');
    console.log(`[auto-resume] ${e.tabId}: in use, replaced or cancelled before queueing, skipping`);
    return;
  }
  {
    // CLAIM at queue time, not write time, and not a bare reserve. The stagger
    // means a tab sits scheduled for many seconds: reserving only at the write
    // left that window open for another surface to take the session (Codex
    // Critical, round 8), and reserving UNCONDITIONALLY stole the session from
    // a resume the phone had legitimately started while the app was still
    // booting (Codex Critical, round 9). A claim does neither.
    let claimed = true;
    try { claimed = await claimSessionResume(e.sessionId, e.tabId); } catch { /* proceed */ }
    if (!claimed) {
      noteResume(e.tabId, 'not resumed: the session is already running or claimed');
      console.log(`[auto-resume] ${e.tabId}: ${e.sessionId} is already running or claimed, skipping`);
      broadcastStatus(e.tabId, 'done');
      return;
    }
    if (!untouched()) {
      releaseSessionResume(e.sessionId, e.tabId);
      noteResume(e.tabId, 'not resumed: the tab was in use, replaced or cancelled during the claim');
      console.log(`[auto-resume] ${e.tabId}: in use, replaced or cancelled during the claim, skipping`);
      return;
    }
    broadcastStatus(e.tabId, 'queued');
    // The PTY was pinned when the tab was first seen (e.pidAt). Tab ids are
    // deterministic per-project counters, so a window closed and reopened
    // recycles the same id for a brand-new shell, and a write keyed on id
    // alone would type `claude --resume` into it (Codex High, round 11).
    // The entry is created BEFORE the timer so the callback can consult its own
    // `cancelled` flag. The callback awaits, and a cancel arriving during that
    // await used to be a no-op (the entry had already been removed from the
    // queue), so the user typing at exactly the wrong moment got the resume
    // typed at them anyway. The flag closes that window.
    const entry = { sessionId: e.sessionId, projectPath: e.projectPath, timer: null, cancelled: false };
    const giveUp = (why) => {
      queue.delete(e.tabId);
      releaseSessionResume(e.sessionId, e.tabId);
      if (why) { noteResume(e.tabId, 'not resumed when its time came'); console.log(`[auto-resume] ${e.tabId}: ${why}`); }
      broadcastStatus(e.tabId, 'done');
    };
    entry.timer = setTimeout(async () => {
      const cmd = buildResumeCommand(e.projectPath, e.sessionId, e.tabId);
      if (!cmd) { giveUp('command build failed, skipping'); return; }
      // Re-check at the moment of writing. Ownership makes this a no-op for
      // our own reservation; it only refuses if something else took the
      // session in the meantime (a real claude actually started it).
      let ok = true;
      try { ok = await claimSessionResume(e.sessionId, e.tabId); } catch { /* proceed */ }
      // Cancelled while we were awaiting: the cancel path already released and
      // dequeued, so just do not write.
      if (entry.cancelled) return;
      if (!ok) { giveUp(`${e.sessionId} is already running elsewhere, skipping`); return; }
      // Nothing but the shell running in the tab: a shell profile that starts
      // Claude (or anything) on its own, even by exec, would get the resume
      // typed into it (Codex, restore round 8).
      let busy = null;
      try { busy = await terminalBusy(e.tabId); } catch (err) { busy = 'unknown'; console.warn(`[auto-resume] ${e.tabId}: could not check the tab's program: ${err?.message || err}`); }
      if (entry.cancelled) return;
      if (busy) { giveUp(`${busy} is already running in the tab, skipping`); return; }
      // The same shell, untouched, and no cancel-all since it was decided.
      if (!untouched()) {
        giveUp('tab was typed into, replaced or cancelled before the write, skipping');
        return;
      }
      queue.delete(e.tabId);
      try {
        writeTerminal(e.tabId, cmd);
        typed.set(e.tabId, { sessionId: e.sessionId, at: Date.now(), seq: terminalInputSeq(e.tabId) });
        // A new run: doubt carried from before the quit ends here, or a crash after this launch would still measure
        // it only up to that older quit and resume a session stopped since (Codex, PR 7).
        clearSessionTabUncertain(e.sessionId);
        noteResume(e.tabId, 'resume typed');
        broadcastStatus(e.tabId, 'working');
      } catch (err) {
        // A priority line (diag.resume is never throttled) with the short tab name, never the full path (Codex, PR 7).
        noteResume(e.tabId, `not resumed: typing the resume failed (${err?.code || 'error'})`);
        console.warn(`[auto-resume] ${shortTab(e.tabId)}: write failed: ${err.message}`);
        releaseSessionResume(e.sessionId, e.tabId);
        broadcastStatus(e.tabId, 'done');
      }
    }, delayMs);
    queue.set(e.tabId, entry);
  }
}

// A restored shell needs a moment before it reads what is typed into it.
const RESTORED_TAB_DELAY_MS = 1500;
// When the next later-restored resume may fire: a window opened with several
// eligible tabs spaces them like the launch pass does (by transcript size),
// rather than starting every heavy `claude --resume` at once (Codex).
let nextRestoredAt = 0;

/**
 * A tab restored with its saved scrollback AFTER the launch pass (its window
 * opened later, from the launcher): resume the Claude session it was running
 * at the last quit, once, under every launch-time guard (Brett, Asana
 * 1220099565720834: "Should this automatically reopen?").
 */
// Why a tab did or did not resume, for the log a person can send (folder and tab
// number only, never the path or the session).
// Either separator: a Windows tab id (term-C:\Users\x\proj-1) has no forward slash and would log its whole path.
const shortTab = (tabId) => String(tabId).replace(/^term-.*[\\/]/, '');
const noteResume = (tabId, what) => logLine('diag.resume', `${shortTab(tabId)}: ${what}`);

export async function resumeRestoredTab(tabId) {
  // After a Cmd+Shift+R this launch, nothing resumes on its own any more.
  if (!startupDone) { restoredDuringStartup.add(tabId); return; }
  if (handled.has(tabId)) { noteResume(tabId, 'window opened later: already decided this launch'); return; }
  if (cancelGen > 0) { noteResume(tabId, 'window opened later: resume was cancelled this launch'); return; }
  const info = launchEligible.get(tabId);
  if (!info) { noteResume(tabId, 'window opened later: no session was running here at the last quit'); return; }
  handled.add(tabId);
  preparing.add(tabId);
  try { await resumeRestoredDecided(tabId, info); } finally { preparing.delete(tabId); }
}

async function resumeRestoredDecided(tabId, info) {
  // And still so NOW: the session's link still names this tab and its running
  // stamp was not cleared since launch (resumed in another tab and stopped
  // there, say: Codex, restore round 6).
  const current = (getSessionTabMap() || {})[info.sessionId];
  if (!current || current.tabId !== tabId || !current.lastRunningAt) {
    console.log(`[auto-resume] ${tabId}: ${info.sessionId} moved or stopped since launch, not resuming`);
    noteResume(tabId, 'window opened later: its session moved or stopped since launch');
    return;
  }
  // Pinned before any await: this shell, this cancel generation.
  const pidAt = listTerminals().find((t) => t.id === tabId)?.pid ?? null;
  const gen = cancelGen;
  const cfg = getAutoResume();
  if (!cfg.enabled) { noteResume(tabId, 'window opened later: auto-resume is off'); return; }
  const sizeMB = await getSessionSize(info.sessionId, info.projectPath);
  if (sizeMB == null) { noteResume(tabId, 'window opened later: transcript not found'); console.log(`[auto-resume] skip ${tabId}: transcript not found for ${info.sessionId}`); return; }
  if (sizeMB > cfg.skipOversizedMB) { noteResume(tabId, 'window opened later: transcript over the size cap'); console.log(`[auto-resume] skip ${tabId}: transcript ${sizeMB.toFixed(0)}MB > ${cfg.skipOversizedMB}MB cap`); return; }
  const now = Date.now();
  const at = Math.max(now + RESTORED_TAB_DELAY_MS, nextRestoredAt);
  nextRestoredAt = at + cfg.staggerMs + Math.round(Math.min(sizeMB || 0, 2000) * 2);
  noteResume(tabId, 'window opened later: queued to resume');
  console.log(`[auto-resume] ${tabId}: window opened later, resuming ${info.sessionId} in ${at - now}ms`);
  await queueResume({ tabId, ...info, sizeMB, pidAt, gen }, at - now);
}

/**
 * A tab's shell went away (its window or the tab closed) while Dobius runs:
 * whatever happens to that tab id later is not the launch's resume to make
 * (Codex, restore round 5). Cancels a pending write too.
 */
export function forgetClosedTab(tabId) {
  handled.add(tabId);
  typed.delete(tabId);
  cancelTabIfPending(tabId);
}

/**
 * Cancel a single pending tab. Called by terminal:write IPC when the user
 * types into a tab BEFORE its scheduled resume fires. Clears the queued
 * dot. No-op if the timer already fired or the tab was never queued.
 */
export function cancelTabIfPending(tabId) {
  const entry = queue.get(tabId);
  if (!entry) return false;
  entry.cancelled = true;
  clearTimeout(entry.timer);
  queue.delete(tabId);
  releaseSessionResume(entry.sessionId, tabId);
  broadcastStatus(tabId, 'done');
  noteResume(tabId, 'pending resume cancelled by input in the tab');
  return true;
}

/**
 * Cancel every tab belonging to a given project (called when a project
 * window is closed before its queue has drained).
 */
export function cancelTabsForProject(projectPath) {
  if (!projectPath) return 0;
  let cancelled = 0;
  for (const [tabId, entry] of queue) {
    // Two projects can be in play per entry: the tab id embeds the WINDOW's
    // project (`term-<path>-N`), while entry.projectPath is the SESSION's,
    // and a cross-project resume makes them differ. Closing the window must
    // cancel by the window's project or the entry survives, its reservation
    // wedges the session, and the timer later types into whatever new shell
    // recycled the tab id (Codex High, round 11).
    const tabProject = projectPathFromTabId(tabId);
    if (entry.projectPath !== projectPath && tabProject !== projectPath) continue;
    // But a project match is not proof the tab died with the closing window:
    // a TEAR-OFF of the same project can still own this PTY (this fires from
    // `closed`, so the closing window's webContents is already destroyed and
    // reads as no-owner, while a live tear-off reads as its owner). Cancelling
    // then would silently drop a legitimate queued resume into a tab that is
    // alive and well. Codex Medium, round 12.
    if (getTerminalWebContentsId(tabId) !== null) continue;
    // Same for a tab moving into another window right now (docking).
    if (dockingTabs.has(tabId)) continue;
    {
      entry.cancelled = true;
      clearTimeout(entry.timer);
      queue.delete(tabId);
      releaseSessionResume(entry.sessionId, tabId);
      broadcastStatus(tabId, 'done');
      noteResume(tabId, 'pending resume cancelled (its window closed)');
      cancelled += 1;
    }
  }
  return cancelled;
}

/**
 * Cancel the entire queue. Called by Cmd+Shift+R from any window.
 */
export function cancelAll() {
  cancelGen += 1; // and every resume still being prepared
  let cancelled = 0;
  for (const [tabId, entry] of queue) {
    entry.cancelled = true;
    clearTimeout(entry.timer);
    releaseSessionResume(entry.sessionId, tabId);
    broadcastStatus(tabId, 'done');
    noteResume(tabId, 'pending resume cancelled (cancel all)');
    cancelled += 1;
  }
  queue.clear();
  return cancelled;
}

/**
 * Renderer probe: returns true iff the tab currently has a pending
 * scheduled resume. Used by the Settings UI for diagnostic display.
 */
export function isTabPending(tabId) {
  return queue.has(tabId);
}

/**
 * Total pending count, for diagnostics.
 */
export function pendingCount() {
  return queue.size;
}
