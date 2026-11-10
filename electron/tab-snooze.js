// Snoozed tabs (Brett, Asana 1220362133877230). Snoozing closes a tab (its terminal stops, so it costs no memory)
// and keeps what is needed to bring it back: label, project, kind, and the Claude session it was on. When its time
// comes the entry turns `ready` and the project's window takes it back as a tab resuming that session; with no window
// open it waits as ready until one opens.
//
// Main owns the list so one timer serves every window, and `take` is the single point where an entry leaves: two
// windows of the same project asking at once get it once.
//
// Bounded by construction: at most MAX_SNOOZED entries (config.snoozedTabs, metadata only), each with at most one
// scrollback file of SCROLLBACK_LINES lines under <userData>/snoozed/, deleted when the entry leaves; one timer, armed
// for the earliest wake and never further out than TIMER_MAX_MS.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { isAbsPath } from '../shared/platform.js';
import { sanitizeAccountPin } from '../shared/tab-label.js';

export const MAX_SNOOZED = 100;
const SCROLLBACK_LINES = 200;
const LINE_MAX = 4000;
const TIMER_MAX_MS = 6 * 60 * 60 * 1000; // re-armed from there, and setTimeout's 24.8-day ceiling never matters
const ID_RE = /^[0-9a-f]{16}$/;
const SESSION_RE = /^[a-zA-Z0-9][\w-]{0,99}$/;

/** Pure: a stored entry made safe, or null. Everything here came from a renderer or a config file. */
export function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) return null;
  if (typeof e.projectPath !== 'string' || !isAbsPath(e.projectPath) || /[\x00-\x1F\x7F]/.test(e.projectPath)) return null;
  const out = {
    id: e.id,
    projectPath: e.projectPath,
    label: typeof e.label === 'string' && e.label.trim() ? e.label.slice(0, 100) : 'Tab',
    kind: e.kind === 'browser' ? 'browser' : 'terminal',
    snoozedAt: Number.isFinite(e.snoozedAt) ? e.snoozedAt : Date.now(),
    until: Number.isFinite(e.until) ? e.until : null,
    ready: e.ready === true,
  };
  if (typeof e.labelLocked === 'boolean') out.labelLocked = e.labelLocked;
  if (e.pinned === true) out.pinned = true;
  if (out.kind === 'browser' && typeof e.url === 'string' && /^https?:\/\//i.test(e.url)) out.url = e.url.slice(0, 4000);
  if (e.viewMode === 'chat') out.viewMode = 'chat';
  const pin = sanitizeAccountPin(e.claudeAccountPin);
  if (pin) out.claudeAccountPin = pin;
  if (typeof e.sessionId === 'string' && SESSION_RE.test(e.sessionId)
    && typeof e.cwd === 'string' && isAbsPath(e.cwd) && !/[\x00-\x1F\x7F]/.test(e.cwd)) {
    out.sessionId = e.sessionId;
    out.cwd = e.cwd;
  }
  if (typeof e.preview === 'string' && e.preview.trim()) out.preview = e.preview.trim().slice(0, 200);
  return out;
}

/** Pure: entries whose time has come and are not ready yet. */
export function dueIds(entries, now) {
  return entries.filter((e) => !e.ready && e.until != null && e.until <= now).map((e) => e.id);
}

/** Pure: ms until the next wake to arm for, or null when nothing is waiting on a time. */
export function nextDelay(entries, now) {
  let next = null;
  for (const e of entries) if (!e.ready && e.until != null && (next === null || e.until < next)) next = e.until;
  if (next === null) return null;
  return Math.min(Math.max(0, next - now), TIMER_MAX_MS);
}

/**
 * @param {object} deps
 * @param {() => object} deps.load      the config object (config-manager loadConfig)
 * @param {(c: object) => void} deps.save
 * @param {string} deps.dir             where scrollback files go (<userData>/snoozed)
 * @param {() => void} deps.onChange    told after every change (main broadcasts snooze:changed)
 * @param {() => number} [deps.now]
 */
