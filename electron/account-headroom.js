// How much room each Claude account has left, how fast it is going, and when
// it runs out; and the rules for moving a tab to another account (by hand or
// automatically when the tab hits a limit). Pure: no electron, no clock, no
// fs. main.js feeds it usage records (claude-usage.js), the account list and
// identities (account-identity.js), and acts on what it decides.
//
// Sam runs several Claude Max logins and had five tabs hit the 5-hour limit
// at once on one of them, while the others sat idle.
//
// The numbers come from the statusLine reporter: per session, LAST REPORTED
// usage per window (five_hour, seven_day, ...), each with its resets_at. Two
// facts shape everything here:
//  - Within one window (one resets_at) usage only grows. So a lower reading
//    that arrives later is an older figure republished (Claude re-renders
//    status lines for many reasons, and a second session can carry an older
//    cache), never a drop. History keeps the FIRST time each new value was
//    seen, which is the closest thing to a measurement time the payload has.
//  - A reading is a LOWER bound. Usage on claude.ai or another Mac counts
//    against the same limit and never reaches this Mac. So an account with no
//    reading is Unknown, never 0%, and a reading nobody is refreshing is
//    labelled stale.

import { keychainServiceFor, configDirForAccount } from './account-identity.js';

export const HISTORY_VERSION = 1;
const MAX_KEYS = 40;
const MAX_WINDOWS = 8;
const MAX_SAMPLES = 120;
// resets_at is fixed for a window; this only absorbs rounding.
const SAME_WINDOW_S = 60;
const MIN_PACE_SPAN_MS = 10 * 60_000;
const KEEP_SINCE_MS = 8 * 24 * 3600_000;
export const PACE_LOOKBACK_MS = { five_hour: 60 * 60_000, default: 24 * 60 * 60_000 };
// A known reading this old, with no session running on it, is flagged stale.
export const STALE_MS = 15 * 60_000;

const KEY_RE = /^Claude Code-credentials(?:-[0-9a-f]{8})?$/;
// Window names come from the payload. A name that is not a plain identifier
// (or that could be __proto__) is ignored rather than used as a key.
const WINDOW_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const isCredentialKey = (k) => typeof k === 'string' && KEY_RE.test(k);
export const isWindowName = (n) => typeof n === 'string' && WINDOW_RE.test(n);

const bare = () => Object.create(null);
export const emptyHistory = () => ({ v: HISTORY_VERSION, keys: bare() });

/**
 * Rebuild a history read from disk, keeping only well-formed parts. Anything
 * odd is dropped, never trusted: the file sits in userData, but a bad write
 * or an older build must not be able to poison the math.
 */
export function sanitizeHistory(raw) {
  const out = emptyHistory();
  if (!raw || typeof raw !== 'object' || raw.v !== HISTORY_VERSION || !raw.keys || typeof raw.keys !== 'object') return out;
  for (const key of Object.keys(raw.keys).slice(0, MAX_KEYS)) {
    if (!isCredentialKey(key)) continue;
    const src = raw.keys[key]?.windows;
    if (!src || typeof src !== 'object') continue;
    const windows = bare();
    for (const name of Object.keys(src).slice(0, MAX_WINDOWS)) {
      if (!isWindowName(name)) continue;
      const w = src[name];
      if (!w || typeof w !== 'object' || !Array.isArray(w.samples)) continue;
      // A window with no reset time never expires: an older build could save
      // one, and it would read as a known figure forever.
      if (typeof w.r !== 'number' || !Number.isFinite(w.r)) continue;
      const r = w.r;
      const samples = [];
      for (const s of w.samples.slice(-MAX_SAMPLES)) {
        if (!s || !Number.isFinite(s.t) || !Number.isFinite(s.p)) continue;
        if (samples.length && (s.t < samples[samples.length - 1].t || s.p <= samples[samples.length - 1].p)) continue;
        samples.push({ t: s.t, p: Math.max(0, Math.min(100, s.p)) });
      }
      if (!samples.length) continue;
      const seenAt = Number.isFinite(w.seenAt) ? Math.max(w.seenAt, samples[samples.length - 1].t) : samples[samples.length - 1].t;
      windows[name] = { r, samples, seenAt };
    }
    if (Object.keys(windows).length || Number.isFinite(raw.keys[key]?.since)) {
      const email = raw.keys[key]?.email;
      const since = raw.keys[key]?.since;
      const ignore = bare();
      const rawIgnore = raw.keys[key]?.ignore;
      if (rawIgnore && typeof rawIgnore === 'object') {
        for (const sid of Object.keys(rawIgnore).slice(0, MAX_IGNORED)) {
          if (SID_RE.test(sid) && typeof rawIgnore[sid] === 'string' && rawIgnore[sid].length <= 2000) ignore[sid] = rawIgnore[sid];
        }
      }
      out.keys[key] = {
        windows,
        ...(typeof email === 'string' && email.length <= 320 ? { email } : {}),
        ...(Number.isFinite(since) ? { since } : {}),
        ...(Object.keys(ignore).length ? { ignore } : {}),
      };
    }
  }
  return out;
}

