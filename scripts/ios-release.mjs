#!/usr/bin/env node
// Ship the phone app to the App Store: build from a clean checkout of one commit, check the signed app, upload, wait
// for processing, submit for review, released by Apple on approval. Docs: docs/ios-release.md. Decisions live in
// scripts/lib/ios-release-plan.mjs (tested).
//
//   node scripts/ios-release.mjs status
//   node scripts/ios-release.mjs release [--if-changed] [--dry-run] [--no-upload] [--no-submit] [--notes "..."]
//                                        [--expect-sha <sha>] [--skip-tests] [--allow-branch]
//   node scripts/ios-release.mjs submit [--dry-run] [--notes "..."]

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ascConfig, createAscClient } from './lib/asc-client.mjs';
import {
  planVersion, liveVersion, nextBuildNumber, compareBuildStrings, lastBuildTag, buildTagNumbers, parseBuildTag, buildTagName, buildOfTag, parseTagMessage, tagMessage, ownUpload, aboveShipped,
  whatsNewText, reviewDetailCopy, reviewDetailProblems, depsChanged, manifestChanged, APP_PATHS,
} from './lib/ios-release-plan.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const BUNDLE_ID = 'com.statusdigital.dobiusplus';
const TEAM_ID = 'Z349CC556Z';
const PROCESSING_TIMEOUT_MS = 45 * 60_000;
const POLL_MS = 30_000;
const MIN = 60_000;
const REFUSED = new Set(['INVALID', 'FAILED']); // Apple's processing states for a build it will never ship

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');
const NO_UPLOAD = flag('--no-upload');
const say = (...a) => console.log('[ios-release]', ...a);
const die = (msg, code = 1) => { console.error(`[ios-release] ${msg}`); process.exit(code); };

// Git gets a deadline too, and never asks for a password: a stalled fetch or push must not hold the lock forever.
const GIT_OPTS = { cwd: ROOT, timeout: 5 * MIN, killSignal: 'SIGKILL', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
const git = (...args) => execFileSync('git', args, { ...GIT_OPTS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const gitOk = (...args) => spawnSync('git', args, GIT_OPTS).status === 0;
const gitIn = (cwd, ...args) => execFileSync('git', args, { ...GIT_OPTS, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
// Every step has a deadline: a signing prompt nobody answers must not hold the lock (and release.sh) forever. Steps run
// without blocking, so the lock watch below keeps running and stops a step whose lock is gone. `capture` also returns
// the output (still shown as it comes) for the steps whose exit status alone does not prove success.
// Each step runs in its own process group, so a timeout or a lost lock stops the step AND everything it started (a
// helper holding the output open would otherwise keep the step, and so the lock, alive past its deadline).
let current = null;
const killGroup = (child) => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') console.error(`[ios-release] could not stop step ${child.pid}: ${err.message}`); }
};
process.on('exit', () => killGroup(current));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { killGroup(current); process.exit(130); });
// The build steps get only these from the environment: anything else could change the app without changing the commit
// (XCODE_XCCONFIG_FILE swaps in another Info.plist, npm_config_* another registry; Codex).
const BUILD_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'DEVELOPER_DIR'];
// npm also reads ~/.npmrc and its global npmrc, where a node-options line would load code into Vite without touching
// the environment: build steps get an empty file for both (Codex iOS round 7).
let emptyNpmrc = null; // npm refuses one file as both, so two
const noNpmrc = () => {
  if (!emptyNpmrc) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-ios-npmrc-'));
    emptyNpmrc = { user: path.join(dir, 'user'), global: path.join(dir, 'global') };
    fs.writeFileSync(emptyNpmrc.user, '');
    fs.writeFileSync(emptyNpmrc.global, '');
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  }
  return emptyNpmrc;
};
const buildEnv = (extra = {}) => ({
  ...Object.fromEntries(BUILD_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
  npm_config_userconfig: noNpmrc().user, npm_config_globalconfig: noNpmrc().global, ...extra,
});
function run(file, args, label, { cwd = ROOT, env, clean = false, minutes = 20, capture = false } = {}) {
  stillLocked();
  say(`${label}...`);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, env: clean ? buildEnv(env) : (env ? { ...process.env, ...env } : process.env), detached: true,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
    current = child;
    let out = '';
    let settled = false;
    const settle = (fn) => { if (settled) return; settled = true; clearTimeout(timer); if (current === child) current = null; fn(); };
    // Captured output is kept, not echoed as it comes: a write to a stalled terminal blocks this process, and with it
    // every deadline and the lock watch (Codex). Its tail is printed once the step ends.
    if (capture) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (d) => { if (out.length < 8 * 1024 * 1024) out += d; });
      }
    }
    // Settled here, not on 'close': a descendant still holding the output open would delay 'close' forever.
    const timer = setTimeout(() => { killGroup(child); settle(() => reject(new Error(`${label} took over ${minutes} minutes and was stopped`))); }, minutes * MIN);
    child.on('error', (err) => settle(() => reject(new Error(`${label} could not start: ${err.message}`))));
    child.on('close', (code, signal) => settle(() => {
      // Kept in a file, with one short line here: a long write to a stalled terminal would block this process (Codex).
      if (capture && out) {
        const log = path.join(os.tmpdir(), `dobius-ios-release-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.log`);
        try { fs.writeFileSync(log, out); say(`${label}: output in ${log}`); } catch (err) { say(`${label}: could not keep its output (${err.message})`); }
      }
      if (code !== 0) reject(new Error(`${label} failed (exit ${code ?? signal})`));
      else { stillLocked(); resolve(out); }
    }));
    // The step is done once its own process exits; a descendant it left behind is stopped, not waited for.
    child.on('exit', () => setTimeout(() => killGroup(child), 2000).unref());
  });
}
// SIGKILL on timeout: the default SIGTERM stays pending on a stopped process and execFileSync would wait forever.
const read = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 2 * MIN, killSignal: 'SIGKILL' });
const plistJson = (file) => JSON.parse(read('plutil', ['-convert', 'json', '-o', '-', file]));
// Branches, plus only this script's own tags: the release tags here can differ from origin's (electron-builder makes
// them), and a plain --tags fetch refuses to clobber them and fails the whole fetch.
// --prune drops a local ios-* tag origin does not have: a binding whose push failed must not count on a later run.
const fetchOrigin = () => gitOk('fetch', '-q', 'origin') && gitOk('fetch', '-q', '--prune', 'origin', '+refs/tags/ios-*:refs/tags/ios-*');

