import { BrowserWindow, app, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { killTerminal, gracefulCloseTerminals, getTerminalsForProject, getTerminalWebContentsId, wasWindowOwned } from './terminal-manager.js';
import { watchFiles } from './watcher-service.js';
import { getProjectConfig, setProjectConfig, loadConfig, saveConfig, getTearOffWindowState, setPrimaryWindowState, deletePrimaryWindowState } from './config-manager.js';
import { getQuittingForUpdate, getQuitting } from './quit-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Map of windowId (number) → { projectPath, win } */
const projectWindows = new Map();

/**
 * Persist the CURRENT set of open project paths to config.lastOpenProjects.
 *
 * v1.0.38 (Brett-reported): lastOpenProjects used to be written in exactly
 * ONE place, the Phase-3 branch of a normal two-press Cmd+Q quit. Any other
 * exit (the auto-update Restart button, force quit, OS shutdown, crash) never
 * recorded the window list, so on relaunch the list was stale or empty and
 * the app came up with just a fresh launcher instead of restoring the
 * session. Brett hit Restart and lost all his windows exactly this way.
 *
 * Keeping the list live on every open/close means the truth is already on
 * disk before any exit path runs, so restore works no matter HOW the app
 * went down. Guarded by getQuitting(): once a quit is committed the windows
 * all close in a cascade, which would otherwise rewrite this to [] and wipe
 * the state we're trying to restore. saveConfig is debounced so the churn is
 * cheap. Tear-off windows are excluded (they're ephemeral, not a project's
 * primary window).
 */
// Set true for the duration of launch-time restore so the per-window
// persistOpenProjects calls (fired as each restored window mounts) can't
// overwrite the saved restore state with a PARTIAL set mid-restore. Audit M2.
let restoring = false;
export function setRestoring(v) { restoring = !!v; }

// Projects / tear-off tabs that have actually had a window OPEN this session.
// Merge-preserve (below) keeps a saved entry whose path is currently missing so
// an unmounted-drive project isn't lost, BUT only if it was never opened this
// session: once the user has opened it and then deliberately closed it, it must
// be dropped even if its path happens to be missing at close time (otherwise it
// reopens on the next launch after the drive returns). Codex.
const openedProjectPathsThisSession = new Set();
// windowKeys of EXTRA primary windows opened this session, so computeRestoreLists
// can tell a deliberately-closed extra window (drop) from a pending/failed
// restore (preserve), mirroring openedProjectPathsThisSession. v1.0.66.
const openedPrimaryWindowKeysThisSession = new Set();
const openedTearOffTabIdsThisSession = new Set();

/**
 * Compute the lastOpenProjects / lastTearOffs to persist, merging the currently
 * open windows with saved entries that should NOT be lost. The preserve signal
 * is "never opened a window this session": that single condition covers a
 * missing-path entry (unmounted drive), a still-pending staggered restore that
 * hasn't opened yet, and a restore that failed to open, while an entry the user
 * actually opened and then closed (opened-this-session, now not open) is a
 * deliberate close and is dropped. Shared by persistOpenProjects AND the quit
 * paths (which write config directly, bypassing the getQuitting guard) so all
 * three apply the same rule. Audit M2 + Codex.
 * @param {object} config current config (read for prev lists)
 * @param {string[]} openNow getOpenProjectsForRestore()
 * @param {Array} tearsNow getOpenTearOffsForRestore()
 */
export function computeRestoreLists(config, openNow, tearsNow, extrasNow = []) {
  const prevProjects = Array.isArray(config?.lastOpenProjects) ? config.lastOpenProjects : [];
  const preservedProjects = prevProjects.filter((p) => typeof p === 'string'
    && !openNow.includes(p) && !openedProjectPathsThisSession.has(p));
  const openTearTabIds = new Set(tearsNow.map((t) => t.tabId));
  const prevTears = Array.isArray(config?.lastTearOffs) ? config.lastTearOffs : [];
  const preservedTears = prevTears.filter((t) => t && t.tabId && t.projectPath
    && !openTearTabIds.has(t.tabId) && !openedTearOffTabIdsThisSession.has(t.tabId));
  // Extra primary windows: same preserve rule keyed by windowKey (an extra
  // window opened this session and now closed is a deliberate close; one never
  // opened this session is still pending/failed restore and is preserved).
  const openKeys = new Set(extrasNow.map((e) => e.windowKey));
  const prevExtras = Array.isArray(config?.lastPrimaryWindows) ? config.lastPrimaryWindows : [];
  const preservedExtras = prevExtras.filter((e) => e && e.windowKey && e.projectPath
    && !openKeys.has(e.windowKey) && !openedPrimaryWindowKeysThisSession.has(e.windowKey));
  // Dedupe all lists so a pre-existing duplicate in config (or two windows that
  // briefly shared an id) can't persist twice and open two windows for one id on
  // restore. First occurrence wins. Codex.
  const seenPaths = new Set();
  const lastOpenProjects = [...openNow, ...preservedProjects].filter((p) => {
    if (seenPaths.has(p)) return false; seenPaths.add(p); return true;
  });
  const seenTabIds = new Set();
  const lastTearOffs = [...tearsNow, ...preservedTears].filter((t) => {
    if (seenTabIds.has(t.tabId)) return false; seenTabIds.add(t.tabId); return true;
  });
  const seenKeys = new Set();
  const lastPrimaryWindows = [...extrasNow, ...preservedExtras].filter((e) => {
    if (seenKeys.has(e.windowKey)) return false; seenKeys.add(e.windowKey); return true;
  });
  return { lastOpenProjects, lastTearOffs, lastPrimaryWindows };
}

function persistOpenProjects() {
  // Also frozen while an update install is armed. The window-close bypass at
  // the 'close' handler lets windows close instantly during quitAndInstall
  // (Electron closes them BEFORE before-quit on that path, so gating that
  // bypass on getQuitting is not an option). But if the install defers or
  // silently fails, getQuitting stays false while windows close, and each
  // 'closed' wrote a SHRINKING open-window list, so a Restart that did not
  // take could rewrite lastOpenProjects to empty and wipe the restore
  // snapshot: the exact "it didn't reopen my windows" failure Brett reported.
  // A slightly stale snapshot is always the better error here.
  // Codex blast-radius review (pre-existing on main, fixed with this batch).
  if (getQuitting() || restoring || getQuittingForUpdate()) return;
  try {
    const config = loadConfig();
    const merged = computeRestoreLists(config, getOpenProjectsForRestore(), getOpenTearOffsForRestore(), getOpenPrimaryWindowsForRestore());
    config.lastOpenProjects = merged.lastOpenProjects;
    config.lastTearOffs = merged.lastTearOffs;
    config.lastPrimaryWindows = merged.lastPrimaryWindows;
    saveConfig(config);
  } catch { /* best-effort */ }
}

// Persist the open-projects snapshot on demand. Called right after the restore
// latch lifts so any window the user opened DURING restore is written out even
// though its own persistOpenProjects was suppressed by the latch. Codex.
export function persistOpenProjectsNow() { persistOpenProjects(); }

/**
 * Tear-off windows that should be recreated on next launch: [{ projectPath,
 * tabId, label, bounds }]. Kept separate from getOpenProjectsForRestore (primary
 * windows) because a tear-off is one torn tab in its own window, not a project's
 * primary window. Brett's "Fix updating": his lost windows were tear-offs, which
 * used to be dropped on every restart/update. v1.0.46.
 */
export function getOpenTearOffsForRestore() {
  const out = [];
  for (const [, entry] of projectWindows) {
    if (!entry.isTearOff || !entry.tearOffTabId || !entry.win || entry.win.isDestroyed()) continue;
    // Only persist a CONFIRMED tear-off (a restored one, or a drag one whose
    // claim succeeded). An in-flight/unconfirmed drag tear-off is never written,
    // so even if its source window closes and its PTY reads null, a crash can't
    // strip the tab from the primary and resurrect a tear-off that never took
    // ownership. Ownership alone can't tell "restored, PTY not created yet" from
    // "in-flight drag whose source closed" (both read null), so we track
    // confirmation explicitly. Codex.
    if (!entry.tearOffConfirmed) continue;
    out.push({
      projectPath: entry.projectPath,
      tabId: entry.tearOffTabId,
      label: entry.tearOffLabel || '',
      bounds: entry.bounds || entry.win.getBounds(),
    });
  }
  return out;
}

/**
 * The project paths that SHOULD be reopened on next launch: live primary
 * windows only. Tear-off windows are excluded because they are ephemeral,
 * so a project whose primary window the user deliberately closed does not
 * come back just because a torn-off tab of it is still floating.
 *
 * Distinct from getOpenProjects(), which includes tear-offs and is used for
 * "is this project open right now" checks (isKnownProject, focus routing).
 * Every writer of lastOpenProjects MUST use this one so the live snapshot
 * and the quit-path snapshots cannot disagree. Codex v1.0.38 r1 P2.
 */
export function getOpenProjectsForRestore() {
  // MAIN windows only (windowKey 'main' or legacy undefined). Extra primary
  // windows are restored separately via getOpenPrimaryWindowsForRestore so
  // each reopens with its own tab bucket. A legacy entry (no windowKey) is a
  // main window. v1.0.66.
  const paths = new Set();
  for (const [, entry] of projectWindows) {
    if (entry.isTearOff || entry.win.isDestroyed()) continue;
    if (!entry.windowKey || entry.windowKey === 'main') paths.add(entry.projectPath);
  }
  return Array.from(paths);
}

/**
 * Extra primary windows to recreate on next launch: [{ projectPath, windowKey,
 * bounds }]. One per additional window on a project folder beyond the first
 * (Brett runs ~4). Restored via openProjectWindow(path, { windowKey, bounds }),
 * each pulling its own config.primaryWindows[windowKey] tab bucket. v1.0.66.
 */
export function getOpenPrimaryWindowsForRestore() {
  const out = [];
  for (const [, entry] of projectWindows) {
    if (entry.isTearOff || entry.win.isDestroyed()) continue;
    if (!entry.windowKey || entry.windowKey === 'main') continue;
    out.push({
      projectPath: entry.projectPath,
      windowKey: entry.windowKey,
      bounds: entry.bounds || entry.win.getBounds(),
    });
  }
  return out;
}

/**
 * Find the first open PRIMARY (non-tear-off) window for a project path. Excludes
 * tear-offs so openProjectWindow opens the full project window even when only a
 * restored tear-off exists (Codex: otherwise it would focus the tear-off and the
 * user could never get the primary back), and so closeProjectWindow closes the
 * primary rather than a floating torn-off tab.
 * @param {string} projectPath
 * @returns {BrowserWindow|null}
 */
function getWindowForProject(projectPath) {
  for (const [, entry] of projectWindows) {
    if (entry.projectPath === projectPath && !entry.isTearOff && !entry.win.isDestroyed()) {
      return entry.win;
    }
  }
  return null;
}

/**
 * Get all window IDs associated with a project path.
 * @param {string} projectPath
 * @returns {number[]}
 */
function getWindowIdsForProject(projectPath) {
  const ids = [];
  for (const [winId, entry] of projectWindows) {
    if (entry.projectPath === projectPath && !entry.win.isDestroyed()) {
      ids.push(winId);
    }
  }
  return ids;
}

// PRIMARY (non-tear-off) windows for a project. The primary window owns the
// project's shared terminals; a tear-off owns only its one torn tab. Used so a
// still-open tear-off does NOT count as "another window owns these terminals"
// when the primary closes (which would leak the primary's PTYs). Audit H1.
function getPrimaryWindowIdsForProject(projectPath) {
  const ids = [];
  for (const [winId, entry] of projectWindows) {
    if (entry.projectPath === projectPath && !entry.isTearOff && !entry.win.isDestroyed()) {
      ids.push(winId);
    }
  }
  return ids;
}

// Tab ids that have a tear-off window (claimed OR still in-flight/unclaimed). A
// tab being torn off is MOVING to its own window, so the source window's
// graceful close must NOT Ctrl+C it (that would interrupt a tab that is just
// relocating). Distinct from the KILL decision, which is ownership-based
// (getTerminalWebContentsId) so an in-flight tear-off that later fails is still
// cleaned up. Codex.
function getTearOffTabIdsForProject(projectPath) {
  const ids = new Set();
  for (const [, entry] of projectWindows) {
    if (entry.isTearOff && entry.projectPath === projectPath && entry.tearOffTabId && !entry.win.isDestroyed()) {
      ids.add(entry.tearOffTabId);
    }
  }
  return ids;
}

// Mark a drag tear-off as confirmed once its renderer has successfully claimed
// the source PTY (called from terminal:claimPty success). Matched by BOTH tabId
// and the claiming window's webContents id, so if two tear-offs of the same tab
// ever coexist the RIGHT (claiming) window is confirmed. Only confirmed tear-offs
// are persisted to lastTearOffs. Codex.
export function markTearOffConfirmed(tabId, webContentsId) {
  for (const [, entry] of projectWindows) {
    if (entry.isTearOff && entry.tearOffTabId === tabId && entry.win && !entry.win.isDestroyed()
        && (webContentsId == null || entry.win.webContents.id === webContentsId)) {
      entry.tearOffConfirmed = true;
      persistOpenProjects(); // capture the now-confirmed tear-off immediately
      return;
    }
  }
}

// Focus the tear-off window that owns a given tab id, if one is open. Lets the
// sidebar reveal a torn-off live tab rather than resume a duplicate. Audit H3.
export function focusTearOffWindowForTab(tabId) {
  for (const [, entry] of projectWindows) {
    if (!entry.isTearOff || !entry.win || entry.win.isDestroyed()) continue;
    // Match the torn tab OR any tab the tear-off window has grown since (its
    // persisted bucket). Without the bucket check, sidebar clicks on a live
    // extra tear-off tab fell through to the primary window or no-op'd
    // (Codex integration round, High).
    const owns = entry.tearOffTabId === tabId
      || (entry.tearOffTabId
          && (getTearOffWindowState(entry.tearOffTabId)?.tabs || []).some((t) => t.id === tabId));
    if (owns) {
      if (entry.win.isMinimized()) entry.win.restore();
      entry.win.show();
      entry.win.focus();
      return true;
    }
  }
  return false;
}

// Focus a project's already-open primary window (does NOT create one). Used when
// a sidebar tab is live in another same-project primary window. Audit H3.
// Focus the primary window that actually OWNS a tab's PTY (v1.0.66). With N
// windows on one project, a sidebar click on a live tab must reveal the RIGHT
// window, not just the first (Codex Medium). Matched by the owning webContents
// id, so it lands on the exact window even for an extra window.
export function focusWindowForTab(tabId) {
  if (typeof tabId !== 'string' || !tabId) return false;
  const ownerWcId = getTerminalWebContentsId(tabId);
  if (ownerWcId == null) return false;
  for (const [, entry] of projectWindows) {
    if (entry.isTearOff || !entry.win || entry.win.isDestroyed()) continue;
    if (entry.win.webContents.id === ownerWcId) {
      if (entry.win.isMinimized()) entry.win.restore();
      entry.win.show();
      entry.win.focus();
      return true;
    }
  }
  return false;
}

export function focusPrimaryWindowForProject(projectPath) {
  const win = getWindowForProject(projectPath);
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return true;
  }
  return false;
}

