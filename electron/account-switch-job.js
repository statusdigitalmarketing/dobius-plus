// Move every RUNNING Claude session to another account (v1.0.75).
//
// Sam: "make it easy to switch all my claudes to a different account even while
// it's running so that i can seamlessly keep working when i get close to the end
// of usage on one account."
//
// How this is possible: a running claude does not hold its credential. It reads
// it from the Keychain item keyed by its config dir, so every process sharing a
// credential moves at once when that credential is re-logged. Verified live:
// this moved 18 running sessions off one account with no restart.
//
// THE COST, chosen by the user with the tradeoff in front of them: the CLI has
// no force-relogin, so the logout comes first. Between it and the browser
// finishing, those sessions have NO credential and their calls fail. This
// module makes that window short, visible and recoverable; it cannot remove it.
// It also OVERWRITES the account that credential held.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { app } from 'electron';
import { scanClaudeProcesses } from './claude-process-scan.js';
import { identityFor, accountMetadata, claudeJsonCandidates, keychainServiceFor, defaultClaudeDir } from './account-identity.js';

const execFileP = promisify(execFile);


// ONE job at a time for the whole app. Per-directory locks are not enough: two
// jobs on different directories would still race for the single browser session
// and for the user's attention (reviewer HIGH).
//
// KNOWN LIMIT: this guard is process-local, so a second Dobius process sharing
// this userData runs its own job. The journal is a file per credential
// precisely so those two cannot erase each other's recovery records.
let current = null;
// The last finished job, so a panel reopened after the fact can still show what
// happened instead of a blank slate (reviewer HIGH).
let lastResult = null;
export function lastSwitchResult() { return lastResult; }
// The login prints its authorization URL ONCE. A panel reopened after that
// subscribes only to future output, so without replaying it the user has no way
// left to finish a login whose credential is already signed out (reviewer
// HIGH). Held only for the life of the job.
let runningOutput = '';
export function runningSwitchOutput() { return current ? runningOutput : ''; }

// Every auth child we spawn, so a quit or an update can terminate them. An
// orphaned `auth login` can complete later and overwrite a credential during a
// subsequent switch (reviewer HIGH).
const liveChildren = new Set();
// Latched at shutdown. Killing the current children is not enough on its own:
// the loop may be sitting in an await with NO child alive, in which case the
// sweep kills nothing, the job wakes up during the quit drain, signs the next
// credential out and spawns a login that outlives the app (reviewer HIGH, two
// lenses). Shutdown therefore also aborts the job and blocks every later spawn.
let shuttingDown = false;
export function killAuthChildren() {
  shuttingDown = true;
  try { current?.controller.abort(); } catch { /* already finishing */ }
  for (const c of liveChildren) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
  liveChildren.clear();
}

/**
 * A quit can be CANCELLED. Dobius's first Cmd+Q arms a one-second timer that
 * un-arms the quit, and the latch above would otherwise stay set for the life
 * of a process that never exited, permanently answering "shutting down" to
 * every attempt to recover a credential that is still signed out (reviewer
 * HIGH, two passes).
 */
export function resetAuthShutdown() { shuttingDown = false; }

