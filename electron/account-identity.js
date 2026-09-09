// Who is an account, ACTUALLY (v1.0.67).
//
// Asana "Switch doesnt actually siwtch": switching was working the whole time.
// The account list showed a name the user typed and nothing else, so on this
// Mac two entries named "Bryan" and "Rich Wiggles" were one Claude login
// (richwigglesworth@gmail.com, one quota), and switching between them could
// not change the limit message. A third, "Sam", had no credential at all and
// answered "Not logged in - Please run /login". None of that was visible.
//
// So the list has to say who each entry really is, not what it was named.
//
// Two sources of truth, and they answer different questions:
//   .claude.json -> oauthAccount.emailAddress = WHICH login this profile is
//   credential   -> whether that login can still actually be used
// A profile can have the first and not the second (credential revoked or
// removed), which reads as a real account in the UI but fails on first use.
//
// Everything here is async and runs in parallel. It is called from an IPC
// handler on the main process, which also serves every terminal, so a stalled
// `security` binary or an unreadable profile must never block it (Codex P2:
// sequential execFileSync timeouts stalled main-process IPC for 5s per row).

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expandTilde } from './claude-account-env.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_LABEL = 'Default';

// A .claude.json is normally ~230KB here. The cap only stops a pathological
// file from stalling the Settings tab; it is not a real limit.
const MAX_CLAUDE_JSON = 25 * 1024 * 1024;

// errSecItemNotFound. `security` returns this when the service does not exist,
// which is the difference between "logged out" and "the probe broke".
const ERR_SEC_ITEM_NOT_FOUND = 44;

const KEYCHAIN_TIMEOUT_MS = 5000;

export function defaultClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

/**
 * The config dir a "Default" terminal will ACTUALLY be spawned with.
 *
 * Default means "no per-account env", so the terminal inherits Dobius's own
 * CLAUDE_CONFIG_DIR. Launch Dobius from a terminal that already carries one
 * (a Dobius terminal, for instance) and the Default row described ~/.claude
 * while every Default terminal ran as the inherited profile (Codex P2). The
 * row has to describe the thing that will actually happen.
 */
export function effectiveDefaultDir() {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return expandTilde(fromEnv.trim());
  return defaultClaudeDir();
}

/**
 * Where the login metadata lives, in priority order.
 *
 * Claude reads <configDir>/.config.json ahead of .claude.json when both exist,
 * so reading only the latter showed a stale address and grouped duplicates by
 * it (Codex P2).
 *
 * With CLAUDE_CONFIG_DIR set, .claude.json sits INSIDE that dir. With it unset,
 * the data dir is ~/.claude but the metadata sits at ~/.claude.json in the home
 * dir. Reading only inside the dir reported the Mac's own default account as
 * never logged in, which is exactly the kind of wrong answer this feature
 * exists to delete (Codex P2).
 *
 * NOT USED, deliberately: `claude auth status --json` reports email and
 * loggedIn authoritatively and would replace every inference below. It WRITES
 * to the config dir (it creates .claude.json and a backups/ directory in an
 * empty one), and this panel re-reads on every window focus. Writing into six
 * profile directories to render a settings row, and fabricating a .claude.json
 * inside a profile that genuinely has none, is worse than an imperfect badge.
 * Everything here stays read-only.
 */
export function claudeJsonCandidates(configDir, { envUnset = false } = {}) {
  const out = [path.join(configDir, '.config.json')];
  // The home-level ~/.claude.json is Claude's metadata ONLY when
  // CLAUDE_CONFIG_DIR is unset. Setting it explicitly to ~/.claude is a
  // different case: Claude then reads ~/.claude/.claude.json like any other
  // config dir. Keying this off the path alone read the wrong file and grouped
  // the default with the wrong saved accounts (Codex P2).
  if (envUnset) out.push(path.join(os.homedir(), '.claude.json'));
  out.push(path.join(configDir, '.claude.json'));
  return out;
}

function sha8(p) {
  // NFC first. Claude normalises the configured pathname before hashing, and
  // macOS hands back decomposed forms for accented names, so hashing the raw
  // string missed the real service and reported 'out' on a working account
  // (Codex P2).
  return crypto.createHash('sha256').update(p.normalize('NFC')).digest('hex').slice(0, 8);
}

/**
 * Claude Code names its Keychain item after the config dir it was logged in
 * under: `Claude Code-credentials-<first 8 of sha256(NFC(dir))>`, and the plain
 * `Claude Code-credentials` for the default ~/.claude.
 *
 * It hashes the CONFIGURED pathname, never the resolved target, so this must
 * not resolve symlinks. Two earlier versions got this wrong in both directions:
 * hashing the realpath reported "no credential" on a working symlinked profile,
 * and then ALSO probing the realpath reported a credential that Claude, reading
 * only the link spelling, cannot use. One spelling, the configured one.
 */