/**
 * The login a credential's history belongs to. Re-logging one profile folder
 * into another login (the Switch job, or /login in a tab) keeps the
 * Keychain service but changes whose limit the numbers describe, so the old
 * login's samples are dropped rather than carried over. Returns whether it
 * changed anything.
 */
// What a record says, for telling a republished figure from a new one.
const figureOf = (windows) => JSON.stringify(Object.keys(windows || {}).sort()
  .map((n) => [n, windows[n]?.usedPercentage, windows[n]?.resetsAt]));
const SID_RE = /^[A-Za-z0-9_-]{1,100}$/;
// Every session with a record on the folder (records older than 8 days are
// pruned, so this is far above what one folder ever has).
const MAX_IGNORED = 1000;

// A credential whose owner cannot be told. Its figures are cleared when it
// becomes this, and none are kept while it stays this.
export const UNKNOWN_LOGIN = '(unknown login)';

export function noteLogin(hist, key, email, now, records = []) {
  if (!isCredentialKey(key) || typeof email !== 'string' || !email.trim()) return false;
  const k = hist.keys[key];
  if (!k) return false;
  const who = email.trim().toLowerCase();
  if (k.email === who) return false;
  // Never owned, and now unknown: figures from a sample that created this key
  // cannot be attributed either.
  // Records the old login's sessions left on disk keep their old figures;
  // anything received before the change is ignored from now on.
  // Never owned and now unknown is a boundary too: figures from the sample
  // that created this key cannot be attributed to whoever comes next.
  if ((k.email && k.email !== who) || (!k.email && who === UNKNOWN_LOGIN)) {
    k.windows = bare();
    k.since = now;
    // A session still running on the folder keeps re-rendering the OLD
    // login's cached figure (with a fresh file time) until its next API
    // call. Its records are ignored while they say exactly what they said at
    // the re-login.
    k.ignore = bare();
    for (const r of Array.isArray(records) ? records : []) {
      if (r?.key !== key || !SID_RE.test(String(r.sessionId || ''))) continue;
      if (Object.keys(k.ignore).length >= MAX_IGNORED) break;
      k.ignore[r.sessionId] = figureOf(r.windows);
    }
  }
  k.email = who;
  return true;
}

const expired = (r, now) => r !== null && r * 1000 <= now;

/**
 * Fold usage records (claude-usage.js readUsageRecords) into the history.
 * Mutates `hist`; returns whether anything changed, so the caller writes the
 * file only when it must.
 */
