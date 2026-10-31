// Main-process side of account headroom (pure rules: account-headroom.js).
//
// Three jobs:
//  1. Keep a small per-credential usage history from the statusLine records
//     and turn it into per-account usage, pace and forecast for the UI.
//  2. Answer "where can this tab move" for the Move to account dialog, with
//     the same-login / no-credential refusals filled in.
//  3. With auto-move switched on, notice a tab that hit a limit, ask its
//     window to move it (the renderer owns the respawn + resumeSession), then
//     send "continue" through the chat-service submit path once Claude is
//     back on its prompt.
//
// Everything that touches the system arrives through `d` (deps), so the
// timing and guard logic can be driven by a test or a harness.
//
// Credentials are never read: identity comes from account-identity's
// read-only metadata and attribute-only Keychain probes, and nothing here runs
// `claude auth status` (it writes into the config dir).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  emptyHistory, sanitizeHistory, updateHistory, usageForKey, accountKeyRows, moveRefusal, autoRefusal,
  rankTargets, liveLimitLine, decideAutoMove, tabBusy, noteLogin, freshUsage, UNKNOWN_LOGIN, STALE_MS, LIMIT_LINE_RE, AUTO,
} from './account-headroom.js';

const SAVE_EVERY_MS = 30_000;
const CONTINUE_TIMEOUT_MS = 60_000;
const PENDING_MAX_MS = 3 * 60_000;
const POLL_MS = 500;
const MAX_NOTICED = 200;
const MAX_HANDLED_PER_TAB = 20;
const DEFAULT_SERVICE = 'Claude Code-credentials';
// After its last input, how long a tab's screen may stay unchanged before it
// is taken as current (Claude echoes typed input at once).
const QUIET_SETTLE_MS = 3000;
const MAX_CANDIDATE_TABS = 64;
// A tab that looked limited is looked at closely (screen render, transcript)
// at most this often: a limited tab can sit for hours.
const RECHECK_MS = 60_000;
// Usage records are one file per session, forever, and every one is read on
// each sample. Older than the longest window they say nothing.
const RECORD_MAX_AGE_MS = 8 * 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;
// Any text in Claude's input box is treated as the person's. Claude's own
// "Try ..." placeholder shows only with no submit and no messages (2.1.314
// binary: `x<1&&!L`), so never on a conversation that hit a limit or was
// resumed; a prompt suggestion drawn there only makes a move wait.
export const isDraft = (box) => typeof box === 'string' && !!box.trim();

/**
 * Could a restart lose unsent text? The box's text when it can be read; when
 * it cannot (promptBoxText refuses screens with a dialog-like line above the
 * box, Claude's own limit menu included), always yes: guessing "empty" is
 * what loses a draft, and every exception tried (a selector, the limit menu,
 * a single pointer row) was shown to hide one. The cost is that a tab with a
 * menu open waits instead of moving.
 */
export function draftOnScreen(box) {
  if (typeof box === 'string') return isDraft(box);
  return true;
}

// Desktop tabs only: phone and bridge PTYs have no window to move them.
const DESKTOP_TAB_RE = /^term-\/.+-\d+$/;

