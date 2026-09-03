// Account profiles share ONE setup; only credentials stay per-account (v1.0.66).
//
// The bug this fixes (Sam, 9/3: "no conversation found with any of the session
// ids that i'm trying to restore"). v1.0.65 turned the Switch button into a
// real pointer, so every new terminal launched with CLAUDE_CONFIG_DIR set to
// the account's profile dir. Claude Code scopes EVERYTHING to that dir, so a
// profile created for a login also had no transcripts, no skills, no hooks and
// no global CLAUDE.md. 3.9GB of real history sat in ~/.claude, invisible to
// `claude --resume`, while Dobius's own Sessions list (data-utils reads
// ~/.claude unconditionally) kept offering those exact sessions and every
// resume answered "No conversation found". The UI and the terminal disagreed
// about which profile was real.
//
// The model, chosen deliberately: an account is a LOGIN, not a separate
// machine. Each entry below is symlinked from the profile into ~/.claude, so
// one store backs every account and history/skills/hooks follow you across a
// Switch. Credentials do NOT: .claude.json holds oauthAccount and the Keychain
// entry is keyed by config dir, which is exactly what makes switching work.
//
// Sync on purpose. This is a startup invariant that must hold before any PTY
// can spawn, and it is a handful of lstat calls once the links exist.
import fs from 'fs';
import path from 'path';
import os from 'os';

// What "my setup" means: history plus the workflow layer. Everything absent
// from this list (.claude.json, sessions/, shell-snapshots/, statsig/, cache/)
// stays profile-local, either because it IS the credential or because it is
// per-process runtime state that would contend if shared.
export const SHARED_ENTRIES = [
  'projects',         // transcripts: what `claude --resume <id>` reads
  'history.jsonl',    // session index behind the /resume picker and Sessions tab
  'settings.json',    // hooks, env, mcpServers, permissions
  'CLAUDE.md',        // global house rules
  'skills',
  'plugins',
  'commands',
  'agents',
  'plans',
  'stats-cache.json',
];

export const defaultClaudeDir = () => path.join(os.homedir(), '.claude');
export const profilesRoot = () => path.join(os.homedir(), '.claude-profiles');

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

// Resolved through every symlink. path.resolve() is only string math, so it
// happily reports two paths as different while they are the SAME directory on
// disk; that is what made a symlinked profile dir rename the real
// ~/.claude/projects aside and replace it with a link to itself (Codex High,
// found independently by all three review lenses).
function realpathOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

/** A `.pre-share-` name nothing occupies, so setting a file aside never
 *  overwrites something already set aside by an earlier run (Codex High). */
function freeAsideName(base, stamp) {
  let candidate = `${base}.pre-share-${stamp}`;
  for (let n = 1; lstatOrNull(candidate); n += 1) candidate = `${base}.pre-share-${stamp}-${n}`;
  return candidate;
}

/** True when `p` is a symlink already resolving to `target`. */
export function linksTo(p, target) {
  const st = lstatOrNull(p);
  if (!st || !st.isSymbolicLink()) return false;
  try {
    return path.resolve(path.dirname(p), fs.readlinkSync(p)) === path.resolve(target);
  } catch { return false; }
}

/**
 * Count, WITHOUT touching anything, the names that exist on both sides and
 * cannot merge. Read-only on purpose: shareEntry has to know whether a merge
 * can fully drain the directory BEFORE it moves the first file.
 */
export function countCollisions(src, dst) {
  let n = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const sStat = lstatOrNull(s);
    if (!sStat) continue;
    const dStat = lstatOrNull(d);
    if (!dStat) continue;
    if (sStat.isDirectory() && dStat.isDirectory()) { n += countCollisions(s, d); continue; }
    n += 1;
  }
  return n;
}

/**
 * Move every child of `src` into `dst`, recursing where both sides hold a
 * directory. NEVER overwrites: a name that already exists in `dst` is left
 * where it is. Returns how many entries were left behind, so the caller can
 * tell "src is now empty, safe to replace with a link" from "keep the
 * leftovers". Losing a transcript here would be unrecoverable, so the
 * collision rule is keep-both, always.
 */