export function updateHistory(hist, records, now) {
  let changed = false;
  const sorted = (Array.isArray(records) ? records : [])
    .filter((r) => r && isCredentialKey(r.key) && r.windows && Number.isFinite(r.receivedAt))
    .sort((a, b) => a.receivedAt - b.receivedAt);
  for (const rec of sorted) {
    for (const name of Object.keys(rec.windows)) {
      if (!isWindowName(name)) continue;
      const w = rec.windows[name];
      const p = w?.usedPercentage;
      if (!Number.isFinite(p)) continue;
      // A figure with no reset time cannot be placed in a window, and would
      // never expire: it is not kept.
      const r = Number.isFinite(w.resetsAt) ? w.resetsAt : null;
      if (r === null || expired(r, now)) continue;
      let k = hist.keys[rec.key];
      if (k?.since && rec.receivedAt < k.since) continue; // from before a re-login (noteLogin)
      if (k?.email === UNKNOWN_LOGIN) continue; // nobody to attribute it to until the login is known again
      if (k?.ignore && typeof rec.sessionId === 'string' && rec.sessionId in k.ignore) {
        if (k.ignore[rec.sessionId] === figureOf(rec.windows)) continue;
        delete k.ignore[rec.sessionId]; // a new figure: that session made a call on the new login
      }
      if (!k) { k = { windows: bare() }; hist.keys[rec.key] = k; changed = true; }
      let ent = k.windows[name];
      if (ent && r !== null && ent.r !== null) {
        if (r < ent.r - SAME_WINDOW_S) continue; // a reading from a window already over
        if (r > ent.r + SAME_WINDOW_S) ent = null; // a new window: the old one's samples say nothing about it
      } else if (ent && r !== ent.r) {
        ent = null; // one side has no reset time: cannot be shown to be the same window
      }
      if (!ent) {
        ent = { r, samples: [], seenAt: 0 };
        k.windows[name] = ent;
        changed = true;
      }
      if (rec.receivedAt > ent.seenAt) { ent.seenAt = rec.receivedAt; changed = true; }
      const last = ent.samples[ent.samples.length - 1];
      if (!last || p > last.p) {
        ent.samples.push({ t: last ? Math.max(last.t, rec.receivedAt) : rec.receivedAt, p });
        if (ent.samples.length > MAX_SAMPLES) ent.samples.splice(0, ent.samples.length - MAX_SAMPLES);
        changed = true;
      }
    }
  }
  if (pruneHistory(hist, now)) changed = true;
  return changed;
}

/** Drop windows past their reset, empty keys, and the oldest beyond the caps. */
export function pruneHistory(hist, now) {
  let changed = false;
  // A key kept only for its re-login boundary (no windows, `since`) counts
  // as recent as that boundary, so the cap cannot evict it first and let the
  // old login's records refill it.
  const latest = (k) => Math.max(0, k.since || 0, ...Object.values(k.windows).map((w) => w.seenAt));
  for (const key of Object.keys(hist.keys)) {
    const k = hist.keys[key];
    for (const name of Object.keys(k.windows)) {
      if (expired(k.windows[name].r, now)) { delete k.windows[name]; changed = true; }
    }
    const names = Object.keys(k.windows);
    if (names.length > MAX_WINDOWS) {
      names.sort((a, b) => k.windows[b].seenAt - k.windows[a].seenAt).slice(MAX_WINDOWS)
        .forEach((n) => { delete k.windows[n]; });
      changed = true;
    }
    // An emptied key is kept while it still remembers a re-login (since), so
    // the old login's records on disk cannot refill it.
    if (!Object.keys(k.windows).length && !(k.since && now - k.since < KEEP_SINCE_MS)) { delete hist.keys[key]; changed = true; }
  }
  const keys = Object.keys(hist.keys);
  if (keys.length > MAX_KEYS) {
    keys.sort((a, b) => latest(hist.keys[b]) - latest(hist.keys[a])).slice(MAX_KEYS)
      .forEach((key) => { delete hist.keys[key]; });
    changed = true;
  }
  return changed;
}

/**
 * Percent per hour over the last `lookbackMs` of this window, ending at the
 * last report. null when there is not enough history to say (under ten
 * minutes of it). 0 is an answer: it has not moved.
 */
