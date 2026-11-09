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
  // The floor: every version that ever shipped (live, replaced, pulled). Apple refuses a version string at or below it.
  const shipped = highest(list.filter((v) => LIVE_STATES.has(stateOf(v)) || PAST_STATES.has(stateOf(v))));
  if (shipped && compareVersions(marketingVersion, vs(shipped)) <= 0) {
    return { action: 'stop', live, reason: `version ${marketingVersion} is not higher than ${vs(shipped)}, which already shipped` };
  }
  const editable = others.filter((v) => EDITABLE_STATES.has(stateOf(v)));
  if (editable.length > 1) return { action: 'stop', live, reason: `more than one editable version (${editable.map(vs).join(', ')})` };
  if (editable.length === 1) return { action: 'reuse', live, version: editable[0], reason: `reusing ${vs(editable[0])} (${stateOf(editable[0])})` };
  return { action: 'create', live, reason: `new version ${marketingVersion}` };
}

// The paths whose changes reach the app binary. mobile/ imports from shared/ only (checked by the tests). The
// dependency files count separately (depsChanged): every release bumps their version line, which changes nothing.
export const APP_PATHS = ['mobile', 'shared', 'ios', 'capacitor.config.json', 'vite.mobile.config.js'];

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
export const REVIEW_NOTE_MARKERS = ['demo.dobius', '123456'];

/** Every reason these review details would leave App Review stuck; an empty list means they are complete. */
export function reviewDetailProblems(attrs) {
  if (!attrs || typeof attrs !== 'object') return ['no review details'];
  const out = [];
  for (const k of CONTACT_FIELDS) if (typeof attrs[k] !== 'string' || !attrs[k].trim()) out.push(`no ${k}`);
  const notes = typeof attrs.notes === 'string' ? attrs.notes : '';
  for (const m of REVIEW_NOTE_MARKERS) if (!notes.includes(m)) out.push(`the notes do not mention ${m}`);
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