/**
 * Set up common window event handlers (bounds saving, close cleanup, etc.)
 * @param {BrowserWindow} win
 * @param {string} projectPath
 * @param {{ isTearOff?: boolean, tearOffTabId?: string }} options
 */
function setupWindowEvents(win, projectPath, { isTearOff = false, tearOffTabId = null, tearOffLabel = null, tearOffConfirmed = false, windowKey = 'main' } = {}) {
  // An EXTRA primary window (windowKey !== 'main') stores its own tabs + bounds
  // in config.primaryWindows[windowKey], so it must be restored and bounds-saved
  // per window rather than under the shared per-project config.
  const isExtraPrimary = !isTearOff && windowKey && windowKey !== 'main';
  // This window's webContents id, used to decide which PTYs it actually OWNS on
  // close. Ownership (entry.webContents.id, set on createTerminal + claim) is the
  // real predicate; registration ("a tear-off window exists for tab T") is not,
  // because an in-flight tear-off is registered BEFORE it claims T, so T is still
  // owned by this (source) window until the claim lands. Audit / Codex.
  const myWcId = win.webContents.id;
  // Keep window title after page sets <title>
  win.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  // Start file watchers for this window
  watchFiles(win.webContents);

  // Save window bounds on move/resize (debounced). Primary windows persist to
  // per-project config; tear-offs stash bounds on their projectWindows entry so
  // the tear-off restore reopens them in place (v1.0.46).
  let boundsTimer;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      if (isTearOff) {
        const entry = projectWindows.get(win.id);
        if (entry) { entry.bounds = win.getBounds(); persistOpenProjects(); }
      } else if (isExtraPrimary) {
        // Extra window: bounds live in its own primaryWindows bucket so each
        // of Brett's windows reopens where he left it (v1.0.66).
        setPrimaryWindowState(windowKey, { projectPath, bounds: win.getBounds() });
      } else {
        const config = getProjectConfig(projectPath) || {};
        config.windowBounds = win.getBounds();
        setProjectConfig(projectPath, config);
      }
    }, 300);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Graceful close: send Ctrl+C twice to Claude sessions so they print resume IDs,
  // save scrollback, then kill terminals. Prevents immediate PTY death on window X.
  let closingGracefully = false;
  win.on('close', (e) => {
    if (closingGracefully) return; // Phase 2, let it close

    // Updater-bypass: when the Restart button is firing app.quit() through
    // squirrel.mac, the bundle replace expects the app to exit FAST. Let
    // every window close immediately; will-quit + the updater branch of
    // before-quit handle PTY/server teardown. Without this bypass, the
    // graceful Ctrl+C+save dance can race the bundle replacement.
    if (getQuittingForUpdate && getQuittingForUpdate()) return;

    // Phase 1, intercept and do graceful shutdown
    e.preventDefault();
    closingGracefully = true;

    // Request scrollback save from renderer
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:requestSave');
    }

    // Determine which terminals to gracefully close (Ctrl+C for resume-ID +
    // scrollback):
    //  - tear-off: its one tab, but only if this window actually owns it (an
    //    aborted tear-off must not Ctrl+C the source window's live tab).
    //  - primary: its project terminals EXCEPT any that have a tear-off window.
    //    A tab being torn off is MOVING to its own window, so interrupting it
    //    here is wrong whether the tear-off ends up succeeding (it survives in
    //    the new window, so no interrupt) or failing (it is then killed with no
    //    window to save from anyway). The KILL decision below is ownership-based
    //    so a failed tear-off's tab is still cleaned up. Codex.
    // wasWindowOwned excludes deliberately-headless PTYs (voice-conductor
    // background agents, phone-spawned terminals) so closing a window never
    // Ctrl+C's a mid-task headless agent. Audit High.
    const termIds = isTearOff && tearOffTabId
      ? (getTerminalWebContentsId(tearOffTabId) === myWcId ? [tearOffTabId] : [])
      : (() => {
          const beingTornOff = getTearOffTabIdsForProject(projectPath);
          // Only THIS window's own terminals (v1.0.66): with N primary windows
          // on one project, getTerminalsForProject returns every window's tabs,
          // so an unscoped Ctrl+C here interrupted the OTHER windows' live
          // Claude sessions (Codex High). Ownership (wc id) scopes it; at
          // 'close' time this window's wc is still alive.
          return getTerminalsForProject(projectPath).filter((id) => !beingTornOff.has(id)
            && wasWindowOwned(id) && getTerminalWebContentsId(id) === myWcId);
        })();

    // Send Ctrl+C twice, wait for Claude to print resume ID, save scrollback, then close
    gracefulCloseTerminals(termIds).then(() => {
      // Request another save to capture the resume ID that Claude just printed
      if (!win.isDestroyed()) {
        win.webContents.send('terminal:requestSave');
      }
      // Brief delay for the save IPC to complete, then actually close
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.close(); // closingGracefully=true so this time it goes through
        }
      }, 500);
    });
  });

  // Clean up on close (runs after graceful close completes)
  win.on('closed', () => {
    projectWindows.delete(win.id);
    // A DELIBERATELY closed extra window: drop its tab bucket now so the
    // desktop sidebar + mobile aggregate stop showing its dead tabs
    // immediately, instead of waiting for the next config-load prune (Codex
    // Medium). Never during a quit/update (getQuitting/getQuittingForUpdate):
    // there the window must be PRESERVED for restore.
    if (isExtraPrimary && windowKey && !getQuitting() && !getQuittingForUpdate()) {
      try { deletePrimaryWindowState(windowKey); } catch { /* best-effort */ }
    }
    // Deliberately closed windows should NOT come back next launch. No-ops
    // during a quit (getQuitting), so the teardown cascade can't wipe the
    // restore list. v1.0.38.
    persistOpenProjects();

    // Auto-resume cancel: drop pending queue entries. A tear-off owns only its
    // torn tab, so cancel just that one; cancelling the whole project here would
    // silently kill the primary window's still-queued resumes. Audit M1.
    try {
      import('./auto-resume.js').then((m) => {
        if (isTearOff && tearOffTabId) {
          if (m?.cancelTabIfPending) m.cancelTabIfPending(tearOffTabId);
          else if (m?.cancelTabsForProject && getPrimaryWindowIdsForProject(projectPath).length === 0) m.cancelTabsForProject(projectPath);
        } else if (m?.cancelTabsForProject) {
          m.cancelTabsForProject(projectPath);
        }
      }).catch(() => {});
    } catch { /* noop */ }

    // If this is a tear-off window, kill the torn PTY ONLY if no LIVE window
    // still owns it (getTerminalWebContentsId returns the owner's webContents id,
    // or null once that webContents is destroyed). This one predicate covers:
    //  - normal tear-off close: this window owned it, now destroyed -> null -> kill
    //  - restored tear-off close: it created the PTY, now destroyed -> null -> kill
    //  - aborted/failed tear-off while the SOURCE window is still open: source
    //    still owns it -> non-null -> spared (must not kill the source's tab)
    //  - orphan (claim never happened AND the source window has since closed too):
    //    no live owner -> null -> kill, so an in-flight tear-off + source-close
    //    race can't leak a windowless PTY. Codex.
    if (isTearOff && tearOffTabId) {
      if (getTerminalWebContentsId(tearOffTabId) === null) killTerminal(tearOffTabId);
      return;
    }

    // v1.0.66: each primary window owns its OWN terminals (distinct tab ids +
    // PTYs per window), so we no longer bail when another primary window of the
    // project is still open. The ownership check below (=== null) already kills
    // ONLY the terminals no live window owns: this closed window's now-ownerless
    // PTYs get reaped while another open window's terminals (which read its live
    // wc id, not null) are spared. Bailing here leaked the closed window's PTYs
    // into main/mobile state (Codex High).

    // Kill every project terminal that no LIVE window still owns
    // (getTerminalWebContentsId === null). At this point our webContents is
    // destroyed, so terminals we owned now read null and are killed; a terminal
    // a tear-off has CLAIMED reads that live window's id and is SPARED (H1); an
    // in-flight tear-off's tab, still bound here, reads null and is killed
    // immediately rather than orphaned until the tear-off's timeout. Codex.
    // wasWindowOwned excludes deliberately-headless PTYs (voice-conductor
    // background agents, phone-spawned terminals) that were never bound to a
    // window, so closing a window can't reap a live background agent. Audit High.
    for (const id of getTerminalsForProject(projectPath)) {
      if (getTerminalWebContentsId(id) === null && wasWindowOwned(id)) killTerminal(id);
    }
  });

  // Record that this project/tear-off actually opened a window this session, so
  // merge-preserve won't resurrect it after a deliberate close (see above). Codex.
  if (isTearOff) { if (tearOffTabId) openedTearOffTabIdsThisSession.add(tearOffTabId); }
  else {
    openedProjectPathsThisSession.add(projectPath);
    if (windowKey && windowKey !== 'main') openedPrimaryWindowKeysThisSession.add(windowKey);
  }

  projectWindows.set(win.id, {
    projectPath, win, isTearOff,
    // windowKey identifies WHICH primary window this is: 'main' = the project's
    // first window (legacy bucket), or a unique key for an extra window whose
    // tabs live in config.primaryWindows[windowKey] (v1.0.66).
    windowKey: isTearOff ? null : windowKey,
    // Tear-offs carry the torn tab + label so the tear-off restore can recreate
    // exactly this window (project + tab) after a restart/update. v1.0.46.
    tearOffTabId: isTearOff ? tearOffTabId : null,
    tearOffLabel: isTearOff ? tearOffLabel : null,
    // A tear-off is "confirmed" once it truly owns its PTY: a RESTORED tear-off
    // creates its own PTY (confirmed from creation), and a DRAG tear-off becomes
    // confirmed when its terminal:claimPty succeeds (markTearOffConfirmed). Only
    // confirmed tear-offs are written to lastTearOffs, so an in-flight/unclaimed
    // drag tear-off (even after its source window closes and its PTY reads null)
    // is never resurrected as authoritative on next launch. Codex.
    tearOffConfirmed: isTearOff ? tearOffConfirmed : false,
    bounds: isTearOff && !win.isDestroyed() ? win.getBounds() : null,
  });
  // Record the new window immediately so any exit path can restore it.
  persistOpenProjects();
}