export function paceFor(ent, lookbackMs) {
  const s = ent?.samples;
  if (!Array.isArray(s) || !s.length) return null;
  const end = ent.seenAt;
  const start = end - lookbackMs;
  let refT;
  let refP;
  if (s[0].t >= start) { refT = s[0].t; refP = s[0].p; }
  else {
    refT = start;
    refP = s[0].p;
    for (const x of s) { if (x.t <= start) refP = x.p; else break; }
  }
  const span = end - refT;
  if (span < MIN_PACE_SPAN_MS) return null;
  return Math.max(0, (s[s.length - 1].p - refP) / (span / 3_600_000));
}

/**
 * When this window reaches 100% at the current pace, capped by its reset.
 * `{ limited, until }` at 100, `{ unknown }` with no pace, `{ steady }` when
 * it is not climbing, `{ resetsFirst }` when the reset comes before 100,
 * else `{ at }` (epoch ms).
 */
export function forecastFor({ p, pace, seenAt, resetsAt }) {
  if (p >= 100) return { limited: true, until: resetsAt ? resetsAt * 1000 : null };
  if (pace === null || pace === undefined) return { unknown: true };
  if (pace <= 0) return { steady: true };
  const at = seenAt + ((100 - p) / pace) * 3_600_000;
  if (resetsAt && at >= resetsAt * 1000) return { resetsFirst: true };
  return { at };
}

/**
 * Usage for one credential key, from the history: every window still inside
 * its reset, with its pace and forecast.
 */
export function usageForKey(hist, key, now) {
  const k = isCredentialKey(key) ? hist?.keys?.[key] : null;
  const windows = bare();
  let lastReportedAt = 0;
  if (k) {
    for (const name of Object.keys(k.windows)) {
      const ent = k.windows[name];
      if (expired(ent.r, now) || !ent.samples.length) continue;
      const p = ent.samples[ent.samples.length - 1].p;
      const pace = paceFor(ent, PACE_LOOKBACK_MS[name] ?? PACE_LOOKBACK_MS.default);
      windows[name] = { used: p, resetsAt: ent.r, pace, forecast: forecastFor({ p, pace, seenAt: ent.seenAt, resetsAt: ent.r }) };
      lastReportedAt = Math.max(lastReportedAt, ent.seenAt);
    }
  }
  // Known only with a live five-hour figure: that is the window a limit
  // usually hits first, and without it the weekly figure says nothing about
  // whether the next message goes through.
  const known = !!windows.five_hour;
  const used = Object.values(windows).map((w) => w.used);
  return {
    known,
    windows,
    lastReportedAt: lastReportedAt || null,
    ageMs: lastReportedAt ? Math.max(0, now - lastReportedAt) : null,
    headroom: known ? Math.max(0, 100 - Math.max(...used)) : null,
    limited: used.some((u) => u >= 100),
  };
}

/**
 * The Default row plus every Claude account, each with its config dir and
 * the Keychain service its sessions report under. That service is the
 * attribution: the reporter records CLAUDE_CONFIG_DIR, parseRecord derives
 * the service with keychainServiceFor, and this derives it for the account
 * the same way, so a report lands on the account whose credential the
 * session actually used. Aligned 1:1 with `accounts` (null where it is not a
 * usable Claude account); ids are user-influenced and never used as keys.
 */
export function accountKeyRows(accounts, { defaultDir }) {
  const list = Array.isArray(accounts) ? accounts : [];
  const keyOf = (dir) => { try { return keychainServiceFor(dir); } catch { return null; } };
  const rows = list.map((a) => {
    if (a?.type !== 'claude') return null;
    const dir = configDirForAccount(a);
    if (!dir || !dir.startsWith('/')) return null;
    return { id: typeof a.id === 'string' ? a.id : null, label: (typeof a.name === 'string' && a.name.trim()) || a.id || 'Account', dir, key: keyOf(dir) };
  });
  return { default: { id: null, label: 'Default', dir: defaultDir, key: keyOf(defaultDir) }, accounts: rows };
}

/**
 * Why a tab may NOT move to `target`, or null when it may.
 * source/target: { key, email }; target also { login: 'in'|'out'|'unknown' }.
 * Same credential, or the same login under two names (one quota), gains
 * nothing; a target with no credential would stop at a login prompt.
 */
