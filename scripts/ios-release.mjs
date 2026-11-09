#!/usr/bin/env node
// Ship the phone app to the App Store: build from a clean checkout of one commit, check the signed app, upload, wait
// for processing, submit for review, released by Apple on approval. Docs: docs/ios-release.md. Decisions live in
// scripts/lib/ios-release-plan.mjs (tested).
//
//   node scripts/ios-release.mjs status
//   node scripts/ios-release.mjs release [--if-changed] [--dry-run] [--no-upload] [--no-submit] [--notes "..."]
//                                        [--expect-sha <sha>] [--skip-tests] [--allow-branch]
//   node scripts/ios-release.mjs submit [--dry-run] [--notes "..."]

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ascConfig, createAscClient } from './lib/asc-client.mjs';
import {
  planVersion, liveVersion, nextBuildNumber, lastBuildTag, buildTagNumbers, parseBuildTag, buildTagName, buildKey,
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

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const gitOk = (...args) => spawnSync('git', args, { cwd: ROOT }).status === 0;
// Every step has a deadline: a signing prompt nobody answers must not hold the lock (and release.sh) forever.
function run(file, args, label, { cwd = ROOT, env, minutes = 20 } = {}) {
  say(`${label}...`);
  const r = spawnSync(file, args, { cwd, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env, timeout: minutes * MIN, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT') throw new Error(`${label} took over ${minutes} minutes and was stopped`);
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status ?? r.signal ?? r.error?.message})`);
}
const read = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 2 * MIN });
const plistJson = (file) => JSON.parse(read('plutil', ['-convert', 'json', '-o', '-', file]));
// Branches, plus only this script's own tags: the release tags here can differ from origin's (electron-builder makes
// them), and a plain --tags fetch refuses to clobber them and fails the whole fetch.
const fetchOrigin = () => gitOk('fetch', '-q', 'origin') && gitOk('fetch', '-q', 'origin', '+refs/tags/ios-*:refs/tags/ios-*');

// ---- one run at a time: the kernel's lock on a file, released when the process ends however it ends ----
const LOCK = path.join(os.tmpdir(), 'dobius-ios-release.lock');
if (cmd !== 'status' && !DRY && process.env.DOBIUS_IOS_RELEASE_LOCKED !== '1') {
  const r = spawnSync('/usr/bin/lockf', ['-s', '-t', '0', LOCK, process.execPath, SELF, ...argv], {
    stdio: 'inherit', env: { ...process.env, DOBIUS_IOS_RELEASE_LOCKED: '1' },
  });
  if (r.status === 75) die('another iOS release is running');
  process.exit(r.status ?? 1);
}

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

// ---- git tags: which commit each upload was ----
/** This script's tags whose commit is an ancestor of `ref`, parsed. */
function buildTagsOn(ref) {
  return git('tag', '--list', 'ios-*').split('\n').map(parseBuildTag).filter(Boolean)
    .filter((t) => gitOk('merge-base', '--is-ancestor', `${t.tag}^{commit}`, ref));
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

// Our builds are matched on the pair (marketing version, exact build string), never the number alone.
const tagKeys = (tags) => new Set(tags.map((t) => buildKey(t.marketing, String(t.n))));
const keyOf = (b) => buildKey(b.marketing, b.raw);

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
function appChangedSince(tag) {
  if (!tag) return { changed: true, why: 'no earlier iOS build of this branch that Apple accepted' };
  const files = git('diff', '--name-only', tag, 'HEAD', '--', ...APP_PATHS).split('\n').filter(Boolean);
  if (files.length) return { changed: true, why: `${files.length} app file(s) changed since ${tag}` };
  const at = (file) => { try { return git('show', `${tag}:${file}`); } catch { return ''; } };
  const now = (file) => git('show', `HEAD:${file}`);
  if (depsChanged(at('package-lock.json'), now('package-lock.json'))) return { changed: true, why: `dependencies changed since ${tag}` };
  if (manifestChanged(at('package.json'), now('package.json'))) return { changed: true, why: `package.json changed since ${tag}` };
  return { changed: false, why: `nothing in the app changed since ${tag}` };
}

// ---- build, check, upload ----
function projectBuildNumber() {
  const pbx = git('show', 'HEAD:ios/App/App.xcodeproj/project.pbxproj');
  const nums = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/**
 * A checkout of exactly `sha` in its own folder, with the dependencies the lockfile names (`npm ci`): nothing edited in
 * the main checkout, and nothing left over in its node_modules, can reach the build.
 */
function cleanSource(sha, work) {
  const src = path.join(work, 'src');
  run('git', ['worktree', 'add', '--detach', src, sha], `Checking out ${sha.slice(0, 8)} on its own`, { minutes: 5 });
  // Only what the phone build needs: no install scripts (Electron's download, native rebuilds).
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 'Installing the locked dependencies', { cwd: src, minutes: 20 });
  run('npm', ['run', 'build:mobile'], 'Building the phone bundle', { cwd: src, minutes: 10 });
  run('npx', ['cap', 'sync', 'ios'], 'Copying it into the iOS app (cap sync)', { cwd: src, minutes: 10 });
  // cap sync must not change tracked files: if it did, the build would not be exactly that commit.
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: src, encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`cap sync changed tracked files:\n${dirty}`);
  return src;
}

/**
 * The signed app inside the IPA is what App Review gets: its version, bundle id, team and push entitlement are
 * checked here, before anything leaves the Mac. A development-signed build ("aps-environment development",
 * get-task-allow) would pass Apple's upload and then fail every push.
 */
function verifyIpa(ipa, marketing, buildNo, work) {
  const out = path.join(work, 'ipa');
  fs.mkdirSync(out);
  run('ditto', ['-x', '-k', ipa, out], 'Unpacking the IPA to check it', { minutes: 5 });
  const payload = path.join(out, 'Payload');
  const apps = fs.readdirSync(payload).filter((n) => n.endsWith('.app'));
  if (apps.length !== 1) throw new Error(`the IPA holds ${apps.length} apps`);
  const app = path.join(payload, apps[0]);
  const info = plistJson(path.join(app, 'Info.plist'));
  const problems = [];
  if (info.CFBundleIdentifier !== BUNDLE_ID) problems.push(`bundle id ${info.CFBundleIdentifier}`);
  if (info.CFBundleShortVersionString !== marketing) problems.push(`version ${info.CFBundleShortVersionString}, expected ${marketing}`);
  if (String(info.CFBundleVersion) !== String(buildNo)) problems.push(`build ${info.CFBundleVersion}, expected ${buildNo}`);
  run('codesign', ['--verify', '--deep', '--strict', app], 'Checking the signature', { minutes: 5 });
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

/** Builds, checks and (unless --no-upload) uploads. Returns true once Apple has the upload. */
function buildAndUpload(cfg, marketing, buildNo) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `dobius-ios-${buildNo}-`));
  try {
    const src = cleanSource(cfg.sha, work);
    const archive = path.join(work, 'Dobius.xcarchive');
    const auth = ['-allowProvisioningUpdates', '-authenticationKeyPath', cfg.keyPath, '-authenticationKeyID', cfg.keyId, '-authenticationKeyIssuerID', cfg.issuerId];
    run('xcodebuild', [
      '-project', path.join(src, 'ios/App/App.xcodeproj'), '-scheme', 'App', '-configuration', 'Release', '-destination', 'generic/platform=iOS',
      '-archivePath', archive, 'archive', `MARKETING_VERSION=${marketing}`, `CURRENT_PROJECT_VERSION=${buildNo}`,
      `DEVELOPMENT_TEAM=${TEAM_ID}`, 'CODE_SIGN_STYLE=Automatic', '-quiet', ...auth,
    ], `Archiving ${marketing} (${buildNo})`, { cwd: src, minutes: 40 });
    // Signed with this Mac's own Apple Distribution identity: the API key cannot use Apple's cloud signing ("Cloud
    // signing permission error"), and with it Xcode repairs a stale App Store profile (one made before a capability such
    // as push was added) through -allowProvisioningUpdates.
    const opts = path.join(work, 'ExportOptions.plist');
    fs.writeFileSync(opts, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
`);
    const exportDir = path.join(work, 'export');
    run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', opts, '-exportPath', exportDir, '-quiet', ...auth],
      `Signing ${marketing} (${buildNo}) for the App Store`, { cwd: src, minutes: 20 });
    const ipas = fs.readdirSync(exportDir).filter((n) => n.endsWith('.ipa'));
    if (ipas.length !== 1) throw new Error(`the export made ${ipas.length} IPAs`);
    const ipa = path.join(exportDir, ipas[0]);
    verifyIpa(ipa, marketing, buildNo, work);
    // altool reads the key from a folder by its Apple name (checked in preflight); the key never goes on a command line.
    const key = ['-t', 'ios', '--api-key', cfg.keyId, '--api-issuer', cfg.issuerId];
    const env = { API_PRIVATE_KEYS_DIR: path.dirname(cfg.keyPath) };
    run('xcrun', ['altool', '--validate-app', ipa, ...key], 'Validating with App Store Connect', { env, minutes: 20 });
    if (NO_UPLOAD) { say('--no-upload: stopping before the upload'); return false; }
    run('xcrun', ['altool', '--upload-package', ipa, ...key], `Uploading ${marketing} (${buildNo})`, { env, minutes: 40 });
    return true;
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', path.join(work, 'src')], { cwd: ROOT });
    fs.rmSync(work, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: ROOT });
  }
}