export function keychainServiceFor(configDir) {
  if (path.resolve(configDir) === path.resolve(defaultClaudeDir())) return 'Claude Code-credentials';
  return `Claude Code-credentials-${sha8(configDir)}`;
}

/**
 * A .credentials.json only counts when it actually holds a Claude OAuth login.
 * The same file is used for MCP OAuth material, and treating that as a Claude
 * credential suppressed the "no credential" warning on an account the CLI
 * reports as logged out (Codex P2).
 */
async function hasClaudeCredentialFile(dir) {
  const p = path.join(dir, '.credentials.json');
  try {
    const st = await fs.stat(p);
    if (!st.isFile() || st.size > MAX_CLAUDE_JSON) return false;
    const parsed = JSON.parse(await fs.readFile(p, 'utf8'));
    return Boolean(parsed?.claudeAiOauth);
  } catch {
    return false;
  }
}

// Claude reads process.env.USER first and only falls back to the OS record, so
// matching the other one selects a credential Claude never looks at (Codex P2).
function osUser() {
  const fromEnv = process.env.USER;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  try { return os.userInfo().username; } catch { return null; }
}

/**
 * One Keychain service. Filtered by OS user because `security` without `-a`
 * matches an entry belonging to a DIFFERENT account on the machine, which
 * Claude cannot use: that read as logged in on an account Claude reported as
 * logged out (Codex P2). When the filtered read finds nothing but an
 * unfiltered one does, the honest answer is 'unknown', not 'out'.
 */
async function probeKeychain(service) {
  const user = osUser();
  const args = ['find-generic-password', '-s', service];
  try {
    await execFileAsync('security', [...args, ...(user ? ['-a', user] : [])], { timeout: KEYCHAIN_TIMEOUT_MS });
    return 'in';
  } catch (err) {
    if (err?.code !== ERR_SEC_ITEM_NOT_FOUND) return 'unknown';
  }
  if (!user) return 'out';
  try {
    await execFileAsync('security', args, { timeout: KEYCHAIN_TIMEOUT_MS });
    return 'unknown'; // an entry exists, but not for this user
  } catch (err) {
    return err?.code === ERR_SEC_ITEM_NOT_FOUND ? 'out' : 'unknown';
  }
}

/**
 * 'in' the credential exists, 'out' it does not, 'unknown' the probe itself
 * could not answer. Never collapse 'unknown' into 'out': telling someone they
 * are logged out because `security` was missing or timed out sends them to
 * re-run a login they did not need.
 *
 * Checks the on-disk credential FIRST. macOS Claude Code supports
 * <configDir>/.credentials.json as a fallback to the Keychain, and an account
 * using it is genuinely logged in; reporting "no credential" there would be a
 * false alarm on a working account (Codex P2).
 */
export async function loginState(configDir) {
  if (await hasClaudeCredentialFile(configDir)) return 'in';
  return probeKeychain(keychainServiceFor(configDir));
}

// KNOWN LIMIT, accepted deliberately: this proves the Keychain ITEM exists, not
// that its contents are a Claude login. Reading the secret needs `security -w`,
// which pops a Keychain prompt, and firing one of those every time Settings
// opens is worse than the failure it prevents. The failure here is a MISSING
// warning, never a wrong one: an account with unrelated material under the same
// service simply does not get flagged.

/**
 * The login this profile belongs to, or null when the profile has never been
 * logged into. A missing .claude.json is the ordinary case for a freshly added
 * account, not an error worth logging on every Settings open.
 *
 * The isFile() guard is not cosmetic: a FIFO reports size 0, sails past a size
 * check, and then blocks the read forever with no error to catch (Codex P2).
 */