export function createHeadroomService(d) {
  const histPath = path.join(d.userDataDir, 'usage-history.json');
  let hist = null;
  let dirty = false;
  let lastSave = 0;
  let saving = null;
  const tabStates = new Map(); // tabId -> { handled: Set<eventId>, lastMoveAt }
  const recentMoves = [];
  const pending = new Map(); // tabId -> { eventId, eventAt, sessionId, project, wcId, at, targetLabel, sourceLabel }
  const noticed = new Set();
  // Credential key -> until when it counts as limited: a tab just hit a
  // limit on it, and its last report may predate that.
  const limitedUntil = new Map();
  let ticking = false;
  let loading = null;
  let lastPrune = 0;
  // Each move gets its own id: a request queued in the window past its expiry
  // must not be taken for a later retry of the same limit.
  let moveCounter = 0;
  // The records the last sample read: a login change noticed outside a
  // sample still needs them to know which sessions carry the old figures.
  let lastRecords = [];

  async function history() {
    if (hist) return hist;
    loading ??= (async () => {
      try { hist = sanitizeHistory(JSON.parse(await fs.readFile(histPath, 'utf8'))); }
      catch { hist = emptyHistory(); }
      return hist;
    })();
    return loading;
  }

  async function save(force = false) {
    if (!dirty || saving) return;
    if (!force && d.now() - lastSave < SAVE_EVERY_MS) return;
    const tmp = `${histPath}.tmp.${process.pid}`;
    dirty = false;
    lastSave = d.now();
    saving = (async () => {
      try {
        await fs.writeFile(tmp, JSON.stringify(hist), { mode: 0o600 });
        await fs.rename(tmp, histPath);
      } catch (err) {
        dirty = true;
        console.warn('[headroom] could not save usage history:', err?.message || err);
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    })();
    try { await saving; } finally { saving = null; }
  }

  async function sample() {
    const h = await history();
    let records;
    if (d.now() - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = d.now();
      try { await d.pruneRecords(RECORD_MAX_AGE_MS); } catch { /* next hour */ }
    }
    try { records = await d.readRecords(); } catch { records = []; }
    lastRecords = records;
    // Who each folder is logged into, BEFORE folding in new figures: a
    // folder re-logged since the last look must not have the old login's
    // samples carried over to the new one (metadata file only, no secrets).
    const logins = await readLogins();
    applyLogins(h, logins, records);
    // Only credentials of listed accounts are kept: an unlisted folder has no
    // login to attribute figures to, and could crowd the key cap.
    const listed = new Set(logins.map((r) => r.key));
    if (updateHistory(h, (records || []).filter((r) => listed.has(r.key)), d.now())) dirty = true;
    // Again for keys this sample created, so a new key never starts without
    // the login its first figures belong to.
    applyLogins(h, logins);
    await save();
    return h;
  }

  // The login address a folder's metadata names. The bare default Keychain
  // service is shared by two spellings with two metadata files (CLAUDE_CONFIG_DIR
  // unset reads ~/.claude.json, an explicit ~/.claude reads the inner one), and
  // a login through either replaces the one credential: when the two files
  // name different addresses, who that credential is cannot be told, so null.
  async function loginInfo(dir, envUnset) {
    let meta;
    try { meta = await d.metadata(dir, { envUnset }); } catch { meta = { state: 'unreadable' }; }
    const a = meta?.email || null;
    // No readable address: the folder's login cannot be told (unreadable,
    // logged out, or never logged in), so any figures it has are not trusted.
    if (!a) return { email: null, conflict: true };
    if (d.keyFor(dir) !== DEFAULT_SERVICE) return { email: a, conflict: false };
    // The other file must be readable to agree: an unreadable one may name
    // the login the credential now belongs to.
    let other;
    try { other = await d.metadata(dir, { envUnset: !envUnset }); } catch { other = { state: 'unreadable' }; }
    if (other?.state === 'unreadable') return { email: null, conflict: true };
    const b = other?.email;
    return b && b.toLowerCase() !== a.toLowerCase() ? { email: null, conflict: true } : { email: a, conflict: false };
  }
  const loginEmail = async (dir, envUnset) => (await loginInfo(dir, envUnset)).email;

  // Two configured folders that are one folder on disk (a symlink) share one
  // metadata file but have TWO Keychain items (Claude hashes the spelling):
  // the address that file names cannot be trusted for either.
  // A credential FILE that lives outside its folder (linked to another
  // profile, listed or not) is the same problem for that folder.
  async function markSharedFolders(rows) {
    await Promise.all(rows.map(async (r) => {
      r.real = await d.realpath(r.dir).catch(() => null);
      r.realCred = await d.realpath(path.join(r.dir, '.credentials.json')).catch(() => null);
      const aliased = r.real && r.real !== path.resolve(r.dir); // another spelling, listed or not, has its own Keychain item
      const credOutside = r.real && r.realCred && r.realCred !== path.join(r.real, '.credentials.json');
      if (aliased || credOutside) { r.email = null; r.loginConflict = true; }
    }));
    const groups = new Map();
    for (const r of rows) {
      if (!r.real) continue;
      if (!groups.has(r.real)) groups.set(r.real, []);
      groups.get(r.real).push(r);
    }
    for (const group of groups.values()) {
      if (new Set(group.map((x) => x.key)).size < 2) continue;
      for (const x of group) { x.email = null; x.loginConflict = true; }
    }
  }


  // Two rows on one credential can read two metadata files (Default with
  // the home-level file, an explicit ~/.claude with the inner one) and name
  // two logins: that credential's owner is undecidable, so it is left alone
  // rather than flipped back and forth.
  function applyLogins(h, rows, records = []) {
    const loginOf = new Map();
    for (const r of rows) {
      if (!r.key) continue;
      const e = r.loginConflict ? UNKNOWN_LOGIN : (r.email ? r.email.toLowerCase() : null);
      if (!e) continue;
      loginOf.set(r.key, loginOf.has(r.key) && loginOf.get(r.key) !== e ? UNKNOWN_LOGIN : e);
    }
    for (const [key, email] of loginOf) {
      const before = h.keys[key]?.email;
      if (noteLogin(h, key, email, d.now(), records)) {
        dirty = true;
        // A limit held on the folder was the OLD login's.
        if (before && before !== email) limitedUntil.delete(key);
      }
    }
  }

  async function readLogins() {
    const { default: def, accounts: rows } = accountKeyRows(d.getAccounts(), { defaultDir: d.defaultDir() });
    const all = [{ ...def, envUnset: d.defaultEnvUnset() }, ...rows.filter(Boolean).map((r) => ({ ...r, envUnset: false }))];
    await Promise.all(all.map(async (r) => {
      const li = await loginInfo(r.dir, r.envUnset);
      r.email = li.email;
      r.loginConflict = li.conflict;
    }));
    await markSharedFolders(all);
    return all;
  }

  // Default + every Claude account, with its login read-only. Ids that two
  // rows share cannot be pinned (spawn-account-env refuses them), so those
  // rows carry a refusal of their own.
  async function accountRows() {
    const accounts = d.getAccounts();
    const { default: def, accounts: rows } = accountKeyRows(accounts, { defaultDir: d.defaultDir() });
    const idCount = new Map();
    for (const a of accounts || []) if (a?.type === 'claude' && typeof a.id === 'string') idCount.set(a.id, (idCount.get(a.id) || 0) + 1);
    const all = [
      { ...def, isDefault: true, envUnset: d.defaultEnvUnset() },
      ...rows.filter(Boolean).map((r) => ({ ...r, isDefault: false, envUnset: false, duplicateId: (idCount.get(r.id) || 0) > 1 })),
    ];
    await Promise.all(all.map(async (r) => {
      try {
        const [login, li, shared] = await Promise.all([d.login(r.dir), loginInfo(r.dir, r.envUnset), d.sharesHistory(r.dir)]);
        r.email = li.email;
        r.loginConflict = li.conflict;
        r.sharedHistory = shared;
        r.login = login || 'unknown';
      } catch {
        r.email = null;
        r.login = 'unknown';
      }
    }));
    // The Default row reads the home-level ~/.claude.json, but a login made
    // with CLAUDE_CONFIG_DIR=~/.claude explicitly writes the inner file under
    // the SAME credential. Two different addresses there: who the credential
    // belongs to is unknown, and it is shown and treated that way.
    await markSharedFolders(all);
    const byEmail = new Map();
    for (const r of all) {
      if (!r.email) continue;
      const k = r.email.toLowerCase();
      byEmail.set(k, [...(byEmail.get(k) || []), r.label]);
    }
    for (const r of all) r.sameAs = r.email ? byEmail.get(r.email.toLowerCase()).filter((l) => l !== r.label) : [];
    // A folder re-logged into another login: its old figures are not this one's.
    applyLogins(await history(), all, lastRecords);
    return all;
  }

  // Which credential a running claude actually uses, by process (a shell rc
  // can export its own CLAUDE_CONFIG_DIR over what the tab was spawned with).
  // null when the scan cannot say.
  async function processGroup(pid) {
    if (!Number.isInteger(pid)) return null;
    let scan;
    try { scan = await d.scan(); } catch { return null; }
    return (scan?.groups || []).find((x) => x.pids.includes(pid)) || null;
  }
  async function processKey(pid) {
    return (await processGroup(pid))?.key || null;
  }

  // The credential a tab's shell was spawned with: its recorded binding, null
  // meaning CLAUDE_CONFIG_DIR unset (the CLI's ~/.claude, with the home-level
  // metadata file).
  async function sourceOf(tab, rows, pid = null) {
    // The running Claude's own folder wins over the tab's spawn binding (a
    // shell can point it elsewhere), and its login is read from THAT folder.
    const g = pid !== null ? await processGroup(pid) : null;
    const envUnset = g ? !!g.envUnset : tab.claudeConfigDir === null;
    const dir = g ? g.configDir : (envUnset ? d.cliDefaultDir() : tab.claudeConfigDir);
    const key = g ? g.key : d.keyFor(dir);
    // `resolved`: the running Claude's own folder was read (not guessed from
    // the tab's spawn binding). Auto-move acts only on a resolved source.
    const resolved = pid === null || !!g;
    const row = rows.find((r) => r.key === key);
    if (row) return { key, email: row.email, label: row.label, resolved };
    // An unlisted folder gets the same link checks as a listed one.
    const own = { dir, key, email: await loginEmail(dir, envUnset) };
    await markSharedFolders([own]);
    return { key, email: own.email, label: path.basename(dir), resolved };
  }

  // One login under two folders is one limit: a folder with no live figure
  // shows (and ranks by) the freshest figure of a folder logged into the same
  // address, marked with where it came from.
  // One login, one limit, whichever folder reported it. Within a window
  // usage only grows, so per window the HIGHEST figure any of the login's
  // folders reported stands (a republished low figure from an idle folder
  // cannot hide a limit reported through another), and a later window
  // replaces an earlier one.
  function usageForRow(r, rows, now) {
    const own = usageForKey(hist, r.key, now);
    if (!r.email) return own;
    const others = rows
      .filter((o) => o !== r && o.key !== r.key && o.email && o.email.toLowerCase() === r.email.toLowerCase())
      .map((o) => ({ o, u: usageForKey(hist, o.key, now) }))
      .filter((x) => x.u.known || Object.keys(x.u.windows).length);
    if (!others.length) return own;
    const windows = Object.create(null);
    let lastReportedAt = own.lastReportedAt || 0;
    let via = null;
    const fold = (u, label) => {
      for (const [name, w] of Object.entries(u.windows)) {
        const cur = windows[name];
        const later = cur && w.resetsAt && cur.resetsAt && w.resetsAt > cur.resetsAt + 60;
        const same = cur && !later && !(cur.resetsAt && w.resetsAt && cur.resetsAt > w.resetsAt + 60);
        if (!cur || later || (same && w.used > cur.used)) {
          windows[name] = w;
          if (label) via = label;
        }
      }
      lastReportedAt = Math.max(lastReportedAt, u.lastReportedAt || 0);
    };
    fold(own, null);
    for (const x of others) fold(x.u, x.o.label);
    const used = Object.values(windows).map((w) => w.used);
    const known = !!windows.five_hour;
    return {
      known,
      windows,
      lastReportedAt: lastReportedAt || null,
      ageMs: lastReportedAt ? Math.max(0, now - lastReportedAt) : null,
      headroom: known ? Math.max(0, 100 - Math.max(...used)) : null,
      limited: used.some((u) => u >= 100),
      ...(via ? { via } : {}),
    };
  }

  // A hold ends at its time limit, or early when the folder's five-hour
  // window is a LATER one than the window the hold was taken in (a reset).
  // A hold taken with no known window ends only at its time limit.
  function keyHeld(key, now) {
    const h = limitedUntil.get(key);
    if (!h || h.until <= now) return false;
    if (Number.isFinite(h.r) && h.r * 1000 <= now) return false; // that window has reset
    const r = hist?.keys?.[key]?.windows?.five_hour?.r;
    return !(Number.isFinite(h.r) && Number.isFinite(r) && r > h.r + 60);
  }

  // One quota per login: reservations are counted per login, not per folder.
  const loginId = (r) => (r.email ? `e:${r.email.toLowerCase()}` : `k:${r.key}`);

  // A limit just hit holds every folder of that login, not only the folder
  // the tab was on.
  function heldNow(r, rows, now) {
    const held = (key) => keyHeld(key, now);
    if (held(r.key)) return true;
    if (!r.email) return false;
    const e = r.email.toLowerCase();
    // Any folder of that login, listed or not (the hold remembers its login).
    for (const [key, h] of limitedUntil) if (h.email === e && held(key)) return true;
    return rows.some((o) => o.email && o.email.toLowerCase() === e && held(o.key));
  }

  // Why a tab on `source` may not go to row `r`. One rule for the dialog and
  // for the check made at the moment of the move.
  function rowRefusal(source, r) {
    const override = d.authOverride?.() || null;
    if (override) return `${override} is set in Dobius's environment, and it signs in every Claude the same way whichever account a tab is on`;
    if (r.duplicateId) return 'two accounts share this id; fix that in Settings first';
    if (!r.isDefault && typeof r.id !== 'string') return 'this account has no usable id; re-add it in Settings';
    if (r.sharedHistory === false) return 'its conversation history is not linked to the shared one, so the conversation cannot be resumed there';
    return moveRefusal(source, r);
  }

  // `reserved`: key -> percent already promised this pass to tabs moved there.
  // `live`: key -> sessions running (null: the scan could not say).
  function candidatesFor(source, rows, now, reserved = null, live = null) {
    const override = d.authOverride?.() || null;
    return rankTargets(rows.map((r) => {
      const usage = usageForRow(r, rows, now);
      if (heldNow(r, rows, now)) { usage.limited = true; usage.headroom = 0; }
      const less = reserved?.get(loginId(r)) || 0;
      if (less && usage.known) usage.headroom = Math.max(0, usage.headroom - less);
      return {
        id: r.id,
        key: r.key,
        dir: r.dir,
        envUnset: r.envUnset,
        isDefault: r.isDefault,
        label: r.label,
        email: r.email,
        login: r.login,
        sameAs: r.sameAs,
        usage,
        refusal: rowRefusal(source, r),
        // For "Move all": what stops ANY tab going there, whichever account it
        // is on now (each tab is judged again by itself when it moves).
        allRefusal: override ? `${override} is set` : r.duplicateId ? 'two accounts share this id' : (!r.isDefault && typeof r.id !== 'string') ? 'no usable id'
          : r.sharedHistory === false ? 'its conversation history is not linked' : (r.login !== 'in' ? 'not logged in' : null),
        autoRefusal: autoRefusal(source, r, { fresh: freshUsage(usage, runningFor(r, rows, live)) }),
      };
    }));
  }

  // Sessions on this row's login, through any of its folders.
  function runningFor(r, rows, live) {
    if (!live) return null;
    const e = r.email ? r.email.toLowerCase() : null;
    let n = live.get(r.key) ?? 0;
    if (e) for (const o of rows) if (o.key !== r.key && o.email && o.email.toLowerCase() === e) n += live.get(o.key) ?? 0;
    return n;
  }

  async function liveByKey() {
    let scan;
    try { scan = await d.scan(); } catch { return null; }
    if (!scan || scan.discoveryFailed) return null;
    return new Map((scan.groups || []).map((g) => [g.key, g.pids.length]));
  }

  async function usage() {
    await sample();
    const now = d.now();
    const rows = await accountRows();
    let scan;
    try { scan = await d.scan(); } catch { scan = null; }
    const live = new Map((scan?.groups || []).map((g) => [g.key, g.pids.length]));
    // A process whose environment could not be read is unresolved, not
    // absent: never call a credential idle on that evidence.
    const coverageUnknown = !scan || !!scan.discoveryFailed || (scan.unresolved?.length || 0) > 0;
    return {
      ok: true,
      scanFailed: coverageUnknown,
      autoMove: !!d.autoMoveEnabled(),
      accounts: rows.map((r) => {
        const u = usageForRow(r, rows, now);
        const running = runningFor(r, rows, live);
        return {
          id: r.id, label: r.label, isDefault: r.isDefault, email: r.email, login: r.login, sameAs: r.sameAs,
          usage: u,
          sessionsRunning: coverageUnknown ? null : running,
          // Still a real figure, but nobody on this Mac is refreshing it, and
          // use elsewhere (claude.ai, another Mac) only ever adds to it.
          stale: u.known && ((u.ageMs ?? 0) > STALE_MS || (!coverageUnknown && running === 0)),
        };
      }),
    };
  }

  async function draftIn(tabId) {
    try {
      const sc = await d.screen(tabId);
      return sc ? draftOnScreen(d.promptBox(sc.lines, sc.modes)) : true;
    } catch { return true; }
  }

  // Newest report made by this very process (pid, not older than its start).
  function reportedSession(info) {
    // With the reporter off, what is on disk describes the past.
    if (!d.reportingOn() || !info || !Number.isInteger(info.pid)) return null;
    let best = null;
    for (const r of lastRecords) {
      if (r?.reporterPid !== info.pid || typeof r.sessionId !== 'string' || !r.sessionId) continue;
      if (Number.isFinite(info.startedAt) && r.receivedAt < info.startedAt) continue;
      if (!best || r.receivedAt > best.receivedAt) best = r;
    }
    return best ? best.sessionId : null;
  }

  async function tabInfo(tabId) {
    const seqAtStart = d.inputSeq(tabId);
    // Reports read AFTER that count: a conversation switched before it is
    // seen here, one switched after it fails the conditional restart.
    await sample();
    let info;
    try { info = await d.claudeInfo(tabId); } catch { info = null; }
    let session = null;
    if (info) {
      try {
        const r = await d.resolveSession(tabId);
        // Where Claude actually runs (a worktree, a subfolder) is where it is
        // resumed: respawning at the project root would resume it outside
        // the checkout it was working in.
        let cwd = null;
        try { cwd = await d.processCwd(info.pid); } catch { cwd = null; }
        // Its own report first (see reportedSession); the resolver when the
        // reporter is off.
        const current = reportedSession(info);
        if (current || r?.sessionId) {
          session = { sessionId: current || r.sessionId, project: cwd || (r?.sessionId === current || !current ? r?.sessionProject : null) || null };
        }
      } catch { session = null; }
    }
    let running = 'claude';
    // A Claude suspended behind something else in the shell is not what a
    // restart would resume; that tab is running "another program".
    if (info && !(await d.isForeground(info.pid))) running = 'other';
    if (!info) {
      let proc;
      try { proc = await d.process(tabId); } catch { proc = 'unknown'; }
      running = proc ? 'other' : 'shell';
    }
    const act = d.activity(tabId);
    // A turn the hook still calls 'working' but that has drawn nothing for a
    // while: busy unless its transcript shows it ended on a limit (a turn
    // that dies on a limit may never send the Stop that clears 'working').
    let busy = tabBusy(act, d.now());
    if (!busy && act?.status === 'working' && act.hookOwned) {
      let rec = null;
      if (session) { try { rec = await d.limitRecord(session.sessionId, session.project); } catch { rec = null; } }
      // The limit must be on this tab's screen too: /clear leaves the old
      // record behind while a new turn runs quietly.
      let onScreen = false;
      if (rec?.limit) { try { onScreen = !!liveLimitLine((await d.screen(tabId))?.lines, d.rows(tabId)); } catch { onScreen = false; } }
      busy = !onScreen;
    }
    return {
      tabId, running, session, busy, status: act?.status || null,
      // Unsent text in Claude's box: a respawn would throw it away. A plain
      // shell's half-typed command cannot be read reliably at all.
      // Input the window still holds (an image paste being saved, the words
      // typed after it) is a draft too.
      draft: d.inputHeld(tabId) || (info ? await draftIn(tabId) : running === 'shell'),
      pid: info?.pid ?? null,
      // Read FIRST would be better; read here it still bounds the restart:
      // terminal:create refuses if anything reached the tab after this.
      inputSeq: seqAtStart,
    };
  }

  async function moveTargets(tabId) {
    const tab = d.tabs().find((t) => t.id === tabId);
    if (!tab) return { ok: false, error: 'that tab has no terminal running' };
    await sample();
    const rows = await accountRows();
    const info = await tabInfo(tabId);
    const source = await sourceOf(tab, rows, info.pid);
    const { pid: _pid, ...tabOut } = info;
    return { ok: true, source: { label: source.label, email: source.email }, targets: candidatesFor(source, rows, d.now()).map(({ key: _k, ...c }) => c), tab: tabOut };
  }

  // Move-all: every tab's state, and why it may not go to `targetId` (null =
  // Default). Each tab is judged from its own current account.
  async function moveCandidates(tabIds, targetId) {
    const ids = [...new Set((Array.isArray(tabIds) ? tabIds : []).filter((x) => typeof x === 'string'))].slice(0, MAX_CANDIDATE_TABS);
    const tabs = new Map(d.tabs().map((t) => [t.id, t]));
    await sample(); // a login change noticed below needs the current records
    const rows = await accountRows();
    const target = targetId === null ? rows.find((r) => r.isDefault) : rows.find((r) => !r.isDefault && r.id === targetId);
    const out = [];
    for (const id of ids) {
      const tab = tabs.get(id);
      if (!tab) continue;
      const info = await tabInfo(id);
      const source = await sourceOf(tab, rows, info.pid);
      const refusal = !target ? 'that account no longer exists' : rowRefusal(source, target);
      const { pid: _pid, ...rest } = info;
      out.push({ ...rest, refusal });
    }
    return out;
  }

  const stateFor = (tabId) => {
    let st = tabStates.get(tabId);
    if (!st) { st = { handled: new Set(), lastMoveAt: 0 }; tabStates.set(tabId, st); }
    return st;
  };

  function notice(tabId, text) {
    d.send(tabId, 'accounts:autoMoveNotice', { text });
  }

  // One look at every desktop tab.
  async function autoTick() {
    if (!d.autoMoveEnabled()) return;
    const now = d.now();
    for (const [tabId, p] of pending) {
      if (now - p.at > PENDING_MAX_MS) {
        pending.delete(tabId);
        // Never started: nothing happened to the tab, so its event and its
        // cooldown are given back and a later look may move it after all.
        if (!p.started) {
          const st = tabStates.get(tabId);
          if (st) { st.handled.delete(p.eventId); st.lastMoveAt = p.prevLastMoveAt || 0; }
        }
        d.log('accounts.auto-move', `tab=${tabId} event=${p.eventId} result=abandoned (the window never ${p.started ? 'finished' : 'started'} the move)`);
      }
    }
    const open = new Set(d.tabs().map((t) => t.id));
    for (const id of tabStates.keys()) if (!open.has(id)) tabStates.delete(id);
    let rows = null;
    let live = null;
    // Headroom promised to tabs moved earlier in this same pass.
    const reserved = new Map();
    for (const tab of d.tabs()) {
      if (!DESKTOP_TAB_RE.test(tab.id) || pending.has(tab.id) || d.windowOf(tab.id) === null) continue;
      const st = stateFor(tab.id);
      if (st.nextLookAt && d.now() < st.nextLookAt) continue;
      // Cheap first: no limit wording in the tab's recent output, no closer look.
      if (!LIMIT_LINE_RE.test(d.strippedTail(tab.id))) continue;
      st.nextLookAt = d.now() + RECHECK_MS;
      let info;
      try { info = await d.claudeInfo(tab.id); } catch { info = null; }
      if (!info) continue;
      // The Claude the keys and the screen belong to, not one suspended
      // behind it in the same shell (the session would be the wrong one).
      if (!(await d.isForeground(info.pid))) continue;
      // The conversation this process is on NOW, from its own report: argv
      // goes on naming the old one after /clear or /resume, and a recent-link
      // match is a guess. With no report there is no automatic move.
      const current = reportedSession(info);
      if (!current) continue;
      let linked;
      try { linked = await d.resolveSession(tab.id); } catch { linked = null; }
      const ses = { sessionId: current, sessionProject: linked?.sessionId === current ? linked.sessionProject : null };
      let cwd;
      try { cwd = await d.processCwd(info.pid); } catch { cwd = null; }
      const project = cwd || ses.sessionProject || tab.cwd;
      let rec;
      let recProject = project;
      try {
        rec = await d.limitRecord(ses.sessionId, project);
        if (!rec?.found && ses.sessionProject && ses.sessionProject !== project) {
          rec = await d.limitRecord(ses.sessionId, ses.sessionProject);
          if (rec?.found) recProject = ses.sessionProject;
        }
      } catch { rec = null; }
      if (!rec?.found || !rec.limit) continue;
      if (Number.isFinite(info.startedAt) && rec.limit.at < info.startedAt + 1000) continue; // see decideAutoMove
      let sc;
      try { sc = await d.screen(tab.id); } catch { sc = null; }
      const screenHit = !!liveLimitLine(sc?.lines, d.rows(tab.id));
      const draft = sc ? draftOnScreen(d.promptBox(sc.lines, sc.modes)) : true;
      // A token or key exported into this Claude (a shell rc) signs it in
      // whatever its profile folder says: moving it would change nothing.
      const tabOverride = await d.processAuthOverride(info.pid); // a name, 'unreadable', or null
      if (tabOverride === 'unreadable') continue; // cannot tell: not moved, looked at again later
      if (tabOverride) {
        const k = `${tab.id}|override|${rec.limit.at}`;
        if (!noticed.has(k)) {
          noticed.add(k);
          d.log('accounts.auto-move', `tab=${tab.id} event=${rec.limit.at} result=no-target (${tabOverride} set in its environment)`);
          notice(tab.id, `This tab hit its limit, but ${tabOverride} is set in its shell, which signs Claude in the same way on every account, so it was not moved.`);
        }
        continue;
      }
      rows ??= await accountRows();
      live ??= await liveByKey();
      const source = await sourceOf(tab, rows, info.pid);
      if (!source.resolved) continue; // which login this Claude is on is unknown: looked at again later
      const u = usageForKey(hist, source.key, now); // the account it really runs on, not the tab's spawn binding
      const dec = decideAutoMove({
        enabled: true,
        now: d.now(),
        limit: rec.limit,
        processStartedAt: info.startedAt ?? null,
        corroboration: { statusLine: u.limited, screen: screenHit },
        draft,
        busy: tabBusy(d.activity(tab.id), d.now()),
        inputAgeMs: d.inputAgeMs(tab.id),
        tabState: st,
        recentMoves,
        ranked: candidatesFor(source, rows, d.now(), reserved, live),
      });
      // A real limit on this tab's account: it is limited for everyone else
      // in this pass and for a while after, whatever its last report said.
      if (dec.action === 'move' || dec.action === 'notice' || dec.action === 'wait') {
        // A new hold replaces one that no longer holds (expired, or a reset
        // since): a limit in the new window must hold again.
        if (source.key && !keyHeld(source.key, d.now())) {
          const r = hist?.keys?.[source.key]?.windows?.five_hour?.r;
          limitedUntil.set(source.key, { at: d.now(), until: d.now() + AUTO.LIMITED_HOLD_MS, r: Number.isFinite(r) ? r : null, email: source.email ? source.email.toLowerCase() : null });
        }
      }
      for (const [k, h] of limitedUntil) if (h.until <= d.now()) limitedUntil.delete(k);
      if (dec.action === 'wait') st.nextLookAt = d.now() + 5_000;
      if (dec.action === 'move') {
        const prevLastMoveAt = st.lastMoveAt;
        st.handled.add(dec.eventId);
        if (st.handled.size > MAX_HANDLED_PER_TAB) st.handled.delete(st.handled.values().next().value);
        st.lastMoveAt = d.now();
        recentMoves.push(st.lastMoveAt);
        while (recentMoves.length > 50) recentMoves.shift();
        reserved.set(loginId(dec.target), (reserved.get(loginId(dec.target)) || 0) + AUTO.RESERVE_PER_TAB);
        const p = {
          moveId: `${dec.eventId}#${++moveCounter}`,
          eventId: dec.eventId, eventAt: rec.limit.at, sessionId: ses.sessionId, project, wcId: d.windowOf(tab.id), at: d.now(),
          targetLabel: dec.target.label, targetKey: dec.target.key, sourceLabel: source.label,
          inputSeq: d.inputSeq(tab.id), pty: d.pty(tab.id), started: false,
          targetDir: dec.target.dir, targetEnvUnset: dec.target.envUnset, targetEmail: dec.target.email, prevLastMoveAt, recProject,
        };
        pending.set(tab.id, p);
        d.log('accounts.auto-move', `tab=${tab.id} from=${source.label} to=${dec.target.label} event=${dec.eventId} result=moving`);
        const sent = d.send(tab.id, 'accounts:autoMove', {
          accountId: dec.target.id, sessionId: ses.sessionId, project, eventId: p.moveId, targetLabel: dec.target.label,
        });
        if (sent !== 'sent') {
          pending.delete(tab.id);
          d.log('accounts.auto-move', `tab=${tab.id} event=${dec.eventId} result=not-moved (no window to move it)`);
        }
      } else if (dec.action === 'notice') {
        const k = `${tab.id}|${dec.eventId}`;
        if (noticed.has(k)) continue;
        noticed.add(k);
        if (noticed.size > MAX_NOTICED) noticed.delete(noticed.values().next().value);
        d.log('accounts.auto-move', `tab=${tab.id} from=${source.label} event=${dec.eventId} result=no-target (${dec.reason})`);
        notice(tab.id, 'This tab hit its limit, but every other account is limited, nearly limited, or has no usage reported yet, so it was not moved. Use Move to account on the tab to pick one yourself.');
      }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await sample();
      await autoTick();
    } catch (err) {
      console.warn('[headroom] tick failed:', err?.message || err);
    } finally {
      ticking = false;
    }
  }

  /**
   * The window moved the tab (respawned it on the target and typed the
   * resume) for a move main asked for, or says why it could not. Waits for
   * Claude to be back on its prompt in that session, then sends "continue".
   * Nothing is sent if anyone typed into the tab after the resume was typed,
   * or if the conversation moved on (its transcript no longer ends in the
   * limit this move was for).
   */
  // Right before the window restarts the tab: the move is still wanted and
  // nothing about the tab changed since main decided (the window may have
  // queued it behind other moves for a minute or more).
  async function startAutoMove(tabId, eventId, senderId) {
    const p = pending.get(tabId);
    if (!p || p.moveId !== eventId || p.wcId !== senderId || p.started) return { ok: false, error: 'no automatic move is waiting for that tab' };
    const stop = (why) => {
      pending.delete(tabId);
      // Nothing happened to the tab: its event and cooldown are given back.
      const st = tabStates.get(tabId);
      if (st) { st.handled.delete(p.eventId); st.lastMoveAt = p.prevLastMoveAt || 0; st.nextLookAt = d.now() + RECHECK_MS; }
      d.log('accounts.auto-move', `tab=${tabId} from=${p.sourceLabel} to=${p.targetLabel} event=${eventId} result=not-moved (${why})`);
      return { ok: false, error: why };
    };
    if (!d.autoMoveEnabled()) return stop('auto-move was switched off');
    if (d.pty(tabId) !== p.pty || d.closing(tabId)) return stop('the tab restarted meanwhile');
    if (d.inputSeq(tabId) !== p.inputSeq || d.inputHeld(tabId)) return stop('someone typed in the tab');
    if (tabBusy(d.activity(tabId), d.now())) return stop('the tab got busy');
    if (await draftIn(tabId)) return stop('there is unsent text in the prompt');
    if (!(await targetStillSame(p))) return stop(`${p.targetLabel} is logged into a different account now`);
    // It may have filled up while this move waited its turn.
    await sample();
    const rows = await accountRows();
    const row = rows.find((r) => r.key === p.targetKey);
    const fresh = row ? usageForRow(row, rows, d.now()) : null;
    if (!fresh?.known || fresh.limited || fresh.headroom < AUTO.MIN_HEADROOM || heldNow(row, rows, d.now())) return stop(`${p.targetLabel} no longer has room`);
    if (!freshUsage(fresh, runningFor(row, rows, await liveByKey()))) return stop(`the figures for ${p.targetLabel} are out of date now`);
    // Still the conversation main decided on (a /clear since then is not).
    let info;
    try { info = await d.claudeInfo(tabId); } catch { info = null; }
    if (reportedSession(info) !== p.sessionId) return stop('the conversation in the tab changed');
    if (d.windowOf(tabId) !== p.wcId) return stop('the tab moved to another window');
    if (d.inputSeq(tabId) !== p.inputSeq) return stop('someone typed in the tab');
    p.started = true;
    p.at = d.now();
    // The window passes this to terminal:create, which refuses the restart if
    // any input reached the tab in between (main, one tick, no await).
    return { ok: true, inputSeq: p.inputSeq };
  }

  // The target folder is still logged into the login main chose it for.
  async function targetStillSame(p) {
    if (!p.targetEmail) return false;
    const row = { dir: p.targetDir, key: p.targetKey, email: await loginEmail(p.targetDir, !!p.targetEnvUnset) };
    await markSharedFolders([row]); // the folder or its credential file relinked meanwhile
    if (!(await d.sharesHistory(p.targetDir))) return false; // so would its conversations be another copy
    return !!row.email && row.email.toLowerCase() === p.targetEmail.toLowerCase();
  }

  async function continueAfterMove(tabId, eventId, senderId, failed) {
    const p = pending.get(tabId);
    if (!p || p.moveId !== eventId || p.wcId !== senderId) return { ok: false, error: 'no automatic move is waiting for that tab' };
    if (!p.started && !(typeof failed === 'string' && failed)) return { ok: false, error: 'that move was never started' };
    pending.delete(tabId);
    const done = (result, ok = false, text = null) => {
      d.log('accounts.auto-move', `tab=${tabId} from=${p.sourceLabel} to=${p.targetLabel} event=${eventId} result=${result}`);
      if (text) notice(tabId, text);
      return { ok, result };
    };
    if (typeof failed === 'string' && failed) {
      // Not moved (the restart was refused, the window gave up): the event and
      // the cooldown are given back, so a later look can try again.
      const st = tabStates.get(tabId);
      if (st) { st.handled.delete(p.eventId); st.lastMoveAt = p.prevLastMoveAt || 0; st.nextLookAt = d.now() + RECHECK_MS; }
      return done(`not-moved (${failed.slice(0, 120)})`, false, `Could not move this tab to ${p.targetLabel}: ${failed.slice(0, 200)}`);
    }
    const baseline = d.inputSeq(tabId);
    const pty = d.pty(tabId);
    if (!pty) return done('no-continue (the tab has no shell)');
    const end = d.now() + CONTINUE_TIMEOUT_MS;
    // Same shell, still this window's: a tab docked into another window
    // meanwhile is that window's business now.
    const stillHere = () => d.pty(tabId) === pty && !d.closing(tabId) && d.windowOf(tabId) === p.wcId;
    // Claude running the session that was resumed.
    let started = null;
    while (d.now() < end && stillHere()) {
      let info;
      try { info = await d.claudeInfo(tabId); } catch { info = null; }
      if (info?.sessionId === p.sessionId) { started = info; break; }
      await d.sleep(POLL_MS);
    }
    if (!started) return done('no-continue (Claude did not resume in time)', false, `Moved this tab to ${p.targetLabel}, but Claude did not come back in time, so "continue" was not sent.`);
    // The resumed Claude must really be on the target's credential. A shell
    // rc that exports its own CLAUDE_CONFIG_DIR would otherwise land it back
    // on the limited account, and "continue" would spend that one.
    const onKey = await processKey(started.pid);
    if (onKey !== p.targetKey) {
      return done(`no-continue (Claude runs on ${onKey ? 'another credential' : 'a credential that could not be read'})`, false,
        `Moved this tab to ${p.targetLabel}, but the Claude it started is not using that account (a shell setting may override it), so "continue" was not sent.`);
    }
    // Its prompt, drawn and still, on two polls in a row.
    let hits = 0;
    while (d.now() < end && stillHere() && hits < 2) {
      const seq = d.outputSeq(tabId);
      let sc;
      try { sc = await d.screen(tabId); } catch { sc = null; }
      const ready = !!sc && d.promptReady(sc.lines, sc.modes);
      hits = ready && d.outputSeq(tabId) === seq ? hits + 1 : 0;
      if (hits < 2) await d.sleep(POLL_MS);
    }
    if (hits < 2 || !stillHere()) return done('no-continue (Claude\'s prompt did not appear)', false, `Moved this tab to ${p.targetLabel}, but its prompt did not appear in time, so "continue" was not sent.`);
    if (d.inputSeq(tabId) !== baseline) return done('no-continue (someone typed in the tab)', false, `Moved this tab to ${p.targetLabel}. Someone typed in it since, so "continue" was not sent.`);
    let rec;
    try { rec = await d.limitRecord(p.sessionId, p.recProject || p.project); } catch { rec = null; }
    if (!rec?.found || rec.limit?.at !== p.eventAt) return done('no-continue (the conversation moved on)', false, `Moved this tab to ${p.targetLabel}. The conversation had moved on, so "continue" was not sent.`);
    if (d.inputSeq(tabId) !== baseline || d.inputHeld(tabId) || !stillHere()) return done('no-continue (someone typed in the tab)');
    // Claude's box must be EMPTY: input that reached it before this check
    // began (a phone, a late window) would otherwise go out with "continue".
    // The screen must postdate every input the tab has received, or an
    // empty box may be one Claude has not redrawn yet.
    if (!d.settled(tabId) && d.inputAgeMs(tabId) < QUIET_SETTLE_MS) {
      await d.sleep(QUIET_SETTLE_MS);
      if (!d.settled(tabId) && d.inputAgeMs(tabId) < QUIET_SETTLE_MS) return done('no-continue (the screen did not catch up with input)', false, `Moved this tab to ${p.targetLabel}, but its screen did not settle, so "continue" was not sent.`);
    }
    if (d.inputSeq(tabId) !== baseline || !stillHere()) return done('no-continue (someone typed in the tab)');
    let box;
    try { const sc = await d.screen(tabId); box = sc ? d.promptBox(sc.lines, sc.modes) : null; } catch { box = null; }
    if (box === null || box.trim() !== '') return done('no-continue (the prompt was not empty)', false, `Moved this tab to ${p.targetLabel}, but its prompt was not empty, so "continue" was not sent.`);
    const override = await d.processAuthOverride(started.pid);
    if (override === 'unreadable') return done('no-continue (its environment could not be checked for an auth override)', false, `Moved this tab to ${p.targetLabel}, but its environment could not be checked, so "continue" was not sent.`);
    if (override) return done(`no-continue (${override} set in its environment)`, false, `Moved this tab to ${p.targetLabel}, but ${override} is set in its shell and signs Claude in the same way on every account, so "continue" was not sent.`);
    // Last, so as little as possible runs between it and the paste.
    if (!(await targetStillSame(p))) return done('no-continue (the target folder is logged into another account now)', false, `Moved this tab to ${p.targetLabel}, but that folder is logged into a different account now, so "continue" was not sent.`);
    // Its latest report, if any, must still name this conversation (a /clear
    // since the resume means "continue" would go to the new one).
    await sample();
    const reported = reportedSession(started);
    if (reported && reported !== p.sessionId) return done('no-continue (the conversation changed)', false, `Moved this tab to ${p.targetLabel}, but its conversation changed, so "continue" was not sent.`);
    // Still the Claude that was checked above, not one started after it.
    let now;
    try { now = await d.claudeInfo(tabId); } catch { now = null; }
    if (now?.pid !== started.pid || now?.sessionId !== p.sessionId) return done('no-continue (Claude restarted while waiting)');
    // And it is the program that will read the keys, not one suspended behind
    // another started in the same shell.
    if (!(await d.isForeground(started.pid))) return done('no-continue (that Claude is not in the foreground)', false, `Moved this tab to ${p.targetLabel}, but that Claude is not in the foreground, so "continue" was not sent.`);
    if (!d.autoMoveEnabled()) return done('no-continue (auto-move was switched off)');
    // Resumed where it was working (a worktree): Claude falls back to another
    // folder when it cannot re-enter it, and "continue" there would work on
    // the wrong checkout.
    if (p.project) {
      let at;
      try { at = await d.processCwd(started.pid); } catch { at = null; }
      if (!at || !(await d.samePath(at, p.project))) {
        return done('no-continue (Claude resumed in another folder)', false, `Moved this tab to ${p.targetLabel}, but Claude came back in a different folder from the one it was working in, so "continue" was not sent.`);
      }
    }
    // Checked again where the submit queue decides to paste. Not inputHeld
    // here: that is /openTab's inputBusy, which also reads "a submit is
    // pending", and inside the queue that is this very submit, so it would
    // always cancel itself (the ship-test caught it). The queue is idle
    // (checked just above), so it pastes in this same tick.
    // Nothing is awaited from this check to the paste: input a window started
    // holding during the reads above (an image paste) stops it here.
    if (d.inputSeq(tabId) !== baseline || d.inputHeld(tabId) || !stillHere()) return done('no-continue (someone typed in the tab)');
    const sent = await d.submit(tabId, 'continue', () => stillHere() && d.inputSeq(tabId) === baseline);
    return sent
      ? done('continued', true)
      : done('no-continue (the submit was interrupted)', false, `Moved this tab to ${p.targetLabel}, but "continue" did not go through. Check the tab.`);
  }

  return {
    tick,
    usage,
    moveTargets,
    moveCandidates,
    continueAfterMove,
    startAutoMove,
    // Quitting: a save is at most 30s behind, but a login remembered in that
    // gap is what stops the next login inheriting its figures.
    flushSync: () => {
      if (!dirty || !hist) return;
      try { fsSync.writeFileSync(histPath, JSON.stringify(hist), { mode: 0o600 }); dirty = false; }
      catch (err) { console.warn('[headroom] could not save usage history:', err?.message || err); }
    },
    _pending: pending,
    _tabStates: tabStates,
  };
}
