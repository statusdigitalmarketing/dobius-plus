// Dobius gws token-broker shim (v1.0.41).
//
// Placed first on a Dobius terminal's PATH as `gws`. It runs the REAL gws as a
// chosen Google account by minting a fresh GOOGLE_WORKSPACE_CLI_TOKEN from that
// account's stored refresh token, so a long-lived shell never carries a stale
// token (env injected at spawn goes dead in ~1h; this mints per invocation with
// a short-lived cache). Standalone: no Dobius/Electron imports, runs under
// `ELECTRON_RUN_AS_NODE=1 <electron> gws-shim.mjs`, so no node/python needed on
// the user's PATH.
//
// Selection (either):
//   DOBIUS_GWS_ACCOUNT=<email>   e.g. `DOBIUS_GWS_ACCOUNT=x@y.com gws gmail ...`
//   DOBIUS_GWS_ACCOUNT_ID=<id>   (set by a bound tab)
// When NEITHER is set it is a transparent passthrough to the real gws, so
// ordinary `gws` in a Dobius terminal behaves exactly as before.
//
// If an account IS requested but cannot be resolved or minted, it FAILS rather
// than silently running as the default account (running as the wrong Google
// account is worse than an error).

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';

const PROFILES_DIR = path.join(os.homedir(), '.gws-profiles');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function fail(msg, code = 1) {
  process.stderr.write(`dobius-gws: ${msg}\n`);
  process.exit(code);
}

// What Dobius found when it looked for gws (gws-setup.js writes gws-env.json beside this shim): { gws, path }. Lets a
// gws installed after this terminal opened, or one only the login shell knows about, work here. Null when absent.
function readHint(selfDir) {
  if (!selfDir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(selfDir, 'gws-env.json'), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

const isExec = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
// Any Dobius shim (another Dobius copy's too) names DOBIUS_GWS_SHIM_SELF in its wrapper; running one as "gws" loops.
function isDobiusShim(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(512);
      return buf.subarray(0, fs.readSync(fd, buf, 0, 512, 0)).toString('latin1').includes('DOBIUS_GWS_SHIM_SELF');
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

// Locate the real gws, never this shim, not even through a link to it (that would run the shim again, forever):
// what Dobius found most recently (gws-env.json), then DOBIUS_REAL_GWS (set at spawn), then PATH.
function findRealGws(selfDir, hint) {
  const realSelf = selfDir ? real(selfDir) : null;
  const notSelf = (p) => {
    if (typeof p !== 'string' || !p.startsWith('/') || !isExec(p)) return false;
    const rp = real(p);
    return !!rp && !(realSelf && (rp === realSelf || rp.startsWith(realSelf + path.sep))) && !isDobiusShim(rp);
  };
  // What Dobius found most recently beats what it found when this terminal opened: a Locate or an install since then
  // must reach open tabs too (Codex round 2).
  if (notSelf(hint?.gws)) return hint.gws;
  if (notSelf(process.env.DOBIUS_REAL_GWS)) return process.env.DOBIUS_REAL_GWS;
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir || dir === selfDir) continue;
    const cand = path.join(dir, 'gws');
    if (notSelf(cand)) return cand;
  }
  return null;
}

// gws from npm is a node script (#!/usr/bin/env node), so for the gws process only, the folders Dobius found (and
// checked: the gws there runs with the node there) go FIRST; an older node earlier on the tab's PATH could not run it.
// Only absolute entries: an empty one would mean the current folder, so a project's own `node` would run.
function withHintPath(env, hint) {
  if (typeof hint?.path !== 'string' || !hint.path) return env;
  const parts = `${hint.path}:${env.PATH || ''}`.split(':').filter((d) => d.startsWith('/'));
  return { ...env, PATH: [...new Set(parts)].join(':') };
}

// The env that makes gws send NO quota project (Justin, 2026-11-07). gws 0.22.5 picks it from a non-empty
// GOOGLE_WORKSPACE_PROJECT_ID, then the client file's project_id, then gcloud's default credentials; each is cleared:
// the variable set empty, a config folder with no client file (~/.gws-profiles/.noquota), and a credentials path with
// nothing at it. Verified against live gws. Null when .noquota is not a plain folder (fail rather than send it).
function noQuotaEnv(env) {
  const dir = path.join(PROFILES_DIR, '.noquota');
  const adc = path.join(dir, 'no-adc.json');
  // Nothing is written: gws treats a credentials path that does not exist as "no project", and creates the config
  // folder itself for its cache (both verified live). Anything at those two names is removed (unlinking never follows a
  // link), so neither can ever carry a project.
  // Only inside a plain folder that is really ours: through a link, the cleanup would delete the real client file.
  let st = null;
  try { st = fs.lstatSync(dir); } catch { /* gws creates it */ }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) return null;
  for (const f of [path.join(dir, 'client_secret.json'), adc]) {
    // Gone is the goal; anything that stays (locked, no permission) could carry a project, so refuse.
    try { fs.unlinkSync(f); } catch (e) { if (e?.code !== 'ENOENT') return null; }
  }
  return { ...env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: dir, GOOGLE_APPLICATION_CREDENTIALS: adc, GOOGLE_WORKSPACE_PROJECT_ID: '' };
}

