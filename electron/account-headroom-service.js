// Main-process side of account headroom (pure rules: account-headroom.js):
// keeps a per-credential usage history from the statusLine records for the
// panel, answers "where can this tab move" for the Move to account dialog, and
// does the move: every check BEFORE anything is stopped, and success reported
// only from what the new process itself shows afterwards.
// Known limits: docs/account-usage-and-move.md.
//
// Everything system-facing arrives through `d`. Identity comes from
// account-identity's read-only metadata and credential-presence checks, and
// nothing here runs `claude auth status` (it writes into the config dir).

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  emptyHistory, sanitizeHistory, updateHistory, usageForKeys, accountKeyRows, moveRefusal,
  rankTargets, tabBusy, noteLogin, moveBlock, limitMenuOn, trustPromptOn, UNKNOWN_LOGIN, STALE_MS,
} from './account-headroom.js';

const SAVE_EVERY_MS = 30_000;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const DEFAULT_SERVICE = 'Claude Code-credentials';
const STOP_MS = 8000;
const VERIFY_MS = 45_000;
const POLL_MS = 1000;
// Older than the longest window a usage record says nothing.
const RECORD_MAX_AGE_MS = 8 * 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;

// Could a restart lose unsent text? A box that cannot be read (a menu is open)
// always could: guessing "empty" is what loses a draft (known limit 8).
export const draftOnScreen = (box) => (typeof box === 'string' ? !!box.trim() : true);

/**
 * Write `text` to `finalPath` without following a link: the parent must be a
 * real directory this user owns, the temp file must be new (a planted symlink
 * fails instead of being written through), and the rename replaces whatever
 * sits at the final path rather than writing into it. 0600 from the first byte.
 */
export function writePrivateFileSync(finalPath, text, tmpSuffix = crypto.randomBytes(8).toString('hex')) {
  const dir = fsSync.lstatSync(path.dirname(finalPath));
  if (!dir.isDirectory() || (typeof process.getuid === 'function' && dir.uid !== process.getuid())) throw new Error('the folder is a link or is not this user\'s');
  const tmp = `${finalPath}.tmp.${process.pid}.${tmpSuffix}`;
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fsSync.constants;
  const fd = fsSync.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    try { fsSync.writeFileSync(fd, text); } finally { fsSync.closeSync(fd); }
    fsSync.renameSync(tmp, finalPath);
  } catch (err) {
    fsSync.rmSync(tmp, { force: true });
    throw err;
  }
}

// The file's text, or null if it is not a plain file. A link is not followed.
async function readPrivateFile(file) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fsSync.constants;
  const fh = await fs.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > MAX_HISTORY_BYTES) return null;
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

