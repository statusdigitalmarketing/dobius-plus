// Recording stand-ins for what bridge-open-main.js imports from electron and
// from the window, terminal, chat and data services (see
// bridge-open-main-loader.mjs). Tests drive IPC through `emit` and `invoke`.

// electron
export const app = { focus: () => {}, getPath: () => '/private/tmp/dobius-bridge-main-test' };
const listeners = new Map(); // channel -> [fn]
const handlers = new Map(); // channel -> fn
export const ipcMain = {
  on: (ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, []); listeners.get(ch).push(fn); },
  handle: (ch, fn) => { handlers.set(ch, fn); },
};
/** Send an ipcRenderer.send message to main from `wc`. */
export function emit(ch, wc, ...args) { for (const fn of listeners.get(ch) || []) fn({ sender: wc }, ...args); }
/** An ipcRenderer.invoke from `wc`; undefined when main has no handler. */
export function invoke(ch, wc, ...args) { const fn = handlers.get(ch); return fn ? fn({ sender: wc }, ...args) : undefined; }

// A window's webContents. `onSend(ch, ...args)` plays the page.
let wcIds = 100;
export function fakeWebContents(onSend = () => {}) {
  const evs = new Map();
  const wc = {
    id: wcIds += 1,
    destroyed: false,
    sent: [],
    send: (ch, ...args) => { wc.sent.push([ch, ...args]); onSend(ch, ...args); },
    on: (ev, fn) => { if (!evs.has(ev)) evs.set(ev, new Set()); evs.get(ev).add(fn); },
    once: (ev, fn) => wc.on(ev, fn),
    removeListener: (ev, fn) => evs.get(ev)?.delete(fn),
    fire: (ev) => { for (const fn of [...(evs.get(ev) || [])]) fn(); },
    isDestroyed: () => wc.destroyed,
  };
  return wc;
}

// window-manager
export const windows = new Map(); // projectPath -> { win, closing }
export const openedWindows = []; // projects openProjectWindow created a window for
/** What openProjectWindow builds for a project with no window (set by a test). */
export const windowFactory = { make: () => ({ webContents: fakeWebContents() }) };
const fakeWin = (wc) => ({ webContents: wc, isDestroyed: () => false, isMinimized: () => false, restore: () => {}, show: () => {}, focus: () => {} });
export function addWindow(projectPath, wc) {
  const entry = { win: fakeWin(wc), closing: false };
  windows.set(projectPath, entry);
  return entry;
}
export function openProjectWindow(projectPath) {
  if (windows.has(projectPath)) return windows.get(projectPath).win;
  openedWindows.push(projectPath);
  return addWindow(projectPath, windowFactory.make().webContents).win;
}
export function primaryDockTarget(projectPath) {
  const e = windows.get(projectPath);
  return e ? { win: e.win } : null;
}
export function getWindowEntryByWcId(id) {
  for (const e of windows.values()) if (e.win.webContents.id === id) return e;
  return null;
}
export function getOpenProjects() { return [...windows.keys()]; }

// terminal-manager
export const terminals = new Map(); // tabId -> { pid, cwd, wcId }
const inputObservers = new Set();
export function terminalInstance(id) { return terminals.get(id) || null; }
export function getTerminalBuffer() { return ''; }
export function terminalCols() { return 80; }
export function subscribeTerminal() { return { ok: true, unsubscribe: () => {} }; }
export function trimToEscapeBoundary(s) { return s; }
export function getTerminalWebContentsId(id) { return terminals.get(id)?.wcId ?? null; }
export const written = [];
export function writeTerminal(id, data) {
  written.push([id, data]);
  for (const fn of inputObservers) fn(id, data);
}
export function listTerminals() { return [...terminals].map(([id, t]) => ({ id, pid: t.pid, cwd: t.cwd })); }
export async function getProcessCwd() { return null; }
export function addInputObserver(fn) { inputObservers.add(fn); return () => inputObservers.delete(fn); }
export function terminalClosing() { return false; }

// chat-service
export const pendingSubmits = new Set();
export function submitPending(id) { return pendingSubmits.has(id); }

// data-service
export async function listProjects() { return []; }
