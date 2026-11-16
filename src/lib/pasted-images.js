// Clickable [Image #N] in the terminal (Asana 1220551275244579, Bryan: "I post an image and completely forget what I
// put inside of that"). Claude Code keeps no copy Dobius can look up by that number, and the number shares a counter
// with pasted text blocks, so it cannot be worked out from paste order. What Dobius does know: every image pasted into a
// tab is saved to <temp>/dobius-clipboard/clipboard-<ms>.<ext> before its path goes into Claude's prompt, and Claude
// then draws a NEW [Image #N] for it. So the paste notes which label appeared, per tab, and the link provider below
// makes only those labels clickable. A label Dobius did not see appear (pasted elsewhere, dropped from Finder) stays
// plain text. A path sent from the command bar is typed, not pasted, so Claude reads it as a file and draws no label
// (checked on 2.1.325); nothing is watched then.
//
// ponytail: the number is per Claude session but the map is per tab, newest paste wins. After /clear or a new session in
// the same tab, an old [Image #2] in the scrollback opens the newer #2. Upgrade path: key by session id once the
// renderer knows it.

const STORE_KEY = 'dobius.pastedImages.v1';
const MAX_PER_TAB = 30; // labels remembered per tab (paths only, a few hundred bytes)
const MAX_TABS = 40; // tabs remembered; the oldest-touched tab is dropped first
const LABEL_RE = /\[Image #(\d{1,4})\]/g;
const WATCH_MS = 4000;
const WATCH_EVERY_MS = 120;

let cache = null;
function load() {
  if (cache) return cache;
  cache = {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [tab, rows] of Object.entries(parsed)) {
        if (Array.isArray(rows?.list)) cache[tab] = { at: Number(rows.at) || 0, list: rows.list.filter((r) => Array.isArray(r) && Number.isInteger(r[0]) && typeof r[1] === 'string').slice(-MAX_PER_TAB) };
      }
    }
  } catch (err) {
    console.warn('[pasted-images] stored labels unreadable, starting empty:', err?.message || err);
  }
  return cache;
}
function save() {
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(cache || {})); } catch (err) {
    console.warn('[pasted-images] could not save labels:', err?.message || err);
  }
}

/** Remember that `[Image #n]` in this tab is the file at `path`. */
export function recordImageLabel(tabId, n, path) {
  if (typeof tabId !== 'string' || !Number.isInteger(n) || n < 1 || typeof path !== 'string') return;
  const all = load();
  const entry = all[tabId] || { at: 0, list: [] };
  entry.list = entry.list.filter((r) => r[0] !== n).concat([[n, path]]).slice(-MAX_PER_TAB);
  entry.at = Date.now();
  all[tabId] = entry;
  const tabs = Object.keys(all);
  if (tabs.length > MAX_TABS) {
    tabs.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    for (const t of tabs.slice(0, tabs.length - MAX_TABS)) delete all[t];
  }
  save();
}

/** The saved file for `[Image #n]` in this tab, or null. */
export function imageForLabel(tabId, n) {
  const row = load()[tabId]?.list.find((r) => r[0] === n);
  return row ? row[1] : null;
}

// One buffer row as text plus, for each character, the cell column it starts in (wide characters take two cells, so
// a string index is not a column).
function rowWithColumns(line, cols) {
  let text = '';
  const colAt = [];
  for (let x = 0; x < cols; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // the right half of a wide character
    const ch = cell.getChars() || ' ';
    for (let i = 0; i < ch.length; i += 1) colAt.push(x);
    text += ch;
  }
  return { text, colAt };
}

/** Every [Image #N] number on the visible screen. */
export function labelsOnScreen(term) {
  const out = new Set();
  const buf = term?.buffer?.active;
  if (!buf) return out;
  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y += 1) {
    const line = buf.getLine(y);
    if (!line) continue;
    for (const m of line.translateToString(true).matchAll(LABEL_RE)) out.add(Number(m[1]));
  }
  return out;
}

/**
 * After image paths were pasted into Claude's prompt: wait for the new [Image #N]
 * labels Claude draws and record them, oldest path to lowest new number. `before` is labelsOnScreen() taken before the
 * paths went in. Claude's counter only goes up, so new labels are numbers above everything that was on screen. Gives up
 * quietly after `ms` (a label it never saw stays plain text).
 */
export function watchForImageLabels(tabId, getTerm, paths, before, ms = WATCH_MS) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string');
  if (!list.length) return;
  const floor = Math.max(0, ...before);
  const started = Date.now();
  const tick = () => {
    const seen = [...labelsOnScreen(getTerm())].filter((n) => n > floor && !before.has(n)).sort((x, y) => x - y);
    const done = seen.length >= list.length;
    if (done || (Date.now() - started >= ms && seen.length)) {
      // Fewer labels than paths: the newest labels belong to the newest paths.
      const pairs = seen.slice(-list.length);
      list.slice(-pairs.length).forEach((p, i) => recordImageLabel(tabId, pairs[i], p));
      return;
    }
    if (Date.now() - started < ms) setTimeout(tick, WATCH_EVERY_MS);
  };
  setTimeout(tick, WATCH_EVERY_MS);
}

/** An xterm link provider that turns known [Image #N] labels into links calling onOpen(path, n). */
export function imageLinkProvider(term, getTabId, onOpen) {
  return {
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1);
      const tabId = getTabId();
      if (!line || !tabId || !load()[tabId]) { callback(undefined); return; }
      const { text, colAt } = rowWithColumns(line, term.cols);
      const links = [];
      for (const m of text.matchAll(LABEL_RE)) {
        const n = Number(m[1]);
        const path = imageForLabel(tabId, n);
        if (!path) continue;
        const start = colAt[m.index];
        const end = colAt[m.index + m[0].length - 1];
        if (start === undefined || end === undefined) continue;
        links.push({
          range: { start: { x: start + 1, y: lineNumber }, end: { x: end + 1, y: lineNumber } },
          text: m[0],
          decorations: { underline: true, pointerCursor: true },
          activate: () => onOpen(path, n),
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
