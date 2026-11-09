// How much room each Claude account has left, how fast it is going, when it
// runs out, and the rule for moving a tab to another account. Pure: the service
// (account-headroom-service.js) feeds it usage records and identities.
//
// Numbers come from the statusLine reporter: per session, LAST REPORTED usage
// per window (five_hour, seven_day, ...), each with its resets_at.
//  - Within one window usage only grows, so a lower reading that arrives later
//    is an older figure republished, never a drop. History keeps the FIRST time
//    each new value was seen, the closest thing to a measurement time there is.
//  - A reading is a LOWER bound: claude.ai or another Mac count against the same
//    limit and never reach this Mac. So no reading is Unknown, never 0%, and a
//    reading nobody is refreshing is labelled stale.

import { keychainServiceFor, configDirForAccount } from './account-identity.js';

export const HISTORY_VERSION = 1;
const MAX_KEYS = 40;
const MAX_WINDOWS = 8;
const MAX_SAMPLES = 120;
// resets_at is fixed for a window; this only absorbs rounding.
const SAME_WINDOW_S = 60;
const MIN_PACE_SPAN_MS = 10 * 60_000;
export const PACE_LOOKBACK_MS = { five_hour: 60 * 60_000, default: 24 * 60 * 60_000 };
// A known reading this old, with no session running on it, is flagged stale.
export const STALE_MS = 15 * 60_000;
// Claude animates its spinner for the whole of a real turn.
export const BUSY_OUTPUT_MS = 10_000;

const KEY_RE = /^Claude Code-credentials(?:-[0-9a-f]{8})?$/;
// Window names come from the payload. A name that is not a plain identifier
// (or that could be __proto__) is ignored rather than used as a key.
const WINDOW_RE = /^[a-z][a-z0-9_]{0,39}$/;
const SID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_IGNORED = 1000;
export const isCredentialKey = (k) => typeof k === 'string' && KEY_RE.test(k);
export const isWindowName = (n) => typeof n === 'string' && WINDOW_RE.test(n);

const bare = () => Object.create(null);
export const emptyHistory = () => ({ v: HISTORY_VERSION, keys: bare() });

/** Rebuild a history read from disk, keeping only well-formed parts. */
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
      // A window with no reset time would read as a known figure forever.
      if (typeof w.r !== 'number' || !Number.isFinite(w.r)) continue;
      const samples = [];
      for (const s of w.samples.slice(-MAX_SAMPLES)) {
        if (!s || !Number.isFinite(s.t) || !Number.isFinite(s.p)) continue;
        if (samples.length && (s.t < samples[samples.length - 1].t || s.p <= samples[samples.length - 1].p)) continue;
        samples.push({ t: s.t, p: Math.max(0, Math.min(100, s.p)) });
      }
      if (!samples.length) continue;
      const newest = samples[samples.length - 1].t;
      windows[name] = { r: w.r, samples, seenAt: Number.isFinite(w.seenAt) ? Math.max(w.seenAt, newest) : newest };
    }
    const { email, since, ignore: rawIgnore } = raw.keys[key];
    if (!Object.keys(windows).length && !Number.isFinite(since) && typeof email !== 'string') continue;
    const ignore = bare();
    for (const sid of Object.keys(rawIgnore && typeof rawIgnore === 'object' ? rawIgnore : {}).slice(0, MAX_IGNORED)) {
      if (SID_RE.test(sid) && typeof rawIgnore[sid] === 'string' && rawIgnore[sid].length <= 2000) ignore[sid] = rawIgnore[sid];
    }
    out.keys[key] = {
      windows,
      ...(typeof email === 'string' && email.length <= 320 ? { email } : {}),
      ...(Number.isFinite(since) ? { since } : {}),
      ...(Object.keys(ignore).length ? { ignore } : {}),
    };
  }
  return out;
}

// What a record says, for telling a republished figure from a new one.
const figureOf = (windows) => JSON.stringify(Object.keys(windows || {}).sort()
  .map((n) => [n, windows[n]?.usedPercentage, windows[n]?.resetsAt]));

