// The screen a tab's WINDOW shows, read from its xterm: the only complete copy.
//
// Everything else in main rebuilds a tab's screen from a bounded tail of its output (screen-render.js). Claude's
// renderer repaints only what changed, so on a tab that has been idle in a /loop for hours the prompt box's rules were
// drawn long before that tail begins: the rebuilt screen shows no box, and every dobius-send or team message to that
// idle tab was refused or held for hours ("not at its prompt", bug reports from Muzikmaker's Mac, 2026-11-10/11). The
// window's xterm was written every byte, hidden tabs included, so it still has the box.
//
// The request goes down the same webContents channel as the tab's output, after it, and the renderer answers only once
// xterm has parsed everything queued before it (write('', cb)), so the answer includes all output main had sent when it
// asked. A tab with no window (a phone-spawned PTY), a closed window or a renderer that does not answer in time gives
// null, and the caller keeps the tail's screen.

const TIMEOUT_MS = 1500;
const MAX_PENDING = 32; // bounded: a renderer that never answers cannot pile requests up
const MAX_ROWS = 500;
const MAX_COLS = 2000;

const pending = new Map(); // nonce -> { wcId, id, resolve, timer }
let counter = 0;

/** Wire the reply channel once (main.js). */
export function initWindowScreen(ipcMain) {
  ipcMain.on('terminal:screenReply', (event, nonce, id, snap) => {
    const p = pending.get(nonce);
    // Only the window that was asked, about the tab it was asked about.
    if (!p || p.wcId !== event.sender.id || p.id !== id) return;
    finish(nonce, validSnapshot(snap));
  });
}

function finish(nonce, value) {
  const p = pending.get(nonce);
  if (!p) return;
  pending.delete(nonce);
  clearTimeout(p.timer);
  p.resolve(value);
}

// Per-row facts (shared/screen-rows.js) carried as the tail render carries them: non-enumerable on the lines.
const INT_FACTS = ['ends', 'dimFrom', 'firstWords'];

/**
 * { lines, cursor } with lines and cursor bounded, else null. `lines` carries the row facts (dimFrom: where Claude's
 * dim ghost suggestion starts, firstColored, ends, firstWords) when the window sent them whole and well formed; a
 * missing or malformed set is dropped, never half kept.
 */
export function validSnapshot(snap) {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.lines)) return null;
  const n = snap.lines.length;
  if (n === 0 || n > MAX_ROWS) return null;
  if (!snap.lines.every((l) => typeof l === 'string' && l.length <= MAX_COLS)) return null;
  const c = snap.cursor;
  const cursor = c && Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= 0 && c.y >= 0 && c.y < n
    ? { x: c.x, y: c.y } : null;
  const lines = snap.lines.slice();
  const okInts = (a) => Array.isArray(a) && a.length === n && a.every((v) => Number.isInteger(v) && v >= -1 && v <= MAX_COLS);
  const okBools = (a) => Array.isArray(a) && a.length === n && a.every((v) => typeof v === 'boolean');
  if (INT_FACTS.every((k) => okInts(snap[k])) && okBools(snap.firstColored)) {
    for (const k of INT_FACTS) Object.defineProperty(lines, k, { value: snap[k].slice() });
    Object.defineProperty(lines, 'firstColored', { value: snap.firstColored.slice() });
  }
  return { lines, cursor };
}

/**
 * Ask the window that owns `id` for its screen. `wc` is that window's webContents (or null). Resolves the snapshot or
 * null; never rejects.
 */
export function requestWindowScreen(id, wc) {
  if (!wc || wc.isDestroyed?.() || pending.size >= MAX_PENDING) return Promise.resolve(null);
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  const nonce = `ws${counter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(nonce, null), TIMEOUT_MS);
    pending.set(nonce, { wcId: wc.id, id, resolve, timer });
    try { wc.send('terminal:screenRequest', nonce, id); } catch { finish(nonce, null); }
  });
}

export const _pendingCount = () => pending.size; // tests
