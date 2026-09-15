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
import { ensureShim } from './gws-accounts.js';

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
 * Build the spawn env for a terminal opened in `cwd`. Resolution: a project's
 * assigned account wins for its OWN tool type; otherwise the globally active
 * Claude and Codex accounts apply independently. Also performs the idempotent
 * profile-sharing side effects (symlinking each profile's shared entries into
 * the default dir) at the spawn choke point, so an account reached only through
 * a per-project override still has its history/skills/hooks linked.
 */
export function resolveAccountEnvForCwd(cwd) {
  const projectAccount = cwd ? getProjectAccount(cwd) : null;
  let activeAccount = null;
  let codexAccount = null;
  {
    const cfgNow = loadConfig();
    const accts = cfgNow.accounts || [];
    const activeId = cfgNow.activeClaudeAccountId;
    if (activeId) activeAccount = accts.find((a) => a.id === activeId && a.type === 'claude') || null;
    const activeCodexId = cfgNow.activeCodexAccountId;
    if (projectAccount && projectAccount.type === 'codex') codexAccount = projectAccount;
    else if (activeCodexId) codexAccount = accts.find((a) => a.id === activeCodexId && a.type === 'codex') || null;
  }
  const claudeProjectAccount = (projectAccount && projectAccount.type === 'claude') ? projectAccount : null;
  const account = resolveTerminalAccount(claudeProjectAccount, activeAccount);

  if (account?.type === 'claude' && account.claudeJsonPath) {
    try { shareProfile(path.dirname(expandTilde(account.claudeJsonPath))); }
    catch (err) { console.warn('[account-share] spawn-time link failed:', err?.message || err); }
  }
  if (codexAccount?.type === 'codex' && codexAccount.authMode === 'chatgpt' && codexAccount.codexHome) {
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

  const shim = getGwsShim();
  if (shim.shimDir) {
    accountEnv.DOBIUS_GWS_SHIM_DIR = shim.shimDir;
    if (shim.realGws) accountEnv.DOBIUS_REAL_GWS = shim.realGws;
  }
  return accountEnv;
}