// A credential whose owner cannot be told. Its figures are cleared when it
// becomes this, and none are kept while it stays this.
export const UNKNOWN_LOGIN = '(unknown login)';

/**
 * The login a credential's history belongs to. Re-logging one profile folder
 * into another login (the Switch job, or /login in a tab) keeps the Keychain
 * service but changes whose limit the numbers describe, so the old login's
 * samples are dropped rather than carried over. Returns whether it changed
 * anything.
 */
export function noteLogin(hist, key, email, now, records = []) {
  if (!isCredentialKey(key) || typeof email !== 'string' || !email.trim()) return false;
  const who = email === UNKNOWN_LOGIN ? email : email.trim().toLowerCase();
  const k = hist.keys[key];
  // No entry yet: remember who it is now, so figures that arrive later are
  // that login's and a later login is seen as a change. Records already on disk
  // may be an earlier login's, so they count only once refreshed (known limit 1,
  // docs/account-usage-and-move.md).
  if (!k) {
    hist.keys[key] = { windows: bare(), email: who, since: now };
    return true;
  }
  if (k.email === who) return false;
  if (k.email || who === UNKNOWN_LOGIN) {
    k.windows = bare();
    k.since = now;
    // A session still running on the folder keeps re-rendering the OLD
    // login's cached figure (with a fresh file time) until its next API call.
    // Its records are ignored while they say exactly what they said at the
    // re-login (known limit 7).
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

const expired = (r, now) => r * 1000 <= now;

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
    let k = hist.keys[rec.key];
    if (k?.since && rec.receivedAt < k.since) continue; // from before a re-login (noteLogin)
    if (k?.email === UNKNOWN_LOGIN) continue; // nobody to attribute it to until the login is known again
    if (k?.ignore && typeof rec.sessionId === 'string' && rec.sessionId in k.ignore) {
      if (k.ignore[rec.sessionId] === figureOf(rec.windows)) continue;
      delete k.ignore[rec.sessionId]; // a new figure: that session made a call on the new login
      changed = true;
    }
    for (const name of Object.keys(rec.windows)) {
      if (!isWindowName(name)) continue;
      const w = rec.windows[name];
      const p = w?.usedPercentage;
      // A figure with no reset time cannot be placed in a window, and would
      // never expire: it is not kept.
      if (!Number.isFinite(p) || !Number.isFinite(w.resetsAt) || expired(w.resetsAt, now)) continue;
      const r = w.resetsAt;
      if (!k) { k = { windows: bare() }; hist.keys[rec.key] = k; changed = true; }
      let ent = k.windows[name];
      if (ent && r < ent.r - SAME_WINDOW_S) continue; // a reading from a window already over
      if (!ent || r > ent.r + SAME_WINDOW_S) { // a new window: the old one's samples say nothing about it
        ent = { r, samples: [], seenAt: 0 };
        k.windows[name] = ent;
        changed = true;
      }
      const last = ent.samples[ent.samples.length - 1];
      if (last && p < last.p) continue; // an older figure republished: it confirms nothing (known limit 2)
      if (rec.receivedAt > ent.seenAt) { ent.seenAt = rec.receivedAt; changed = true; }
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

/** Drop windows past their reset, and empty keys that remember nothing. */
export function pruneHistory(hist, now) {
  let changed = false;
  for (const key of Object.keys(hist.keys)) {
    const k = hist.keys[key];
    for (const name of Object.keys(k.windows)) {
      if (expired(k.windows[name].r, now)) { delete k.windows[name]; changed = true; }
    }
    // An empty key is kept while it names its login: forgetting that would let
    // a later login inherit figures.
    if (!Object.keys(k.windows).length && !k.email) { delete hist.keys[key]; changed = true; }
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
  if (p >= 100) return { limited: true, until: resetsAt * 1000 };
  if (pace === null || pace === undefined) return { unknown: true };
  if (pace <= 0) return { steady: true };
  const at = seenAt + ((100 - p) / pace) * 3_600_000;
  if (at >= resetsAt * 1000) return { resetsFirst: true };
  return { at };
}

/**
 * Usage for one login, from the history of every credential key it reports
 * under (one login under two folders is one limit): every window still inside
 * its reset, with its own age, pace and forecast. Within a window the highest
 * figure stands, whichever folder reported it, and a later window replaces an
 * earlier one.
 */
export function usageForKeys(hist, keys, now) {
  const windows = bare();
  for (const key of keys) {
    const k = isCredentialKey(key) ? hist?.keys?.[key] : null;
    if (!k) continue;
    for (const name of Object.keys(k.windows)) {
      const ent = k.windows[name];
      if (expired(ent.r, now) || !ent.samples.length) continue;
      const p = ent.samples[ent.samples.length - 1].p;
      const cur = windows[name];
      if (cur && ent.r < cur.resetsAt - SAME_WINDOW_S) continue;
      if (cur && ent.r <= cur.resetsAt + SAME_WINDOW_S && (p < cur.used || (p === cur.used && ent.seenAt <= cur.reportedAt))) continue;
      const pace = paceFor(ent, PACE_LOOKBACK_MS[name] ?? PACE_LOOKBACK_MS.default);
      windows[name] = { used: p, resetsAt: ent.r, reportedAt: ent.seenAt, ageMs: Math.max(0, now - ent.seenAt), pace, forecast: forecastFor({ p, pace, seenAt: ent.seenAt, resetsAt: ent.r }) };
    }
  }
  // Known with any live figure: real accounts often report only seven_day, and
  // each window shows on its own (a missing one reads Unknown). The headline age
  // is the five-hour figure's when there is one: a weekly-only report must not
  // make an old five-hour figure look fresh.
  const list = Object.values(windows);
  const known = list.length > 0;
  const lastReportedAt = windows.five_hour ? windows.five_hour.reportedAt : Math.max(0, ...list.map((w) => w.reportedAt));
  return {
    known,
    windows,
    lastReportedAt: lastReportedAt || null,
    ageMs: lastReportedAt ? Math.max(0, now - lastReportedAt) : null,
    headroom: known ? Math.max(0, 100 - Math.max(...list.map((w) => w.used))) : null,
    limited: list.some((w) => w.used >= 100),
  };
}

/**
 * The Default row plus every Claude account, each with its config dir and the
 * Keychain service its sessions report under (parseRecord derives it the same
 * way, so a report lands on the account whose credential the session used).
 * Aligned 1:1 with `accounts`, null where it is not a usable Claude account.
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
 * source/target: { key, email, login: 'in'|'out'|'unknown' }.
 * The same credential, or the same login under two names (one quota), gains
 * nothing; a target with no credential would stop at a login prompt. A login
 * nobody can name cannot be shown to be a different one, so it is refused too.
 * The one exception is a source that has no credential at all: it is on no
 * login, so it cannot share one.
 */
export function moveRefusal(source, target) {
  if (!target?.key) return 'that account has no usable profile folder';
  if (source?.key && source.key === target.key) return 'the tab is already on that account';
  if (target.login !== 'in') return target.login === 'out' ? 'that account is not logged in' : 'could not confirm that account is logged in';
  const b = typeof target.email === 'string' ? target.email.trim().toLowerCase() : '';
  if (!b) return 'could not tell which login that account is, so it cannot be shown to be a different login';
  if (source?.login === 'out') return null;
  const a = typeof source?.email === 'string' ? source.email.trim().toLowerCase() : '';
  if (!a) return 'could not tell which login this tab is on, so that account cannot be shown to be a different login';
  if (a === b) return `that is the same login (${target.email}) as the tab's current account, so it shares the same limit`;
  return null;
}

/**
 * Candidates ordered best first: known headroom (most first, the fresher
 * reading on a tie), then every unknown.
 */
export function rankTargets(candidates) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((x, y) => {
    const kx = x.usage?.known ? 1 : 0;
    const ky = y.usage?.known ? 1 : 0;
    if (kx !== ky) return ky - kx;
    if (!kx) return 0;
    if (y.usage.headroom !== x.usage.headroom) return y.usage.headroom - x.usage.headroom;
    return (y.usage.lastReportedAt || 0) - (x.usage.lastReportedAt || 0);
  });
}

// Auto-move on limit (opt-in, Settings > Accounts > Account usage). The move is
// the dialog's (moveOne); these are only the extra rules for doing it unasked.
export const AUTO = {
  // A tab moved automatically is left alone this long, whatever happens next.
  COOLDOWN_MS: 15 * 60_000,
  // Never into an account with less than this left: a resume re-sends the whole
  // conversation with a cold cache on the new account.
  MIN_HEADROOM: 20,
  // A login just seen on its limit menu is not a target until its five-hour
  // window resets, or for a whole five-hour window when that is not known,
  // even if its last report (which predates the hit) says otherwise.
  HOLD_MS: 5 * 3600_000,
  // No automatic move while the tab had input this recently.
  QUIET_MS: 30_000,
  // Until a moved tab reports, assume it takes this much from its target, so
  // tabs that hit a limit together do not all pile onto one account.
  RESERVE_PER_MOVE: 15,
  RESERVE_MS: 10 * 60_000,
  // A window forecast to run out sooner than this counts as near its limit.
  NEAR_MS: 30 * 60_000,
};

/**
 * Why the automatic move will not use candidate `c` (candidatesFor's shape), or
 * null. On top of the dialog's refusal: a known five-hour figure, room in
 * every window, not held, and not forecast to run out soon. Unknown is never a target:
 * it is not 0%.
 */
export function autoTargetRefusal(c, { now, held = false, reserved = 0 } = {}) {
  if (c?.refusal) return c.refusal;
  const u = c?.usage;
  if (!u?.known) return 'its usage is unknown';
  // Weekly-only figures (real records often carry nothing else) say nothing
  // about the five-hour limit, which is the one a carry-on runs into first.
  if (!Number.isFinite(u.windows?.five_hour?.used)) return 'its five-hour use is unknown';
  if (u.limited) return 'it is at its limit';
  if (held) return 'it hit its limit and has not reset since';
  if (u.headroom - reserved < AUTO.MIN_HEADROOM) return `it has less than ${AUTO.MIN_HEADROOM}% left`;
  const soon = Object.values(u.windows || {}).some((w) => Number.isFinite(w?.forecast?.at) && w.forecast.at - now < AUTO.NEAR_MS);
  return soon ? 'it is forecast to reach its limit within half an hour' : null;
}

/**
 * The account to move a limited tab to, or null: the candidate with the most
 * room once recent automatic moves into it are counted. `heldFor(c)` and
 * `reservedFor(c)` come from the service's memory.
 */
export function pickAutoTarget(candidates, { now, heldFor = () => false, reservedFor = () => 0 } = {}) {
  let best = null;
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const reserved = reservedFor(c);
    if (autoTargetRefusal(c, { now, held: heldFor(c), reserved })) continue;
    const room = c.usage.headroom - reserved;
    if (!best || room > best.room) best = { c, room };
  }
  return best ? best.c : null;
}

/**
 * Until when a login seen on its limit menu is no target: its five-hour
 * window's reset when a live figure names one, else a whole five-hour window.
 * A weekly-only report says nothing about when a five-hour limit lifts, and a
 * hold that lapsed early sent tabs back and forth between two logins that were
 * both out.
 */
export function autoHoldUntil(usage, now) {
  const r = usage?.known ? usage.windows?.five_hour?.resetsAt : null;
  return Number.isFinite(r) && r * 1000 > now ? r * 1000 : now + AUTO.HOLD_MS;
}

/** Is this tab still inside the cooldown after its last automatic move? */
export const autoCoolingDown = (state, now) => Number.isFinite(state?.movedAt) && now - state.movedAt < AUTO.COOLDOWN_MS;

/**
 * Is a tab mid-turn? Claude's own record of the process says so when it says
 * anything but idle (a background agent or shell, a dialog: a restart stops
 * them all). A permission prompt always is. 'working' from the hook counts only
 * while output arrives: a turn that dies on a limit may never send the Stop that
 * clears it, and that must not pin the tab forever.
 */
export function tabBusy(activity, now, presenceStatus = null) {
  if (typeof presenceStatus === 'string' && presenceStatus !== 'idle') return true;
  if (!activity) return false;
  if (activity.status === 'needs') return true;
  return activity.status === 'working' && Number.isFinite(activity.lastActivityAt) && now - activity.lastActivityAt < BUSY_OUTPUT_MS;
}

/**
 * Why a tab's own state stops a move, or null. A move needs a Claude that is a
 * plain child of the tab's shell, its conversation, and the folder it runs in:
 * without all three it could not be resumed, so nothing is touched. allowBusy:
 * the person was warned about the turn or the unsent text on this tab.
 */
export function moveBlock(info, { allowBusy = false, allowDraft = false } = {}) {
  if (info.running === 'shell') return 'no Claude is running in it';
  if (info.running !== 'claude') return 'something other than one Claude runs in its shell';
  if (!info.session?.sessionId) return 'its conversation could not be identified';
  if (!info.session.project) return 'the folder its conversation runs in could not be read';
  if (info.override) return info.override === 'unreadable' ? 'its environment could not be read, so its login cannot be named' : `${info.override} is set in its environment, so its login cannot be named`;
  if (info.busy && !allowBusy) return info.status === 'needs' ? 'waiting on a question' : 'in the middle of a turn';
  return info.draft && !allowDraft ? 'has unsent text in the prompt' : null;
}

/**
 * What a process's environment text (claude-process-scan's processEnvironment,
 * no argv) says would stop its account folder deciding its login: one of `names`
 * set, or a HOME or USER other than ours (`own`, what the credential is found by).
 * By name only; 'unreadable' with no text to read.
 */
export function authOverrideIn(env, names, own) {
  if (typeof env !== 'string') return 'unreadable';
  const named = names.find((n) => new RegExp(`(?:^|\\s)${n}=\\S`).test(env));
  if (named) return named;
  for (const [name, mine] of Object.entries(own)) {
    const value = env.match(new RegExp(`(?:^|\\s)${name}=(.*)`))?.[1];
    if (value === undefined || value === mine) continue;
    if (!value.startsWith(mine) || !/^\s+[A-Za-z_][A-Za-z0-9_]*=/.test(value.slice(mine.length))) return name;
  }
  return null;
}

// Claude's own dialogs, read by structure from the live bottom of the screen as
// 2.1.316 draws them (fixtures: limit-menu, trust-prompt). Words alone prove
// nothing: a transcript, tool output or a draft can quote them, and an input box
// always ends below any of those. A wrapped row, or a version drawing these
// differently, simply does not match: the tab then reads as busy, the safe way.
const drawnRows = (lines) => (Array.isArray(lines) ? lines : []).map(String).filter((l) => l.trim());
const FOOTER = /^\s*Enter to confirm · Esc to cancel\s*$/;
const pointed = (rows) => rows.filter((r) => /^\s*❯/.test(r)).length === 1;

export function limitMenuOn(lines) {
  const rows = drawnRows(lines);
  let i = rows.length - 1;
  if (i < 0 || !FOOTER.test(rows[i])) return false;
  const options = [];
  for (i -= 1; i >= 0 && /^\s*(?:❯\s*)?\d+\.\s/.test(rows[i]); i -= 1) options.unshift(rows[i]);
  return options.length >= 2 && pointed(options)
    && /^\s*(?:❯\s*)?1\. Stop and wait for limit to reset\s*$/.test(options[0])
    && /^\s*What do you want to do\?\s*$/.test(rows[i] ?? '')
    && /^\s*▔{8,}/.test(rows[i - 1] ?? ''); // the effort badge can sit on this row
}

export function trustPromptOn(lines) {
  const rows = drawnRows(lines).slice(-3);
  return rows.length === 3 && FOOTER.test(rows[2]) && pointed(rows.slice(0, 2))
    && /^\s*(?:❯\s*)?No, exit\s*$/.test(rows[0]) && /^\s*(?:❯\s*)?Yes, I trust this folder\s*$/.test(rows[1]);
}
