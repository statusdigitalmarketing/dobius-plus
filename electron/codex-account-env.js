// Codex login accounts (v1.0.72).
//
// Mirrors the Claude account model. A Codex account is one of:
//   - 'chatgpt': a ChatGPT login. It gets its own CODEX_HOME under
//     ~/.codex-profiles/<id>; `codex login` run once in that home writes an
//     auth.json there, so it is an independent login. The rest of ~/.codex
//     (sessions, history, config, skills) is symlinked in so switching Codex
//     accounts never loses history and every account shares one settings file.
//   - 'apikey': an OpenAI API key, passed as OPENAI_API_KEY (the pre-v1.0.72
//     behavior, unchanged).
//
// CODEX_HOME is honored by the CLI (verified: a fresh empty CODEX_HOME reports
// "Not logged in"), so a per-account home is a per-account login, exactly like
// CLAUDE_CONFIG_DIR for Claude. auth.json is the credential and stays
// per-profile (never shared), like .claude.json for Claude.

import path from 'path';
import os from 'os';
import { shareProfile } from './account-profile-share.js';
import { expandTilde } from './claude-account-env.js';

export const codexDefaultDir = () => path.join(os.homedir(), '.codex');
export const codexProfilesRoot = () => path.join(os.homedir(), '.codex-profiles');

// What every Codex login shares from ~/.codex. Deliberately conservative:
//   - sessions / history.jsonl / session_index.jsonl: one shared history, so
//     switching accounts keeps it and the Sessions tab (which reads ~/.codex/
//     sessions) sees every account's sessions.
//   - config.toml: one settings + project-trust file across accounts.
//   - skills / rules / shell_snapshots: shared setup.
// NOT shared, and why:
//   - auth.json: THE login. Per-profile is the whole point (a test asserts it).
//   - the *.sqlite DBs (+ -wal/-shm): SQLite anchors its WAL to the directory
//     it opened, so a symlinked DB would split its WAL across homes and
//     corrupt. Verified on a copy. Each home keeps its own operational DBs.
//   - installation_id, log/, cache, models_cache.json, .tmp, config.toml.bak-*:
//     per-install or regenerable.
//   - plugins: Claude's plugin store validates marketplace paths by literal
//     config-dir prefix (#82272); Codex's behavior here is unverified, so it
//     stays per-profile rather than risk the same breakage.
export const SHARED_CODEX_ENTRIES = [
  'sessions',
  'history.jsonl',
  'session_index.jsonl',
  'config.toml',
  'skills',
  'rules',
  'shell_snapshots',
];

export const NEVER_SHARE_CODEX = new Set(['auth.json']); // guard for a test

/** The CODEX_HOME dir for a chatgpt account, or null. */
export function codexHomeForAccount(account) {
  if (!account || account.type !== 'codex') return null;
  if (account.authMode !== 'chatgpt') return null;
  const p = account.codexHome;
  if (typeof p !== 'string' || !p.trim()) return null;
  return expandTilde(p.trim());
}

/**
 * Env additions for a Codex account. chatgpt -> CODEX_HOME (no OPENAI_API_KEY,
 * which would override the login); apikey -> OPENAI_API_KEY. {} for anything
 * else, so a null/claude account contributes nothing.
 */
export function codexEnvForAccount(account) {
  if (!account || account.type !== 'codex') return {};
  if (account.authMode === 'chatgpt') {
    const home = codexHomeForAccount(account);
    // OPENAI_API_KEY: undefined is a deletion signal to createTerminal, so an
    // inherited key cannot override this account's stored ChatGPT login.
    return home ? { CODEX_HOME: home, OPENAI_API_KEY: undefined } : {};
  }
  if (account.apiKey) return { OPENAI_API_KEY: String(account.apiKey) };
  return {};
}

/**
 * Symlink the shared Codex setup from ~/.codex into a chatgpt account's home,
 * reusing the generic shareProfile (its realpath / all-or-nothing / ELOOP
 * guards apply unchanged). No-op for apikey/claude accounts.
 */
export function shareCodexProfile(profileDir, opts = {}) {
  if (typeof profileDir !== 'string' || !profileDir) return { skipped: 'no-path' };
  return shareProfile(profileDir, {
    defaultDir: codexDefaultDir(),
    profilesRoot: codexProfilesRoot(),
    entries: SHARED_CODEX_ENTRIES,
    ...opts,
  });
}
