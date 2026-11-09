#!/usr/bin/env node
// Ship the phone app to the App Store: build, check the signed app, upload, wait for processing, submit for review,
// released by Apple on approval. Docs: docs/ios-release.md. Decisions live in scripts/lib/ios-release-plan.mjs (tested).
//
//   node scripts/ios-release.mjs status
//   node scripts/ios-release.mjs release [--if-changed] [--dry-run] [--no-submit] [--notes "..."]
//                                        [--expect-sha <sha>] [--skip-tests] [--allow-branch]
//   node scripts/ios-release.mjs submit [--dry-run] [--notes "..."]

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ascConfig, createAscClient } from './lib/asc-client.mjs';
import {
  planVersion, liveVersion, nextBuildNumber, lastBuildTag, buildTagNumbers, whatsNewText, reviewDetailCopy, reviewDetailProblems,
  depsChanged, manifestChanged, APP_PATHS,
} from './lib/ios-release-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ID = 'com.statusdigital.dobiusplus';
const TEAM_ID = 'Z349CC556Z';
const PROCESSING_TIMEOUT_MS = 45 * 60_000;
const POLL_MS = 30_000;

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');
const say = (...a) => console.log('[ios-release]', ...a);
const die = (msg, code = 1) => { console.error(`[ios-release] ${msg}`); process.exit(code); };

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const gitOk = (...args) => spawnSync('git', args, { cwd: ROOT }).status === 0;
function run(file, args, label, env) {
  say(`${label}...`);
  const r = spawnSync(file, args, { cwd: ROOT, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status ?? r.signal})`);
}
// Branches, plus only this script's own tags: the release tags here can differ from origin's (electron-builder makes
// them), and a plain --tags fetch refuses to clobber them and fails the whole fetch.
const fetchOrigin = () => gitOk('fetch', '-q', 'origin') && gitOk('fetch', '-q', 'origin', '+refs/tags/ios-build-*:refs/tags/ios-build-*');
const read = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const plistJson = (file) => JSON.parse(read('plutil', ['-convert', 'json', '-o', '-', file]));

// ---- one run at a time ----
const LOCK = path.join(os.tmpdir(), 'dobius-ios-release.lock');
function takeLock() {
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    const pid = Number.parseInt(fs.readFileSync(LOCK, 'utf8'), 10);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (alive) die(`another iOS release is running (pid ${pid})`);
    fs.writeFileSync(LOCK, String(process.pid));
  }
  const drop = () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* gone */ } };
  process.on('exit', drop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { drop(); process.exit(130); });
}

// ---- checks before building ----
function preflight() {
  const cfg = ascConfig();
  if (!fs.existsSync(cfg.keyPath)) die(`App Store Connect key not found at ${cfg.keyPath}`);
  // altool finds the key by its file name in a folder, so the file must carry Apple's name.
  if (path.basename(cfg.keyPath) !== `AuthKey_${cfg.keyId}.p8`) die(`the key file must be named AuthKey_${cfg.keyId}.p8`);
  // A worktree's node_modules is usually a symlink, and cap sync writes its real path into Package.swift.
  if (git('rev-parse', '--git-dir') !== git('rev-parse', '--git-common-dir')) die('run this from the main checkout, not a worktree');
  if (fs.lstatSync(path.join(ROOT, 'node_modules')).isSymbolicLink()) die('node_modules is a symlink: cap sync would write its real path into Package.swift');
  if (git('status', '--porcelain')) die('the working tree has changes: commit or drop them first (the build must be exactly a commit)');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main' && !flag('--allow-branch')) die(`on branch ${branch}: App Store builds come from main (or pass --allow-branch)`);
  const sha = git('rev-parse', 'HEAD');
  const expect = opt('--expect-sha');
  if (expect && sha !== expect) die(`HEAD is ${sha}, not the expected ${expect}`);
  if (!fetchOrigin()) die('could not fetch origin');
  if (!gitOk('merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`)) die(`HEAD is not on origin/${branch}: push it first`);
  return { ...cfg, sha };
}

// The build must be exactly the commit it is tagged with: nothing may move HEAD or touch tracked files mid-build.
function assertSameTree(sha, when) {
  const now = git('rev-parse', 'HEAD');
  if (now !== sha) throw new Error(`HEAD moved ${when} (${sha.slice(0, 8)} to ${now.slice(0, 8)})`);
  const dirty = git('status', '--porcelain');
  if (dirty) throw new Error(`tracked files changed ${when}:\n${dirty}`);
}

// ---- git tags: which commit each upload was ----
/** `ios-build-<N>` tags whose commit is an ancestor of `ref`. */
function buildTagsOn(ref) {
  return git('tag', '--list', 'ios-build-*').split('\n').filter(Boolean)
    .filter((t) => gitOk('merge-base', '--is-ancestor', `${t}^{commit}`, ref));
}