function runReal(realGws, env) {
  const r = spawnSync(realGws, process.argv.slice(2), { stdio: 'inherit', env: withHintPath(env, HINT) });
  if (r.error) fail(`could not run gws (${r.error.code || 'unknown'})`, 127);
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

// Find the requested account's profile by id or email. Returns
// { id, creds } | { error } | null (null = no account requested -> passthrough).
function resolveProfile() {
  const wantId = process.env.DOBIUS_GWS_ACCOUNT_ID || '';
  const wantEmail = (process.env.DOBIUS_GWS_ACCOUNT || '').toLowerCase();
  if (!wantId && !wantEmail) return null;
  let files;
  try {
    files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return { error: 'no connected Google accounts' };
  }
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8')); } catch { continue; }
    const id = f.slice(0, -'.json'.length);
    // ID is AUTHORITATIVE: when a bound tab sets DOBIUS_GWS_ACCOUNT_ID, match
    // ONLY by id and never fall back to email. Otherwise a stray
    // DOBIUS_GWS_ACCOUNT in the user's shell could win by readdir order and run
    // gws as the wrong Google account. Codex v1.0.41 holistic P2.
    if (wantId) {
      if (id !== wantId) continue;
      // When the binder ALSO names the email, the profile must corroborate
      // it: id selects, email verifies. A swapped profile file would
      // otherwise run gws as whoever's token is inside (Codex P1). Any
      // future bound-tab feature must inject BOTH env vars for this reason.
      if (wantEmail && (typeof j.email !== 'string' || j.email.toLowerCase() !== wantEmail)) {
        return { error: `account identity mismatch: profile ${id} is not ${process.env.DOBIUS_GWS_ACCOUNT}` };
      }
      return { id, creds: j };
    }
    if (wantEmail && typeof j.email === 'string' && j.email.toLowerCase() === wantEmail) return { id, creds: j };
  }
  return { error: `no connected gws account for ${process.env.DOBIUS_GWS_ACCOUNT_ID || process.env.DOBIUS_GWS_ACCOUNT}` };
}

const cacheFile = (id) => path.join(PROFILES_DIR, `.token-${id}.json`);

function readCachedToken(id) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(id), 'utf8'));
    if (c && typeof c.token === 'string' && c.expiresAt - Date.now() > 60 * 1000) return c.token;
  } catch { /* miss */ }
  return null;
}

function writeCachedToken(id, token, expiresIn) {
  try {
    fs.writeFileSync(
      cacheFile(id),
      JSON.stringify({ token, expiresAt: Date.now() + (expiresIn - 60) * 1000 }),
      { mode: 0o600 },
    );
  } catch { /* cache is best-effort */ }
}

async function mint(creds) {
  try {
    const body = new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) return { token: j.access_token, expiresIn: Number(j.expires_in) || 3600 };
    return { error: typeof j.error === 'string' ? j.error : `http_${r.status}` };
  } catch (e) {
    return { error: e?.code || 'network_error' };
  }
}

const SELF_DIR = process.env.DOBIUS_GWS_SHIM_SELF ? path.dirname(process.env.DOBIUS_GWS_SHIM_SELF) : null;
const HINT = readHint(SELF_DIR);
const realGws = findRealGws(SELF_DIR, HINT);
const target = resolveProfile();

if (!target) {
  // No account requested: transparent passthrough.
  if (!realGws) fail('gws is not installed (or Dobius cannot find it). Open Dobius Settings > Google Accounts > Setup to install or locate it.', 127);
  runReal(realGws, process.env);
} else if (target.error) {
  fail(target.error);
} else if (!realGws) {
  fail('gws is not installed (or Dobius cannot find it). Open Dobius Settings > Google Accounts > Setup to install or locate it.', 127);
} else if (!target.creds || typeof target.creds.refresh_token !== 'string') {
  fail(`stored credentials for that account are unreadable`);
} else {
  let token = readCachedToken(target.id);
  if (!token) {
    const m = await mint(target.creds);
    // invalid_grant means GOOGLE revoked the stored refresh token; nothing on
    // this machine can fix it and retrying forever is the ve-CLI login loop
    // all over again. Say what actually happened and the one action that
    // works. Live audit 2026-08-10: 4 of Sam's 5 connected accounts were in
    // exactly this state and the bare "(invalid_grant)" gave no way out.
    if (m.error === 'invalid_grant') {
      fail(`Google has revoked the stored grant for ${target.creds.email || 'this account'}.`
        + ' Re-logging in or retrying cannot fix it. Reconnect the account in'
        + ' Dobius Settings > Google Accounts (takes one browser approval).');
    }
    if (m.error) fail(`could not get an access token (${m.error})`);
    token = m.token;
    writeCachedToken(target.id, m.token, m.expiresIn);
  }
  const env = { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: token };
  // An account Google refuses the OAuth client's Cloud project (a personal Gmail next to Workspace accounts) runs
  // without one, or every call is a 403 (Justin, 2026-11-07).
  if (target.creds.noQuotaProject === true) {
    const nq = noQuotaEnv(env);
    if (!nq) fail(`${path.join(PROFILES_DIR, '.noquota')} could not be cleared (not a plain folder, or a file in it cannot be removed), so gws cannot run without the Cloud project for this account. Remove that folder and try again.`);
    runReal(realGws, nq);
  }
  runReal(realGws, env);
}
