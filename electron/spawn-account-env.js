// The single place terminal spawn env is resolved, so EVERY spawn path (the
// desktop terminal:create IPC and every mobile-server createTerminal call) puts
// a terminal on the active Claude + Codex accounts. Before this, mobile-spawned
// terminals passed no env and silently ran on the Mac's default ~/.claude
// identity regardless of the Switch button (reviewer P2).

import fs from 'node:fs';
import path from 'node:path';
import { resolveTerminalAccount, claudeEnvForAccount, expandTilde } from './claude-account-env.js';
import { codexEnvForAccount, shareCodexProfile, codexProfilesRoot } from './codex-account-env.js';
import { shareProfile } from './account-profile-share.js';
import { loadConfig, getProjectAccount } from './config-manager.js';
import { ensureShim, resolveRealGws } from './gws-accounts.js';

let _gwsShim = null;
function getGwsShim() {
  if (!_gwsShim) _gwsShim = ensureShim();
  return _gwsShim;
}

// Does `p` resolve (through symlinks) to somewhere inside `root`? Uses lstat to
// find the deepest existing node so a DANGLING symlink is rejected, and
// realpath to catch a symlink COMPONENT that was retargeted to escape the root
// after the value was saved (reviewer P1). Same shape as config-manager's
// realWithin, applied at spawn time.
function pathWithinRoot(p, root) {
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return false; }
  let probe = path.resolve(p);
  for (;;) {
    let lst;
    try { lst = fs.lstatSync(probe); } catch { lst = null; }
    if (lst) {
      let real;
      try { real = fs.realpathSync(probe); } catch { return false; } // dangling symlink
      return real === realRoot || real.startsWith(realRoot + path.sep);
    }
    const parent = path.dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
}

/**
 * The account a tab's pin names: undefined for no usable pin (the normal
 * resolution applies), null for Default, or the one Claude account with that id
 * and a profile path. A pin that names nothing, or an id two rows share, is
 * ignored rather than guessed at.
 */
export function resolveClaudeAccountPin(pin, accounts) {
  if (!pin || typeof pin !== 'object' || !('id' in pin)) return undefined;
  if (pin.id === null) return null;
  if (typeof pin.id !== 'string' || !pin.id) return undefined;
  const matches = (Array.isArray(accounts) ? accounts : []).filter((a) => a?.type === 'claude' && a.id === pin.id);
  if (matches.length !== 1 || typeof matches[0].claudeJsonPath !== 'string' || !matches[0].claudeJsonPath) {
    console.warn('[account-pin] ignoring a tab pin that names no single Claude account');
    return undefined;
  }
  return matches[0];
}

/**
 * Build the spawn env for a terminal opened in `cwd`. Resolution: a project's
 * assigned account wins for its OWN tool type; otherwise the globally active
 * Claude and Codex accounts apply independently. Also performs the idempotent
 * profile-sharing side effects (symlinking each profile's shared entries into
 * the default dir) at the spawn choke point, so an account reached only through
 * a per-project override still has its history/skills/hooks linked.
 */
export function resolveAccountEnvForCwd(cwd, { claudeAccountPin } = {}) {
  const projectAccount = cwd ? getProjectAccount(cwd) : null;
  let activeAccount = null;
  let codexAccount = null;
  let pinned;
  {
    const cfgNow = loadConfig();
    const accts = cfgNow.accounts || [];
    const activeId = cfgNow.activeClaudeAccountId;
    if (activeId) activeAccount = accts.find((a) => a.id === activeId && a.type === 'claude') || null;
    const activeCodexId = cfgNow.activeCodexAccountId;
    if (projectAccount && projectAccount.type === 'codex') codexAccount = projectAccount;
    else if (activeCodexId) codexAccount = accts.find((a) => a.id === activeCodexId && a.type === 'codex') || null;
    pinned = resolveClaudeAccountPin(claudeAccountPin, accts);
  }
  const claudeProjectAccount = (projectAccount && projectAccount.type === 'claude') ? projectAccount : null;
  // A tab moved to an account keeps it over the project's and the active one.
  // undefined = no pin; null = pinned to Default.
  const account = pinned !== undefined ? pinned : resolveTerminalAccount(claudeProjectAccount, activeAccount);

  // Windows: profiles are shared by symlink, which needs admin or Developer
  // Mode there, so they are not linked (and accounts are not offered) yet.
  const IS_WIN = process.platform === 'win32';
  if (!IS_WIN && account?.type === 'claude' && account.claudeJsonPath) {
    try { shareProfile(path.dirname(expandTilde(account.claudeJsonPath))); }
    catch (err) { console.warn('[account-share] spawn-time link failed:', err?.message || err); }
  }
  if (!IS_WIN && codexAccount?.type === 'codex' && codexAccount.authMode === 'chatgpt' && codexAccount.codexHome) {
    try { shareCodexProfile(expandTilde(codexAccount.codexHome)); }
    catch (err) { console.warn('[codex-share] spawn-time link failed:', err?.message || err); }
  }
  const accountEnv = { ...claudeEnvForAccount(account), ...codexEnvForAccount(codexAccount) };
  // Re-validate CODEX_HOME AT SPAWN. safeCodexHome checked containment at save,
  // but a symlink component of the stored home can be retargeted afterward to
  // escape ~/.codex-profiles (e.g. to ~/.codex), which would point the terminal
  // at the DEFAULT credentials under this account's name (reviewer P1). Drop a
  // home that no longer resolves within the profiles root; the terminal then
  // falls back to the default ~/.codex rather than an escaped location.
  if (typeof accountEnv.CODEX_HOME === 'string' && !pathWithinRoot(accountEnv.CODEX_HOME, codexProfilesRoot())) {
    accountEnv.CODEX_HOME = undefined;
  }
  // Default Codex (no active chatgpt account) means the Mac's ~/.codex, which is
  // what the CLI uses when CODEX_HOME is unset. If the codex env did not set a
  // CODEX_HOME (default, or an apikey account, or a home dropped just above),
  // DELETE any CODEX_HOME inherited from Dobius's own launch environment so a
  // stale/other account home cannot leak into the terminal (reviewer P2).
  // undefined is createTerminal's deletion signal.
  if (typeof accountEnv.CODEX_HOME !== 'string') accountEnv.CODEX_HOME = undefined;

  // ponytail: the per-account `gws` shim is a sh wrapper, so Windows terminals
  // run the user's own gws unchanged. Upgrade path: a gws.cmd wrapper plus a
  // Windows-aware real-gws lookup in gws-shim.mjs.
  const shim = IS_WIN ? { shimDir: null } : getGwsShim();
  if (shim.shimDir) {
    accountEnv.DOBIUS_GWS_SHIM_DIR = shim.shimDir;
    // The shim folder is staged once; the real gws is looked up again for every terminal, so one installed after
    // launch is used without a restart (the shim also reads gws-env.json when this is unset or stale).
    // None found: clear any DOBIUS_REAL_GWS Dobius itself inherited (launched from a Dobius terminal), so the shim falls
    // through to gws-env.json instead of a stale path. undefined is createTerminal's deletion signal.
    accountEnv.DOBIUS_REAL_GWS = resolveRealGws(shim.shimDir) || undefined;
  }
  return accountEnv;
}