// ---- one run at a time: the kernel's lock on a file, released when the process ends however it ends ----
const LOCK = path.join(os.tmpdir(), 'dobius-ios-release.lock');
if (cmd !== 'status' && !DRY && process.env.DOBIUS_IOS_RELEASE_LOCKED !== '1') {
  const r = spawnSync('/usr/bin/lockf', ['-s', '-t', '0', LOCK, process.execPath, SELF, ...argv], {
    stdio: 'inherit', env: { ...process.env, DOBIUS_IOS_RELEASE_LOCKED: '1' },
  });
  if (r.status === 75) die('another iOS release is running');
  process.exit(r.status ?? 1);
}
// lockf holds the lock, not this process: if lockf is killed the lock is gone and another run may start, so this one
// stops too. Checked before every step and every App Store Connect write, and every few seconds while it waits.
const LOCK_HOLDER = process.env.DOBIUS_IOS_RELEASE_LOCKED === '1' ? process.ppid : null;
function stillLocked() {
  if (LOCK_HOLDER === null || process.ppid === LOCK_HOLDER) return;
  killGroup(current);
  die('the release lock was released (its lockf process ended); stopping');
}
if (LOCK_HOLDER !== null) setInterval(stillLocked, 5000).unref();

// ---- checks before building ----
function preflight() {
  const cfg = ascConfig();
  if (!fs.existsSync(cfg.keyPath)) die(`App Store Connect key not found at ${cfg.keyPath}`);
  // altool finds the key by its file name in a folder, so the file must carry Apple's name.
  if (path.basename(cfg.keyPath) !== `AuthKey_${cfg.keyId}.p8`) die(`the key file must be named AuthKey_${cfg.keyId}.p8`);
  if (git('status', '--porcelain')) die('the working tree has changes: commit or drop them first');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main' && !flag('--allow-branch')) die(`on branch ${branch}: App Store builds come from main (or pass --allow-branch)`);
  const sha = git('rev-parse', 'HEAD');
  const expect = opt('--expect-sha');
  if (expect && sha !== expect) die(`HEAD is ${sha}, not the expected ${expect}`);
  if (!fetchOrigin()) die('could not fetch origin');
  if (!gitOk('merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`)) die(`HEAD is not on origin/${branch}: push it first`);
  return { ...cfg, sha };
}

/** The checkout is still exactly the commit preflight pinned: the tests run here, and must be of the commit built. */
function assertAt(sha) {
  const head = git('rev-parse', 'HEAD');
  if (head !== sha) throw new Error(`the checkout moved from ${sha.slice(0, 8)} to ${head.slice(0, 8)} during the run`);
  if (git('status', '--porcelain')) throw new Error('the working tree changed during the run');
}

// ---- git tags: which commit each upload was ----
// Each upload's tag records when the upload began and ended, and, once the run sees Apple list the build, that build's
// App Store Connect id. See buildOfTag: a bound tag vouches for that build only; an unbound one for the first build of
// its pair Apple dates inside the window; a tag without both times for nothing.

/** This script's tags whose commit is an ancestor of `ref`, parsed, with the upload window and build id. */
function buildTagsOn(ref) {
  const out = git('for-each-ref', '--format=%(refname:short)%09%(contents:subject)', 'refs/tags/ios-*');
  return out.split('\n').filter(Boolean).map((line) => {
    const [name, subject = ''] = line.split('\t');
    const t = parseBuildTag(name);
    return t && { ...t, ...parseTagMessage(subject) };
  }).filter(Boolean).filter((t) => gitOk('merge-base', '--is-ancestor', `${t.tag}^{commit}`, ref));
}


// ---- App Store Connect reads ----
async function readState(asc) {
  const apps = await asc.get(`/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=name,bundleId`);
  const app = apps.data.find((a) => a.attributes?.bundleId === BUNDLE_ID);
  if (!app) throw new Error(`no App Store Connect app with bundle id ${BUNDLE_ID}`);
  const versions = await asc.all(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=200&fields[appStoreVersions]=platform,versionString,appVersionState,appStoreState,releaseType,createdDate`);
  const { data, included } = await asc.pages(`/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=200&fields[builds]=version,processingState,uploadedDate,expired,preReleaseVersion&include=preReleaseVersion&fields[preReleaseVersions]=version`);
  const pre = new Map(included.filter((x) => x.type === 'preReleaseVersions').map((x) => [x.id, x.attributes.version]));
  const builds = data.map((b) => {
    const raw = String(b.attributes.version ?? '');
    return {
      id: b.id,
      raw,
      // A build string like "7.1" is not one of ours (we upload whole numbers only) and never compares as 7.
      number: /^\d+$/.test(raw) ? Number(raw) : Number.NaN,
      marketing: pre.get(b.relationships?.preReleaseVersion?.data?.id) || null,
      state: b.attributes.processingState,
      expired: b.attributes.expired === true,
      uploaded: b.attributes.uploadedDate,
    };
  });
  return { app, versions, builds };
}

async function buildOfVersion(asc, versionId) {
  const r = await asc.get(`/v1/appStoreVersions/${versionId}/build?fields[builds]=version`);
  return r.data ? { id: r.data.id, raw: String(r.data.attributes.version) } : null;
}

// A version with no review details answers 404 or an empty data: both mean "none".
async function reviewDetailOf(asc, versionId) {
  try {
    return (await asc.get(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`)).data || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}


// ---- status ----
async function status(asc) {
  const { app, versions, builds } = await readState(asc);
  say(`${app.attributes.name} (${app.id})`);
  for (const v of versions) say(`  version ${v.attributes.versionString}: ${v.attributes.appVersionState || v.attributes.appStoreState}, release ${v.attributes.releaseType}`);
  for (const b of builds.slice(0, 6)) say(`  build ${b.raw} (${b.marketing || '?'}): ${b.state}${b.expired ? ', expired' : ''}, uploaded ${b.uploaded}`);
  const subs = await asc.get(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&limit=5`);
  for (const s of subs.data) say(`  review submission ${s.id}: ${s.attributes.state}${s.attributes.submittedDate ? `, submitted ${s.attributes.submittedDate}` : ''}`);
  say(`  last uploaded commit tag: ${lastBuildTag(buildTagsOn('HEAD').map((t) => t.tag)) || 'none'}`);
}

// ---- did anything in the app change since the last upload Apple did not refuse? ----
function appChangedSince(tag, sha) {
  if (!tag) return { changed: true, why: 'no earlier iOS build of this branch that Apple accepted' };
  const files = git('diff', '--name-only', tag, sha, '--', ...APP_PATHS).split('\n').filter(Boolean);
  if (files.length) return { changed: true, why: `${files.length} app file(s) changed since ${tag}` };
  const at = (file) => { try { return git('show', `${tag}:${file}`); } catch { return ''; } };
  const now = (file) => git('show', `${sha}:${file}`);
  if (depsChanged(at('package-lock.json'), now('package-lock.json'))) return { changed: true, why: `dependencies changed since ${tag}` };
  if (manifestChanged(at('package.json'), now('package.json'))) return { changed: true, why: `package.json changed since ${tag}` };
  return { changed: false, why: `nothing in the app changed since ${tag}` };
}

// ---- build, check, upload ----
function projectBuildNumber(sha) {
  const pbx = git('show', `${sha}:ios/App/App.xcodeproj/project.pbxproj`);
  // Every value, dotted ones too ("100.1"): nextBuildNumber reads each by its first part.
  return [...pbx.matchAll(/CURRENT_PROJECT_VERSION = "?([\d.]+)"?;/g)].map((m) => m[1]);
}

/**
 * A checkout of exactly `sha` in its own folder, with the dependencies the lockfile names (`npm ci`): nothing edited in
 * the main checkout, and nothing left over in its node_modules, can reach the build.
 */
async function cleanSource(sha, work) {
  const src = path.join(work, 'src');
  // No hooks: a post-checkout hook could move the new checkout to another commit. And the checkout must then be exactly
  // that commit, clean, before anything is built from it (Codex iOS round 7).
  await run('git', ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', src, sha], `Checking out ${sha.slice(0, 8)} on its own`, { minutes: 5 });
  const at = () => gitIn(src, 'rev-parse', 'HEAD');
  if (at() !== sha) throw new Error(`the checkout is at ${at()}, not ${sha}`);
  if (gitIn(src, 'status', '--porcelain')) throw new Error('the fresh checkout is not clean');
  // Only what the phone build needs: no install scripts (Electron's download, native rebuilds).
  // Dev dependencies too (Vite builds the phone bundle), whatever NODE_ENV says (Codex).
  await run('npm', ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], 'Installing the locked dependencies', { cwd: src, clean: true, minutes: 20 });
  await run('npm', ['run', 'build:mobile'], 'Building the phone bundle', { cwd: src, clean: true, minutes: 10 });
  await run('npx', ['cap', 'sync', 'ios'], 'Copying it into the iOS app (cap sync)', { cwd: src, clean: true, minutes: 10 });
  // cap sync must not change tracked files: if it did, the build would not be exactly that commit.
  const dirty = gitIn(src, 'status', '--porcelain');
  if (dirty) throw new Error(`cap sync changed tracked files:\n${dirty}`);
  if (at() !== sha) throw new Error(`the checkout moved to ${at()} during the build`);
  return src;
}

/**
 * The signed app inside the IPA is what App Review gets: its version, bundle id, team and push entitlement are
 * checked here, before anything leaves the Mac. A development-signed build ("aps-environment development",
 * get-task-allow) would pass Apple's upload and then fail every push.
 */
async function verifyIpa(ipa, marketing, buildNo, work) {
  const out = path.join(work, 'ipa');
  fs.mkdirSync(out);
  await run('ditto', ['-x', '-k', ipa, out], 'Unpacking the IPA to check it', { minutes: 5 });
  const payload = path.join(out, 'Payload');
  const apps = fs.readdirSync(payload).filter((n) => n.endsWith('.app'));
  if (apps.length !== 1) throw new Error(`the IPA holds ${apps.length} apps`);
  const app = path.join(payload, apps[0]);
  const info = plistJson(path.join(app, 'Info.plist'));
  const problems = [];
  if (info.CFBundleIdentifier !== BUNDLE_ID) problems.push(`bundle id ${info.CFBundleIdentifier}`);
  if (info.CFBundleShortVersionString !== marketing) problems.push(`version ${info.CFBundleShortVersionString}, expected ${marketing}`);
  if (String(info.CFBundleVersion) !== String(buildNo)) problems.push(`build ${info.CFBundleVersion}, expected ${buildNo}`);
  await run('codesign', ['--verify', '--deep', '--strict', app], 'Checking the signature', { minutes: 5 });
  const entFile = path.join(work, 'entitlements.plist');
  fs.writeFileSync(entFile, read('codesign', ['-d', '--entitlements', '-', '--xml', app]));
  const ent = plistJson(entFile);
  if (ent['aps-environment'] !== 'production') problems.push(`aps-environment ${ent['aps-environment']}, expected production`);
  if (ent['get-task-allow'] === true) problems.push('get-task-allow is on (a development signature)');
  if (ent['com.apple.developer.team-identifier'] !== TEAM_ID) problems.push(`team ${ent['com.apple.developer.team-identifier']}`);
  if (ent['application-identifier'] !== `${TEAM_ID}.${BUNDLE_ID}`) problems.push(`application-identifier ${ent['application-identifier']}`);
  if (problems.length) throw new Error(`the signed app is not what the App Store should get: ${problems.join('; ')}`);
  say(`checked: ${BUNDLE_ID} ${marketing} (${buildNo}), team ${TEAM_ID}, push production, distribution signed`);
}

// ---- App Store signing: this Mac's Apple Distribution identity and a profile made for it through the API ----
// Signing is manual. The API key cannot use Apple's cloud signing ("Cloud signing permission error"), and Xcode's
// automatic export then falls back to a cached profile it cannot repair: one made before push was added to the App ID
// has no aps-environment, so the export fails (or, worse, would ship an app whose pushes never arrive).
const PROFILE_DIR = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles');
const PROFILE_MIN_DAYS = 14; // a profile expiring sooner is replaced, so a run never signs with one about to lapse

/** SHA-1s of the valid Apple Distribution identities for this team that have their private key on this Mac. */
function localDistributionShas() {
  const out = read('security', ['find-identity', '-v', '-p', 'codesigning']);
  const re = new RegExp(`\\b([0-9A-F]{40}) "Apple Distribution: [^"]*\\(${TEAM_ID}\\)"`, 'g');
  return new Set([...out.matchAll(re)].map((m) => m[1]));
}

// One value from a plist by key path, as text (a date in ISO 8601, data in base64, an array as its length); null when
// the key is not there. A profile holds dates and data, which plutil cannot turn into JSON, so it is read key by key.
function plistValue(file, keyPath) {
  const r = spawnSync('plutil', ['-extract', keyPath, 'raw', '-o', '-', file], { encoding: 'utf8', timeout: MIN, killSignal: 'SIGKILL' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The parts of a profile the export depends on, or null when it cannot be read. */
function decodeProfile(contentB64, work) {
  if (typeof contentB64 !== 'string' || !contentB64) return null;
  const file = path.join(work, `profile-${crypto.randomUUID()}.mobileprovision`);
  fs.writeFileSync(file, Buffer.from(contentB64, 'base64'));
  const xml = path.join(work, `profile-${crypto.randomUUID()}.plist`);
  try {
    fs.writeFileSync(xml, read('security', ['cms', '-D', '-i', file]));
  } catch (err) {
    say(`could not read a profile: ${err.message}`);
    return null;
  }
  const v = (k) => plistValue(xml, k);
  const certCount = Number(v('DeveloperCertificates')) || 0;
  const certs = [];
  for (let i = 0; i < certCount && i < 50; i += 1) certs.push(v(`DeveloperCertificates.${i}`));
  return {
    file,
    plist: {
      UUID: v('UUID'), ExpirationDate: v('ExpirationDate'), ProvisionedDevices: v('ProvisionedDevices'),
      DeveloperCertificates: certs,
      Entitlements: {
        'application-identifier': v('Entitlements.application-identifier'),
        'aps-environment': v('Entitlements.aps-environment'),
        'get-task-allow': v('Entitlements.get-task-allow') === 'true',
      },
    },
  };
}

/** Why this profile cannot sign the App Store build (empty when it can). */
function profileProblems(plist, certDerB64) {
  const out = [];
  const ent = plist?.Entitlements || {};
  if (ent['application-identifier'] !== `${TEAM_ID}.${BUNDLE_ID}`) out.push(`it is for ${ent['application-identifier']}`);
  if (ent['aps-environment'] !== 'production') out.push(`its push entitlement is ${ent['aps-environment'] ?? 'missing'}`);
  if (ent['get-task-allow'] === true || plist?.ProvisionedDevices !== null) out.push('it is not an App Store profile');
  const exp = Date.parse(plist?.ExpirationDate);
  if (!(exp > Date.now() + PROFILE_MIN_DAYS * 24 * 60 * MIN)) out.push(`it expires ${plist?.ExpirationDate}`);
  // plutil gives each certificate as base64 DER, the same form App Store Connect uses: the identity must be one.
  if (!(plist?.DeveloperCertificates || []).includes(certDerB64)) out.push('it does not hold this Mac\'s distribution certificate');
  if (typeof plist?.UUID !== 'string' || !/^[0-9A-Fa-f-]{36}$/.test(plist.UUID)) out.push('it has no UUID');
  return out;
}

/**
 * The certificate and profile the export signs with: an active App Store profile for this app that holds this Mac's
 * distribution certificate and the push entitlement, else a new one made through the API (never in a dry run).
 * Installed where Xcode looks for profiles. Returns { sha1, uuid, name } or null in a dry run with nothing usable.
 */
async function appStoreSigning(asc, { create }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-ios-sign-'));
  try {
    const local = localDistributionShas();
    const certs = await asc.all('/v1/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=200');
    // Every distribution certificate with its private key here and at least PROFILE_MIN_DAYS left, longest-lived first:
    // during a certificate rotation the old one must not win just because Apple lists it first (Codex).
    const soon = Date.now() + PROFILE_MIN_DAYS * 24 * 60 * MIN;
    const candidates = certs.map((c) => {
      const der = c.attributes?.certificateContent;
      const sha1 = der ? crypto.createHash('sha1').update(Buffer.from(der, 'base64')).digest('hex').toUpperCase() : null;
      return { id: c.id, der, sha1, expires: Date.parse(c.attributes?.expirationDate) };
    }).filter((c) => c.sha1 && local.has(c.sha1) && c.expires > soon).sort((a, b) => b.expires - a.expires);
    if (!candidates.length) throw new Error(`no Apple Distribution certificate of team ${TEAM_ID} with ${PROFILE_MIN_DAYS}+ days left has its private key on this Mac`);
    const bundles = (await asc.all(`/v1/bundleIds?filter[identifier]=${BUNDLE_ID}&limit=50`)).filter((b) => b.attributes?.identifier === BUNDLE_ID);
    if (bundles.length !== 1) throw new Error(`App Store Connect lists ${bundles.length} bundle ids named ${BUNDLE_ID}`);
    const profiles = await asc.all(`/v1/bundleIds/${bundles[0].id}/profiles?limit=200`);
    let chosen = null;
    for (const p of profiles) {
      if (p.attributes?.profileType !== 'IOS_APP_STORE' || p.attributes?.profileState !== 'ACTIVE') continue;
      const d = decodeProfile(p.attributes.profileContent, work);
      const cert = d && candidates.find((c) => !profileProblems(d.plist, c.der).length);
      if (cert) { chosen = { ...d, name: p.attributes.name, cert }; break; }
    }
    if (!chosen) {
      const cert = candidates[0];
      if (!create) { say('[dry run] would make an App Store profile for this Mac\'s distribution certificate'); return null; }
      const name = `Dobius App Store ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      say(`making App Store profile "${name}" (no active one holds this Mac's certificate and push)`);
      const made = await asc.post('/v1/profiles', { data: {
        type: 'profiles',
        attributes: { name, profileType: 'IOS_APP_STORE' },
        relationships: { bundleId: { data: { type: 'bundleIds', id: bundles[0].id } }, certificates: { data: [{ type: 'certificates', id: cert.id }] } },
      } });
      const d = decodeProfile(made?.data?.attributes?.profileContent, work);
      const problems = d ? profileProblems(d.plist, cert.der) : ['Apple sent no profile back'];
      if (problems.length) throw new Error(`the new profile cannot sign the app: ${problems.join('; ')} (is Push Notifications on for the App ID?)`);
      chosen = { ...d, name, cert };
    }
    if (!create) { say(`[dry run] would sign with "${chosen.name}" (${chosen.plist.UUID})`); return null; }
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.copyFileSync(chosen.file, path.join(PROFILE_DIR, `${chosen.plist.UUID}.mobileprovision`));
    say(`signing with "${chosen.name}" (${chosen.plist.UUID}), expires ${chosen.plist.ExpirationDate}`);
    return { sha1: chosen.cert.sha1, uuid: chosen.plist.UUID, name: chosen.name };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Builds, checks and (unless --no-upload) uploads. Returns { after, before } (ms, when the upload began and ended) once Apple has
 * the upload, false with --no-upload.
 */
async function buildAndUpload(cfg, signing, marketing, buildNo) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `dobius-ios-${buildNo}-`));
  try {
    const src = await cleanSource(cfg.sha, work);
    const archive = path.join(work, 'Dobius.xcarchive');
    const auth = ['-allowProvisioningUpdates', '-authenticationKeyPath', cfg.keyPath, '-authenticationKeyID', cfg.keyId, '-authenticationKeyIssuerID', cfg.issuerId];
    await run('xcodebuild', [
      '-project', path.join(src, 'ios/App/App.xcodeproj'), '-scheme', 'App', '-configuration', 'Release', '-destination', 'generic/platform=iOS',
      '-archivePath', archive, 'archive', `MARKETING_VERSION=${marketing}`, `CURRENT_PROJECT_VERSION=${buildNo}`,
      `DEVELOPMENT_TEAM=${TEAM_ID}`, 'CODE_SIGN_STYLE=Automatic', '-quiet', ...auth,
    ], `Archiving ${marketing} (${buildNo})`, { cwd: src, clean: true, minutes: 40 });
    // Signed by hand with the identity and profile appStoreSigning() chose (see there for why not automatic).
    const opts = path.join(work, 'ExportOptions.plist');
    fs.writeFileSync(opts, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>${signing.sha1}</string>
  <key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${signing.uuid}</string></dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
`);
    const exportDir = path.join(work, 'export');
    await run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', opts, '-exportPath', exportDir, '-quiet'],
      `Signing ${marketing} (${buildNo}) for the App Store`, { cwd: src, clean: true, minutes: 20 });
    const ipas = fs.readdirSync(exportDir).filter((n) => n.endsWith('.ipa'));
    if (ipas.length !== 1) throw new Error(`the export made ${ipas.length} IPAs`);
    const ipa = path.join(exportDir, ipas[0]);
    await verifyIpa(ipa, marketing, buildNo, work);
    // altool reads the key from a folder by its Apple name (checked in preflight); the key never goes on a command line.
    const key = ['-t', 'ios', '--api-key', cfg.keyId, '--api-issuer', cfg.issuerId];
    const env = { API_PRIVATE_KEYS_DIR: path.dirname(cfg.keyPath) };
    // altool can exit 0 on a refused upload (a duplicate build, for one), so its own success line is required too.
    const checked = await run('xcrun', ['altool', '--validate-app', ipa, ...key], 'Validating with App Store Connect', { env, clean: true, minutes: 20, capture: true });
    if (!/VERIFY SUCCEEDED/.test(checked) || /VERIFY FAILED/.test(checked)) throw new Error('altool did not report VERIFY SUCCEEDED');
    if (NO_UPLOAD) { say('--no-upload: stopping before the upload'); return false; }
    const after = Date.now();
    const sent = await run('xcrun', ['altool', '--upload-package', ipa, ...key], `Uploading ${marketing} (${buildNo})`, { env, clean: true, minutes: 40, capture: true });
    if (!/UPLOAD SUCCEEDED/.test(sent) || /UPLOAD FAILED/.test(sent)) throw new Error('altool did not report UPLOAD SUCCEEDED');
    // The delivery id names this upload's own record (and so its build) in App Store Connect; see ownUpload.
    const delivery = /Delivery (?:UUID|ID):?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(sent);
    return { after, before: Date.now(), deliveryId: delivery ? delivery[1].toLowerCase() : null };
  } finally {
    // Cleanup never decides the outcome: a leftover folder must not turn an accepted upload into a failure (and so an
    // untagged build).
    for (const step of [
      () => spawnSync('git', ['worktree', 'remove', '--force', path.join(work, 'src')], GIT_OPTS),
      () => fs.rmSync(work, { recursive: true, force: true }),
      () => spawnSync('git', ['worktree', 'prune'], GIT_OPTS),
    ]) {
      try { step(); } catch (err) { say(`cleanup: ${err.message} (left ${work})`); }
    }
  }
}

// The commit this binary is, tagged as soon as Apple has it: what --if-changed compares against next time, and what
// marks the build as ours to submit. Tagged again (same commit) with the build's id once Apple lists it. A build Apple
// later refuses stops counting (see release()).
function tagBuild(marketing, buildNo, sha, up, buildId = null) {
  stillLocked();
  const tag = buildTagName(marketing, buildNo);
  git('tag', '-f', '-a', tag, '-m', tagMessage(marketing, buildNo, up.after, up.before, buildId), sha);
  if (gitOk('push', '-q', '-f', 'origin', `refs/tags/${tag}`)) return true;
  say(`could not push tag ${tag}; push it by hand: git push -f origin ${tag}`);
  return false;
}

/**
 * 'valid' once Apple has processed it, 'timeout' if it is still processing; throws when Apple refused it. The build is
 * found through this run's OWN upload record (ownUpload: the delivery id altool printed, else the one record of these
 * numbers Apple created during the upload), never by numbers and dates in the builds list: Apple lets a failed
 * upload's numbers be reused, and a later upload of them is someone else's binary. Once that record leads to its build,
 * the build is bound to the tag by id (onSeen).
 */
async function waitForBuild(asc, appId, marketing, buildNo, up, onSeen) {
  const until = Date.now() + PROCESSING_TIMEOUT_MS;
  let buildId = null;
  let why = '';
  if (!up.deliveryId) {
    say(`altool printed no delivery id for ${marketing} (${buildNo}), so this upload cannot be told apart from another of the same numbers: the tag stays unbound and vouches for nothing. Check the upload output, then upload again or submit by hand.`);
    return 'unbound';
  }
  say(`Waiting for Apple to process build ${buildNo}...`);
  while (Date.now() < until) {
    if (!buildId) {
      const uploads = await asc.all(`/v1/apps/${appId}/buildUploads?limit=200`);
      const found = ownUpload(uploads, { marketing, n: buildNo, ...up });
      why = found.reason || '';
      const state = found.upload?.attributes?.state?.state;
      if (state === 'FAILED') throw new Error(`Apple refused the upload of ${marketing} (${buildNo}): ${JSON.stringify(found.upload.attributes.state.errors || []).slice(0, 400)}`);
      if (found.upload && state === 'COMPLETE') {
        const r = await asc.get(`/v1/buildUploads/${found.upload.id}?include=build`);
        const id = r.data?.relationships?.build?.data?.id;
        if (id) { buildId = id; onSeen(id); }
        else why = `the upload of ${marketing} (${buildNo}) lists no build yet`;
      }
    }
    if (buildId) {
      const b = (await asc.get(`/v1/builds/${buildId}?fields[builds]=version,processingState`)).data;
      if (String(b?.attributes?.version) !== String(buildNo)) throw new Error(`build ${buildId} is not number ${buildNo}`);
      if (b.attributes.processingState === 'VALID') { say(`build ${buildNo} processed`); return 'valid'; }
      if (REFUSED.has(b.attributes.processingState)) throw new Error(`Apple marked build ${buildNo} ${b.attributes.processingState}`);
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  if (!buildId) say(`never found this run's own upload (${why}); the tag stays unbound and vouches for nothing`);
  return 'timeout';
}

// ---- submit ----
async function itemsOf(asc, subId) {
  return asc.all(`/v1/reviewSubmissions/${subId}/items?fields[reviewSubmissionItems]=state,appStoreVersion&limit=50`);
}
/** The version's item in a submission (a removed one does not count: it cannot come back). */
const itemFor = (items, versionId) => items.find((i) => i.relationships?.appStoreVersion?.data?.id === versionId && i.attributes?.state !== 'REMOVED');

async function submit(asc, notes, justUploaded) {
  // Which builds are ours depends on origin/main: a stale copy could vouch for a commit main no longer has.
  if (!fetchOrigin()) throw new Error('could not fetch origin, so it cannot tell which builds are on main');
  const { app, versions, builds } = await readState(asc);
  // Only builds this script uploaded from a commit on main, matched on BOTH numbers: a build made by hand or from a
  // branch, or one reusing our number under another version, never ships here.
  const ours = new Set(buildTagsOn('origin/main').map((t) => buildOfTag(t, builds)?.id).filter(Boolean));
  const live = liveVersion(versions);
  const liveBuild = live ? await buildOfVersion(asc, live.id) : null;
  // Newer than the live build, whichever path picked it: a hotfix shipped from elsewhere is never replaced by older code.
  // Compared as Apple orders build strings, so a live "100.1" keeps out a 7; a live build string that cannot be read
  // keeps out everything.
  const eligible = builds.filter((b) => b.state === 'VALID' && !b.expired && b.marketing && Number.isInteger(b.number)
    && ours.has(b.id) && aboveShipped(versions, b.marketing) && (!liveBuild || compareBuildStrings(b.raw, liveBuild.raw) === 1));
  const candidate = justUploaded
    ? eligible.find((b) => b.marketing === justUploaded.marketing && b.number === justUploaded.number)
    : eligible.sort((a, b) => b.number - a.number)[0];
  if (!candidate) { say('no processed build of ours newer than the live one: nothing to submit'); return; }
  const plan = planVersion(versions, candidate.marketing);
  say(`build ${candidate.raw} (${candidate.marketing}): ${plan.action}, ${plan.reason}`);
  if (plan.action === 'stop') throw new Error(plan.reason);
  if (plan.action === 'wait') { say('it will be submitted on a later run'); return; }
  if (DRY) return say(`[dry run] would ${plan.action} version ${candidate.marketing}, attach build ${candidate.raw}, set What's New, check the review details, and submit for review`);

  // Submitting sends every item in a submission, so one holding this version plus anything else (an In-App Event,
  // another version) is someone else's to send. Checked BEFORE any write, so such a version is never edited here.
  const othersIn = (items, versionId) => items.filter((i) => i.attributes?.state !== 'REMOVED' && i.relationships?.appStoreVersion?.data?.id !== versionId);
  const open = await asc.all(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES&limit=50`);
  const openItems = new Map();
  for (const s of open) openItems.set(s.id, await itemsOf(asc, s.id));
  if (plan.version) {
    for (const s of open) {
      const items = openItems.get(s.id);
      if (itemFor(items, plan.version.id) && othersIn(items, plan.version.id).length) {
        throw new Error(`version ${plan.version.attributes?.versionString ?? plan.version.id} sits in review submission ${s.id} with other items; resolve or remove them in App Store Connect first (nothing was changed)`);
      }
    }
  }

  let version = plan.version;
  if (plan.action === 'create') {
    const r = await asc.post('/v1/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: candidate.marketing, releaseType: 'AFTER_APPROVAL' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } });
    version = r.data;
    say(`created version ${candidate.marketing}`);
  } else {
    await asc.patch(`/v1/appStoreVersions/${version.id}`, { data: { type: 'appStoreVersions', id: version.id, attributes: { versionString: candidate.marketing, releaseType: 'AFTER_APPROVAL' } } });
    say(`set ${candidate.marketing} on the existing version, released automatically on approval`);
  }
  await asc.patch(`/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: 'builds', id: candidate.id } });
  say(`attached build ${candidate.raw}`);
  const text = whatsNewText(notes);
  const locs = await asc.all(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,whatsNew`);
  if (!locs.length) throw new Error('the version has no localizations to put What\'s New on');
  for (const l of locs) {
    await asc.patch(`/v1/appStoreVersionLocalizations/${l.id}`, { data: { type: 'appStoreVersionLocalizations', id: l.id, attributes: { whatsNew: text } } });
  }

  // Review details (the demo Mac, its code, and a contact): repaired from the live version's when any part is missing.
  const detail = await reviewDetailOf(asc, version.id);
  const problems = reviewDetailProblems(detail?.attributes);
  if (problems.length) {
    const liveDetail = live ? await reviewDetailOf(asc, live.id) : null;
    const attrs = reviewDetailCopy(liveDetail?.attributes);
    if (!attrs) throw new Error(`the review details are incomplete (${problems.join(', ')}) and the live version has no complete set to copy; fix them in App Store Connect`);
    if (detail) await asc.patch(`/v1/appStoreReviewDetails/${detail.id}`, { data: { type: 'appStoreReviewDetails', id: detail.id, attributes: attrs } });
    else await asc.post('/v1/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes: attrs, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } } } });
    say(`review details repaired from the live version (${problems.join(', ')})`);
  }

  // Read everything back before handing it to Apple: a write that did not stick must not go to review.
  const back = (await asc.get(`/v1/appStoreVersions/${version.id}?fields[appStoreVersions]=versionString,releaseType,appVersionState`)).data;
  const backLocs = await asc.all(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,whatsNew`);
  const backDetail = await reviewDetailOf(asc, version.id);
  const wrong = [];
  if (back.attributes.versionString !== candidate.marketing) wrong.push(`version string ${back.attributes.versionString}`);
  if (back.attributes.releaseType !== 'AFTER_APPROVAL') wrong.push(`release type ${back.attributes.releaseType}`);
  for (const l of backLocs) if (l.attributes.whatsNew !== text) wrong.push(`What's New in ${l.attributes.locale}`);
  wrong.push(...reviewDetailProblems(backDetail?.attributes));
  if (wrong.length) throw new Error(`version ${candidate.marketing} did not read back as written: ${wrong.join('; ')}`);

  // The review submission: one left open by a rejection that holds this version (its item is marked resolved), else a
  // draft holding only this version (a run that stopped before submitting), else an empty draft, else a new one. Apple
  // allows several drafts; one holding anything else is left alone (and one holding this version too stopped the run
  // above, before any write).
  let sub = null;
  for (const s of open.filter((x) => x.attributes?.state === 'UNRESOLVED_ISSUES')) {
    const items = await itemsOf(asc, s.id);
    const item = itemFor(items, version.id);
    if (!item) continue;
    if (othersIn(items, version.id).length) throw new Error(`review submission ${s.id} (unresolved issues) also holds other items; resolve or remove them in App Store Connect first`);
    if (item.attributes?.state === 'REJECTED') {
      await asc.patch(`/v1/reviewSubmissionItems/${item.id}`, { data: { type: 'reviewSubmissionItems', id: item.id, attributes: { resolved: true } } });
      say('marked the rejected item resolved');
    }
    sub = s;
    break;
  }
  if (!sub) {
    let empty = null;
    for (const s of open.filter((x) => x.attributes?.state === 'READY_FOR_REVIEW')) {
      const items = openItems.get(s.id);
      if (othersIn(items, version.id).length) continue;
      if (itemFor(items, version.id)) { sub = s; break; }
      if (!empty) empty = s;
    }
    sub = sub || empty;
  }
  if (!sub) sub = (await asc.post('/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
  if (!itemFor(await itemsOf(asc, sub.id), version.id)) {
    await asc.post('/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } }, appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } } } });
  }
  // Last looks, the build first and the items LAST, then the submit at once: the build on the version must still be
  // ours (another App Store Connect user could have picked a different one), and the submission must hold this version
  // and nothing else. What is left is the time between the items read and the submit (one request): Apple offers no
  // conditional submit, so an item added in that instant would go with it.
  const finalBuild = await buildOfVersion(asc, version.id);
  if (finalBuild?.id !== candidate.id) throw new Error(`the version's build changed to ${finalBuild?.raw ?? 'none'} before submitting; not submitted`);
  const finalItems = await itemsOf(asc, sub.id);
  if (!itemFor(finalItems, version.id)) throw new Error(`version ${candidate.marketing} is not in review submission ${sub.id}`);
  if (othersIn(finalItems, version.id).length) throw new Error(`review submission ${sub.id} gained other items before submitting; not submitted`);
  await asc.patch(`/v1/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } });
  say(`submitted ${candidate.marketing} (${candidate.raw}) for review; Apple releases it when it is approved`);
}

// ---- release ----
async function release(asc) {
  const cfg = DRY ? { ...ascConfig(), sha: git('rev-parse', 'HEAD') } : preflight();
  const marketing = JSON.parse(git('show', `${cfg.sha}:package.json`)).version;
  const { app, versions, builds } = await readState(asc);
  const plan = planVersion(versions, marketing);
  if (plan.action === 'stop') die(plan.reason);
  // Our earlier uploads on this branch that Apple has and did not refuse. One still processing counts; one Apple
  // refused, or never lists, does not, so its changes are built again.
  // A build the live one has overtaken (shipped by hand from elsewhere) can never be submitted either, so it does not
  // count unless it IS the live build: otherwise its changes would never ship (Codex).
  const live = liveVersion(versions);
  const liveBuild = live ? await buildOfVersion(asc, live.id) : null;
  const good = buildTagsOn(cfg.sha).filter((t) => {
    const b = buildOfTag(t, builds);
    // An expired build can no longer be submitted, so it does not count as shipped either: its changes build again.
    if (!b || REFUSED.has(b.state) || b.expired) return false;
    if (liveBuild && b.id === liveBuild.id) return true;
    // A version Apple will no longer take (at or below one that shipped) can never ship either (Codex).
    if (!aboveShipped(versions, b.marketing)) return false;
    return !liveBuild || compareBuildStrings(b.raw, liveBuild.raw) === 1;
  });
  const change = appChangedSince(lastBuildTag(good.map((t) => t.tag)), cfg.sha);
  // A change since the last good build always builds, even under the same version: an earlier build of it may be the
  // one App Review rejected, and the fix must not be skipped for it (Codex).
  let uploaded = null;
  if (flag('--if-changed') && !change.changed) {
    say(`no new build: ${change.why}`);
  } else {
    const allTags = git('tag', '--list', 'ios-*').split('\n');
    const buildNo = nextBuildNumber(builds.map((b) => b.raw), 0, [...projectBuildNumber(cfg.sha), ...buildTagNumbers(allTags)]);
    say(`building ${marketing} (${buildNo}) from ${cfg.sha.slice(0, 8)}: ${change.why}`);
    if (DRY) {
      await appStoreSigning(asc, { create: false });
      say(`[dry run] would test, build from a clean checkout, check, validate and upload ${marketing} (${buildNo}), then tag ${buildTagName(marketing, buildNo)}`);
    } else {
      if (!flag('--skip-tests')) {
        assertAt(cfg.sha);
        await run('npm', ['test'], 'Running the tests', { minutes: 30 });
        assertAt(cfg.sha);
      }
      const signing = await appStoreSigning(asc, { create: true });
      const up = await buildAndUpload(cfg, signing, marketing, buildNo);
      if (!up) return; // --no-upload
      tagBuild(marketing, buildNo, cfg.sha, up);
      // Only a bound tag vouches for a build (buildOfTag), and origin's copy is what later runs read: if the binding
      // cannot be pushed, the build is not submitted (a later run builds again).
      const state = await waitForBuild(asc, app.id, marketing, buildNo, up, (id) => {
        if (!tagBuild(marketing, buildNo, cfg.sha, up, id)) throw new Error(`could not push the binding of ${buildTagName(marketing, buildNo)} to build ${id}; not submitting it`);
      });
      // Unbound: it can never be submitted from here, so the run fails and release.sh says so.
      if (state === 'unbound') throw new Error(`build ${buildNo} was uploaded but could not be bound to this run (no delivery id)`);
      if (state === 'timeout') {
        say(`build ${buildNo} is still processing after ${PROCESSING_TIMEOUT_MS / MIN} minutes; run "node scripts/ios-release.mjs submit" later`);
        return;
      }
      uploaded = { marketing, number: buildNo };
    }
  }
  // --no-upload is a ship-test: it never submits, not even a build that was already there.
  if (flag('--no-submit') || NO_UPLOAD) return;
  await submit(asc, opt('--notes'), uploaded);
}

const COMMANDS = { status, release, submit: (asc) => submit(asc, opt('--notes'), null) };
if (!COMMANDS[cmd]) die(`unknown command ${cmd} (status, release, submit)`);
try {
  // Every App Store Connect write checks the lock first (see stillLocked).
  const asc = createAscClient();
  const guard = (fn) => (...a) => { stillLocked(); return fn(...a); };
  await COMMANDS[cmd]({ ...asc, post: guard(asc.post), patch: guard(asc.patch), del: guard(asc.del) });
} catch (err) {
  die(err?.message || String(err));
}