export function mergeInto(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let leftBehind = 0;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const sStat = lstatOrNull(s);
    if (!sStat) continue;
    const dStat = lstatOrNull(d);
    if (!dStat) {
      // rename() within one volume keeps open fds valid, so a live session's
      // transcript keeps being appended to after it moves.
      try { fs.renameSync(s, d); } catch { leftBehind += 1; }
      continue;
    }
    if (sStat.isDirectory() && dStat.isDirectory()) {
      const nested = mergeInto(s, d);
      leftBehind += nested;
      // A drained subdirectory that still refuses to go (a file landed after
      // the readdir snapshot, or the parent is not writable) means this tree
      // is NOT empty. Reporting 0 there let the caller believe the merge was
      // complete and try to link over a populated directory (Codex High).
      if (nested === 0) {
        try { fs.rmdirSync(s); } catch { leftBehind += 1; }
      }
      continue;
    }
    leftBehind += 1;
  }
  return leftBehind;
}

/**
 * Make one entry in `profileDir` resolve to `defaultDir`'s copy. Returns a
 * short status string naming what happened, for the startup log.
 */
export function shareEntry(profileDir, defaultDir, name, stamp = Date.now()) {
  const target = path.join(defaultDir, name);
  const link = path.join(profileDir, name);
  if (!lstatOrNull(target)) return 'absent-in-default';
  if (linksTo(link, target)) return 'already-shared';

  // Same directory reached by two names (a profile dir that is itself a
  // symlink into ~/.claude). Every branch below would then operate on the
  // real store: rename it aside, then link it to itself. Bail before any of
  // that can run.
  const realTarget = realpathOrNull(target);
  const realLink = realpathOrNull(link);
  if (realTarget && realLink && realTarget === realLink) return 'same-as-target';

  const st = lstatOrNull(link);
  if (!st) {
    fs.symlinkSync(target, link);
    return 'linked';
  }
  if (st.isSymbolicLink()) {
    // A link to nowhere is broken, not a preference. Repair it.
    if (!realLink) {
      fs.unlinkSync(link);
      fs.symlinkSync(target, link);
      return 'relinked-dangling';
    }
    // A link somebody deliberately pointed elsewhere is not ours to rewrite,
    // but it DOES mean this account resolves transcripts somewhere the
    // Sessions list is not reading, so say so loudly (Codex High).
    console.warn(`[account-share] ${link} points at ${realLink}, not ${target}. Sessions listed in the app will not resume in terminals for this account.`);
    return 'foreign-symlink';
  }

  if (st.isDirectory()) {
    // Check BEFORE acting: all or nothing. Merging first and only then
    // discovering a collision moves the NON-colliding transcripts into the
    // shared store and leaves the profile a real directory, so those sessions
    // become invisible from this account, which is the exact symptom this
    // module exists to remove (Codex High, round 2). Renaming the directory
    // aside instead is worse: it yanks it out from under any live claude
    // process appending to a transcript inside it (Codex High, round 1).
    // Transcript names are UUIDs, so a collision means the same session id in
    // both stores, which effectively cannot happen.
    const collisions = countCollisions(link, target);
    if (collisions > 0) {
      console.warn(`[account-share] ${link}: ${collisions} entr${collisions === 1 ? 'y' : 'ies'} collide with the shared store. Nothing moved, this one stays profile-local.`);
      return 'kept-not-shared';
    }
    let leftBehind = mergeInto(link, target);
    // One retry: a rename can fail transiently, and the re-scan also absorbs
    // anything a concurrent writer created during the first pass.
    if (leftBehind > 0 && countCollisions(link, target) === 0) leftBehind = mergeInto(link, target);
    if (leftBehind === 0) {
      try {
        fs.rmdirSync(link);
        fs.symlinkSync(target, link);
        return 'merged';
      } catch { /* something landed mid-flight; fall through and re-decide */ }
    }
    // Two review rounds pull opposite ways here and they only conflict in this
    // corner. Round 1: never move a file a live claude may be appending to.
    // Round 3: never leave a SPLIT tree, where entries already moved are
    // invisible through the profile. A residue that now COLLIDES is the live
    // case, so the collision policy wins and nothing further is touched: no
    // data is lost either way (the moved entries are in the shared store, and
    // the app reads that store), but moving a live transcript would break its
    // writer. Log it loudly, since this is the one state the invariant does
    // not cover.
    if (countCollisions(link, target) > 0) {
      console.warn(`[account-share] ${link}: a colliding entry appeared mid-merge. Left in place, so this account resolves some sessions through the shared store and some locally.`);
      return 'kept-not-shared';
    }
    // No clash: the residue is an IO or permission failure. Set it aside under
    // a name the CLI's `<uuid>.jsonl` scan ignores, so the store stays whole
    // and nothing is deleted.
    console.warn(`[account-share] ${link}: ${leftBehind} entr${leftBehind === 1 ? 'y' : 'ies'} could not move after a clean pre-scan. Set aside so the store stays whole.`);
    fs.renameSync(link, freeAsideName(link, stamp));
    fs.symlinkSync(target, link);
    return 'partial-merge-set-aside';
  }

  // A real file. Merging two JSONL indexes blind risks corrupting the good
  // one, so set the profile's copy aside instead of guessing.
  fs.renameSync(link, freeAsideName(link, stamp));
  fs.symlinkSync(target, link);
  return 'preserved-and-linked';
}