/** Resolve a usable `claude` executable, preflighted before anything destructive. */
export async function resolveClaudeBin(cliPath) {
  const candidates = [];
  if (cliPath) candidates.push(cliPath.startsWith('~') ? path.join(os.homedir(), cliPath.slice(1)) : cliPath);
  candidates.push(
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  );
  for (const c of candidates) {
    try { await fsp.access(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  try {
    const { stdout } = await execFileP('/usr/bin/which', ['claude'], { timeout: 2000, encoding: 'utf8' });
    const p = stdout.trim();
    if (p) { await fsp.access(p, fs.constants.X_OK); return p; }
  } catch { /* nothing usable */ }
  return null;
}

/**
 * The metadata file the CLI would actually READ for this binding, or null.
 *
 * Needed because a metadata file can be shared by two DIFFERENT credentials:
 * `/p/work` and `/p/work/` hash to two Keychain items but to one
 * `<dir>/.claude.json`. After switching the first, the second's file reports the
 * new address while its own credential is untouched, so an address match would
 * skip it and leave those sessions on the old account (reviewer HIGH).
 */
async function metadataFileFor(configDir, envUnset) {
  for (const candidate of claudeJsonCandidates(configDir, { envUnset })) {
    try {
      const st = await fsp.stat(candidate);
      if (!st.isFile()) continue;
      // Compare the REAL path. Two profile directories where one is a symlink
      // to the other reach one metadata file under two spellings, and comparing
      // the spellings found no sharing at all (reviewer HIGH, two passes).
      try { return await fsp.realpath(candidate); } catch { return candidate; }
    } catch { /* next */ }
  }
  return null;
}

/**
 * Identity of one credential group, read in the SAME mode the sessions use.
 * `envUnset` matters: with CLAUDE_CONFIG_DIR unset the CLI reads the home-level
 * ~/.claude.json, not <dir>/.claude.json, so reading the wrong one reports the
 * wrong address and could skip a group that actually needs switching
 * (reviewer HIGH).
 *
 * When one credential carries sessions from BOTH binding modes, those are two
 * different metadata files for one credential and they can disagree. The
 * address is then unknowable, so it is reported as ambiguous rather than picked
 * (reviewer HIGH, two lenses).
 */
async function groupIdentity(g) {
  // The default credential is reachable in BOTH binding modes, so it always has
  // two possible metadata files whether or not both modes are running right
  // now. Reading only the live one let a file left stale by an earlier switch
  // name the old account, and the group was silently skipped while its sessions
  // spent the new one (reviewer HIGH). Whether the modes currently coexist is
  // not the question; whether the files can disagree is.
  const dualMode = g.mixedModes || g.envUnset
    || keychainServiceFor(g.configDir) === keychainServiceFor(defaultClaudeDir());
  if (!dualMode) {
    const id = await identityFor(g.configDir, { envUnset: !!g.envUnset });
    return { ...id, ambiguous: false };
  }
  const [unset, explicit, login] = await Promise.all([
    accountMetadata(g.configDir, { envUnset: true }),
    accountMetadata(g.configDir, { envUnset: false }),
    identityFor(g.configDir, { envUnset: !!g.envUnset }).then((i) => i.login),
  ]);
  // A file that is MISSING, or present but recording no login, holds no
  // opinion: on this Mac ~/.claude/.claude.json exists with no oauthAccount at
  // all, and counting that as disagreement made the default credential's five
  // live sessions unverifiable and unmovable. A file we could not READ is the
  // opposite, and must stop us: treating that as absence let a stale file win
  // and a live credential be skipped (reviewer HIGH, both directions).
  //
  // Addresses compare case-insensitively, as they do everywhere else here. Two
  // spellings of one account are not two accounts (reviewer MEDIUM).
  if (unset.state === 'unreadable' || explicit.state === 'unreadable') {
    return { email: unset.email || explicit.email, login, ambiguous: true };
  }
  const a = unset.email || null;
  const b = explicit.email || null;
  const conflict = !!a && !!b && a.toLowerCase() !== b.toLowerCase();
  return { email: a || b, login, ambiguous: conflict };
}

/** A group is only "already done" with a matching address AND a real credential. */
function isAlreadyOnTarget(id, targetEmail) {
  return !!(id.email && id.login === 'in' && targetEmail
    && id.email.toLowerCase() === targetEmail.toLowerCase());
}

/**
 * What to do with one group: 'skip', 'switch', or 'unverifiable'.
 *
 * 'unverifiable' exists because the other two are both wrong for a group whose
 * login record cannot be trusted. Skipping it risks leaving sessions on the old
 * account, which is the incident this feature exists for. But forcing it to
 * 'switch' is worse than it looks: nothing about it changes after a SUCCESSFUL
 * switch either, so the plan kept demanding the same destructive logout forever
 * and every retry reopened the credential gap on an account that was already
 * correct (reviewer HIGH, two passes). It is therefore excluded from the
 * one-click action and reported to the user instead.
 */
function decideAction(id, targetEmail, row) {
  if (id.ambiguous || row.sharedMetadata) return 'unverifiable';
  return isAlreadyOnTarget(id, targetEmail) ? 'skip' : 'switch';
}

/** READ-ONLY preview of what a switch would do. Mutates nothing. */
export async function planAccountSwitch(targetEmail) {
  const { groups, unresolved, total, discoveryFailed } = await scanClaudeProcesses();

  // A group running in BOTH binding modes reads two metadata files, and
  // offering only one of them to the sharing check hid a third group that
  // shared the other (reviewer HIGH).
  const metas = await Promise.all(groups.map(async (g) => {
    const modes = g.mixedModes ? [true, false] : [!!g.envUnset];
    const files = await Promise.all(modes.map((m) => metadataFileFor(g.configDir, m)));
    return [...new Set(files.filter(Boolean))];
  }));
  const metaCount = new Map();
  for (const files of metas) for (const m of files) metaCount.set(m, (metaCount.get(m) || 0) + 1);

  const rows = [];
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    const sharedMetadata = metas[i].some((m) => metaCount.get(m) > 1);
    const id = await groupIdentity(g);
    const row = {
      key: g.key,
      configDir: g.configDir,
      envUnset: !!g.envUnset,
      mixedModes: !!g.mixedModes,
      sharedMetadata,
      sessions: g.pids.length,
      currentEmail: id.email,
      loginState: id.login,
      ambiguous: !!id.ambiguous,
    };
    row.action = decideAction(id, targetEmail, row);
    rows.push(row);
  }
  return {
    target: targetEmail,
    groups: rows,
    unresolved,
    discoveryFailed: !!discoveryFailed,
    totalSessions: total,
    willSwitch: rows.filter((r) => r.action === 'switch').reduce((n, r) => n + r.sessions, 0),
    unverifiable: rows.filter((r) => r.action === 'unverifiable').reduce((n, r) => n + r.sessions, 0),
  };
}

/**
 * The journal records EVERY credential this feature has signed out and not yet
 * confirmed back in, as ONE FILE PER CREDENTIAL under a directory.
 *
 * Not one JSON array: that is a read-modify-write, and Dobius takes no
 * single-instance lock (checked: there is no requestSingleInstanceLock in the
 * app), so a packaged app and a dev run share this userData and two switches
 * can interleave. Both would read, both would write, and the second would erase
 * the first's record of a profile that is still signed out (reviewer HIGH,
 * three rounds). A file per key means two writers never touch the same path,
 * and clearing one is an unlink rather than a rewrite of everyone else's.
 *
 * There is no migration from the single-file shape because it never shipped:
 * this whole module is new in v1.0.75.
 */
const journalDir = () => path.join(app.getPath('userData'), 'account-switch-journal');
// A RANDOM per-run id is part of the NAME. Reading an entry and then unlinking
// it is a TOCTOU: another process can rename its own entry over that pathname in
// between, and the unlink then deletes a live record instead (reviewer HIGH,
// twice). A timestamp is not enough to name a run either: two processes can
// read the same millisecond, collide on the filename, and one then clears the
// other's live record (reviewer HIGH).
const entryFile = (key, runId) => path.join(
  journalDir(),
  `${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}.${runId}.json`,
);

/**
 * @throws when an entry exists but cannot be read or parsed. A missing
 * directory is an empty journal; an UNREADABLE entry is not. Collapsing the two
 * turned an EACCES into "no stranded credentials", and the next write then
 * replaced the record of a profile that was still signed out (reviewer HIGH).
 */
async function readJournal() {
  let names;
  try {
    names = await fsp.readdir(journalDir());
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // a *.tmp mid-write is not an entry
    let raw;
    try {
      raw = await fsp.readFile(path.join(journalDir(), name), 'utf8');
    } catch (err) {
      // Cleared between the listing and the read, which is an entry that
      // RECOVERED. Only a real read failure may raise the alarm.
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.configDir === 'string') out.push(parsed);
  }
  return out;
}

// Returns success: a destructive step must NOT proceed without recovery
// evidence on disk (reviewer HIGH).
async function addJournalEntry(entry) {
  const target = entryFile(entry.key, entry.runId);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fsp.mkdir(journalDir(), { recursive: true });
    // Temp file plus rename: a failure or a kill mid-write must not leave a
    // truncated entry that reads as no entry at all.
    await fsp.writeFile(tmp, JSON.stringify(entry, null, 2));
    await fsp.rename(tmp, target);
    return true;
  } catch {
    await fsp.unlink(tmp).catch(() => {});
    return false;
  }
}

/**
 * Clear EVERY entry for this credential, once a login has been verified.
 *
 * Not just this run's. A cancelled run leaves an entry behind, and with a
 * per-run filename a later successful run on the same credential no longer
 * removed it, so the "interrupted, it never reached Bob" warning came back on
 * the next unrelated switch and survived restarts (reviewer MEDIUM). A warning
 * that cries wolf is worse than no warning, because the real one stops being
 * read.
 *
 * Safe because the caller has just CONFIRMED this credential is signed in as
 * the target: whatever those older entries describe has been superseded.
 *
 * RESIDUAL, accepted: a second Dobius process could sign this same credential
 * out in the instant between that verification and this call, and lose its
 * warning. That needs two processes driving one credential, which also means
 * two logins fighting over one browser.
 */
async function clearJournalEntries(key) {
  const prefix = `${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}.`;
  let names;
  try { names = await fsp.readdir(journalDir()); } catch { return; }
  await Promise.all(names
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json'))
    // A failure leaves the entry, which errs toward warning the user.
    .map((n) => fsp.unlink(path.join(journalDir(), n)).catch(() => {})));
}

/**
 * Every interrupted switch from a previous run, so the user can see which
 * directories may have been left signed out. Recovery is never automatic:
 * re-running a login unasked would pop a browser window at launch.
 */
export async function interruptedSwitches() {
  let entries;
  // Reporting nothing because the file could not be READ would tell the user
  // they are safe on no evidence. One synthetic row says the opposite.
  try { entries = await readJournal(); }
  catch { return [{ key: 'journal', configDir: journalDir(), target: null, unreadable: true, loginState: 'unknown', recovered: false }]; }
  return Promise.all(entries.map(async (j) => {
    const id = await identityFor(j.configDir, { envUnset: !!j.envUnset });
    // "Recovered" means it reached the account the interrupted run was AIMING
    // at. Judging on login state alone called a login that landed on the wrong
    // account recovered, which is the exact failure the verification step
    // exists to catch (reviewer HIGH).
    const recovered = id.login === 'in' && !!id.email && !!j.target
      && id.email.toLowerCase() === String(j.target).toLowerCase();
    return {
      key: j.key || j.configDir,
      configDir: j.configDir,
      target: j.target,
      startedAt: j.startedAt,
      currentEmail: id.email,
      loginState: id.login,
      recovered,
    };
  }));
}

/** Run one CLI subcommand against a credential group. Resolves with its exit. */
function runBound(bin, args, group, onOutput, signal) {
  return new Promise((resolve) => {
    // An ALREADY-aborted signal, or a shutdown in progress, must not spawn
    // anything (reviewer HIGH).
    if (shuttingDown || signal?.aborted) return resolve({ code: -1, aborted: true });

    const env = { ...process.env };
    if (group.envUnset) delete env.CLAUDE_CONFIG_DIR; // the unset mode IS the binding
    else env.CLAUDE_CONFIG_DIR = group.configDir;

    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    liveChildren.add(child);
    let killTimer = null;
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      // A child that ignores SIGTERM would otherwise block every future switch
      // forever (reviewer MEDIUM).
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const pump = (s) => s.on('data', (d) => { try { onOutput?.(String(d)); } catch { /* noop */ } });
    pump(child.stdout); pump(child.stderr);
    const finish = (res) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      liveChildren.delete(child);
      resolve(res);
    };
    child.on('error', () => finish({ code: -1, failed: true }));
    child.on('close', (code) => finish({ code, aborted: !!signal?.aborted }));
  });
}