// ---- App Store Connect reads ----
async function readState(asc) {
  const apps = await asc.get(`/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=name,bundleId`);
  const app = apps.data.find((a) => a.attributes?.bundleId === BUNDLE_ID);
  if (!app) throw new Error(`no App Store Connect app with bundle id ${BUNDLE_ID}`);
  const versions = await asc.all(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=200&fields[appStoreVersions]=platform,versionString,appVersionState,appStoreState,releaseType,createdDate`);
  const buildsRes = await asc.get(`/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=200&fields[builds]=version,processingState,uploadedDate,expired,preReleaseVersion&include=preReleaseVersion&fields[preReleaseVersions]=version`);
  const pre = new Map((buildsRes.included || []).filter((x) => x.type === 'preReleaseVersions').map((x) => [x.id, x.attributes.version]));
  const builds = buildsRes.data.map((b) => ({
    id: b.id,
    number: Number.parseInt(b.attributes.version, 10),
    marketing: pre.get(b.relationships?.preReleaseVersion?.data?.id) || null,
    state: b.attributes.processingState,
    expired: b.attributes.expired === true,
    uploaded: b.attributes.uploadedDate,
  }));
  return { app, versions, builds };
}

async function buildOfVersion(asc, versionId) {
  const r = await asc.get(`/v1/appStoreVersions/${versionId}/build?fields[builds]=version`);
  return r.data ? { id: r.data.id, number: Number.parseInt(r.data.attributes.version, 10) } : null;
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
  for (const b of builds.slice(0, 6)) say(`  build ${b.number} (${b.marketing || '?'}): ${b.state}${b.expired ? ', expired' : ''}, uploaded ${b.uploaded}`);
  const subs = await asc.get(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&limit=5`);
  for (const s of subs.data) say(`  review submission ${s.id}: ${s.attributes.state}${s.attributes.submittedDate ? `, submitted ${s.attributes.submittedDate}` : ''}`);
  say(`  last uploaded commit tag: ${lastBuildTag(buildTagsOn('HEAD')) || 'none'}`);
}

// ---- did anything in the app change since the last upload? ----
function appChangedSince(tag) {
  if (!tag) return { changed: true, why: 'no earlier iOS build tag on this branch' };
  const files = git('diff', '--name-only', tag, 'HEAD', '--', ...APP_PATHS).split('\n').filter(Boolean);
  if (files.length) return { changed: true, why: `${files.length} app file(s) changed since ${tag}` };
  const at = (file) => { try { return git('show', `${tag}:${file}`); } catch { return ''; } };
  const now = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (depsChanged(at('package-lock.json'), now('package-lock.json'))) return { changed: true, why: `dependencies changed since ${tag}` };
  if (manifestChanged(at('package.json'), now('package.json'))) return { changed: true, why: `package.json changed since ${tag}` };
  return { changed: false, why: `nothing in the app changed since ${tag}` };
}