/**
 * Open a window for a project. If one already exists, focus it.
 * @param {string} projectPath
 * @returns {BrowserWindow}
 */
export function openProjectWindow(projectPath, opts = {}) {
  const { newWindow = false, windowKey: existingKey = null, bounds: restoreBounds = null } = opts;
  // Default open focuses the project's FIRST primary window (unchanged
  // behavior). A New Window request (newWindow) OR a restore of a saved extra
  // window (existingKey) always creates a fresh keyed window instead (v1.0.66,
  // Brett: 4 windows on one project folder).
  if (!newWindow && !existingKey) {
    const existing = getWindowForProject(projectPath);
    if (existing) {
      existing.focus();
      return existing;
    }
  }
  // windowKey: 'main' for the first window (legacy config.projects[path].tabs
  // bucket, zero migration); a unique key for every extra window (its own
  // config.primaryWindows[key] bucket). A restore passes the saved key back.
  const windowKey = existingKey || (newWindow ? randomKey() : 'main');
  const isExtra = windowKey !== 'main';

  const projectConfig = getProjectConfig(projectPath) || {};
  // Extra windows remember their own bounds (in the primaryWindows bucket);
  // the first window keeps using the per-project windowBounds.
  const bounds = restoreBounds || (isExtra ? {} : (projectConfig.windowBounds || {}));
  const folderName = path.basename(projectPath);

  const win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 860,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    title: `${folderName} | Dobius+`,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0D1117',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // BrowserPane (v1.0.25+) embeds <webview> for the dev-server preview.
      // Tag is sandboxed + isolated via partition string in BrowserPane.jsx.
      webviewTag: true,
    },
  });

  const isDev = !app.isPackaged;
  const encodedProject = encodeURIComponent(projectPath);
  // Only extra windows carry a windowKey; the first window's URL is unchanged
  // so its renderer code path is byte-identical to before.
  const wkParam = isExtra ? `&windowKey=${encodeURIComponent(windowKey)}` : '';
  if (isDev) {
    win.loadURL(`http://localhost:5173?project=${encodedProject}${wkParam}`);
  } else {
    const query = { project: projectPath };
    if (isExtra) query.windowKey = windowKey;
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query });
  }

  setupWindowEvents(win, projectPath, { windowKey });
  return win;
}