export async function accountEmail(configDir, opts) {
  for (const candidate of claudeJsonCandidates(configDir, opts)) {
    // SELECTION. Only "this file is not here" may advance to the next
    // candidate. The isFile() guard is not cosmetic either: a FIFO reports
    // size 0, sails past a size check, then blocks the read forever with no
    // error to catch.
    let st;
    try {
      st = await fs.stat(candidate);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    // SELECTED. Claude picks the metadata file by existence and reads only that
    // one, so from here every failure means "no address", never "try the next".
    // Advancing on an unreadable file surfaced a stale address out of a file
    // Claude ignores and grouped two rows as one login on it (Codex P2, twice:
    // first for an addressless file, then for an unreadable one).
    if (st.size > MAX_CLAUDE_JSON) return null;
    let raw;
    try {
      raw = await fs.readFile(candidate, 'utf8');
    } catch (err) {
      console.warn(`[account-identity] cannot read ${candidate}: ${err.message}`);
      return null;
    }
    try {
      const email = JSON.parse(raw)?.oauthAccount?.emailAddress;
      return typeof email === 'string' && email.trim() ? email.trim() : null;
    } catch (err) {
      console.warn(`[account-identity] ${candidate} is not valid JSON: ${err.message}`);
      return null;
    }
  }
  return null;
}

export async function identityFor(configDir, opts) {
  const [email, login] = await Promise.all([accountEmail(configDir, opts), loginState(configDir)]);
  return { email, login };
}

export function configDirForAccount(account) {
  // Typed, not just truthy: a config carrying claudeJsonPath: 123 sailed past a
  // truthiness guard and threw ERR_INVALID_ARG_TYPE inside path.dirname, which
  // rejected the whole lookup and blanked the identity of every healthy account
  // including the default (Codex P2).
  const p = account?.claudeJsonPath;
  if (typeof p !== 'string' || !p.trim()) return null;
  return path.dirname(expandTilde(p));
}

/**
 * Identity for the default plus every Claude account.
 *
 * Returns `{ default, accounts: [...] }` with the accounts as an ARRAY rather
 * than a map keyed by account id. Account ids are user-influenced, and a map
 * let an id of `__proto__` silently mutate the result's prototype instead of
 * adding a row, and an id of `__default__` overwrite the real default entry so
 * both rows showed the same login (Codex P2, twice). An array cannot collide.
 *
 * Every probe runs in parallel: one slow Keychain lookup costs one timeout for
 * the whole call, not one per account.
 *
 * Codex accounts are skipped: they have no Claude login to report.
 */
export async function accountIdentities(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];

  // `accounts` comes back aligned 1:1 with the input list, null where there is
  // nothing to report (a Codex account, or a row with no usable path). The
  // renderer looks rows up BY POSITION, never by account id: ids are
  // user-supplied, and a config carrying the same id twice made two rows read a
  // single identity and render one account's login against another. Deduping
  // the ids did not fix that, it just hid the second account (Codex P2, twice).
  const eligible = list.map((a) => {
    if (a?.type !== 'claude') return null;
    const dir = configDirForAccount(a);
    return dir ? { acct: a, dir } : null;
  });

  // Per row: one unreadable profile must not reject the whole call and blank
  // every healthy account's identity along with it (Codex P2).
  const safeIdentity = async (dir, opts) => {
    try {
      return await identityFor(dir, opts);
    } catch (err) {
      console.warn(`[account-identity] ${dir}: ${err?.message || err}`);
      return { email: null, login: 'unknown' };
    }
  };

  const [defaultIdent, ...idents] = await Promise.all([
    // Only the Default row can be reading a dir Claude was not explicitly
    // pointed at; a saved account is always spawned with an explicit
    // CLAUDE_CONFIG_DIR, so the home-level file never applies to it.
    safeIdentity(effectiveDefaultDir(), { envUnset: !process.env.CLAUDE_CONFIG_DIR }),
    ...eligible.map((e) => (e ? safeIdentity(e.dir) : Promise.resolve(null))),
  ]);

  const label = (acct) => {
    if (typeof acct.name === 'string' && acct.name.trim()) return acct.name.trim();
    return typeof acct.id === 'string' && acct.id ? acct.id : 'Account';
  };

  const rows = eligible.map((e, i) => (e && idents[i]
    ? { id: typeof e.acct.id === 'string' ? e.acct.id : null, label: label(e.acct), ...idents[i], sameAs: [] }
    : null));

  const defaultRow = { id: null, label: DEFAULT_LABEL, ...defaultIdent, sameAs: [] };

  // Group by login. Case-insensitive because an address differing only in case
  // is still the same account and the same quota. The default takes part: it is
  // routinely the same login as one of the saved accounts, and that is exactly
  // the pair a reader needs to see.
  const byEmail = new Map();
  for (const row of [defaultRow, ...rows.filter(Boolean)]) {
    if (!row.email) continue;
    const k = row.email.toLowerCase();
    if (!byEmail.has(k)) byEmail.set(k, []);
    byEmail.get(k).push(row);
  }
  for (const group of byEmail.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      row.sameAs = group.filter((r) => r !== row).map((r) => r.label);
    }
  }

  return { default: defaultRow, accounts: rows };
}