export function createSnoozeStore({ load, save, dir, onChange, now = Date.now }) {
  let timer = null;

  const read = () => {
    const raw = load().snoozedTabs;
    return Array.isArray(raw) ? raw.map(cleanEntry).filter(Boolean).slice(0, MAX_SNOOZED) : [];
  };
  const write = (entries) => {
    const c = load();
    c.snoozedTabs = entries;
    save(c);
  };
  const fileFor = (id) => path.join(dir, `${id}.json`);
  const removeFile = (id) => {
    try { fs.rmSync(fileFor(id), { force: true }); } catch (err) { console.warn(`[snooze] could not remove ${id}: ${err.message}`); }
  };

  const changed = () => {
    arm();
    try { onChange(); } catch (err) { console.warn('[snooze] change listener failed:', err?.message || err); }
  };

  // Due entries turn ready; then the timer is armed for the next one.
  function checkDue() {
    const entries = read();
    const due = new Set(dueIds(entries, now()));
    if (due.size === 0) { arm(); return; }
    write(entries.map((e) => (due.has(e.id) ? { ...e, ready: true } : e)));
    changed();
  }

  function arm() {
    if (timer) clearTimeout(timer);
    timer = null;
    const delay = nextDelay(read(), now());
    if (delay === null) return;
    timer = setTimeout(checkDue, delay);
    timer.unref?.();
  }

  return {
    list: read,
    checkDue,
    start: arm,
    stop() { if (timer) clearTimeout(timer); timer = null; },

    /** Adds an entry; returns its id, or null when it is not valid or the list is full. */
    add(fields, scrollback) {
      const entries = read();
      if (entries.length >= MAX_SNOOZED) return null;
      const id = crypto.randomBytes(8).toString('hex');
      const until = Number.isFinite(fields?.until) ? fields.until : null;
      const entry = cleanEntry({ ...fields, id, snoozedAt: now(), until, ready: until != null && until <= now() });
      if (!entry) return null;
      if (Array.isArray(scrollback) && scrollback.length > 0) {
        const lines = scrollback.slice(-SCROLLBACK_LINES).map((l) => String(l).slice(0, LINE_MAX));
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fileFor(id), JSON.stringify(lines), { mode: 0o600 });
        } catch (err) {
          console.warn(`[snooze] scrollback not kept for ${id}: ${err.message}`);
        }
      }
      write([...entries, entry]);
      changed();
      return id;
    },

    /**
     * Removes an entry and returns it with its scrollback; null if another caller took it first. `onlyReady`: null
     * unless it is still ready (a window returning due tabs from a list it read a moment ago, during which the entry
     * may have been snoozed again).
     */
    take(id, { onlyReady = false } = {}) {
      const entries = read();
      const entry = entries.find((e) => e.id === id);
      if (!entry || (onlyReady && !entry.ready)) return null;
      let scrollback = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(fileFor(id), 'utf8'));
        if (Array.isArray(parsed)) scrollback = parsed.slice(-SCROLLBACK_LINES).map((l) => String(l));
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[snooze] scrollback for ${id} unreadable: ${err.message}`);
      }
      write(entries.filter((e) => e.id !== id));
      removeFile(id);
      changed();
      return { entry, scrollback };
    },

    /** A new time (null: until brought back), or now: ready at once. */
    setTime(id, until) {
      const entries = read();
      if (!entries.some((e) => e.id === id)) return false;
      const u = Number.isFinite(until) ? until : null;
      write(entries.map((e) => (e.id === id ? { ...e, until: u, ready: u != null && u <= now() } : e)));
      changed();
      return true;
    },

    discard(id) {
      const entries = read();
      if (!entries.some((e) => e.id === id)) return false;
      write(entries.filter((e) => e.id !== id));
      removeFile(id);
      changed();
      return true;
    },

    /** Scrollback files with no entry (a crash between the two writes): removed at start. */
    sweepOrphans() {
      let names;
      try { names = fs.readdirSync(dir); } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`[snooze] could not list ${dir}: ${err.message}`);
        return;
      }
      const keep = new Set(read().map((e) => e.id));
      for (const n of names) {
        const m = /^([0-9a-f]{16})\.json$/.exec(n);
        if (m && !keep.has(m[1])) removeFile(m[1]);
      }
    },
  };
}