// Key for an extra primary window: EXACTLY `w-` + 8 lowercase alphanumerics.
// The fixed shape lets every id parser (main scrollback, mobile) right-anchor
// on `~w-XXXXXXXX-<counter>` so a `~` elsewhere in a real folder name can never
// be mistaken for the window marker (Codex High). Padded so it is always 8.
function randomKey() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i += 1) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `w-${s}`;
}

/**
 * Open a torn-off tab in its own window.
 * @param {string} projectPath
 * @param {string} tabId — the terminal tab ID being torn off
 * @param {string} tabLabel — display label for the tab
 * @param {number} screenX — cursor X position (screen coords)
 * @param {number} screenY — cursor Y position (screen coords)
 * @returns {BrowserWindow}
 */
// Shared creator for a torn-off tab window at explicit bounds. Used by the
// cursor-drag tear-off AND the launch-time tear-off restore (v1.0.46), so the
// two can't drift.
function createTornOffWindow(projectPath, tabId, tabLabel, bounds = {}, restore = false) {
  const folderName = path.basename(projectPath);
  // Count existing windows for this project to generate "folder (2)" style title
  const windowNumber = getWindowIdsForProject(projectPath).length + 1;
  const title = windowNumber > 1
    ? `${folderName} (${windowNumber}) | Dobius+`
    : `${folderName} | Dobius+`;

  const win = new BrowserWindow({
    width: bounds.width || 1100,
    height: bounds.height || 720,
    x: bounds.x,
    y: bounds.y,
    minWidth: 600,
    minHeight: 400,
    title,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0D1117',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // BrowserPane (v1.0.25+) embeds <webview> for the dev-server preview.
      // Tag is sandboxed + isolated via partition string in BrowserPane.jsx.
      webviewTag: true,
    },
  });

  const isDev = !app.isPackaged;
  // restore=true (launch-time recreate) tells the renderer to CREATE a fresh PTY
  // for this tab rather than CLAIM a live one: after a cold start there is no
  // torn-off PTY to claim, so a claim would leave a dead terminal. With create,
  // auto-resume then revives the session. v1.0.46 (Codex).
  if (isDev) {
    let query = `project=${encodeURIComponent(projectPath)}&tearOffTab=${encodeURIComponent(tabId)}&tearOffLabel=${encodeURIComponent(tabLabel)}`;
    if (restore) query += '&tearOffRestore=1';
    win.loadURL(`http://localhost:5173?${query}`);
  } else {
    const query = { project: projectPath, tearOffTab: tabId, tearOffLabel: tabLabel };
    if (restore) query.tearOffRestore = '1';
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query });
  }

  // A restored tear-off creates its OWN PTY on mount, so it owns its tab from
  // the start (confirmed). A drag tear-off must claim the source's PTY first, so
  // it stays unconfirmed until markTearOffConfirmed() on a successful claim. Codex.
  setupWindowEvents(win, projectPath, { isTearOff: true, tearOffTabId: tabId, tearOffLabel: tabLabel, tearOffConfirmed: restore });
  return win;
}