// The commit this binary is, tagged as soon as Apple has it: what --if-changed compares against next time, and what
// marks the build as ours to submit. A build Apple later refuses stops counting (see release()).
function tagBuild(marketing, buildNo, sha) {
  const tag = buildTagName(marketing, buildNo);
  git('tag', '-a', tag, '-m', `iOS ${marketing} (${buildNo})`, sha);
  if (!gitOk('push', '-q', 'origin', tag)) say(`could not push tag ${tag}; push it by hand: git push origin ${tag}`);
}

/** 'valid' once Apple has processed it, 'timeout' if it is still processing; throws when Apple refused it. */
async function waitForBuild(asc, appId, marketing, buildNo) {
  const until = Date.now() + PROCESSING_TIMEOUT_MS;
  say(`Waiting for Apple to process build ${buildNo}...`);
  while (Date.now() < until) {
    const r = await asc.get(`/v1/builds?filter[app]=${appId}&filter[version]=${buildNo}&filter[preReleaseVersion.version]=${marketing}&fields[builds]=version,processingState`);
    const b = r.data.find((x) => String(x.attributes.version) === String(buildNo));
    if (b?.attributes.processingState === 'VALID') { say(`build ${buildNo} processed`); return 'valid'; }
    if (b && REFUSED.has(b.attributes.processingState)) throw new Error(`Apple marked build ${buildNo} ${b.attributes.processingState}`);
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
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
  const ours = tagKeys(buildTagsOn('origin/main'));
  const live = liveVersion(versions);
  const liveBuild = live ? await buildOfVersion(asc, live.id) : null;
  const liveNo = liveBuild && /^\d+$/.test(liveBuild.raw) ? Number(liveBuild.raw) : null;
  // Newer than the live build, whichever path picked it: a hotfix shipped from elsewhere is never replaced by older code.
  const eligible = builds.filter((b) => b.state === 'VALID' && !b.expired && b.marketing && Number.isInteger(b.number)
    && ours.has(keyOf(b)) && (liveNo === null || b.number > liveNo));
  const candidate = justUploaded
    ? eligible.find((b) => b.marketing === justUploaded.marketing && b.number === justUploaded.number)
    : eligible.sort((a, b) => b.number - a.number)[0];
  if (!candidate) { say('no processed build of ours newer than the live one: nothing to submit'); return; }
  const plan = planVersion(versions, candidate.marketing);
  say(`build ${candidate.raw} (${candidate.marketing}): ${plan.action}, ${plan.reason}`);
  if (plan.action === 'stop') throw new Error(plan.reason);
  if (plan.action === 'wait') { say('it will be submitted on a later run'); return; }
  if (DRY) return say(`[dry run] would ${plan.action} version ${candidate.marketing}, attach build ${candidate.raw}, set What's New, check the review details, and submit for review`);

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

  // The review submission: one left open by a rejection that holds this version (its item is marked resolved), else an
  // open one ready for review, else a new one. A submission holding only other items (an In-App Event) is left alone.
  const open = await asc.all(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES&limit=50`);
  let sub = null;
  for (const s of open.filter((x) => x.attributes?.state === 'UNRESOLVED_ISSUES')) {
    const item = itemFor(await itemsOf(asc, s.id), version.id);
    if (!item) continue;
    if (item.attributes?.state === 'REJECTED') {
      await asc.patch(`/v1/reviewSubmissionItems/${item.id}`, { data: { type: 'reviewSubmissionItems', id: item.id, attributes: { resolved: true } } });
      say('marked the rejected item resolved');
    }
    sub = s;
    break;
  }
  if (!sub) sub = open.find((x) => x.attributes?.state === 'READY_FOR_REVIEW') || null;
  if (!sub) sub = (await asc.post('/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
  if (!itemFor(await itemsOf(asc, sub.id), version.id)) {
    await asc.post('/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } }, appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } } } });
  }
  if (!itemFor(await itemsOf(asc, sub.id), version.id)) throw new Error(`version ${candidate.marketing} is not in review submission ${sub.id}`);
  // Last look right before submitting: the build on the version must still be ours (another App Store Connect user
  // could have picked a different one since it was attached).
  const finalBuild = await buildOfVersion(asc, version.id);
  if (finalBuild?.id !== candidate.id) throw new Error(`the version's build changed to ${finalBuild?.raw ?? 'none'} before submitting; not submitted`);
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
  const byKey = new Map(builds.map((b) => [keyOf(b), b]));
  const good = buildTagsOn(cfg.sha).filter((t) => {
    const b = byKey.get(buildKey(t.marketing, String(t.n)));
    return b && !REFUSED.has(b.state);
  });
  const change = appChangedSince(lastBuildTag(good.map((t) => t.tag)));
  const existing = good.find((t) => t.marketing === marketing);
  let uploaded = null;
  if (flag('--if-changed') && !change.changed) {
    say(`no new build: ${change.why}`);
  } else if (flag('--if-changed') && existing) {
    say(`no new build: ${marketing} already has build ${existing.n}`);
  } else {
    const allTags = git('tag', '--list', 'ios-*').split('\n');
    const buildNo = nextBuildNumber(builds.map((b) => b.number), projectBuildNumber(), buildTagNumbers(allTags));
    say(`building ${marketing} (${buildNo}) from ${cfg.sha.slice(0, 8)}: ${change.why}`);
    if (DRY) {
      say(`[dry run] would test, build from a clean checkout, check, validate and upload ${marketing} (${buildNo}), then tag ${buildTagName(marketing, buildNo)}`);
    } else {
      if (!flag('--skip-tests')) run('npm', ['test'], 'Running the tests', { minutes: 30 });
      if (!buildAndUpload(cfg, marketing, buildNo)) return; // --no-upload
      tagBuild(marketing, buildNo, cfg.sha);
      const state = await waitForBuild(asc, app.id, marketing, buildNo);
      if (state === 'timeout') {
        say(`build ${buildNo} is still processing after ${PROCESSING_TIMEOUT_MS / MIN} minutes; run "node scripts/ios-release.mjs submit" later`);
        return;
      }
      uploaded = { marketing, number: buildNo };
    }
  }
  if (flag('--no-submit')) return;
  await submit(asc, opt('--notes'), uploaded);
}

const COMMANDS = { status, release, submit: (asc) => submit(asc, opt('--notes'), null) };
if (!COMMANDS[cmd]) die(`unknown command ${cmd} (status, release, submit)`);
try {
  await COMMANDS[cmd](createAscClient());
} catch (err) {
  die(err?.message || String(err));
}
