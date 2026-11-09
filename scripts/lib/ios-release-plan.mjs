// The decisions behind scripts/ios-release.mjs, kept pure so they are tested without Apple or Xcode
// (electron/__tests__/ios-release-plan.test.mjs). Docs: docs/ios-release.md.

/** -1, 0 or 1 for dotted numeric versions ("2.2.12" vs "2.2.1"). A missing part counts as 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * One more than every build number App Store Connect has, the project's own, and every `ios-<version>-<N>` tag (an upload
 * Apple has not listed yet still used its number). Never reused.
 */
/**
 * Compares two build strings the way Apple orders them: up to three dot-separated whole numbers, a missing part read as
 * 0 ("7" equals "7.0", "100.1" is above "7"). Returns -1, 0 or 1, or null when either is not a build string.
 */
export function compareBuildStrings(a, b) {
  const parse = (v) => (/^\d+(?:\.\d+){0,2}$/.test(String(v ?? '')) ? String(v).split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * One above every build number in use. A dotted build ("100.1") counts by its first part, so the next whole number
 * (101) still sorts above it.
 */
export function nextBuildNumber(ascBuildVersions, projectBuild, tagNumbers = []) {
  const nums = [...(ascBuildVersions || []), projectBuild, ...(tagNumbers || [])]
    .map((v) => Number.parseInt(String(v ?? ''), 10))
    .filter((n) => Number.isInteger(n) && n >= 0);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

// Apple's appVersionState values (appStoreState for older answers), grouped by what this script may do with them.
export const LIVE_STATES = new Set(['READY_FOR_DISTRIBUTION']);
// Shipped once and since replaced or pulled: they set the version floor and block nothing.
export const PAST_STATES = new Set(['REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE']);
// Apple has it: no edits, no second submission. The build waits for a later run.
export const BUSY_STATES = new Set([
  'WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACCEPTED', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION',
  'WAITING_FOR_EXPORT_COMPLIANCE',
]);
// Approved and waiting for a person to press Release. Never pressed from here: someone chose a manual release (only a
// version made by hand can be in it), so it waits for them.
export const PENDING_RELEASE_STATES = new Set(['PENDING_DEVELOPER_RELEASE']);
// Waiting on the account, not on Apple's review: a person has to sign the agreements.
export const ACCOUNT_STATES = new Set(['PENDING_CONTRACT']);
// Editable: the next build goes here.
export const EDITABLE_STATES = new Set([
  'PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'READY_FOR_REVIEW',
]);

const stateOf = (v) => v?.attributes?.appVersionState || v?.attributes?.appStoreState || null;
const vs = (v) => v.attributes.versionString;
const highest = (list) => [...list].sort((a, b) => compareVersions(vs(b), vs(a)))[0] || null;

const iosVersions = (versions) => (versions || []).filter((v) => v?.type === 'appStoreVersions' && (v.attributes?.platform || 'IOS') === 'IOS');

/** The version on the App Store now (the highest live one), or null. */
export function liveVersion(versions) {
  return highest(iosVersions(versions).filter((v) => LIVE_STATES.has(stateOf(v))));
}

/**
 * What to do with a build of `marketingVersion` given the app's iOS App Store versions (ASC objects).
 * Returns { action, version?, live?, reason }:
 *   'create'   no version can take it: make a new one (AFTER_APPROVAL)
 *   'reuse'    put it on this editable version (its version string is set to marketingVersion)
 *   'wait'     Apple is handling a version, or one waits for a person's release: leave everything, try on a later run
 *   'stop'     the build cannot ship (its version is not above every shipped one, a person must act, or a state this
 *              script does not know)
 */
/** The floor: the highest version string that ever shipped (live, replaced, pulled), or null. */
export function shippedFloor(versions) {
  const list = iosVersions(versions);
  const top = highest(list.filter((v) => LIVE_STATES.has(stateOf(v)) || PAST_STATES.has(stateOf(v))));
  return top ? vs(top) : null;
}

/** Whether a version string can still ship: Apple refuses one at or below the shipped floor. */
export function aboveShipped(versions, marketingVersion) {
  const floor = shippedFloor(versions);
  return !floor || compareVersions(marketingVersion, floor) > 0;
}

export function planVersion(versions, marketingVersion) {
  const list = iosVersions(versions);
  const live = liveVersion(list);
  const others = list.filter((v) => !LIVE_STATES.has(stateOf(v)) && !PAST_STATES.has(stateOf(v)));
  const known = (s) => BUSY_STATES.has(s) || PENDING_RELEASE_STATES.has(s) || ACCOUNT_STATES.has(s) || EDITABLE_STATES.has(s);
  const unknown = others.find((v) => !known(stateOf(v)));
  if (unknown) return { action: 'stop', live, version: unknown, reason: `version ${vs(unknown)} is in a state this script does not handle (${stateOf(unknown)})` };
  const account = others.find((v) => ACCOUNT_STATES.has(stateOf(v)));
  if (account) return { action: 'stop', live, version: account, reason: `version ${vs(account)} waits on the account (${stateOf(account)}): sign the agreements in App Store Connect` };
  const busy = others.find((v) => BUSY_STATES.has(stateOf(v)));
  if (busy) return { action: 'wait', live, version: busy, reason: `Apple is handling ${vs(busy)} (${stateOf(busy)})` };
  const pending = others.find((v) => PENDING_RELEASE_STATES.has(stateOf(v)));
  if (pending) return { action: 'wait', live, version: pending, reason: `${vs(pending)} is approved and waits for a manual release in App Store Connect` };
  const shipped = shippedFloor(list);
  if (!aboveShipped(list, marketingVersion)) {
    return { action: 'stop', live, reason: `version ${marketingVersion} is not higher than ${shipped}, which already shipped` };
  }
  const editable = others.filter((v) => EDITABLE_STATES.has(stateOf(v)));
  if (editable.length > 1) return { action: 'stop', live, reason: `more than one editable version (${editable.map(vs).join(', ')})` };
  if (editable.length === 1) return { action: 'reuse', live, version: editable[0], reason: `reusing ${vs(editable[0])} (${stateOf(editable[0])})` };
  return { action: 'create', live, reason: `new version ${marketingVersion}` };
}

// The paths whose changes reach the app binary. mobile/ imports from shared/ only (checked by the tests). The
// dependency files count separately (depsChanged): every release bumps their version line, which changes nothing.
// Root build configs Vite would pick up for the phone build count too, even before they exist (Codex round 10).
export const APP_PATHS = ['mobile', 'shared', 'ios', 'capacitor.config.json', 'vite.mobile.config.js', 'npm-shrinkwrap.json', 'postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'postcss.config.ts', 'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts', 'postcss.config.cts', 'postcss.config.mts', '.postcssrc', '.postcssrc.json', '.postcssrc.yaml', '.postcssrc.yml', '.postcssrc.js', '.postcssrc.cjs', '.postcssrc.mjs', '.postcssrc.ts', '.postcssrc.cts', '.postcssrc.mts', '.browserslistrc', 'browserslist'];

/** True when the installed dependency set differs between two package-lock.json texts, ignoring the app's own version. */
export function depsChanged(oldLock, newLock) {
  const strip = (text) => {
    let j;
    try { j = JSON.parse(text); } catch { return null; }
    if (!j || typeof j !== 'object') return null;
    const packages = { ...(j.packages || {}) };
    if (packages['']) { const { version: _v, ...root } = packages['']; packages[''] = root; }
    return JSON.stringify({ packages, dependencies: j.dependencies || null });
  };
  const a = strip(oldLock);
  const b = strip(newLock);
  return a === null || b === null || a !== b; // unreadable on either side: treat as changed
}

/** True when package.json differs in anything but its own version (scripts, dependencies, Capacitor config...). */
export function manifestChanged(oldPkg, newPkg) {
  const strip = (text) => {
    let j;
    try { j = JSON.parse(text); } catch { return null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const { version: _v, ...rest } = j;
    return stableJson(rest);
  };
  const a = strip(oldPkg);
  const b = strip(newPkg);
  return a === null || b === null || a !== b;
}

function stableJson(x) {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stableJson(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

// Each upload's commit is tagged `ios-<marketing>-<build>` (ios-2.2.12-7): both numbers, because Apple lets a build
// number repeat across marketing versions, so the pair is what names one binary.
const TAG_RE = /^ios-(\d+(?:\.\d+){0,3})-(\d+)$/;

/** { tag, marketing, n } for one of this script's tags, else null. */
export function parseBuildTag(tag) {
  const m = TAG_RE.exec(String(tag ?? '').trim());
  return m ? { tag: m[0], marketing: m[1], n: Number(m[2]) } : null;
}

export const buildTagName = (marketing, n) => `ios-${marketing}-${n}`;

/** The key that names one uploaded binary: its marketing version and its build string, exactly. */
export const buildKey = (marketing, build) => `${marketing}|${build}`;

// A tag records when its upload began and ended; Apple's clock may run a little behind this Mac's, and Apple may date a
// build a little after the transfer ends.
export const UPLOAD_SLACK_MS = 2 * 60_000;
export const UPLOAD_LATE_MS = 10 * 60_000;

/** Parses a tag message: { after, before } (ms, NaN when missing) and buildId (null when not bound yet). */
export function parseTagMessage(subject) {
  const time = (k) => { const m = new RegExp(`${k} (\\S+)`).exec(subject || ''); return m ? Date.parse(m[1]) : Number.NaN; };
  const id = /asc-build ([A-Za-z0-9-]+)/.exec(subject || '');
  return { after: time('uploaded-after'), before: time('uploaded-before'), buildId: id ? id[1] : null };
}

export const tagMessage = (marketing, n, after, before, buildId) =>
  `iOS ${marketing} (${n}) uploaded-after ${new Date(after).toISOString()} uploaded-before ${new Date(before).toISOString()}${buildId ? ` asc-build ${buildId}` : ''}`;

/**
 * The build a tag ({ marketing, n, after, before, buildId }) vouches for: only the build whose App Store Connect id the
 * run recorded on it (bound the first time it saw Apple list the build, inside the upload's own window), and only while
 * that build still carries the tag's numbers and falls in the window. A tag never bound (the run died, Apple never
 * listed the build, the binding push failed) vouches for nothing: Apple lets a failed upload's numbers be reused, so
 * any later match could be someone else's binary. `builds` are { id, marketing, raw, uploaded }.
 */
export function buildOfTag(t, builds) {
  if (!t || !t.buildId || !Number.isFinite(t.after) || !Number.isFinite(t.before)) return null;
  return (builds || []).find((b) => b.id === t.buildId && inUploadWindow(t, b.marketing, b.raw, b.uploaded)) || null;
}

/** Whether a build ({marketing, raw, uploaded}) has a tag's numbers and Apple dates it inside the tag's upload window. */
export function inUploadWindow(t, marketing, raw, uploaded) {
  const at = Date.parse(uploaded);
  return marketing === t.marketing && String(raw) === String(t.n) && at >= t.after - UPLOAD_SLACK_MS && at <= t.before + UPLOAD_LATE_MS;
}

/** The last uploaded build's tag among `tags`: the highest build number. */
export function lastBuildTag(tags) {
  let best = null;
  for (const t of tags || []) {
    const b = parseBuildTag(t);
    if (b && (!best || b.n > best.n)) best = b;
  }
  return best?.tag || null;
}

/** The build numbers of this script's tags. */
export function buildTagNumbers(tags) {
  return (tags || []).map(parseBuildTag).filter(Boolean).map((b) => b.n);
}

/** "What's New" text: the person's own, else a plain line. Apple caps it at 4000 characters. */
export function whatsNewText(notes) {
  const t = typeof notes === 'string' ? notes.trim() : '';
  return (t || 'Improvements and fixes across the app.').slice(0, 4000);
}

// What App Review needs on every version: a contact, and the notes that tell it how to reach the demo Mac
// (RELEASING-IOS.md: the demo host and its pairing code).
const CONTACT_FIELDS = ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'];

/** Every reason these review details would leave App Review stuck; an empty list means they are complete. */
/**
 * Every demo.dobius mention in review notes is one the demo answers (see reviewDetailProblems). A mention is only read
 * from the start of its host: `notdemo.dobius`, `staging.demo.dobius` or `example.com/demo.dobius` are other addresses,
 * so every occurrence of the name has to be a whole, valid address of its own (Codex iOS round 7).
 */
export function demoAddressesOk(notes) {
  const s = String(notes || '');
  let valid = 0;
  for (const m of s.matchAll(/(?<![a-z0-9+._@/:-])(?:([a-z][a-z0-9+.-]*):\/\/)?demo\.dobius([^\s,;)\]'"<>]*)/gi)) {
    const scheme = m[1] ? m[1].toLowerCase() : null;
    const rest = m[2].replace(/[.!?:/]+$/, ''); // sentence punctuation, a trailing slash
    if (scheme ? !(scheme === 'http' && rest === ':8420') : !(rest === '' || rest === ':8420')) return false;
    valid += 1;
  }
  return valid === (s.match(/demo\.dobius/gi) || []).length;
}

/**
 * Which of App Store Connect's upload records (`/v1/apps/{id}/buildUploads`) is this run's own upload: the one whose id
 * is the delivery id altool printed for it, and nothing else. Without that id no record is named: numbers and dates
 * cannot tell this upload from someone else's of the same numbers made around the same time (Codex iOS round 7), so
 * the tag stays unbound and vouches for nothing.
 * Returns { upload } or { reason }.
 */
export function ownUpload(uploads, { marketing, n, deliveryId }) {
  if (!deliveryId) return { reason: 'altool printed no delivery id for this upload, so it cannot be told apart from another upload of the same numbers' };
  const id = String(deliveryId).toLowerCase();
  const u = (uploads || []).find((x) => String(x?.id).toLowerCase() === id);
  if (!u) return { reason: `Apple does not list delivery ${deliveryId} yet` };
  if (u.attributes?.cfBundleShortVersionString !== marketing || String(u.attributes?.cfBundleVersion) !== String(n)) return { reason: `delivery ${deliveryId} is not ${marketing} (${n})` };
  return { upload: u };
}

export function reviewDetailProblems(attrs) {
  if (!attrs || typeof attrs !== 'object') return ['no review details'];
  const out = [];
  for (const k of CONTACT_FIELDS) if (typeof attrs[k] !== 'string' || !attrs[k].trim()) out.push(`no ${k}`);
  const notes = typeof attrs.notes === 'string' ? attrs.notes : '';
  if (!notes.includes('demo.dobius')) out.push('the notes do not mention demo.dobius');
  // The code on its own: 0123456 contains it, and the phone keeps only the first six digits typed (Codex round 10).
  if (!/(?<![0-9])123456(?![0-9])/.test(notes)) out.push('the notes do not give the pairing code 123456 on its own');
  // The built-in demo answers only at http://demo.dobius:8420 (mobile/host.js DEMO_ORIGIN), and the phone keeps any
  // scheme or port it is given. So every mention must be bare `demo.dobius`, `demo.dobius:8420`, or exactly
  // `http://demo.dobius:8420`: https, http without the port, another port or a longer host reaches no Mac.
  if (!demoAddressesOk(notes)) out.push('the notes give the demo address in a form the demo does not answer (use demo.dobius or http://demo.dobius:8420)');
  // A version that says reviewers need a sign-in must carry one, or Apple refuses the submission.
  if (attrs.demoAccountRequired === true) {
    for (const k of ['demoAccountName', 'demoAccountPassword']) if (typeof attrs[k] !== 'string' || !attrs[k].trim()) out.push(`no ${k}`);
  }
  return out;
}

/** The review details to copy onto a version from a complete set (the live version's), minus Apple's own fields. */
export function reviewDetailCopy(attrs) {
  if (reviewDetailProblems(attrs).length) return null;
  const keys = [...CONTACT_FIELDS, 'demoAccountName', 'demoAccountPassword', 'demoAccountRequired', 'notes'];
  const out = {};
  for (const k of keys) if (attrs[k] !== undefined && attrs[k] !== null) out[k] = attrs[k];
  return out;
}
