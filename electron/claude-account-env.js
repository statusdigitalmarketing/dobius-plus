// Which Claude account a NEW terminal should run as, and the env that makes
// it real (v1.0.65).
//
// The discovery that makes this work (Sam, 8/22: "does switch do it for all
// dobius terminals... idek if that works at all rn"): Claude Code scopes its
// LOGIN to the config dir. A fresh CLAUDE_CONFIG_DIR reports loggedIn:false
// even while the default ~/.claude login sits valid in the Keychain, so each
// config dir is a fully independent identity. No keychain surgery needed:
// switching accounts = pointing new terminals at a different config dir.
//
// The old Switch button instead copied the snapshot over ~/.claude.json,
// which never changed the actual login (the token lives in the Keychain) and
// left mismatched oauthAccount metadata behind. That path is gone.
//
// Resolution order for a terminal in `projectPath`:
//   1. The project's assigned account (config.projectAccounts), the optional
//      per-project override.
//   2. The globally ACTIVE account (config.activeClaudeAccountId), which the
//      Switch button sets.
//   3. Neither -> no env at all: the terminal uses the Mac's default
//      ~/.claude identity, settings, skills, and hooks.
//
// Since v1.0.66 an account is a LOGIN boundary only: settings, skills, hooks
// and history are shared into ~/.claude by account-profile-share.js.
//
// Plugins are shared differently (v1.0.71). Claude Code keys its plugin
// registry, marketplaces and cache to the config dir, and validates
// marketplace install locations by LITERAL path prefix against the current
// CLAUDE_CONFIG_DIR (anthropics/claude-code#82272, open), so a symlinked
// plugins dir makes `plugin update` fail from every profile but one. The
// documented CLAUDE_CODE_PLUGIN_CACHE_DIR overrides the whole plugin root,
// validation included, so every account points at ~/.claude/plugins and sees
// the same installed set by construction. Verified on 2.1.270: five accounts,
// 18 enabled / 1 disabled / 0 failed each, and marketplace + plugin updates
// succeed from secondary profiles.

import path from 'path';
import os from 'os';

/** Expand a leading ~ (shells do not expand it inside env values). */
/** The Mac's own ~/.claude/plugins: the default plugin root for every account. */
export function sharedPluginRoot() {
  return path.join(os.homedir(), '.claude', 'plugins');
}

/**
 * The plugin root every Claude process spawned by Dobius should use. An
 * explicit CLAUDE_CODE_PLUGIN_CACHE_DIR in Dobius's own environment wins, so a
 * user who launched the app with a custom store keeps it on EVERY account;
 * silently replacing it only for saved accounts made switching accounts change
 * which plugins existed and where installs went (Codex P2). Otherwise the
 * shared root.
 */
export function resolvePluginRoot(env = process.env) {
  const explicit = env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return expandTilde(explicit.trim());
  return sharedPluginRoot();
}

/**
 * Pin the plugin root into Dobius's OWN environment, once, before any spawn.
 * Every child then inherits it: Default terminals (which get no per-account
 * env, and which inherit Dobius's CLAUDE_CONFIG_DIR when the app was launched
 * from a profile), agent and orchestrator spawns, the voice conductor. Without
 * this, a Default terminal on an inherited profile used that profile's own
 * plugins dir, which no longer gets a symlink, while the SAME identity selected
 * as an account used the shared root (Codex P2).
 */
export function pinPluginRoot(env = process.env) {
  env.CLAUDE_CODE_PLUGIN_CACHE_DIR = resolvePluginRoot(env);
  return env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
}

export function expandTilde(p) {
  return (typeof p === 'string' && p.startsWith('~')) ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Pure: pick the account for a terminal. `projectAccount` wins over
 * `activeAccount`; either may be null. Only claude/codex accounts the
 * callers already validated should be passed in.
 */
export function resolveTerminalAccount(projectAccount, activeAccount) {
  return projectAccount || activeAccount || null;
}

/**
 * Pure: the env additions for an account (claude or codex), same shapes the
 * terminal spawn already consumed. Returns {} for null/default.
 */
export function claudeEnvForAccount(account) {
  const env = {};
  if (!account) return env;
  if (account.type === 'codex' && account.apiKey) {
    env.OPENAI_API_KEY = account.apiKey;
    return env;
  }
  if (account.type !== 'claude') return env;
  if (account.claudeJsonPath) {
    env.CLAUDE_CONFIG_DIR = path.dirname(expandTilde(account.claudeJsonPath));
    // One plugin root for every account (see header). Set alongside the config
    // dir so the pure function is self-consistent; the default identity gets
    // the same value by inheriting the root pinned at boot (pinPluginRoot).
    env.CLAUDE_CODE_PLUGIN_CACHE_DIR = resolvePluginRoot();
  }
  if (account.cliPath) {
    env.DOBIUS_CLI_DIR = path.dirname(expandTilde(account.cliPath));
  }
  return env;
}