/**
 * @param {string[]|null} allowKeys the credential keys the USER reviewed and
 *   approved. Execution re-plans, because sessions start and stop, but it may
 *   only act on keys in this list. Without it the panel's list of profiles was
 *   advisory: twenty sessions could start on a colleague's profile between the
 *   preview and the click, and the job would sign that profile out although it
 *   never appeared in front of the user (reviewer HIGH). Anything new is
 *   reported back as appeared, untouched.
 */
export async function runAccountSwitch({ targetEmail, cliPath = null, onProgress = null, allowKeys = null } = {}) {
  if (current) return { ok: false, error: 'A switch is already running' };
  if (shuttingDown) return { ok: false, error: 'Dobius is shutting down' };
  if (!targetEmail || typeof targetEmail !== 'string') return { ok: false, error: 'No target account' };

  const controller = new AbortController();
  current = { targetEmail, controller };
  runningOutput = '';
  const emit = (ev) => { try { onProgress?.(ev); } catch { /* noop */ } };
  // A job outlives the panel that started it, so the result has to reach
  // whatever panel is mounted when it ends, not only the caller's promise
  // (reviewer HIGH).
  const done = (res) => {
    lastResult = { ...res, target: targetEmail, finishedAt: Date.now() };
    // Retire the job BEFORE announcing it. The finally below runs after this
    // returns, so a panel that mounted in between asked isSwitchRunning(),
    // was told yes, adopted busy, and then never received the 'finished' it
    // had already missed.
    current = null;
    emit({ phase: 'finished', result: lastResult });
    return lastResult;
  };

  try {
    // PREFLIGHT: everything that can fail without touching a credential.
    const bin = await resolveClaudeBin(cliPath);
    if (!bin) return done({ ok: false, error: 'Could not find a usable claude executable' });

    const plan = await planAccountSwitch(targetEmail);
    const wanted = plan.groups.filter((g) => g.action === 'switch');
    const allowed = Array.isArray(allowKeys) ? new Set(allowKeys) : null;
    const todo = allowed ? wanted.filter((g) => allowed.has(g.key)) : wanted;
    // Groups that need switching but were not in front of the user.
    const appeared = allowed ? wanted.filter((g) => !allowed.has(g.key)) : [];
    if (todo.length === 0) {
      // Not "everything is fine" if some sessions could not be classified or
      // could not be verified (reviewer MEDIUM).
      const covered = plan.unresolved.length === 0 && !plan.discoveryFailed && plan.unverifiable === 0;
      return done({
        ok: covered && appeared.length === 0, results: [], plan, notSwitched: [], appeared,
        remaining: appeared.reduce((n, g) => n + g.sessions, 0),
        unresolved: plan.unresolved.length,
        unverifiable: plan.unverifiable, discoveryFailed: plan.discoveryFailed,
        note: appeared.length > 0
          ? 'Sessions started on another profile after you reviewed this, so they were left alone'
          : covered
            ? 'Every running session is already on that account'
            : 'No group needed switching, but some sessions could not be identified',
      });
    }

    const results = [];
    for (const g of todo) {
      if (controller.signal.aborted) { results.push({ ...g, state: 'cancelled' }); break; }

      // Journal BEFORE the destructive step. If it cannot be written, do NOT
      // sign anything out: an interruption would then be unrecoverable evidence
      // free (reviewer HIGH).
      const startedAt = Date.now();
      const runId = crypto.randomUUID();
      const journaled = await addJournalEntry({
        key: g.key, configDir: g.configDir, envUnset: g.envUnset, target: targetEmail, startedAt, runId,
      });
      if (!journaled) { results.push({ ...g, state: 'journal-failed' }); break; }

      emit({ phase: 'logout', configDir: g.configDir, sessions: g.sessions });
      const out = await runBound(bin, ['auth', 'logout'], g, null, controller.signal);
      if (out.aborted) { results.push({ ...g, state: 'cancelled' }); break; }
      if (out.failed || out.code !== 0) { results.push({ ...g, state: 'logout-failed' }); break; }

      emit({ phase: 'awaiting-browser', configDir: g.configDir, sessions: g.sessions });
      const login = await runBound(
        bin, ['auth', 'login', '--email', targetEmail], g,
        (chunk) => { runningOutput = (runningOutput + chunk).slice(-4000); emit({ phase: 'output', configDir: g.configDir, chunk }); },
        controller.signal,
      );

      // VERIFY. A clean exit does NOT prove the intended account was reached:
      // the browser can silently approve a different signed-in session, which
      // is how several rows ended up on one login. A matching address with NO
      // credential is not success either (reviewer HIGH x2).
      // Verify in the mode the LOGIN actually ran in, not both. A credential
      // carrying sessions from both binding modes has two metadata files, and
      // the login only updates its own; comparing both then called a SUCCESSFUL
      // switch ambiguous and broke the loop before the remaining groups
      // (reviewer MEDIUM).
      const id = await identityFor(g.configDir, { envUnset: !!g.envUnset });
      const matches = !!(id.email && id.email.toLowerCase() === targetEmail.toLowerCase());
      let state;
      if (id.login !== 'in') state = login.aborted ? 'cancelled-signed-out' : 'signed-out';
      else if (!id.email) state = 'signed-in-address-unreadable';
      else if (matches) state = 'switched';
      else state = 'wrong-account';

      results.push({ ...g, state, landedEmail: id.email, loginState: id.login });
      emit({ phase: 'done-one', configDir: g.configDir, state, landedEmail: id.email });

      // Only a confirmed success clears this group's recovery record. Anything
      // else leaves it so the panel can warn about a stranded credential after a
      // restart (reviewer MEDIUM).
      if (state === 'switched') await clearJournalEntries(g.key);
      else break;
    }

    // Every group this run did NOT successfully switch. It must be "not
    // switched", never "not attempted": a group recorded as cancelled,
    // logout-failed or journal-failed counted as attempted and so vanished from
    // this list, and when the after-scan then failed the caller was told zero
    // remained while nine sessions sat on the old account (reviewer MEDIUM,
    // two passes). It has to come from the plan, because reading the after-scan
    // alone drops them entirely whenever that scan fails (reviewer HIGH).
    const switched = new Set(results.filter((r) => r.state === 'switched').map((r) => r.key));
    const notSwitched = todo.filter((g) => !switched.has(g.key));

    // Re-scan: sessions can start while the browser is open, so the frozen set
    // may no longer be the whole picture.
    const after = await planAccountSwitch(targetEmail);
    const afterTrustworthy = !after.discoveryFailed;
    const allSwitched = results.length > 0 && results.every((r) => r.state === 'switched');
    return done({
      ok: allSwitched && notSwitched.length === 0 && appeared.length === 0 && afterTrustworthy
        && after.willSwitch === 0 && after.unresolved.length === 0 && after.unverifiable === 0,
      results,
      notSwitched,
      appeared,
      // When discovery itself failed, the after-scan cannot lower this count.
      // Fall back to what the plan already proved was outstanding.
      remaining: afterTrustworthy
        ? after.willSwitch
        : Math.max(after.willSwitch, notSwitched.reduce((n, g) => n + g.sessions, 0)),
      unresolved: after.unresolved.length,
      unverifiable: after.unverifiable,
      discoveryFailed: after.discoveryFailed,
    });
  } finally {
    current = null;
  }
}

export function cancelAccountSwitch() {
  if (!current) return false;
  current.controller.abort();
  return true;
}
export function isSwitchRunning() { return !!current; }
export function runningSwitchTarget() { return current?.targetEmail ?? null; }