/**
 * Point one profile dir at the shared setup. Refuses anything that is not a
 * real profile dir, so a malformed claudeJsonPath can never turn ~/.claude
 * into a pile of self-referential symlinks.
 */
export function shareProfile(profileDir, opts = {}) {
  const defaultDir = opts.defaultDir || defaultClaudeDir();
  const root = opts.profilesRoot || profilesRoot();
  const entries = opts.entries || SHARED_ENTRIES;
  if (typeof profileDir !== 'string' || !profileDir) return { skipped: 'no-path' };
  const resolved = path.resolve(profileDir);
  if (resolved === path.resolve(defaultDir)) return { skipped: 'is-default-dir' };
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return { skipped: 'outside-profiles-root' };
  if (!lstatOrNull(defaultDir)) return { skipped: 'no-default-dir' };

  fs.mkdirSync(resolved, { recursive: true });
  // Re-run the guards on the REAL paths. The lexical checks above pass for a
  // profile dir that is a symlink into ~/.claude, and every entry would then
  // be linked to itself (Codex High).
  const realProfile = realpathOrNull(resolved);
  const realDefault = realpathOrNull(defaultDir);
  if (!realDefault) return { skipped: 'no-default-dir' };
  if (!realProfile) return { skipped: 'no-profile-dir' };
  if (realProfile === realDefault) return { skipped: 'profile-is-default-dir' };
  const realRoot = realpathOrNull(root);
  if (realRoot && !(realProfile + path.sep).startsWith(realRoot + path.sep)) {
    return { skipped: 'outside-profiles-root' };
  }
  const stamp = opts.stamp || Date.now();
  const report = {};
  for (const name of entries) {
    try { report[name] = shareEntry(resolved, defaultDir, name, stamp); }
    catch (err) { report[name] = `error: ${err?.message || err}`; }
  }
  return report;
}

/**
 * Startup entry point: every configured Claude account profile shares the one
 * setup. Best-effort per account, so a single bad path cannot block boot.
 */
export function shareConfiguredProfiles(accounts, opts = {}) {
  const out = [];
  for (const acct of Array.isArray(accounts) ? accounts : []) {
    if (!acct || acct.type !== 'claude' || typeof acct.claudeJsonPath !== 'string') continue;
    const expanded = acct.claudeJsonPath.startsWith('~')
      ? path.join(os.homedir(), acct.claudeJsonPath.slice(1))
      : acct.claudeJsonPath;
    const dir = path.dirname(expanded);
    let report;
    try { report = shareProfile(dir, opts); }
    catch (err) { report = { skipped: `error: ${err?.message || err}` }; }
    const changed = Object.entries(report).filter(([, v]) => v !== 'already-shared' && v !== 'absent-in-default');
    if (changed.length) {
      console.log(`[account-share] ${acct.name || acct.id}: ${changed.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
    out.push({ id: acct.id, dir, report });
  }
  return out;
}