/**
 * Open a torn-off tab in its own window (cursor drag).
 * projectPath, tabId (terminal tab id being torn off), tabLabel (display label),
 * screenX / screenY (cursor position in screen coords). Returns the window.
 */
export function openTornOffWindow(projectPath, tabId, tabLabel, screenX, screenY) {
  // Position window near the cursor, offset so the title bar is under the cursor.
  const display = screen.getDisplayNearestPoint({ x: screenX, y: screenY });
  const x = Math.max(display.bounds.x, screenX - 200);
  const y = Math.max(display.bounds.y, screenY - 30);
  return createTornOffWindow(projectPath, tabId, tabLabel, { x, y, width: 1100, height: 720 });
}

/**
 * Recreate a torn-off tab window on launch from persisted state (Brett's
 * "Fix updating"). Positioned at its saved bounds. The renderer creates a fresh
 * terminal for tabId and auto-resume revives the session via the sessionTabMap.
 */
export function restoreTornOffWindow(projectPath, tabId, tabLabel, bounds) {
  return createTornOffWindow(projectPath, tabId, tabLabel, bounds || {}, true);
}

/** Single Visual preview window (phone-shaped, its own window so it never covers the terminal). */
let visualWindow = null;
let visualWindowProject = null;

function visualUrl(win, projectPath) {
  const isDev = !app.isPackaged;
  const encodedProject = encodeURIComponent(projectPath);
  if (isDev) {
    win.loadURL(`http://localhost:5173?project=${encodedProject}&visual=1`);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      query: { project: projectPath, visual: '1' },
    });
  }
}