export function moveRefusal(source, target) {
  if (!target || !target.key) return 'that account has no usable profile folder';
  if (source?.key && source.key === target.key) return 'the tab is already on that account';
  const a = typeof source?.email === 'string' ? source.email.trim().toLowerCase() : '';
  const b = typeof target.email === 'string' ? target.email.trim().toLowerCase() : '';
  if (a && b && a === b) return `that is the same login (${target.email}) as the tab's current account, so it shares the same limit`;
  if (target.login !== 'in') return target.login === 'out' ? 'that account is not logged in' : 'could not confirm that account is logged in';
  return null;
}

/**
 * Candidates ordered best first: known headroom (most first, the fresher
 * reading on a tie), then every unknown. Each candidate:
 * { ...row, usage: usageForKey(...), refusal: moveRefusal(...) }.
 */
export function rankTargets(candidates) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((x, y) => {
    const kx = x.usage?.known ? 1 : 0;
    const ky = y.usage?.known ? 1 : 0;
    if (kx !== ky) return ky - kx;
    if (kx) {
      if (y.usage.headroom !== x.usage.headroom) return y.usage.headroom - x.usage.headroom;
      return (y.usage.lastReportedAt || 0) - (x.usage.lastReportedAt || 0);
    }
    return 0;
  });
}

/**
 * Does a process's environment text (ps eww: argv, then NAME=value pairs)
 * set `name` differently from Dobius's own value (`fallback`: what an unset
 * variable means)? For USER: does it select a different Keychain account? Claude picks
 * its item by USER, falling back to the OS user name when it is unset.
 * 'USER' when it does, null when it provably does not, 'unreadable' when the
 * text cannot say: USER= appearing twice (an argument or another variable's
 * value can contain it), or no own user to compare with. A value counts as
 * ours only if it is exactly ours, followed by the next NAME= or the end.
 */
export function envOverrideIn(text, name, own, fallback) {
  if (typeof text !== 'string' || !own) return 'unreadable';
  const hits = [...text.matchAll(new RegExp(`(?:^|\\s)${name}=`, 'g'))];
  if (hits.length > 1) return 'unreadable';
  if (hits.length === 0) return fallback === own ? null : name;
  const rest = text.slice(hits[0].index + hits[0][0].length).replace(/\s+$/, '');
  if (rest === own) return null;
  if (!rest.startsWith(own)) return name;
  return /^\s+[A-Za-z_][A-Za-z0-9_]*=/.test(rest.slice(own.length)) ? null : name;
}

export const userOverrideIn = (text, ownUser, osUser) => envOverrideIn(text, 'USER', ownUser, osUser);

// ---- auto-move ----------------------------------------------------------

/**
 * Is a tab mid-turn? A permission prompt ('needs') always is. 'working' only
 * counts while output is still arriving: the hook marks a tab working at
 * UserPromptSubmit and a turn that dies on a limit may never send the Stop
 * that clears it, so a stale 'working' must not pin a limited tab forever.
 * Claude animates its spinner for the whole of a real turn.
 */
export const BUSY_OUTPUT_MS = 10_000;
export function tabBusy(activity, now) {
  if (!activity) return false;
  if (activity.status === 'needs') return true;
  return activity.status === 'working' && Number.isFinite(activity.lastActivityAt) && now - activity.lastActivityAt < BUSY_OUTPUT_MS;
}

export const AUTO = {
  COOLDOWN_MS: 5 * 60_000,
  TYPED_RECENTLY_MS: 30_000,
  // A resume re-sends the whole conversation with a cold prompt cache on the
  // new account, so a sliver of headroom is gone on the first turn.
  MIN_HEADROOM: 10,
  GLOBAL_MAX: 10,
  GLOBAL_WINDOW_MS: 10 * 60_000,
  // Without a 100% report, the screen vouches only for a limit that just
  // happened: a limit line can sit there long after the window reset.
  SCREEN_FRESH_MS: 10 * 60_000,
  // What one moved tab is assumed to take from its target within one pass,
  // so five tabs that hit a limit together do not all pile onto one account.
  RESERVE_PER_TAB: 15,
  // After a limit hit, its account counts as limited for this long even if
  // its last report said otherwise (that report predates the hit).
  LIMITED_HOLD_MS: 30 * 60_000,
};

