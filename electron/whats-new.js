// The one-time "What's new" popup after an update (Sam, 2026-11-11: "shouldnt we have a pop up after every update to
// say whats new or updated?"). Notes are electron/whats-new/<version>.md (whats-new-notes.js has the rules).
//
// MAIN decides which window shows it, never the windows themselves (Codex design review, findings 2 and 3): a window
// says it is listening (`whatsNew:ready`, sent once its tabs have had a moment to restore), and main sends the notes
// to the FOCUSED listening window, only after the launch's window restore has finished. One window at a time: if that
// window closes or its page dies before Continue, the next focused listening window gets them; if it reloads, it gets
// them again.
//
// State: config.whatsNew = { seen: '<version>' }. An OBJECT on purpose: a renderer's whole-config save only copies
// top-level scalars (config-manager mergeForeignScalars), so a stale snapshot can never undo a dismissal (finding 4).
// Only packaged builds or an isolated harness (DOBIUS_USERDATA_DIR) take part: a dev copy running next to the real app
// on the same userData would show the notes twice and race the write (finding 5).
import { app, BrowserWindow, ipcMain } from 'electron';
import { loadConfig, saveConfig, configExistedAtStart } from './config-manager.js';
import { readAllNotes, plan, isVersion, compareVersions } from './whats-new-notes.js';

let enabled = false;
let pending = null; // { sections: [{ version, bullets }] } until Continue
let shownTo = null; // webContents id of the window showing it now
let restoreDone = false;
const ready = new Set(); // webContents ids listening for it
const watched = new Set(); // webContents ids we put lifecycle listeners on (one set each, ever)
let notesCache = null;

function notes() {
  if (!notesCache) {
    const { notes: n, bad } = readAllNotes();
    if (bad.length) console.warn('[whats-new] notes skipped:', bad.join('; '));
    notesCache = n;
  }
  return notesCache;
}

function seenOf(config) {
  const w = config?.whatsNew;
  return w && typeof w === 'object' && !Array.isArray(w) && isVersion(w.seen) ? w.seen : null;
}

// Raises `seen` to v, never lowers it (a downgrade and back must not re-show notes already read).
// Through the normal debounced save. Accepted: a crash in the half second after Continue shows the notes once more
// (a synchronous write here could still lose to an older async write already in flight; Codex).
function recordSeen(v) {
  try {
    const c = loadConfig();
    const prev = seenOf(c);
    if (prev && compareVersions(prev, v) >= 0) return;
    const w = c.whatsNew && typeof c.whatsNew === 'object' && !Array.isArray(c.whatsNew) ? c.whatsNew : {};
    c.whatsNew = { ...w, seen: v };
    saveConfig(c);
  } catch (err) {
    console.warn('[whats-new] could not record the version as seen:', err?.message || err);
  }
}

function offer() {
  if (!enabled || !pending || shownTo != null || !restoreDone) return;
  const win = BrowserWindow.getFocusedWindow();
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!ready.has(wc.id)) return;
  shownTo = wc.id;
  wc.send('whatsNew:show', pending);
}

function forget(id) {
  ready.delete(id);
  if (shownTo === id) shownTo = null;
  offer();
}

function watch(wc) {
  if (watched.has(wc.id)) return;
  watched.add(wc.id);
  const id = wc.id;
  wc.once('destroyed', () => { watched.delete(id); forget(id); });
  // A crashed or reloaded page shows nothing; it says ready again once it is back, and main picks the focused window
  // again then (a reload must not hand the notes back to a window that is now behind another one; Codex).
  wc.on('render-process-gone', () => forget(id));
  wc.on('did-navigate', () => forget(id));
}

// The launch's window restore has finished (main.js, after the last staggered window opened).
export function whatsNewRestoreDone() {
  restoreDone = true;
  offer();
}

export function initWhatsNew() {
  enabled = app.isPackaged || !!process.env.DOBIUS_USERDATA_DIR;

  // The Updates tab shows this version's notes in every build.
  ipcMain.handle('whatsNew:current', () => {
    const v = app.getVersion();
    const bullets = notes().get(v);
    return bullets ? { version: v, bullets } : null;
  });
  ipcMain.on('whatsNew:ready', (event) => {
    if (!enabled) return;
    const wc = event.sender;
    watch(wc);
    // Saying ready again (a reload) gives up any earlier claim: the focused window is picked afresh.
    if (shownTo === wc.id) shownTo = null;
    ready.add(wc.id);
    offer();
  });
  ipcMain.on('whatsNew:dismiss', (event) => {
    if (!enabled || !pending || event.sender.id !== shownTo) return;
    pending = null;
    shownTo = null;
    recordSeen(app.getVersion());
  });
  // The window stopped listening (its popup unmounted, or another overlay holds its keyboard): it is offered the notes
  // again only after it says ready, and if it held them another window may show them.
  ipcMain.on('whatsNew:release', (event) => {
    if (!enabled) return;
    ready.delete(event.sender.id);
    if (shownTo === event.sender.id) shownTo = null;
    offer();
  });
  app.on('browser-window-focus', () => offer());

  if (!enabled) return;
  const p = plan({ current: app.getVersion(), seen: seenOf(loadConfig()), existedAtStart: configExistedAtStart(), notes: notes() });
  if (p.newSeen) recordSeen(p.newSeen);
  if (p.sections.length) pending = { sections: p.sections };
}