// ---- build, check, upload ----
function projectBuildNumber() {
  const pbx = fs.readFileSync(path.join(ROOT, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
  const nums = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/**
 * The signed app inside the IPA is what App Review gets: its version, bundle id, team and push entitlement are
 * checked here, before anything leaves the Mac. A development-signed build ("aps-environment development",
 * get-task-allow) would pass Apple's upload and then fail every push.
 */
function verifyIpa(ipa, marketing, buildNo, work) {
  const out = path.join(work, 'ipa');
  fs.mkdirSync(out);
  run('ditto', ['-x', '-k', ipa, out], 'Unpacking the IPA to check it');
  const payload = path.join(out, 'Payload');
  const apps = fs.readdirSync(payload).filter((n) => n.endsWith('.app'));
  if (apps.length !== 1) throw new Error(`the IPA holds ${apps.length} apps`);
  const app = path.join(payload, apps[0]);
  const info = plistJson(path.join(app, 'Info.plist'));
  const problems = [];
  if (info.CFBundleIdentifier !== BUNDLE_ID) problems.push(`bundle id ${info.CFBundleIdentifier}`);
  if (info.CFBundleShortVersionString !== marketing) problems.push(`version ${info.CFBundleShortVersionString}, expected ${marketing}`);
  if (String(info.CFBundleVersion) !== String(buildNo)) problems.push(`build ${info.CFBundleVersion}, expected ${buildNo}`);
  run('codesign', ['--verify', '--deep', '--strict', app], 'Checking the signature');
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

function buildAndUpload(cfg, marketing, buildNo) {
  run('npm', ['run', 'build:mobile'], 'Building the phone bundle');
  run('npx', ['cap', 'sync', 'ios'], 'Copying it into the iOS app (cap sync)');
  assertSameTree(cfg.sha, 'during cap sync');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `dobius-ios-${buildNo}-`));
  try {
    const archive = path.join(work, 'Dobius.xcarchive');
    const auth = ['-allowProvisioningUpdates', '-authenticationKeyPath', cfg.keyPath, '-authenticationKeyID', cfg.keyId, '-authenticationKeyIssuerID', cfg.issuerId];
    run('xcodebuild', [
      '-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release', '-destination', 'generic/platform=iOS',
      '-archivePath', archive, 'archive', `MARKETING_VERSION=${marketing}`, `CURRENT_PROJECT_VERSION=${buildNo}`,
      `DEVELOPMENT_TEAM=${TEAM_ID}`, 'CODE_SIGN_STYLE=Automatic', '-quiet', ...auth,
    ], `Archiving ${marketing} (${buildNo})`);
    assertSameTree(cfg.sha, 'during the archive');
    const opts = path.join(work, 'ExportOptions.plist');
    fs.writeFileSync(opts, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
`);
    const exportDir = path.join(work, 'export');
    run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', opts, '-exportPath', exportDir, '-quiet', ...auth],
      `Signing ${marketing} (${buildNo}) for the App Store`);
    const ipas = fs.readdirSync(exportDir).filter((n) => n.endsWith('.ipa'));
    if (ipas.length !== 1) throw new Error(`the export made ${ipas.length} IPAs`);
    const ipa = path.join(exportDir, ipas[0]);
    verifyIpa(ipa, marketing, buildNo, work);
    // altool reads the key from a folder by its Apple name (checked in preflight); the key never goes on a command line.
    const key = ['-t', 'ios', '--api-key', cfg.keyId, '--api-issuer', cfg.issuerId];
    const keyEnv = { API_PRIVATE_KEYS_DIR: path.dirname(cfg.keyPath) };
    run('xcrun', ['altool', '--validate-app', ipa, ...key], 'Validating with App Store Connect', keyEnv);
    run('xcrun', ['altool', '--upload-package', ipa, ...key], `Uploading ${marketing} (${buildNo})`, keyEnv);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// The commit this build is: what --if-changed compares against next time, and what marks a build as ours to submit.
function tagBuild(marketing, buildNo, sha) {
  const tag = `ios-build-${buildNo}`;
  git('tag', '-a', tag, '-m', `iOS ${marketing} (${buildNo})`, sha);
  if (!gitOk('push', '-q', 'origin', tag)) say(`could not push tag ${tag}; push it by hand: git push origin ${tag}`);
  return tag;
}

/** 'valid' once Apple has processed it, 'timeout' if it is still processing; throws when Apple refused it. */
async function waitForBuild(asc, appId, marketing, buildNo) {
  const until = Date.now() + PROCESSING_TIMEOUT_MS;
  say(`Waiting for Apple to process build ${buildNo}...`);
  while (Date.now() < until) {
    const r = await asc.get(`/v1/builds?filter[app]=${appId}&filter[version]=${buildNo}&filter[preReleaseVersion.version]=${marketing}&fields[builds]=version,processingState`);
    const b = r.data[0];
    if (b?.attributes.processingState === 'VALID') { say(`build ${buildNo} processed`); return 'valid'; }
    if (b && ['INVALID', 'FAILED'].includes(b.attributes.processingState)) throw new Error(`Apple marked build ${buildNo} ${b.attributes.processingState}`);
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  return 'timeout';
}

// ---- submit ----
async function submit(asc, notes, justUploaded) {
  if (!fetchOrigin()) say('could not fetch origin: using the tags already here');
  const { app, versions, builds } = await readState(asc);
  // Only builds this script uploaded from a commit on main: a build made by hand, or from a branch, never ships here.
  const ours = new Set(buildTagNumbers(buildTagsOn('origin/main')));
  const live = liveVersion(versions);
  const liveBuild = live ? await buildOfVersion(asc, live.id) : null;
  const candidate = justUploaded
    ? builds.find((b) => b.number === justUploaded.number && b.state === 'VALID' && ours.has(b.number))
    : builds.filter((b) => b.state === 'VALID' && !b.expired && b.marketing && ours.has(b.number) && (!liveBuild || b.number > liveBuild.number))
      .sort((a, b) => b.number - a.number)[0];
  if (!candidate) { say('no processed build of ours newer than the live one: nothing to submit'); return; }
  const plan = planVersion(versions, candidate.marketing);
  say(`build ${candidate.number} (${candidate.marketing}): ${plan.action}, ${plan.reason}`);
  if (plan.action === 'stop') throw new Error(plan.reason);
  if (plan.action === 'wait') { say('it will be submitted on a later run'); return; }
  if (DRY) return say(`[dry run] would ${plan.action} version ${candidate.marketing}, attach build ${candidate.number}, set What's New, check the review details, and submit for review`);

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
  say(`attached build ${candidate.number}`);
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
  const backBuild = await buildOfVersion(asc, version.id);
  const backLocs = await asc.all(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,whatsNew`);
  const backDetail = await reviewDetailOf(asc, version.id);
  const wrong = [];
  if (back.attributes.versionString !== candidate.marketing) wrong.push(`version string ${back.attributes.versionString}`);
  if (back.attributes.releaseType !== 'AFTER_APPROVAL') wrong.push(`release type ${back.attributes.releaseType}`);
  if (backBuild?.id !== candidate.id) wrong.push(`build ${backBuild?.number ?? 'none'}`);
  for (const l of backLocs) if (l.attributes.whatsNew !== text) wrong.push(`What's New in ${l.attributes.locale}`);
  wrong.push(...reviewDetailProblems(backDetail?.attributes));
  if (wrong.length) throw new Error(`version ${candidate.marketing} did not read back as written: ${wrong.join('; ')}`);

  // One open review submission for the app (a fresh one, or one left open by a rejection), with this version in it.
  const open = await asc.get(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES&limit=5`);
  let sub = open.data[0];
  if (!sub) sub = (await asc.post('/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data;
  try {
    await asc.post('/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } }, appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } } } });
  } catch (err) {
    if (err.status !== 409) throw err; // 409 is usually "already in it": the read below decides
  }
  const items = await asc.all(`/v1/reviewSubmissions/${sub.id}/items?include=appStoreVersion&fields[reviewSubmissionItems]=state,appStoreVersion`);
  if (!items.some((i) => i.relationships?.appStoreVersion?.data?.id === version.id)) {
    throw new Error(`version ${candidate.marketing} is not in review submission ${sub.id}`);
  }
  await asc.patch(`/v1/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } });
  say(`submitted ${candidate.marketing} (${candidate.number}) for review; Apple releases it when it is approved`);
}

// ---- release ----
async function release(asc) {
  const cfg = DRY ? { ...ascConfig(), sha: git('rev-parse', 'HEAD') } : preflight();
  const marketing = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const { app, versions, builds } = await readState(asc);
  const plan = planVersion(versions, marketing);
  if (plan.action === 'stop') die(plan.reason);
  const tags = buildTagsOn('HEAD');
  const change = appChangedSince(lastBuildTag(tags));
  // A build of this version that Apple did not refuse already exists: a second one would only queue behind it.
  const existing = builds.find((b) => b.marketing === marketing && !['INVALID', 'FAILED'].includes(b.state));
  let uploaded = null;
  if (flag('--if-changed') && !change.changed) {
    say(`no new build: ${change.why}`);
  } else if (flag('--if-changed') && existing) {
    say(`no new build: ${marketing} already has build ${existing.number} (${existing.state})`);
  } else {
    const allTags = git('tag', '--list', 'ios-build-*').split('\n');
    const buildNo = nextBuildNumber(builds.map((b) => b.number), projectBuildNumber(), buildTagNumbers(allTags));
    say(`building ${marketing} (${buildNo}) from ${cfg.sha.slice(0, 8)}: ${change.why}`);
    if (DRY) {
      say(`[dry run] would test, build, check, validate and upload ${marketing} (${buildNo}), then tag ios-build-${buildNo}`);
    } else {
      if (!flag('--skip-tests')) run('npm', ['test'], 'Running the tests');
      assertSameTree(cfg.sha, 'during the tests');
      buildAndUpload(cfg, marketing, buildNo);
      const state = await waitForBuild(asc, app.id, marketing, buildNo);
      // Tagged once Apple has it and did not refuse it: a refused build must not count as "the app as shipped".
      tagBuild(marketing, buildNo, cfg.sha);
      if (state === 'timeout') {
        say(`build ${buildNo} is still processing after ${PROCESSING_TIMEOUT_MS / 60_000} minutes; run "node scripts/ios-release.mjs submit" later`);
        return;
      }
      uploaded = { number: buildNo };
    }
  }
  if (flag('--no-submit')) return;
  await submit(asc, opt('--notes'), uploaded);
}

const COMMANDS = { status, release, submit: (asc) => submit(asc, opt('--notes'), null) };
if (!COMMANDS[cmd]) die(`unknown command ${cmd} (status, release, submit)`);
if (cmd !== 'status' && !DRY) takeLock();
try {
  await COMMANDS[cmd](createAscClient());
} catch (err) {
  die(err?.message || String(err));
}