/**
 * Why the AUTOMATIC path will not pick this candidate, on top of
 * moveRefusal: it needs both logins known and different, because two profile
 * folders logged into one login share one limit and a folder with no
 * recorded address cannot be shown to be different.
 */
export function autoRefusal(source, target, { fresh = false } = {}) {
  const a = typeof source?.email === 'string' ? source.email.trim() : '';
  const b = typeof target?.email === 'string' ? target.email.trim() : '';
  if (!a || !b) return 'its login address (or the tab\'s) is not recorded, so it cannot be shown to be a different login';
  // An old figure nobody is refreshing is only a lower bound: claude.ai or
  // another Mac may have used the rest since. Shown, never acted on.
  if (!fresh) return 'its usage was not reported recently and no session is running on it';
  return null;
}

/**
 * Is this usage live enough to act on: reported in the last STALE_MS, or a
 * session is running on the credential right now (it reports after each
 * turn). `running` is null when the process scan could not say.
 */
export function freshUsage(usage, running) {
  if (!usage?.known) return false;
  if (Number.isFinite(usage.ageMs) && usage.ageMs <= STALE_MS) return true;
  return Number.isInteger(running) && running > 0;
}

/**
 * Claude's own record of a limit hit, from the END of a session transcript:
 * the newest user or assistant entry (meta entries and sidechains skipped) is
 * the synthetic assistant message Claude writes when a request is refused for
 * a limit (`isApiErrorMessage: true, error: 'rate_limit'`, text "You've hit
 * your 5-hour limit · resets 6am"). Anything written after it (a "continue",
 * a reply) means the tab has moved on. Returns { at, text } or null.
 */
export function limitFromEntries(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e || typeof e !== 'object') continue;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isSidechain || e.isMeta) continue;
    if (e.type !== 'assistant' || e.isApiErrorMessage !== true || e.error !== 'rate_limit') return null;
    const at = Date.parse(e.timestamp);
    if (!Number.isFinite(at)) return null;
    const c = e.message?.content;
    const text = Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : (typeof c === 'string' ? c : '');
    return { at, text: String(text).slice(0, 200) };
  }
  return null;
}