/**
 * Open (or focus) the Visual preview window for a project. If a window is
 * already open for a DIFFERENT project, reload it to the requested project
 * (instead of silently showing the previous project).
 * @param {string} projectPath
 * @returns {BrowserWindow}
 */
export function openVisualWindow(projectPath) {
  if (visualWindow && !visualWindow.isDestroyed()) {
    if (visualWindowProject !== projectPath) {
      visualWindowProject = projectPath;
      visualUrl(visualWindow, projectPath);
      visualWindow.setTitle(`Visual — ${path.basename(projectPath)}`);
    }
    visualWindow.focus();
    return visualWindow;
  }

  const folderName = path.basename(projectPath);

  // Phone-shaped: 375 viewport + 8px bezel each side + panel padding, plus header/footer chrome.
  const win = new BrowserWindow({
    width: 431,
    height: 880,
    minWidth: 431,
    minHeight: 560,
    title: `Visual — ${folderName}`,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0D1117',
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  visualUrl(win, projectPath);

  win.on('closed', () => {
    visualWindow = null;
    visualWindowProject = null;
    // Stop the express server + chokidar watcher when the Visual window
    // closes. The renderer's visualStop IPC is not reliable once the
    // BrowserWindow is being destroyed (channel can die mid-flight), so
    // tear down from the main side too. Dynamic import to avoid a top-of-
    // file circular risk. Codex r28 P2.
    import('./visual-server.js').then((m) => {
      if (m?.stopVisualServer) m.stopVisualServer().catch(() => {});
    }).catch(() => {});
  });
  visualWindow = win;
  visualWindowProject = projectPath;
  return win;
}

export function getVisualWindow() {
  return (visualWindow && !visualWindow.isDestroyed()) ? visualWindow : null;
}

/** Destroy the Visual window if open (used on quit so its server can be torn down). */
export function closeVisualWindow() {
  if (visualWindow && !visualWindow.isDestroyed()) visualWindow.destroy();
  visualWindow = null;
  visualWindowProject = null;
}

/**
 * Get list of open project paths (deduplicated).
 * @returns {string[]}
 */
export function getOpenProjects() {
  const paths = new Set();
  for (const [, entry] of projectWindows) {
    if (!entry.win.isDestroyed()) {
      paths.add(entry.projectPath);
    }
  }
  return Array.from(paths);
}

/**
 * Close the primary window for a specific project.
 * @param {string} projectPath
 */
export function closeProjectWindow(projectPath) {
  const win = getWindowForProject(projectPath); // primary only
  if (win && !win.isDestroyed()) {
    win.close();
    return;
  }
  // No primary window (e.g. only a restored tear-off remains): close whatever
  // windows the project still has, so the launcher "Close Window" action stays
  // functional instead of no-opping. Codex.
  for (const [, entry] of projectWindows) {
    if (entry.projectPath === projectPath && entry.win && !entry.win.isDestroyed()) {
      entry.win.close();
    }
  }
}

/**
 * Close all project windows — called on app quit.
 * Uses destroy() to skip per-window graceful close (app quit already ran gracefulCloseAll).
 */
export function closeAllProjectWindows() {
  for (const [, entry] of projectWindows) {
    if (!entry.win.isDestroyed()) {
      entry.win.destroy(); // Skips 'close' event — prevents per-window graceful close
    }
  }
  projectWindows.clear();
}
