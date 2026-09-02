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
// Honest tradeoff, stated in the UI too: an account's config dir is a FULL
// Claude config dir. Terminals running under one have that dir's settings,
// skills, and history, not ~/.claude's. The default (option 3) is the only
// one that carries the user's main setup.

import path from 'path';
import os from 'os';

/** Expand a leading ~ (shells do not expand it inside env values). */
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
  }
  if (account.cliPath) {
    env.DOBIUS_CLI_DIR = path.dirname(expandTilde(account.cliPath));
  }
  return env;
}
