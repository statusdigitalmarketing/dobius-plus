// Google Workspace (gws) multi-account foundation (v1.0.41).
//
// Lets Dobius connect several Google accounts and run the `gws` CLI (or, later,
// Google API calls) AS a chosen account, selected by email. Chrome is not
// involved here: this is the CLI/API side. The Chrome-profile launcher
// (chrome-profiles.js) is the browser equivalent.
//
// Model (see GWS-MULTI-ACCOUNT-PLAN.md, Codex-reviewed):
//  - Connect snapshots an account's refresh token via `gws auth export` into a
//    0600 file under ~/.gws-profiles/<id>.json (dir 0700). config holds only
//    metadata (id, email, name, scopes), never the token.
//  - A short-lived access token is minted on demand from the refresh token
//    (OAuth refresh grant) and cached in memory until it expires. Tokens NEVER
//    cross to the renderer; only purpose-specific main-side callers use them.
//
// PHASE-0 CAVEAT: the exact OAuth client that mints from gws's refresh token
// could not be proven from the build environment (no outbound HTTP there). The
// connect flow proves it live on first run and stores the working client; if
// neither candidate client works it fails loudly with a redacted error.

import fs from 'fs/promises';
import fsSync, { constants as FS } from 'fs';
import path from 'path';
import os from 'os';
import { execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { app, shell, BrowserWindow } from 'electron';
import { getGwsAccounts, saveGwsAccount, deleteGwsAccount, isValidGwsId } from './config-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROFILES_DIR = path.join(os.homedir(), '.gws-profiles');
const GWS_CLIENT_SECRET = path.join(os.homedir(), '.config', 'gws', 'client_secret.json');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// gws is typically a Homebrew binary; Electron's PATH is minimal, so augment it.
const EXEC_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
const IS_WIN = process.platform === 'win32';
const EXEC_ENV = IS_WIN ? { ...process.env } : { ...process.env, PATH: `${EXEC_PATH}:${process.env.PATH || ''}` };

// How to start gws: { file, args, env }. macOS runs the binary from PATH. On
// Windows npm installs gws as a .cmd, which Node will not start without a
// shell (and a shell would re-quote our arguments), so its JS entry runs under
// Dobius's own Electron binary in node mode. Same lookup as gws-mcp.mjs.
export function gwsCommand(args, env = process.env) {
  if (!IS_WIN) return { file: 'gws', args, env: EXEC_ENV };
  const candidates = [];
  if (env.APPDATA) {
    const pkgDir = path.join(env.APPDATA, 'npm', 'node_modules', '@googleworkspace', 'cli');
    try {
      const pkg = JSON.parse(fsSync.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.gws;
      if (typeof bin === 'string' && bin) candidates.push(path.join(pkgDir, bin));
    } catch { /* no package.json: the literals below */ }
    candidates.push(path.join(pkgDir, 'run.js'), path.join(pkgDir, 'bin', 'gws'));
  }
  for (const cand of candidates) {
    try {
      fsSync.accessSync(cand, fsSync.constants.R_OK);
      return { file: process.execPath, args: [cand, ...args], env: { ...EXEC_ENV, ELECTRON_RUN_AS_NODE: '1' } };
    } catch { /* next */ }
  }
  return { file: 'gws.exe', args, env: EXEC_ENV }; // a native gws.exe on PATH, if any
}

// In-memory access-token cache: id -> { token, expiresAt }. Never persisted.
const tokenCache = new Map();

function ensureProfilesDir() {
  // The dir that holds refresh tokens must be a REAL directory we own, not a
  // symlink: O_NOFOLLOW only guards the leaf <id>.json, so a symlinked
  // ~/.gws-profiles would still land tokens in the link's target (possibly a
  // less-protected or attacker-controlled dir). lstat (no-follow) and refuse if
  // it is a symlink or not a directory. Codex v1.0.41 r3 P2.
  let st = null;
  try {
    st = fsSync.lstatSync(PROFILES_DIR);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error('profiles_dir_unsafe');
    }
    try { fsSync.chmodSync(PROFILES_DIR, 0o700); } catch { /* best effort */ }
    return;
  }
  // 0700: only the user can enter the dir that holds refresh tokens.
  fsSync.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
  try { fsSync.chmodSync(PROFILES_DIR, 0o700); } catch { /* best effort */ }
}

// Derive the profile path FROM the id on every use; never store or trust a
// path from config. The id shape (gws-<alnum>) cannot contain a path
// separator or dots, so the join stays inside PROFILES_DIR. Codex plan #3.
// Exported for tests; returns null for any id that is not shape-valid.
export function profilePathFor(id) {
  if (!isValidGwsId(id)) return null;
  const p = path.join(PROFILES_DIR, `${id}.json`);
  // Belt-and-suspenders: the resolved path must still sit directly inside
  // PROFILES_DIR. isValidGwsId already forbids separators/dots, so this can
  // only ever pass, but it makes the containment explicit and future-proof.
  if (path.dirname(p) !== PROFILES_DIR) return null;
  return p;
}

function newGwsId() {
  // Opaque, main-generated. base64url avoids path-hostile chars.
  return `gws-${randomBytes(18).toString('base64url')}`;
}

// Delete the shim's on-disk token cache for an account. Called on reconnect
// (creds/scopes may have changed, so an old cached bearer token must not be
// reused for up to an hour) and on removal. Codex v1.0.41 holistic P2.
export async function clearShimTokenCache(id) {
  if (!isValidGwsId(id)) return;
  try { await fs.unlink(path.join(PROFILES_DIR, `.token-${id}.json`)); } catch { /* none */ }
}

// Read a profile file safely: open with O_NOFOLLOW so the final component is
// never followed through a symlink, verify the OPEN fd is a regular file
// (fstat, closes the lstat/read TOCTOU window), then parse. Returns creds or
// null. Codex v1.0.41 r2 P2.
async function readProfile(id) {
  const p = profilePathFor(id);
  if (!p) return null;
  let fh;
  try {
    fh = await fs.open(p, FS.O_RDONLY | FS.O_NOFOLLOW);
  } catch {
    return null; // ELOOP (symlink) / ENOENT / etc.
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const raw = await fh.readFile('utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j.refresh_token !== 'string') return null;
    return j;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

// Write a profile with no-follow, exclusive-of-symlinks semantics so a stale or
// malicious symlink at the target can NEVER redirect the refresh-token write
// onto another file (which we would then chmod). O_NOFOLLOW fails with ELOOP if
// the final component is a symlink; O_CREAT|O_TRUNC creates or replaces our own
// regular file. We fstat the opened fd before writing and fchmod it (not the
// path) so perms are set on the actual file. Exported for the no-follow test.
// Codex v1.0.41 r2 P2.
export async function writeProfile(id, creds) {
  ensureProfilesDir();
  const p = profilePathFor(id);
  if (!p) throw new Error('bad_id');
  const flags = FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW;
  let fh;
  try {
    fh = await fs.open(p, flags, 0o600);
  } catch {
    // ELOOP means the path is a symlink: refuse rather than follow it.
    throw new Error('profile_open_refused');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('profile_not_regular_file');
    await fh.chmod(0o600);
    await fh.writeFile(JSON.stringify(creds));
  } finally {
    await fh.close();
  }
}

// Run `gws auth export` for the CURRENTLY logged-in gws account. Read-only.
// Returns { client_id, client_secret, refresh_token } or null.
function gwsAuthExport() {
  return new Promise((resolve) => {
    // --unmasked is REQUIRED: without it current gws masks the refresh_token
    // and client_secret (e.g. an 11-char placeholder), and every refresh-grant
    // mint then fails invalid_grant, so no account could ever connect. Verified
    // against the installed gws CLI. Codex v1.0.41 r4 P1.
    const cmd = gwsCommand(['auth', 'export', '--unmasked']);
    execFile(cmd.file, cmd.args, { env: cmd.env, timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) {
        console.warn('[gws-accounts] gws auth export failed:', err.code || 'unknown');
        return resolve(null);
      }
      try {
        const j = JSON.parse(stdout);
        if (j && typeof j.refresh_token === 'string') resolve(j);
        else resolve(null);
      } catch {
        resolve(null); // never log stdout: it carries the refresh token
      }
    });
  });
}

// The OAuth client from ~/.config/gws/client_secret.json (installed app form).
async function readGwsClient() {
  try {
    const j = JSON.parse(await fs.readFile(GWS_CLIENT_SECRET, 'utf8'));
    const c = j.installed || j.web || {};
    if (typeof c.client_id === 'string' && typeof c.client_secret === 'string') {
      return { client_id: c.client_id, client_secret: c.client_secret };
    }
  } catch { /* fall through */ }
  return null;
}

// Exchange a refresh token for an access token. Returns { access_token,
// expires_in, scope } or { error } (never throws; never returns secrets in
// error). This is the phase-0 mechanism and the runtime minter.
async function refreshGrant(client_id, client_secret, refresh_token) {
  try {
    const body = new URLSearchParams({ client_id, client_secret, refresh_token, grant_type: 'refresh_token' });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) {
      return { access_token: j.access_token, expires_in: Number(j.expires_in) || 3600, scope: typeof j.scope === 'string' ? j.scope : '' };
    }
    // j.error is an OAuth error CODE (invalid_grant, etc.), not a secret.
    return { error: typeof j.error === 'string' ? j.error : `http_${r.status}` };
  } catch (e) {
    return { error: e?.code || 'network_error' };
  }
}

/**
 * Connect the currently-logged-in gws account into Dobius.
 *
 * Flow: snapshot via `gws auth export`, find a client that actually mints
 * (proving phase 0 live), read the account email from the granted token,
 * persist the 0600 profile + metadata. Returns { ok, account } or
 * { ok:false, error } with a REDACTED, generic error.
 */
export async function connectGwsAccount() {
  const exp = await gwsAuthExport();
  if (!exp) {
    return { ok: false, error: 'Could not read gws credentials. Run `gws auth login` in a terminal first.' };
  }
  // Try the export's own client first (matched set with its refresh token),
  // then the installed client from client_secret.json. Store whichever works.
  const candidates = [];
  if (exp.client_id && exp.client_secret) candidates.push({ client_id: exp.client_id, client_secret: exp.client_secret });
  const installed = await readGwsClient();
  if (installed) candidates.push(installed);
  if (candidates.length === 0) {
    return { ok: false, error: 'No usable OAuth client found for gws.' };
  }

  let working = null;
  let minted = null;
  for (const c of candidates) {
    const res = await refreshGrant(c.client_id, c.client_secret, exp.refresh_token);
    if (res.access_token) { working = c; minted = res; break; }
  }
  if (!working) {
    return { ok: false, error: 'Google rejected the refresh token for every known OAuth client. Reconnect with `gws auth login`.' };
  }

  // Identify the account email from the minted access token (userinfo).
  let email = '';
  try {
    const ur = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${minted.access_token}` },
    });
    const uj = await ur.json().catch(() => ({}));
    if (typeof uj.email === 'string') email = uj.email;
  } catch { /* email stays empty; handled below */ }
  if (!email) {
    return { ok: false, error: 'Connected, but could not read the account email (userinfo scope missing?). Reconnect granting profile/email.' };
  }

  // Reuse an existing id for this email so reconnect refreshes in place.
  const existing = getGwsAccounts().find((a) => a.email === email);
  const id = existing?.id || newGwsId();
  try {
    await writeProfile(id, {
      email,
      client_id: working.client_id,
      client_secret: working.client_secret,
      refresh_token: exp.refresh_token,
    });
  } catch {
    return { ok: false, error: 'Could not save the account profile.' };
  }
  const scopes = minted.scope ? minted.scope.split(/\s+/).filter(Boolean) : [];
  const meta = saveGwsAccount({ id, email, name: email, scopes, addedAt: Date.now() });
  if (!meta) {
    return { ok: false, error: 'Could not save the account.' };
  }
  // Reconnect may have changed scopes or the client, so drop the shim's stale
  // on-disk token cache; otherwise terminal `gws` keeps using the old bearer
  // token for up to an hour. Codex v1.0.41 holistic P2.
  await clearShimTokenCache(id);
  // Seed the token cache with the token we just minted.
  tokenCache.set(id, { token: minted.access_token, expiresAt: Date.now() + (minted.expires_in - 60) * 1000 });
  return { ok: true, account: { id: meta.id, email: meta.email, name: meta.name, scopes: meta.scopes } };
}

/** Public list: metadata only, NEVER tokens. */
export function listGwsAccounts() {
  return getGwsAccounts().map((a) => ({ id: a.id, email: a.email, name: a.name, scopes: a.scopes || [] }));
}

// ---------------------------------------------------------------------------
// Health + one-button reconnect (v1.0.61). A live audit found 4 of 5 stored
// grants revoked by Google (invalid_grant) with nothing in the UI saying so:
// every Claude attempt through those accounts just failed. Sam: "when we need
// to reconnect gws, it should be an easy way to do it from the settings".
// ---------------------------------------------------------------------------

// Verify results are cached briefly: Settings re-renders must not hammer
// Google's token endpoint. A successful probe seeds the runtime token cache,
// so verifying is never wasted work.
const verifyCache = new Map(); // id -> { at, status, error }
const VERIFY_CACHE_MS = 5 * 60_000;

/**
 * Probe every connected account's stored grant against Google.
 * status: 'ok' (mints), 'revoked' (invalid_grant: only a reconnect fixes it),
 * 'error' (transient/other; the account may still be fine).
 */
export async function verifyGwsAccounts({ force = false } = {}) {
  const out = [];
  for (const a of getGwsAccounts()) {
    const hit = verifyCache.get(a.id);
    if (!force && hit && Date.now() - hit.at < VERIFY_CACHE_MS) {
      out.push({ id: a.id, email: a.email, status: hit.status, error: hit.error });
      continue;
    }
    let status = 'error';
    let error = null;
    const prof = await readProfile(a.id);
    if (!prof) {
      error = 'profile_unreadable';
    } else {
      const res = await refreshGrant(prof.client_id, prof.client_secret, prof.refresh_token);
      if (res.access_token) {
        // The mint proves the GRANT lives; it does not prove it belongs to
        // the email this row claims. A swapped or stale profile file would
        // otherwise get its token cached under the registry id, and
        // getAccessTokenForEmail(alice) could then act as bob (Codex P1).
        // Ask Google whose token this is before trusting it, AND require the
        // profile file's own email to agree with the registry: a token that
        // is provably the right person's inside a profile whose email field
        // lies still means the file is corrupted or tampered, and the two
        // consumers (this cache seed and getAccessToken's mint path) must
        // reach the same verdict on it or one bypasses the other via the
        // cache (Codex P1, final round).
        const profileAgrees = !prof?.email || !a.email
          || String(prof.email).toLowerCase() === String(a.email).toLowerCase();
        const who = await tokenEmail(res.access_token);
        if (profileAgrees && who && a.email && who.toLowerCase() === String(a.email).toLowerCase()) {
          status = 'ok';
          tokenCache.set(a.id, { token: res.access_token, expiresAt: Date.now() + (res.expires_in - 60) * 1000 });
        } else if (who) {
          error = 'email_mismatch'; // grant works but is not this account's
        } else {
          error = 'userinfo_failed'; // cannot prove ownership: do not cache
        }
      } else if (res.error === 'invalid_grant') {
        status = 'revoked';
      } else {
        error = res.error; // network_error, http_5xx, ...: not proof of death
      }
    }
    verifyCache.set(a.id, { at: Date.now(), status, error });
    out.push({ id: a.id, email: a.email, status, error });
  }
  return out;
}

/** Whose access token is this? Email from Google userinfo, or null. */
async function tokenEmail(accessToken) {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const j = await r.json().catch(() => ({}));
    return typeof j.email === 'string' ? j.email : null;
  } catch { return null; }
}

/** The email the BASE gws login currently acts as, or null. */
function baseAuthUser() {
  return new Promise((resolve) => {
    const cmd = gwsCommand(['auth', 'status']);
    execFile(cmd.file, cmd.args, { env: cmd.env, timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        // Output is a banner line then JSON; parse from the first brace.
        const i = stdout.indexOf('{');
        const j = JSON.parse(stdout.slice(i));
        resolve(typeof j.user === 'string' ? j.user : null);
      } catch { resolve(null); }
    });
  });
}

/**
 * Pull Google's OAuth consent URL out of accumulated child output, or null.
 * Only Google's own OAuth origin is ever eligible: this feeds
 * shell.openExternal, and arbitrary child output must never pick what opens.
 * The URL only counts once something follows it (gws prints a blank line
 * after): a match that runs to the end of the buffer may be a chunk boundary
 * mid-URL, and opening that prefix would send the browser to a broken auth
 * request while the full URL arrives one chunk too late (Codex High).
 */
export function extractGoogleAuthUrl(text) {
  const s = String(text);
  const m = s.match(/https:\/\/accounts\.google\.com\/\S+/);
  if (!m) return null;
  return m.index + m[0].length < s.length ? m[0] : null;
}

// Only one browser approval can meaningfully run at a time; a second click
// while one is pending would stack OAuth flows and confuse whose approval
// landed where.
let reconnectInFlight = false;

/**
 * One-button reconnect: run `gws auth login` (opens the browser; the user
 * picks the account and approves), then capture whatever was approved via the
 * normal connect flow, which refreshes the matching account IN PLACE by
 * email.
 *
 * Two honest limits, both surfaced to the UI rather than papered over:
 * - `gws auth login` has no account hint, so the user can approve a
 *   DIFFERENT account than the row they clicked. That other account gets
 *   refreshed (harmless, correct by email-keying) and the result says so.
 * - Logging in switches the BASE terminal identity to the approved account.
 *   The result reports what it changed from, and the UI's guidance is to
 *   reconnect the daily-driver account LAST, which both revives it and puts
 *   the terminal identity back.
 */
/**
 * Spawn `gws auth login --full`, open the consent URL in the browser (gws
 * never opens it itself without a TTY), broadcast the URL to the UI for the
 * wrong-profile copy-link fallback, and wait for the approval. `uiId` tags
 * the broadcast: an account id for Reconnect, '__add__' for Add.
 * Returns null on success or a user-facing error string.
 *
 * Always requests the FULL scope set (Sam, 8/15: "gws should have full
 * permissions"); --full is also the only mode proven prompt-free under a
 * no-TTY spawn (--services can open the interactive scope picker, which
 * would hang here).
 */
// The two scope modes (Sam, 8/20: "options like full or w/o gcp scope or
// something so the auth never dies"):
// - 'standard' (default): every Workspace productivity scope `--full` grants
//   MINUS the two Google Cloud scopes (cloud-platform, pubsub). On Workspace
//   accounts, grants carrying GCP scopes fall under Google Cloud session
//   control and die with invalid_rapt every ~16h; without them the grant
//   lives until revoked. Proven by the two long-lived grants on this Mac
//   (gmail-only and workspace-only scoped), while every --full reconnect
//   died within a day.
// - 'full': gws's own --full (adds cloud-platform + pubsub). Only worth it
//   for actual GCP work, and on Workspace accounts only with the admin
//   console's session control set to never reauthenticate.
const STANDARD_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/tasks',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/** Login argv for a scope mode. Pure, for tests. */
export function loginArgsFor(scopeMode) {
  if (scopeMode === 'full') return ['auth', 'login', '--full'];
  return ['auth', 'login', '--scopes', STANDARD_SCOPES.join(',')];
}

async function runBrowserLogin(uiId, scopeMode = 'standard') {
  let authUrl = null;
  let openFailed = false;
  // spawn (not execFile) in its OWN process group, resolving on exit: `gws`
  // on PATH is a node wrapper that re-execs the real binary, so a dead
  // wrapper leaves an orphan grandchild holding the inherited pipes, and
  // execFile only fires its callback when those streams close. The flow hung
  // on "Waiting for browser..." forever with the single-flight guard stuck
  // (observed live 8/18; latent in the v1.0.62 reconnect too). The group id
  // also lets timeout/failure paths reap the whole tree, so orphaned
  // localhost listeners stop accumulating.
  const login = await new Promise((resolve) => {
    let child;
    try {
      // Windows has no process groups and a detached child gets its own
      // console window; the tree is ended with taskkill /T instead.
      const cmd = gwsCommand(loginArgsFor(scopeMode));
      child = spawn(cmd.file, cmd.args, { env: cmd.env, detached: !IS_WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, startError: e });
      return;
    }
    let settled = false;
    let winKilled = false;
    let exitedAlready = false;
    const killGroup = (sig) => {
      if (IS_WIN) {
        if (sig !== 'SIGTERM' || winKilled || exitedAlready || !child.pid) return;
        winKilled = true;
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        return;
      }
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // 5 minutes: the human is in a browser consent screen. The timeout path
    // must not release the single-flight guard until the tree is actually
    // dead (or provably unkillable), or a retry could race the old OAuth
    // listener (Codex P2): SIGTERM, escalate to SIGKILL, and settle on the
    // resulting exit, with a hard 3s bound for the unkillable case.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      const k = setTimeout(() => killGroup('SIGKILL'), 2000);
      k.unref?.(); // never keep the app alive just for cleanup (Codex P3)
      const h = setTimeout(() => settle({ killed: true }), 3000);
      h.unref?.();
    }, 5 * 60_000);
    child.on('error', (e) => settle({ code: -1, startError: e }));
    child.on('exit', (code) => {
      exitedAlready = true;
      // Disarm the timeout FIRST: an approval landing in the last instant
      // must never be re-labeled "not completed" by a timer firing during
      // the output grace below (Codex P2).
      clearTimeout(timer);
      // A non-clean end can leave group members behind (the re-exec'd real
      // binary); reap them so no orphan keeps the OAuth listener alive.
      if (timedOut || code !== 0) killGroup('SIGTERM');
      // Tiny grace so trailing output already in flight still lands.
      setTimeout(() => settle(timedOut ? { killed: true } : (code === 0 ? null : { code })), 150);
    });
    let seen = '';
    const watch = (chunk) => {
      if (authUrl) return;
      seen += String(chunk);
      const url = extractGoogleAuthUrl(seen);
      if (url) {
        authUrl = url;
        try { shell.openExternal(url).catch(() => { openFailed = true; }); }
        catch { openFailed = true; }
        // Also hand the URL to the UI: openExternal lands in the default
        // browser's LAST-ACTIVE profile, which can be the wrong Google
        // identity entirely (Sam, 8/15: it opened in someone else's Chrome
        // profile). The panel shows a copyable link a few seconds after the
        // browser opens. The URL is a public consent link, not a secret.
        for (const w of (BrowserWindow.getAllWindows?.() || [])) {
          try { w.webContents.send('gws:reconnect-url', { id: uiId, url }); } catch { /* window mid-close */ }
        }
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
  });
  if (!login) return null;
  if (login.killed) {
    if (!authUrl) return 'gws never produced a Google sign-in URL. Try `gws auth login` in a terminal to see why.';
    // The URL is single-use and its local listener died with the timeout,
    // so never tell the user to paste it now: it can only fail.
    if (openFailed) return 'The sign-in page could not be opened automatically and the approval window expired. Run `gws auth login` in a terminal instead.';
    return 'The browser approval was not completed within 5 minutes. Nothing was changed.';
  }
  return 'gws auth login failed. Try `gws auth login` in a terminal to see why.';
}

export async function reconnectGwsAccount(id, opts = {}) {
  if (!isValidGwsId(id)) return { ok: false, error: 'Unknown account.' };
  const target = getGwsAccounts().find((a) => a.id === id);
  if (!target) return { ok: false, error: 'Unknown account.' };
  if (reconnectInFlight) return { ok: false, error: 'A reconnect is already waiting on a browser approval. Finish or cancel that one first.' };
  reconnectInFlight = true;
  try {
    const baseBefore = await baseAuthUser();
    const loginError = await runBrowserLogin(id, opts.scopeMode === 'full' ? 'full' : 'standard');
    if (loginError) return { ok: false, error: loginError };
    const res = await connectGwsAccount();
    if (!res.ok) return res;
    // Fresh grant: yesterday's verdicts for both the requested row and the
    // approved account are stale.
    verifyCache.delete(id);
    verifyCache.delete(res.account.id);
    const approvedEmail = res.account.email;
    const result = {
      ...res,
      requestedEmail: target.email,
      approvedEmail,
      baseChangedFrom: baseBefore && baseBefore !== approvedEmail ? baseBefore : null,
    };
    if (approvedEmail !== target.email) {
      result.warning = `You approved ${approvedEmail} in the browser, so THAT account was refreshed instead. Hit Reconnect on ${target.email} again and pick it this time.`;
    }
    return result;
  } finally {
    reconnectInFlight = false;
  }
}

/**
 * Add a Google account entirely from Settings (Sam, 8/18: no more terminal
 * `gws auth login` dance). Same browser flow as Reconnect, minus a target
 * row: whatever account is approved gets captured; a NEW email creates a new
 * row and an existing one refreshes in place (connectGwsAccount is
 * email-keyed either way). Note the base-identity switch honestly.
 */
export async function addGwsAccountViaBrowser(opts = {}) {
  if (reconnectInFlight) return { ok: false, error: 'Another browser approval is already pending. Finish or cancel that one first.' };
  reconnectInFlight = true;
  try {
    const baseBefore = await baseAuthUser();
    const loginError = await runBrowserLogin('__add__', opts.scopeMode === 'full' ? 'full' : 'standard');
    if (loginError) return { ok: false, error: loginError };
    const res = await connectGwsAccount();
    if (!res.ok) return res;
    verifyCache.delete(res.account.id); // fresh grant: any cached verdict is stale
    const approvedEmail = res.account.email;
    return {
      ...res,
      approvedEmail,
      baseChangedFrom: baseBefore && baseBefore !== approvedEmail ? baseBefore : null,
    };
  } finally {
    reconnectInFlight = false;
  }
}

/** Remove an account: delete its 0600 profile file + registry entry + cache. */
export async function removeGwsAccount(id) {
  if (!isValidGwsId(id)) return { ok: false, error: 'Invalid account' };
  const p = profilePathFor(id);
  if (p) {
    try {
      await fs.unlink(p);
    } catch (e) {
      // ENOENT (already gone) is fine. Any other failure means the refresh
      // token is STILL on disk, so do NOT drop the registry entry and do NOT
      // report success: keep the account visible so the user can retry rather
      // than orphan a live token invisibly. Codex v1.0.41 r5 P2.
      if (e?.code !== 'ENOENT') {
        console.warn('[gws-accounts] could not delete profile:', e?.code || 'unknown');
        return { ok: false, error: 'Could not delete the stored credentials. Try again.' };
      }
    }
  }
  tokenCache.delete(id);
  await clearShimTokenCache(id); // also drop the shim's on-disk token cache
  deleteGwsAccount(id);
  return { ok: true };
}

/** Resolve an email to a connected account id, or null. */
export function idForEmail(email) {
  if (typeof email !== 'string') return null;
  const hit = getGwsAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
  return hit ? hit.id : null;
}

/**
 * Get a valid access token for a connected account id. Mints + caches as
 * needed. MAIN-PROCESS ONLY: this is deliberately not exposed through preload,
 * so a bearer token never reaches the renderer (Codex plan #1). Returns the
 * token string or null.
 */
export async function getAccessToken(id) {
  if (!isValidGwsId(id)) return null;
  const cached = tokenCache.get(id);
  if (cached && cached.expiresAt - Date.now() > 60 * 1000) return cached.token;
  const prof = await readProfile(id);
  if (!prof) return null;
  // Ownership cross-check, no network needed: connect writes the email into
  // the profile from the SAME minted token that named the registry row, so a
  // profile whose email differs from its registry row is a swapped or
  // corrupted file, and minting from it would hand out some OTHER account's
  // token under this row's identity (Codex P1). Refuse instead.
  const row = getGwsAccounts().find((a) => a.id === id);
  if (row?.email && prof.email && String(row.email).toLowerCase() !== String(prof.email).toLowerCase()) {
    console.warn('[gws-accounts] profile/registry email mismatch for', id, '- refusing to mint');
    return null;
  }
  const res = await refreshGrant(prof.client_id, prof.client_secret, prof.refresh_token);
  if (!res.access_token) {
    console.warn('[gws-accounts] token refresh failed:', res.error || 'unknown');
    return null;
  }
  tokenCache.set(id, { token: res.access_token, expiresAt: Date.now() + (res.expires_in - 60) * 1000 });
  return res.access_token;
}

/** Convenience: token by email. Main-only. */
export async function getAccessTokenForEmail(email) {
  const id = idForEmail(email);
  return id ? getAccessToken(id) : null;
}

// --- Terminal token-broker shim (v1.0.41) ---

/** Find the real gws binary (never the shim). Scans the standard dirs. */
export function resolveRealGws(excludeDir = null) {
  for (const dir of EXEC_PATH.split(':')) {
    if (!dir || dir === excludeDir) continue;
    const cand = path.join(dir, 'gws');
    try { fsSync.accessSync(cand, FS.X_OK); return cand; } catch { /* next */ }
  }
  return null;
}

/**
 * Materialize the gws shim into userData and return { shimDir, realGws }.
 *
 * Writes a wrapper `gws` that runs the bundled gws-shim.mjs under Dobius's own
 * Electron binary in node mode (ELECTRON_RUN_AS_NODE), so the shim needs no
 * node/python on the user's PATH. main.js prepends shimDir to each terminal's
 * PATH and sets DOBIUS_REAL_GWS, so `gws` in a Dobius terminal is the shim
 * (transparent passthrough unless DOBIUS_GWS_ACCOUNT[_ID] is set). Returns null
 * shimDir if the source cannot be staged.
 */
export function ensureShim() {
  const realGws = resolveRealGws();
  let shimDir;
  try {
    shimDir = path.join(app.getPath('userData'), 'gws-shim');
    fsSync.mkdirSync(shimDir, { recursive: true });
    const srcJs = path.join(__dirname, 'gws-shim.mjs');
    const destJs = path.join(shimDir, 'gws-shim.mjs');
    // Copy the bundled shim source out of the asar so a plain node can run it.
    fsSync.copyFileSync(srcJs, destJs);
    const wrapperPath = path.join(shimDir, 'gws');
    // execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes it a node.
    const wrapper = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport DOBIUS_GWS_SHIM_SELF="${wrapperPath}"\nexec "${process.execPath}" "${destJs}" "$@"\n`;
    fsSync.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
    fsSync.chmodSync(wrapperPath, 0o755);
  } catch (e) {
    console.warn('[gws-accounts] could not stage gws shim:', e?.code || e?.message || 'unknown');
    shimDir = null;
  }
  return { shimDir, realGws };
}