export function createHeadroomService(d) {
  const histPath = path.join(d.userDataDir, 'usage-history.json');
  let hist = null;
  let dirty = false;
  let lastSave = 0;
  let ticking = false;
  let loading = null;
  // What the last sample read: a login change noticed outside a sample needs it.
  let lastRecords = [];
  // One move at a time, across every window.
  let moving = false;
  let lastPrune = 0;

  async function history() {
    if (hist) return hist;
    loading ??= (async () => {
      try { hist = sanitizeHistory(JSON.parse(await readPrivateFile(histPath))); }
      catch (err) {
        if (err?.code !== 'ENOENT') console.warn('[headroom] usage history not used:', err?.message || err);
        hist = emptyHistory();
      }
      return hist;
    })();
    return loading;
  }

  function save(force = false) {
    if (!hist || !dirty || (!force && d.now() - lastSave < SAVE_EVERY_MS)) return;
    lastSave = d.now();
    try {
      writePrivateFileSync(histPath, JSON.stringify(hist));
      dirty = false;
    } catch (err) {
      console.warn('[headroom] could not save usage history:', err?.message || err);
    }
  }

  async function sample() {
    const h = await history();
    if (d.now() - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = d.now();
      await d.pruneRecords(RECORD_MAX_AGE_MS).catch((err) => console.warn('[headroom] record cleanup failed:', err?.message || err));
    }
    const records = await d.readRecords(RECORD_MAX_AGE_MS);
    lastRecords = records;
    // Logins BEFORE new figures: a folder re-logged since the last look must not
    // have the old login's samples carried over.
    const rows = await baseRows();
    applyLogins(h, rows, records);
    // An unlisted folder has no login to attribute figures to.
    const listed = new Set(rows.map((r) => r.key));
    if (updateHistory(h, records.filter((r) => listed.has(r.key)), d.now())) dirty = true;
    save();
    return h;
  }

  // The address a folder's metadata names. The bare default Keychain service
  // has two metadata files (CLAUDE_CONFIG_DIR unset reads ~/.claude.json, an
  // explicit ~/.claude the inner one): when they disagree, or the other cannot
  // be read, who that credential is cannot be told, so null.
  async function loginEmail(dir, envUnset) {
    let meta;
    try { meta = await d.metadata(dir, { envUnset }); } catch { meta = { state: 'unreadable' }; }
    const a = meta?.email || null;
    if (!a || d.keyFor(dir) !== DEFAULT_SERVICE) return a;
    let other;
    try { other = await d.metadata(dir, { envUnset: !envUnset }); } catch { other = { state: 'unreadable' }; }
    if (other?.state === 'unreadable') return null;
    return other?.email && other.email.toLowerCase() !== a.toLowerCase() ? null : a;
  }

  // Keychain items hash the CONFIGURED spelling of a folder, but its metadata
  // belongs to the folder on disk. So another spelling (a symlink, /p/b/., /p/b/,
  // another case) has its own credential reading the same address, which says
  // nothing about it. Only the canonical spelling is trusted, and only while no
  // listed spelling of that folder has a credential of its own. A credential or
  // metadata FILE linked out of its folder is the same problem. All read as unknown.
  // Known limits 4 and 5: ~/.claude.json, and a spelling not listed anywhere.
  async function markSharedFolders(rows) {
    const nfc = (p) => p.normalize('NFC');
    await Promise.all(rows.map(async (r) => {
      r.real = await d.realpath(r.dir).catch(() => null);
      if (!r.real) return;
      if (nfc(r.real) !== nfc(r.dir)) r.email = null;
      await Promise.all(['.credentials.json', '.config.json', '.claude.json'].map(async (name) => {
        const at = await d.realpath(path.join(r.dir, name)).catch(() => null);
        if (at && at !== path.join(r.real, name)) r.email = null;
        // A hard link looks like the folder's own file, and realpath cannot tell.
        if (at && (await d.nlink(at).catch(() => 2)) > 1) r.email = null;
      }));
    }));
    const keysOf = new Map();
    for (const r of rows) {
      if (!r.real) continue;
      const id = nfc(r.real);
      if (!keysOf.has(id)) keysOf.set(id, new Set());
      keysOf.get(id).add(r.key);
    }
    for (const r of rows) if (r.real && keysOf.get(nfc(r.real)).size > 1) r.email = null;
  }

  // Two rows on one credential naming two logins, or a row with no address:
  // that credential's owner is unknown and its figures are not kept.
  function applyLogins(h, rows, records = []) {
    const loginOf = new Map();
    for (const r of rows) {
      if (!r.key) continue;
      const e = r.email ? r.email.toLowerCase() : UNKNOWN_LOGIN;
      loginOf.set(r.key, loginOf.has(r.key) && loginOf.get(r.key) !== e ? UNKNOWN_LOGIN : e);
    }
    for (const [key, email] of loginOf) if (noteLogin(h, key, email, d.now(), records)) dirty = true;
  }

  // Default + every Claude account with its address. Runs on the timer, so no
  // Keychain probe.
  async function baseRows() {
    const accounts = d.getAccounts();
    const { default: def, accounts: rows } = accountKeyRows(accounts, { defaultDir: d.defaultDir() });
    const all = [
      { ...def, isDefault: true, envUnset: d.defaultEnvUnset() },
      ...rows.filter(Boolean).map((r) => ({ ...r, isDefault: false, envUnset: false })),
    ];
    await Promise.all(all.map(async (r) => { r.email = await loginEmail(r.dir, r.envUnset); }));
    await markSharedFolders(all);
    return all;
  }

  // baseRows plus whether each is logged in and can resume the shared history.
  async function accountRows() {
    const all = await baseRows();
    await Promise.all(all.map(async (r) => {
      const [login, shared] = await Promise.all([
        d.login(r.dir).catch(() => 'unknown'),
        d.sharesHistory(r.dir).catch(() => false),
      ]);
      r.login = login || 'unknown';
      r.sharedHistory = shared;
    }));
    const same = (a, b) => !!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase();
    for (const r of all) r.sameAs = all.filter((o) => o !== r && same(o, r)).map((o) => o.label);
    // A folder re-logged into another login: its old figures are not this one's.
    applyLogins(await history(), all, lastRecords);
    return all;
  }

  // One login, one limit, whichever of its folders reported it.
  function loginKeys(r, rows) {
    const e = r.email?.toLowerCase();
    return new Set([r.key, ...rows.filter((o) => e && o.email?.toLowerCase() === e).map((o) => o.key)]);
  }
  const usageForRow = (r, rows, now) => usageForKeys(hist, [...loginKeys(r, rows)], now);

  // What stops any tab going to row `r`. An auth override in Dobius's own
  // environment is one login under every account name.
  function targetRefusal(r) {
    const override = d.authOverride?.() || null;
    if (override) return `${override} is set in Dobius's environment, and it signs in every Claude the same way whichever account a tab is on`;
    if (!r.isDefault && typeof r.id !== 'string') return 'this account has no usable id; re-add it in Settings';
    if (r.sharedHistory !== true) return 'its conversation history is not linked to the shared one, so the conversation cannot be resumed there';
    return null;
  }
  const rowRefusal = (source, r) => targetRefusal(r)
    || (source.sharedHistory === false ? 'this tab\'s conversation is in a private copy of its account\'s history, so it may not resume the same elsewhere' : null)
    || moveRefusal(source, r);

  async function readScan() {
    try { return await d.scan(); }
    catch (err) { console.warn('[headroom] process scan failed:', err?.message || err); return null; }
  }
  const groupOf = (scan, pid) => (scan?.groups || []).find((g) => g.pids.includes(pid)) || null;

  // The account a tab is really on: the running Claude's own folder (a shell
  // can point it elsewhere), else the folder the tab's shell was spawned with
  // (null meaning CLAUDE_CONFIG_DIR unset). A Claude whose folder cannot be
  // read, or a folder that is not a listed account, has no login to compare.
  function sourceOf(tab, rows, pid, scan) {
    // pid null: no child Claude, but `exec claude` runs as the shell's own pid.
    const g = groupOf(scan, pid ?? tab.pid);
    let key = null;
    if (g) key = g.key;
    else if (pid === null) key = d.keyFor(tab.claudeConfigDir === null ? d.cliDefaultDir() : tab.claudeConfigDir);
    const row = key && rows.find((r) => r.key === key);
    return row ? { key, email: row.email, login: row.login, label: row.label, sharedHistory: row.sharedHistory }
      : { key, email: null, login: 'unknown', label: 'an unlisted account' };
  }

  function candidatesFor(source, rows, now) {
    return rankTargets(rows.map((r) => {
      const generic = targetRefusal(r);
      return {
        id: r.id,
        isDefault: r.isDefault,
        label: r.label,
        email: r.email,
        login: r.login,
        sameAs: r.sameAs,
        usage: usageForRow(r, rows, now),
        refusal: rowRefusal(source, r),
        // For "Move all": what stops ANY tab going there, whichever account it
        // is on now (each tab is judged again by itself when it moves).
        allRefusal: generic || (r.login !== 'in' ? 'not logged in' : !r.email ? 'its login could not be told' : null),
      };
    }));
  }

  async function usage() {
    await sample();
    // Last and together: identities and the history they read must be one moment.
    const scan = await readScan();
    const rows = await accountRows();
    const now = d.now();
    const live = new Map((scan?.groups || []).map((g) => [g.key, g.pids.length]));
    // An unresolved process is not an absent one: never call a credential idle
    // on that evidence.
    const coverageUnknown = !scan || !!scan.discoveryFailed || (scan.unresolved?.length || 0) > 0;
    return {
      ok: true,
      scanFailed: coverageUnknown,
      accounts: rows.map((r) => {
        const u = usageForRow(r, rows, now);
        const running = [...loginKeys(r, rows)].reduce((n, k) => n + (live.get(k) ?? 0), 0);
        return {
          id: r.id, label: r.label, isDefault: r.isDefault, email: r.email, login: r.login, sameAs: r.sameAs,
          usage: u,
          sessionsRunning: coverageUnknown ? null : running,
          // A real figure, but nobody on this Mac is refreshing it.
          stale: u.known && ((u.ageMs ?? 0) > STALE_MS || (!coverageUnknown && running === 0)),
        };
      }),
    };
  }

  // What is in a tab right now, for the dialog's warning and for Move all.
  async function tabInfo(tab, scan) {
    const tabId = tab.id;
    // Read first: the restart is refused if anything reached the tab after it.
    const inputSeq = d.inputSeq(tabId);
    let info;
    try { info = await d.claudeInfo(tabId); } catch { info = null; }
    let session = null;
    let presence = null;
    let override = null;
    if (info) {
      const g = groupOf(scan, info.pid);
      // Claude's own record names the conversation it is on now (argv keeps
      // naming the old one after /clear).
      presence = await d.presence(info, g ? (g.envUnset ? null : g.configDir) : tab.claudeConfigDir).catch(() => null);
      if (presence?.sessionId) {
        // Resumed where it runs (a worktree, a subfolder), not at the project root.
        const cwd = await d.processCwd(info.pid).catch(() => null);
        session = {
          sessionId: presence.sessionId,
          project: cwd && d.isDir(cwd) ? cwd : null,
          // A Claude that never got a message has no transcript to resume.
          hasTranscript: await d.hasTranscript(presence.sessionId).catch(() => true),
        };
      }
      override = await d.processAuthOverride(info.pid);
    }
    // A Claude sharing its shell with another program (suspended behind an
    // editor) is not all a restart would stop.
    let running = 'claude';
    if (!info) running = (await d.process(tabId).catch(() => 'unknown')) ? 'other' : 'shell';
    else if (info.soleChild === false) running = 'other';
    const act = d.activity(tabId);
    const sc = info ? await d.screen(tabId).catch(() => null) : null;
    // The screen and Claude's own record must agree. A real limited tab's record
    // says 'waiting', with the hook on 'working' then 'idle', never 'needs': a
    // permission prompt is never read through as a limit.
    const limited = !!sc && presence?.status === 'waiting' && act?.status !== 'needs' && limitMenuOn(sc.lines);
    return {
      tabId, running, session, override,
      busy: !limited && tabBusy(act, d.now(), presence?.status),
      status: act?.status || null,
      // Unsent text in Claude's box, or input the window still holds (an image
      // paste being saved): a respawn would throw it away.
      draft: d.inputHeld(tabId) || (info && !limited ? (sc ? draftOnScreen(d.promptBox(sc.lines, sc.modes)) : true) : false),
      pid: info?.pid ?? null,
      inputSeq,
    };
  }

  async function moveTargets(tabId) {
    const tab = d.tabs().find((t) => t.id === tabId);
    if (!tab) return { ok: false, error: 'that tab has no terminal running' };
    await sample();
    const [rows, scan] = await Promise.all([accountRows(), readScan()]);
    const { pid, ...info } = await tabInfo(tab, scan);
    info.hardBlock = moveBlock(info, { allowBusy: true, allowDraft: true });
    const source = sourceOf(tab, rows, pid, scan);
    return { ok: true, source: { label: source.label, email: source.email }, targets: candidatesFor(source, rows, d.now()), tab: info };
  }

  // Move all: every tab's state, and why it may not go to `targetId` (null =
  // Default). Each tab is judged from its own current account.
  async function moveCandidates(tabIds, targetId) {
    const ids = [...new Set((Array.isArray(tabIds) ? tabIds : []).filter((x) => typeof x === 'string'))];
    const tabs = new Map(d.tabs().map((t) => [t.id, t]));
    await sample();
    const [rows, scan] = await Promise.all([accountRows(), readScan()]);
    const target = targetRow(rows, targetId);
    const out = [];
    for (const id of ids) {
      const tab = tabs.get(id);
      if (!tab) continue;
      const { pid, ...info } = await tabInfo(tab, scan);
      const source = sourceOf(tab, rows, pid, scan);
      out.push({
        ...info,
        block: moveBlock(info),
        hardBlock: moveBlock(info, { allowBusy: true, allowDraft: true }),
        refusal: target ? rowRefusal(source, target) : 'that account no longer exists',
      });
    }
    return out;
  }

  const targetRow = (rows, id) => (id === null ? rows.find((r) => r.isDefault) : rows.find((r) => !r.isDefault && r.id === id));
  const pinOf = (r) => ({ id: r.isDefault ? null : r.id });
  const named = (r) => (r.email ? `${r.label} (${r.email})` : r.label);

  async function moveOne(tabId, targetId, { allowBusy, allowDraft, cannotRestart, restart }) {
    const fail = (error, extra = {}) => ({ ok: false, error, ...extra });
    const tab = d.tabs().find((t) => t.id === tabId);
    if (!tab) return fail('the tab has no terminal running');
    await sample();
    const scan = await readScan();
    const info = await tabInfo(tab, scan);
    const block = moveBlock(info, { allowBusy, allowDraft });
    if (block) return fail(block);
    // Read last, so the target's login is as fresh as it can be when Claude stops.
    const rows = await accountRows();
    const target = targetRow(rows, targetId);
    if (!target) return fail('that account no longer exists');
    const refusal = rowRefusal(sourceOf(tab, rows, info.pid, scan), target);
    if (refusal) return fail(refusal);
    // No await from here to the signal.
    if (d.inputSeq(tabId) !== info.inputSeq || d.inputHeld(tabId)) return fail('something was typed in the tab, so it was left alone');
    const pin = pinOf(target);
    const cannot = cannotRestart(tabId, pin);
    if (cannot) return fail(cannot);
    const { project, hasTranscript } = info.session;
    // No transcript means nothing to resume: a plain Claude starts on the target.
    const sessionId = hasTranscript ? info.session.sessionId : null;
    const manual = sessionId
      ? `The conversation is safe: run claude --resume ${sessionId} in ${project}, in this tab.`
      : `There was no conversation to lose: run claude in ${project}, in this tab.`;
    try { d.stop(info.pid); } catch (err) { if (err?.code !== 'ESRCH') return fail(`Claude could not be stopped: ${err.message}`); }
    // Everything above left the tab untouched. From here it only ever reports.
    const stopBy = d.now() + STOP_MS;
    while (d.alive(info.pid) && d.now() < stopBy) await d.sleep(100);
    if (d.alive(info.pid)) return fail(`Claude did not stop within ${STOP_MS / 1000} seconds, so nothing else was changed. It may still be closing.`);
    if (sessionId && !(await d.claim(sessionId, tabId))) return fail(`Claude stopped, but something else is resuming that conversation, so this tab was not restarted. ${manual}`);
    const abort = (error) => { if (sessionId) d.release(sessionId, tabId); return fail(error); };
    // Input since it was judged may be a program started in the shell Claude left.
    if (d.inputSeq(tabId) !== info.inputSeq) return abort(`Claude stopped, but something was typed in the tab, so it was not restarted. ${manual}`);
    // The shell's folder may have been deleted since it started.
    const cwd = d.isDir(tab.cwd) ? tab.cwd : project;
    try {
      if (!restart(tabId, cwd, pin, { sessionId, cwd: project })) return abort(`Claude stopped, but the tab could not restart on ${target.label}. ${manual}`);
    } catch (err) { return abort(`Claude stopped, but the tab could not restart on ${target.label}: ${err.message}. ${manual}`); }
    return verifyMove(tabId, sessionId, target, rows, pin, manual);
  }

  const tokenDecides = (target, name) => `Claude runs in ${target.label}'s folder, but ${name} is set in the tab's shell and decides its login instead of the folder, so it did not change login.`;

  // What is really running in the tab now, from the process's own environment
  // and Claude's own record, never from what was asked for. Polled: nothing
  // announces a process starting, and a slow shell rc only uses up the bound.
  async function verifyMove(tabId, sessionId, target, rows, pin, manual) {
    const end = d.now() + VERIFY_MS;
    let started = false;
    while (d.now() < end) {
      const info = await d.claudeInfo(tabId).catch(() => null);
      if (started && !info) { if (sessionId) d.release(sessionId, tabId); return { ok: false, pin, error: `Claude started on ${target.label} and exited. The tab is a shell there. ${manual}` }; }
      if (info) {
        started = true;
        const g = groupOf(await readScan(), info.pid);
        if (g && g.key !== target.key) {
          const actual = rows.find((r) => r.key === g.key);
          const token = await d.processAuthOverride(info.pid);
          const also = token && token !== 'unreadable' ? ` ${token} is set too, and that decides its login, not the folder.` : '';
          return { ok: false, pin: actual ? pinOf(actual) : null, error: `Claude resumed on ${actual ? named(actual) : g.configDir}, not ${target.label}. Something in the shell's startup files sets CLAUDE_CONFIG_DIR, so this tab stays there.${also}` };
        }
        // Nothing more can be confirmed until a person answers this, behind the dialog.
        const sc = g ? await d.screen(tabId).catch(() => null) : null;
        if (sc && trustPromptOn(sc.lines)) {
          const token = await d.processAuthOverride(info.pid);
          return { ok: false, pin, error: token && token !== 'unreadable'
            ? tokenDecides(target, token)
            : `Claude on ${target.label} is asking whether to trust this folder. Answer it in the tab; the conversation carries on after that.` };
        }
        const seen = g ? await d.presence(info, g.envUnset ? null : g.configDir).catch(() => null) : null;
        if (sessionId && seen?.sessionId && seen.sessionId !== sessionId) return { ok: false, pin, error: `Claude is on ${target.label}, but running conversation ${seen.sessionId}, not ${sessionId}. ${manual}` };
        if (seen?.sessionId) {
          const override = await d.processAuthOverride(info.pid);
          if (override) {
            return { ok: false, pin, error: override === 'unreadable'
              ? `Claude runs in ${target.label}'s folder, but its environment could not be read, so its login cannot be confirmed.`
              : tokenDecides(target, override) };
          }
          // The folder may have been logged into something else during the move.
          const now = { dir: target.dir, key: target.key, email: await loginEmail(target.dir, target.envUnset) };
          await markSharedFolders([now]);
          if (now.email?.toLowerCase() !== target.email.toLowerCase()) return { ok: false, pin, error: `Claude runs on ${target.label}, but that folder now names ${now.email || 'no login that can be confirmed'}, not ${target.email}. Check it is the login you meant.` };
          // The process appearing is what ends a hold (terminal-manager): from
          // here the running Claude itself is what stops a second resume.
          if (sessionId) d.release(sessionId, tabId);
          return { ok: true, pin };
        }
      }
      await d.sleep(POLL_MS);
    }
    // Not started is not given up: a slow shell can still run the queued resume,
    // so the conversation stays claimed or a second tab could write to it too.
    return { ok: false, pin, error: started
      ? `Claude started, but what it is running could not be confirmed within ${VERIFY_MS / 1000} seconds. Check the tab before relying on it.`
      : `Claude has not started after ${VERIFY_MS / 1000} seconds. The tab's shell on ${target.label} may still start it, so give it a moment before doing anything there.` };
  }

  async function move(tabId, targetId, opts) {
    if (moving) return { ok: false, error: 'another account move is still running; try again when it finishes' };
    moving = true;
    try { return await moveOne(tabId, targetId, opts); }
    finally { moving = false; }
  }

  return {
    move,
    tick: async () => {
      if (ticking) return;
      ticking = true;
      try { await sample(); }
      catch (err) { console.warn('[headroom] sample failed:', err?.message || err); }
      finally { ticking = false; }
    },
    usage,
    moveTargets,
    moveCandidates,
    flushSync: () => save(true),
  };
}