// Claude's limit lines: "You've hit your 5-hour limit · resets 6am", the older
// "session limit", "weekly limit", "Opus limit", and "Usage limit reached".
// Words may be separated by any run of spaces: the screen is drawn with
// cursor moves, not literal spaces.
export const LIMIT_LINE_RE = /You['’]ve\s+hit\s+your\s+(?:[\w-]+\s+){0,3}limit|Usage\s+limit\s+reached/i;
// The live region: Claude's latest output sits just above its prompt box at
// the bottom of the screen. Rows above this are scrollback in all but name.
export const LIVE_REGION_ROWS = 20;

/**
 * The limit line in the bottom drawn rows, or null: LIVE_REGION_ROWS, or the
 * terminal's own height when that is smaller (the render grid is taller than
 * the real screen, and rows above the real screen are scrollback).
 */
export function liveLimitLine(lines, termRows = null) {
  if (!Array.isArray(lines)) return null;
  const span = Number.isInteger(termRows) && termRows > 0 ? Math.min(termRows, LIVE_REGION_ROWS) : LIVE_REGION_ROWS;
  let last = lines.length - 1;
  while (last >= 0 && !String(lines[last] || '').trim()) last -= 1;
  for (let i = last; i >= 0 && i > last - span; i -= 1) {
    const row = String(lines[i] || '');
    if (LIMIT_LINE_RE.test(row)) return row.trim().slice(0, 200);
  }
  return null;
}

/**
 * Should this tab move now, and where?
 *
 * in: {
 *   enabled, now,
 *   limit: { at } | null          the transcript's limit record (the event)
 *   processStartedAt: number|null when the claude now in the tab started
 *   corroboration: { screen, statusLine }  the limit line is in this tab's live
 *                                 screen region (required: nothing else says
 *                                 THIS conversation is limited, /clear leaves
 *                                 the old record behind with --resume still in
 *                                 argv); the usage report reads 100% (needed
 *                                 too once the limit is more than a few minutes old)
 *   draft: boolean                Claude's input box holds unsent text
 *   busy: boolean                 a permission prompt is open, or Claude drew
 *                                 something in the last few seconds (a turn
 *                                 runs its spinner the whole time)
 *   inputAgeMs: number            since a person (or anything) last wrote to the tab
 *   tabState: { handled: Set<eventId>, lastMoveAt }
 *   recentMoves: number[]         times of every auto-move, all tabs
 *   ranked: rankTargets(...)      candidates, refusals filled in
 * }
 * out: { action: 'none'|'wait'|'move'|'notice', reason, eventId?, target? }
 * 'wait' means look again soon (the person is typing, the turn is still going);
 * 'none' means this event is settled or not one.
 */
export function decideAutoMove(inp) {
  const { enabled, now, limit, processStartedAt, corroboration, draft, busy, inputAgeMs, tabState, recentMoves, ranked } = inp;
  if (!enabled) return { action: 'none', reason: 'auto-move is off' };
  if (!limit || !Number.isFinite(limit.at)) return { action: 'none', reason: 'no limit record' };
  const eventId = `${limit.at}`;
  // The limit has to have happened to the claude running NOW. A resumed
  // conversation's transcript still ends in the limit its previous process
  // hit (on the account it left) until something new is written; after a
  // manual move or a relaunch nothing else remembers that. ps reports a
  // start time rounded DOWN to the second, so a limit in that same second
  // may still be the previous process's: a second of margin (no process
  // reaches a limit within a second of starting).
  if (Number.isFinite(processStartedAt) && limit.at < processStartedAt + 1000) return { action: 'none', reason: 'the limit predates this Claude process', eventId };
  if (!corroboration?.screen) return { action: 'none', reason: 'the limit is not on this tab\'s screen', eventId };
  if (!corroboration?.statusLine && now - limit.at >= AUTO.SCREEN_FRESH_MS) return { action: 'none', reason: 'an old limit the usage report does not confirm', eventId };
  if (tabState?.handled?.has(eventId)) return { action: 'none', reason: 'already handled', eventId };
  if (tabState?.lastMoveAt && limit.at <= tabState.lastMoveAt) return { action: 'none', reason: 'the limit predates the last move', eventId };
  if (tabState?.lastMoveAt && now - tabState.lastMoveAt < AUTO.COOLDOWN_MS) return { action: 'wait', reason: 'moved recently', eventId };
  if (busy) return { action: 'wait', reason: 'the tab is busy', eventId };
  if (Number.isFinite(inputAgeMs) && inputAgeMs < AUTO.TYPED_RECENTLY_MS) return { action: 'wait', reason: 'someone typed in the tab recently', eventId };
  // A respawn throws away whatever sits unsent in the input box.
  if (draft) return { action: 'wait', reason: 'there is unsent text in the prompt', eventId };
  const recent = (recentMoves || []).filter((t) => now - t < AUTO.GLOBAL_WINDOW_MS);
  if (recent.length >= AUTO.GLOBAL_MAX) return { action: 'wait', reason: 'too many automatic moves in the last few minutes', eventId };
  const target = (ranked || []).find((c) => !c.refusal && !c.autoRefusal && c.usage?.known && !c.usage.limited && c.usage.headroom >= AUTO.MIN_HEADROOM);
  if (!target) return { action: 'notice', reason: 'every other account is limited, nearly limited, or its usage is unknown', eventId };
  return { action: 'move', reason: 'limit hit', eventId, target };
}
