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
import { gwsClientSecretPath, gwsCommand as gwsPath, windowsGwsEntry, npmGwsEntry, gwsExecEnv, gwsState, findIn, isInside, setHintDir, gwsSetupStatus, effectiveQuotaProject } from './gws-setup.js';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { app, shell, BrowserWindow } from 'electron';
import { getGwsAccounts, saveGwsAccount, deleteGwsAccount, isValidGwsId } from './config-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROFILES_DIR = path.join(os.homedir(), '.gws-profiles');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// gws is typically a Homebrew binary; Electron's PATH is minimal, so augment it.
const IS_WIN = process.platform === 'win32';
// Where gws is, and the PATH that runs it (node included), come from gws-setup: a Finder-launched app has no login
// shell PATH and npm installs gws in user folders (Justin, 2026-11-07).
// How to start gws: { file, args, env }. macOS runs the gws gws-setup found, with its PATH. On Windows npm installs gws
// as a .cmd, which Node will not start without a shell (and a shell would re-quote our arguments), so its JS entry runs
// under Dobius's own Electron binary in node mode (windowsGwsEntry, the same lookup as gws-mcp.mjs).
export function gwsCommand(args) {
  if (!IS_WIN) return { file: gwsPath(), args, env: gwsExecEnv() };
  const entry = windowsGwsEntry();
  if (entry) return { file: process.execPath, args: [entry, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  return { file: 'gws.exe', args, env: { ...process.env } }; // a native gws.exe on PATH, if any
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

// Write a profile so a stale or malicious symlink at the target can NEVER redirect the refresh-token write onto
// another file (Codex v1.0.41 r2 P2): a link at the profile's name is refused, the token goes into a fresh O_EXCL |
// O_NOFOLLOW temp file created 0600, and a rename replaces the profile (rename swaps the name, never follows a link).
// Exported for the no-follow test. `mustExist`: update only; never recreate a profile removed meanwhile.
export async function writeProfile(id, creds, { mustExist = false } = {}) {
  ensureProfilesDir();
  const p = profilePathFor(id);
  if (!p) throw new Error('bad_id');
  // Never through a link at the profile's name, and with mustExist never recreate one that is gone.
  try {
    if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('profile_open_refused');
  } catch (e) {
    if (e?.message === 'profile_open_refused') throw e;
    if (e?.code !== 'ENOENT') throw new Error('profile_open_refused', { cause: e });
    if (mustExist) throw new Error('profile_gone', { cause: e });
  }
  // A fresh exclusive temp file (0600, never through a link), then rename over the profile: a reader (the terminal
  // shim, Claude Desktop) sees the old file or the new one, never a truncated one (Codex round 4).
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${randomBytes(6).toString('hex')}.tmp`);
  let fh;
  try {
    fh = await fs.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
  } catch (e) {
    throw new Error('profile_open_refused', { cause: e });
  }
  try {
    await fh.chmod(0o600);
    await fh.writeFile(JSON.stringify(creds));
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, p);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error('profile_write_failed', { cause: e });
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
    const j = JSON.parse(await fs.readFile(gwsClientSecretPath(), 'utf8'));
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

// Every write to one account's profile file in this process goes through its lock, one at a time, so a slow quota
// check can never write an older grant over a reconnect that finished meanwhile (Codex round 3).
const profileLocks = new Map(); // id -> tail promise
function withProfileLock(id, fn) {
  const prev = profileLocks.get(id) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  profileLocks.set(id, tail);
  tail.then(() => { if (profileLocks.get(id) === tail) profileLocks.delete(id); });
  return run;
}

// The quota project (Justin, 2026-11-07, second report). gws reads project_id from client_secret.json and sends it as
// x-goog-user-project on every call. The project belongs to one Google Workspace org: that org's accounts may bill to
// it, a personal @gmail.com account may not, and Google answers that account 403 on every API even though its grant is
// fine. So each account is asked once whether Google lets it use the project; one that is refused is marked
// noQuotaProject in its profile, and the shim and the Claude Desktop server run gws for it with an empty config folder
// (no client file, so no quota project). Accounts that can use it are left exactly as they were.
const QUOTA_DENIED_RE = /serviceusage|USER_PROJECT_DENIED|required permission to use project/i;
const QUOTA_PROBES = [
  'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
  'https://gmail.googleapis.com/gmail/v1/users/me/profile',
];
/** true: Google refuses this account the project; false: it may use it (or there is none); null: could not tell. */
export async function quotaProjectDenied(accessToken, projectId, fetchImpl = fetch) {
  if (!projectId) return false;
  // A refusal from either API decides. Only Drive answering OK clears it: Gmail has been seen to succeed with the
  // same credentials Drive refuses (googleworkspace/cli#729), so a Gmail OK alone says nothing (Codex round 8).
  for (const url of QUOTA_PROBES) {
    try {
      const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, 'x-goog-user-project': projectId } });
      if (r.ok) {
        if (url === QUOTA_PROBES[0]) return false;
        continue;
      }
      const text = await r.text().catch(() => '');
      if (r.status === 403 && QUOTA_DENIED_RE.test(text)) return true;
      // Anything else (not granted, not enabled, a 5xx): ask the next one.
    } catch {
      return null;
    }
  }
  return null;
}

/** The project gws would send for quota on this Mac (env, client file, gcloud defaults, in gws's order), or null. */
function clientProject() {
  return effectiveQuotaProject();
}

/**
 * Update the stored noQuotaProject mark from a fresh probe; unchanged when Google did not say. The probe takes a
 * moment, so the profile is read again just before writing, and only rewritten when it is still there with the same
 * grant: a Remove or a Reconnect that landed meanwhile wins (Codex round 2, all four lenses).
 */
async function syncQuotaMark(id, prof, accessToken, stillNewest = () => true) {
  const project = clientProject();
  const denied = await quotaProjectDenied(accessToken, project);
  // Decided under the lock from a fresh read, so no connect, reconnect, remove or other check for this account can
  // land between the read and the write. Kept as stored when Google did not say, when the project gws sends changed
  // while it answered (the check for the new one decides), or when the grant or the account changed.
  return withProfileLock(id, async () => {
    const now = await readProfile(id);
    if (!now) return false;
    const stored = !!now.noQuotaProject;
    // A newer check started while Google answered this one: that one decides (Codex round 4).
    if (!stillNewest() || clientProject() !== project || now.refresh_token !== prof.refresh_token || !getGwsAccounts().some((a) => a.id === id)) return stored;
    // The mark records the project it was decided for. Google not saying (null) keeps a mark only for that same
    // project; a mark made for another project no longer applies.
    const want = denied === null ? stored && now.noQuotaFor === project : denied;
    if (want === stored && (!want || now.noQuotaFor === project)) return stored;
    const next = { ...now };
    if (want) { next.noQuotaProject = true; next.noQuotaFor = project; } else { delete next.noQuotaProject; delete next.noQuotaFor; }
    try {
      await writeProfile(id, next, { mustExist: true });
    } catch (e) {
      console.warn('[gws-accounts] could not save the quota mark:', e?.message || 'unknown');
      return stored;
    }
    return want;
  });
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
    return { ok: false, error: 'Google approved the sign-in, but gws did not hand back the credentials. Press Add Google Account again.' };
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
    return { ok: false, error: 'Google rejected the sign-in for the OAuth client on this Mac. Check the client file under Setup, then press Add Google Account again.' };
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
  // Google did not say (null): keep what a reconnect already knew about this account.
  const probedProject = clientProject();
  const probed = await quotaProjectDenied(minted.access_token, probedProject);
  let denied = false;
  try {
    await withProfileLock(id, async () => {
      // Google did not say, or the project changed while it answered: keep what is stored for this account.
      const prior = existing ? await readProfile(id) : null;
      denied = probed === null || clientProject() !== probedProject
        ? !!prior?.noQuotaProject && prior?.noQuotaFor === clientProject()
        : probed;
      await writeProfile(id, {
        email,
        client_id: working.client_id,
        client_secret: working.client_secret,
        refresh_token: exp.refresh_token,
        ...(denied ? { noQuotaProject: true, noQuotaFor: clientProject() } : {}),
      });
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
  return { ok: true, account: { id: meta.id, email: meta.email, name: meta.name, scopes: meta.scopes }, quotaSkipped: !!denied };
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
const verifyCache = new Map(); // id -> { at, seq, status, error }
let verifySeq = 0;
let verifyWrites = 0; // bumped on every verifyCache write: a result written after a check began is newer than its copy
const latestVerify = new Map(); // id -> seq of the newest check that probes it
const VERIFY_CACHE_MS = 5 * 60_000;

/**
 * Probe every connected account's stored grant against Google.
 * status: 'ok' (mints), 'revoked' (invalid_grant: only a reconnect fixes it),
 * 'error' (transient/other; the account may still be fine).
 */
export async function verifyGwsAccounts({ force = false } = {}) {
  const out = [];
  // Two checks can overlap (the launch check and Settings opening): the one that STARTED later wins the cache, so an
  // older failure landing after a newer success never shows "check failed" for five minutes (Codex).
  const startedAt = ++verifySeq;
  const writesAtStart = verifyWrites;
  const accounts = getGwsAccounts();
  // Decided once: an answer that expires while earlier accounts are checked is still served, never probed unclaimed
  // (an unclaimed probe skips the quota mark, Codex round 6).
  const probe = new Set();
  for (const a of accounts) if (force || !verifyCache.get(a.id) || Date.now() - verifyCache.get(a.id).at >= VERIFY_CACHE_MS) { probe.add(a.id); latestVerify.set(a.id, startedAt); }
  for (const a of accounts) {
    const hit = verifyCache.get(a.id);
    if (!probe.has(a.id) && hit) {
      out.push({ id: a.id, email: a.email, status: hit.status, error: hit.error, quotaSkipped: !!hit.quotaSkipped });
      continue;
    }
    let status = 'error';
    let error = null;
    let quotaSkipped = false;
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
          // Only the newest check for this account may change its quota mark: an older probe landing late must not
          // undo what a newer one decided (Codex round 3).
          quotaSkipped = latestVerify.get(a.id) === startedAt
            ? await syncQuotaMark(a.id, prof, res.access_token, () => latestVerify.get(a.id) === startedAt)
            : !!prof.noQuotaProject;
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
    const prev = verifyCache.get(a.id);
    if (prev && prev.seq > startedAt) {
      // A check that started later already answered: report that one, never this older result (Codex round 2).
      out.push({ id: a.id, email: a.email, status: prev.status, error: prev.error, quotaSkipped: !!prev.quotaSkipped });
      continue;
    }
    // A newer check has claimed this account but not answered yet: report this result, but leave the cache to the
    // newer one, so it still probes the quota project instead of finding this answer and stopping (Codex round 4).
    if (latestVerify.get(a.id) !== startedAt) {
      out.push({ id: a.id, email: a.email, status, error, quotaSkipped });
      continue;
    }
    verifyCache.set(a.id, { at: Date.now(), seq: startedAt, w: ++verifyWrites, status, error, quotaSkipped });
    out.push({ id: a.id, email: a.email, status, error, quotaSkipped });
  }
  // Any answer written to the cache after this check began is newer than what this check holds: a later check that
  // finished first, or an earlier forced one that finished while this one served that account from the old cache
  // (Codex round 5). Only the newest check for an account writes it, so the cache is never older than our copy.
  return out.map((r) => {
    const c = verifyCache.get(r.id);
    return c && c.w > writesAtStart ? { ...r, status: c.status, error: c.error, quotaSkipped: !!c.quotaSkipped } : r;
  });
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

/**
 * Before opening a browser sign-in: is gws, node and an OAuth client in place? Returns an error string naming what is
 * missing (the Setup section above the list fixes each one), or null.
 */
export async function setupProblem() {
  const st = await gwsSetupStatus();
  if (st.windows && !st.gws) return 'gws is not installed. Install Node.js, run npm i -g @googleworkspace/cli in a terminal, then press Check again in Setup above.';
  if (st.installing) return 'gws is still installing. Wait for Setup above to finish, then try again.';
  if (st.halfInstalled) return 'gws did not finish installing. Use Install gws in Setup above, then try again.';
  if (!st.gws) return 'gws is not installed on this Mac yet. Use Install gws in Setup above, then press Add again.';
  if (st.needsNode && (!st.node || st.nodeTooOld)) return 'gws needs Node.js, which this Mac does not have. Install it from nodejs.org, then press Check again.';
  if (!st.client) return 'This Mac has no Google OAuth client file yet. Add one in Setup above (Use this one, or Choose client_secret.json).';
  return null;
}

async function runBrowserLogin(uiId, scopeMode = 'standard') {
  let authUrl = null;
  let seen = ''; // what gws printed before the sign-in link (its reason when it fails early)
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
    const watch = (chunk) => {
      // Kept after the link too: a failure to SAVE the login comes after it, and that is what gets shown and logged.
      seen = (seen + String(chunk)).slice(-20000);
      if (authUrl) return;
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
    if (!authUrl) return 'gws never produced a Google sign-in link. Press Check in Setup above to confirm gws runs, then try again.';
    // The URL is single-use and its local listener died with the timeout,
    // so never tell the user to paste it now: it can only fail.
    if (openFailed) return 'The sign-in page could not be opened automatically and the approval window expired. Press Add again and use the sign-in link shown here.';
    return 'The browser approval was not completed within 5 minutes. Nothing was changed.';
  }
  // Say what gws said (Max, 2026-11-07: "No OAuth client configured" was thrown away), and keep it in error.log.
  // Only the last lines, one line each, no escape codes; gws prints no secrets before the sign-in link.
  const said = seen.replace(/https?:\/\/\S+/g, '<link>').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 400);
  console.warn('[gws-accounts] gws auth login failed:', login.startError?.code || `exit ${login.code}`, said || '(no output)');
  if (login.startError) return 'gws could not be started. Press Check again in Setup above to find it, then try again.';
  return `gws could not finish the Google sign-in${said ? `. gws said: ${said}` : ''}. Press Check again in Setup above, then try again.`;
}

export async function reconnectGwsAccount(id, opts = {}) {
  if (!isValidGwsId(id)) return { ok: false, error: 'Unknown account.' };
  const target = getGwsAccounts().find((a) => a.id === id);
  if (!target) return { ok: false, error: 'Unknown account.' };
  if (reconnectInFlight) return { ok: false, error: 'A reconnect is already waiting on a browser approval. Finish or cancel that one first.' };
  reconnectInFlight = true;
  try {
    const missing = await setupProblem();
    if (missing) return { ok: false, error: missing, setup: true };
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
    const missing = await setupProblem();
    if (missing) return { ok: false, error: missing, setup: true };
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
      await withProfileLock(id, () => fs.unlink(p));
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
const isExecutable = (p) => { try { fsSync.accessSync(p, FS.X_OK); return fsSync.statSync(p).isFile(); } catch { return false; } };
/**
 * Windows: the real gws for the shim to run (Max, 2026-11-07, patch 0010). npm installs gws as a .cmd/.ps1 pair around
 * a JS entry, which the shim runs under Dobius's own Electron in node mode (the same lookup as gwsCommand); a native
 * gws.exe on Path also works. Never a file inside excludeDir (the shim's own folder).
 */
export function resolveRealGwsWindows(excludeDir = null, env = process.env) {
  const entry = windowsGwsEntry(env);
  if (entry && !isInside(entry, excludeDir)) return entry;
  const skip = excludeDir ? path.win32.resolve(excludeDir).toLowerCase() : null;
  for (const dir of String(env.Path || env.PATH || '').split(';')) {
    if (!dir || !path.win32.isAbsolute(dir) || (skip && path.win32.resolve(dir).toLowerCase() === skip)) continue;
    // npm with its own prefix (not %APPDATA%\npm): the JS entry beside that prefix's gws.cmd (Codex).
    const npmEntry = npmGwsEntry(dir);
    if (npmEntry && !isInside(npmEntry, excludeDir)) return npmEntry;
    const cand = path.win32.join(dir, 'gws.exe');
    try { if (fsSync.statSync(cand).isFile()) return cand; } catch { /* next */ }
  }
  return null;
}

/**
 * Windows: the gws.cmd that runs the shim under Electron in node mode. %* hands the arguments through exactly as
 * npm's own gws.cmd does (same quoting limits). Null when a path holds a character cmd would read as syntax (% expands,
 * " ends the quote, a line break ends the command) or one outside ASCII: no wrapper beats a wrapper that runs
 * something else, and without one the tab's plain gws still works.
 */
// gws.cmd for a Dobius folder cmd.exe cannot name: it refuses loudly instead of being left out, because without it
// cmd.exe would find npm's gws.cmd next and run as the default Google account whatever DOBIUS_GWS_ACCOUNT says
// (Codex round 7). No path inside, so nothing in it needs quoting.
export const WINDOWS_REFUSING_CMD = '@echo off\r\n1>&2 echo gws: Dobius cannot run gws from cmd.exe here, its folder name has characters cmd.exe cannot carry. Use a PowerShell or Git Bash tab.\r\nexit /b 1\r\n';

export function windowsShimWrapper(execPath, shimJs, selfPath) {
  // Also nothing outside ASCII: cmd reads a .cmd file in the console's OEM codepage, so a C:\Users\José path written
  // as UTF-8 would name a folder that does not exist, and this wrapper (first on Path) would break plain gws too.
  // ! too: with delayed expansion on it expands, and DisableDelayedExpansion below turns it off for this file anyway.
  if ([execPath, shimJs, selfPath].some((p) => typeof p !== 'string' || !p || /[%!"\r\n]|[^\x20-\x7e]/.test(p))) return null;
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set ELECTRON_RUN_AS_NODE=1',
    `set "DOBIUS_GWS_SHIM_SELF=${selfPath}"`,
    `"${execPath}" "${shimJs}" %*`,
    '',
  ].join('\r\n');
}

/**
 * Windows: an extensionless `gws` sh script for Git Bash, which is also the shell Claude Code's Bash tool uses there.
 * Bash never runs gws.cmd for `gws`, so without this it finds npm's own `gws` further down PATH and ignores
 * DOBIUS_GWS_ACCOUNT (Codex). Forward slashes; null when a path holds a character sh would read inside "...".
 */
export function windowsShShimWrapper(execPath, shimJs, selfPath) {
  // Single-quoted, so $ ` " and \ are all literal; a ' is closed, escaped and reopened. Only control characters (a
  // line break would end the command) are refused (Codex round 2: a $ in the install path dropped this wrapper).
  const ok = (p) => typeof p === 'string' && p && !/[\x00-\x1f\x7f]/.test(p);
  if (![execPath, shimJs, selfPath].every(ok)) return null;
  const q = (p) => `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport DOBIUS_GWS_SHIM_SELF=${q(selfPath)}\nexec ${q(execPath)} ${q(shimJs)} "$@"\n`;
}

export function resolveRealGws(excludeDir = null) {
  if (IS_WIN) return resolveRealGwsWindows(excludeDir);
  // Looked up again on every call (each terminal spawn), so a gws installed after launch is found without a restart.
  // The gws in use (a Locate pick may be run.js, which a search by name would miss), unless it is gone or the shim.
  const st = gwsState();
  if (st.gws && isExecutable(st.gws) && !isInside(st.gws, excludeDir)) return st.gws;
  return findIn(st.dirs, 'gws', excludeDir);
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
  let shimDir;
  try {
    shimDir = path.join(app.getPath('userData'), 'gws-shim');
    fsSync.mkdirSync(shimDir, { recursive: true });
    const srcJs = path.join(__dirname, 'gws-shim.mjs');
    const destJs = path.join(shimDir, 'gws-shim.mjs');
    // Copy the bundled shim source out of the asar so a plain node can run it.
    fsSync.copyFileSync(srcJs, destJs);
    if (IS_WIN) {
      // Three ways in, all first on the tab's Path: gws.cmd for cmd.exe, an extensionless sh `gws` for Git Bash (and
      // Claude's Bash tool), and in PowerShell a `gws` function the tab defines at start (shared/new-tab.js), which
      // passes JSON quotes intact where PowerShell would mangle them on the way into a .cmd.
      const cmdPath = path.join(shimDir, 'gws.cmd');
      const shPath = path.join(shimDir, 'gws');
      const cmd = windowsShimWrapper(process.execPath, destJs, cmdPath);
      const sh = windowsShShimWrapper(process.execPath, destJs, shPath);
      for (const [file, text] of [[cmdPath, cmd || WINDOWS_REFUSING_CMD], [shPath, sh]]) {
        if (text) fsSync.writeFileSync(file, text);
        else try { fsSync.unlinkSync(file); } catch { /* none */ } // never leave an older one pointing elsewhere
      }
      if (!cmd && !sh) throw Object.assign(new Error('unsafe path for the gws wrappers'), { code: 'EUNSAFEPATH' });
    } else {
      const wrapperPath = path.join(shimDir, 'gws');
      // execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes it a node.
      const wrapper = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport DOBIUS_GWS_SHIM_SELF="${wrapperPath}"\nexec "${process.execPath}" "${destJs}" "$@"\n`;
      fsSync.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
      fsSync.chmodSync(wrapperPath, 0o755);
    }
  } catch (e) {
    console.warn('[gws-accounts] could not stage gws shim:', e?.code || e?.message || 'unknown');
    shimDir = null;
  }
  if (shimDir) setHintDir(shimDir);
  return { shimDir, realGws: resolveRealGws(shimDir) };
}
