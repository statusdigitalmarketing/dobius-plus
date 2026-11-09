// The iOS release script's decisions (scripts/lib/ios-release-plan.mjs) and its App Store Connect token.
// Run: npm run test:iosrelease
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions, compareBuildStrings, buildOfTag, parseTagMessage, tagMessage, nextBuildNumber, planVersion, liveVersion, lastBuildTag, buildTagNumbers, parseBuildTag, buildTagName, buildKey,
  whatsNewText, reviewDetailCopy, reviewDetailProblems, depsChanged, manifestChanged, APP_PATHS,
} from '../../scripts/lib/ios-release-plan.mjs';
import { ascJwt, createAscClient } from '../../scripts/lib/asc-client.mjs';

const ver = (versionString, appVersionState, id = versionString) => ({ type: 'appStoreVersions', id, attributes: { platform: 'IOS', versionString, appVersionState } });

test('versions compare numerically, not as text', () => {
  assert.equal(compareVersions('2.2.12', '2.2.1'), 1);
  assert.equal(compareVersions('2.2.1', '2.2.12'), -1);
  assert.equal(compareVersions('2.2', '2.2.0'), 0);
  assert.equal(compareVersions('10.0', '9.9.9'), 1);
});

test('a build number is one past everything App Store Connect and the project have', () => {
  assert.equal(nextBuildNumber(['6', '5', '3', '1'], 6), 7);
  assert.equal(nextBuildNumber(['6'], 9), 10, 'the project can be ahead');
  assert.equal(nextBuildNumber([], undefined), 1);
  assert.equal(nextBuildNumber(['abc', null, '12'], '4'), 13);
  assert.equal(nextBuildNumber(['6'], 6, [9]), 10, 'an upload Apple has not listed yet still used its number');
});

test('a new version when only the live one exists', () => {
  const p = planVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('1.0', 'READY_FOR_DISTRIBUTION')], '2.2.12');
  assert.equal(p.action, 'create');
  assert.equal(p.live.attributes.versionString, '2.2.1', 'the highest live version');
});

test('never a version at or below one that ever shipped', () => {
  assert.equal(planVersion([ver('2.2.12', 'READY_FOR_DISTRIBUTION')], '2.2.12').action, 'stop');
  assert.equal(planVersion([ver('2.3.0', 'READY_FOR_DISTRIBUTION')], '2.2.12').action, 'stop');
  // A version that shipped and was since pulled or replaced still sets the floor (Apple refuses a lower string).
  for (const s of ['REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE']) {
    assert.equal(planVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('2.2.20', s)], '2.2.12').action, 'stop', s);
  }
  assert.equal(planVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('2.2.20', 'PREPARE_FOR_SUBMISSION')], '2.2.12').action, 'reuse',
    'an editable version is renamed, so its string is no floor');
});

test('a version Apple is handling is left alone', () => {
  for (const s of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACCEPTED', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION', 'WAITING_FOR_EXPORT_COMPLIANCE']) {
    const p = planVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('2.2.11', s)], '2.2.12');
    assert.equal(p.action, 'wait', s);
    assert.equal(p.version.attributes.versionString, '2.2.11');
  }
});

test('an approved version waiting on a manual release is never released from here: the build waits', () => {
  const p = planVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('2.2.11', 'PENDING_DEVELOPER_RELEASE')], '2.2.12');
  assert.equal(p.action, 'wait');
  assert.match(p.reason, /manual release/);
});

test('a version waiting on the agreements stops and says so', () => {
  const p = planVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('2.2.11', 'PENDING_CONTRACT')], '2.2.12');
  assert.equal(p.action, 'stop');
  assert.match(p.reason, /agreements/);
});

test('the live version is the highest one on the App Store', () => {
  assert.equal(liveVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('2.2.10', 'READY_FOR_DISTRIBUTION', 'b'), ver('3.0', 'IN_REVIEW')]).id, 'b');
  assert.equal(liveVersion([ver('3.0', 'IN_REVIEW')]), null);
});

test('an editable version is reused; two editable versions stop', () => {
  for (const s of ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'READY_FOR_REVIEW']) {
    const p = planVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('2.2.11', s)], '2.2.12');
    assert.equal(p.action, 'reuse', s);
  }
  assert.equal(planVersion([ver('2.2.10', 'PREPARE_FOR_SUBMISSION'), ver('2.2.11', 'REJECTED')], '2.2.12').action, 'stop');
});

test('a state the script does not know stops instead of guessing', () => {
  for (const s of ['SOMETHING_NEW', 'NOT_APPLICABLE']) {
    const p = planVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('2.2.11', s)], '2.2.12');
    assert.equal(p.action, 'stop', s);
    assert.match(p.reason, new RegExp(s));
  }
});

test('replaced and removed versions do not block', () => {
  const p = planVersion([ver('2.2.1', 'READY_FOR_DISTRIBUTION'), ver('2.2.0', 'REPLACED_WITH_NEW_VERSION')], '2.2.12');
  assert.equal(p.action, 'create');
});

test('a build tag names the marketing version and the build, and the last one is the highest build', () => {
  assert.equal(buildTagName('2.2.12', 7), 'ios-2.2.12-7');
  assert.deepEqual(parseBuildTag('ios-2.2.12-7'), { tag: 'ios-2.2.12-7', marketing: '2.2.12', n: 7 });
  for (const bad of ['ios-build-7', 'v2.2.12', 'ios-2.2.12-7.1', 'ios-2.2.12-', 'ios--7', '']) assert.equal(parseBuildTag(bad), null, bad);
  assert.equal(lastBuildTag(['ios-2.2.10-7', 'ios-2.2.12-12', 'ios-2.2.11-9', 'v2.2.12']), 'ios-2.2.12-12');
  assert.equal(lastBuildTag(['v1', 'ios-build-x']), null);
  assert.deepEqual(buildTagNumbers(['ios-2.2.12-7', 'v2.2.12', 'ios-2.2.13-12', 'ios-2.2.13-1a', '']), [7, 12]);
});

test('a build is ours only when both numbers match exactly', () => {
  // Apple lets build 7 repeat under another marketing version, and allows "7.1": neither is the tagged binary.
  assert.notEqual(buildKey('2.2.13', '7'), buildKey('2.2.12', '7'));
  assert.notEqual(buildKey('2.2.12', '7.1'), buildKey('2.2.12', '7'));
  assert.equal(buildKey('2.2.12', '7'), buildKey('2.2.12', String(parseBuildTag('ios-2.2.12-7').n)));
});

test('dependency changes count, the release version bump does not', () => {
  const lock = (ver, react) => JSON.stringify({ name: 'dobius-plus', version: ver, packages: { '': { name: 'dobius-plus', version: ver }, 'node_modules/react': { version: react } } });
  assert.equal(depsChanged(lock('2.2.11', '19.0.0'), lock('2.2.12', '19.0.0')), false);
  assert.equal(depsChanged(lock('2.2.11', '19.0.0'), lock('2.2.12', '19.1.0')), true);
  assert.equal(depsChanged('not json', lock('2.2.12', '19.0.0')), true, 'unreadable counts as changed');
});

test('package.json counts when anything but its version changed, in any key order', () => {
  const pkg = (o) => JSON.stringify(o);
  assert.equal(manifestChanged(pkg({ version: '2.2.11', scripts: { a: '1', b: '2' } }), pkg({ scripts: { b: '2', a: '1' }, version: '2.2.12' })), false);
  assert.equal(manifestChanged(pkg({ version: '2.2.11', scripts: { a: '1' } }), pkg({ version: '2.2.12', scripts: { a: '2' } })), true);
  assert.equal(manifestChanged('', pkg({ version: '1' })), true, 'missing at the tag counts as changed');
});

test('the phone bundle imports nothing outside mobile/ and shared/ (so the change paths cover it)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const outside = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(jsx?|mjs|css)$/.test(e.name)) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = path.relative(root, path.resolve(path.dirname(p), m[1])).split(path.sep)[0];
        if (!APP_PATHS.includes(target)) outside.add(target);
      }
    }
  };
  walk(path.join(root, 'mobile'));
  assert.deepEqual([...outside], []);
});

test('What\'s New: the given notes, else a plain line, never over Apple\'s limit', () => {
  assert.equal(whatsNewText('  Phone tasks  '), 'Phone tasks');
  assert.equal(whatsNewText(''), 'Improvements and fixes across the app.');
  assert.equal(whatsNewText('x'.repeat(5000)).length, 4000);
});

test('review details are checked field by field and copied only from a complete set', () => {
  const full = { contactFirstName: 'S', contactLastName: 'N', contactPhone: '1', contactEmail: 'a@b.c', notes: 'Pair with demo.dobius, code 123456', demoAccountRequired: false, id: 'x' };
  assert.deepEqual(reviewDetailProblems(full), []);
  const c = reviewDetailCopy(full);
  assert.deepEqual(Object.keys(c).sort(), ['contactEmail', 'contactFirstName', 'contactLastName', 'contactPhone', 'demoAccountRequired', 'notes']);
  assert.deepEqual(reviewDetailProblems({ ...full, contactPhone: '  ' }), ['no contactPhone']);
  assert.deepEqual(reviewDetailProblems({ ...full, notes: 'Pair with demo.dobius' }), ['the notes do not mention 123456']);
  assert.deepEqual(reviewDetailProblems(null), ['no review details']);
  assert.equal(reviewDetailCopy({ ...full, contactEmail: '' }), null);
  // Reviewers told a sign-in is needed must get one.
  assert.deepEqual(reviewDetailProblems({ ...full, demoAccountRequired: true, demoAccountName: 'r', demoAccountPassword: '' }), ['no demoAccountPassword']);
  assert.deepEqual(reviewDetailProblems({ ...full, demoAccountRequired: true, demoAccountName: 'r', demoAccountPassword: 'p' }), []);
  assert.equal(reviewDetailCopy(null), null);
});

test('the token is a valid ES256 JWT that lives under 20 minutes', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const t = ascJwt({ keyId: 'KEY1234567', issuerId: 'iss', key: privateKey }, 1000);
  const [h, p, s] = t.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(h), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  const pl = dec(p);
  assert.equal(pl.aud, 'appstoreconnect-v1');
  assert.equal(pl.iss, 'iss');
  assert.ok(pl.exp - pl.iat <= 20 * 60);
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
});

test('the client goes only to App Store Connect and keeps the token out of errors', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const seen = [];
  const fetchImpl = async (u, init) => {
    seen.push([String(u), init.headers.Authorization]);
    return { ok: false, status: 409, text: async () => JSON.stringify({ errors: [{ title: 'Conflict', detail: 'nope' }] }) };
  };
  const c = createAscClient({ keyId: 'K', issuerId: 'I', key: privateKey, fetchImpl });
  await assert.rejects(c.get('https://evil.example/v1/apps'), /outside App Store Connect/);
  const err = await c.get('/v1/apps').catch((e) => e);
  assert.match(err.message, /409: Conflict: nope/);
  assert.equal(err.message.includes(seen[0][1].slice(7)), false, 'no token in the message');
  assert.equal(seen.length, 1, 'the off-site request was never sent');
});

test('the client refuses redirects, a non-JSON success, and a list cut short', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const inits = [];
  const answers = [];
  const fetchImpl = async (u, init) => { inits.push(init); return answers.shift(); };
  const c = createAscClient({ keyId: 'K', issuerId: 'I', key: privateKey, fetchImpl });
  answers.push({ ok: true, status: 200, text: async () => '<html>proxy</html>' });
  await assert.rejects(c.get('/v1/apps'), /not JSON/);
  assert.equal(inits[0].redirect, 'error');
  assert.equal(inits[0].signal instanceof AbortSignal, true);
  answers.push({ ok: true, status: 200, text: async () => '{}' });
  await assert.rejects(c.get('/v1/apps'), /no data/);
  const page = (n) => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: String(n) }], links: { next: `https://api.appstoreconnect.apple.com/v1/apps?cursor=${n}` } }) });
  answers.push(page(1), page(2));
  await assert.rejects(c.all('/v1/apps', 2), /more than 2 pages/);
  answers.push({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'a' }], links: { next: 'https://evil.example/v1/apps' } }) });
  await assert.rejects(c.all('/v1/apps'), /outside App Store Connect/);
  answers.push({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }) });
  assert.deepEqual((await c.all('/v1/apps')).map((x) => x.id), ['a', 'b']);
  // Every page's included objects come back with the list (a build's marketing version lives there).
  answers.push(
    { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: '1' }], included: [{ id: 'p1' }], links: { next: 'https://api.appstoreconnect.apple.com/v1/builds?cursor=2' } }) },
    { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: '2' }], included: [{ id: 'p2' }] }) },
  );
  const pg = await c.pages('/v1/builds');
  assert.deepEqual([pg.data.map((x) => x.id), pg.included.map((x) => x.id)], [['1', '2'], ['p1', 'p2']]);
});

test('build strings compare the way Apple orders them, and a dotted build still gets a higher next number', () => {
  assert.equal(compareBuildStrings('7', '6'), 1);
  assert.equal(compareBuildStrings('7', '100.1'), -1, 'a live dotted hotfix keeps an older whole number out');
  assert.equal(compareBuildStrings('101', '100.1'), 1);
  assert.equal(compareBuildStrings('7', '7.0'), 0);
  assert.equal(compareBuildStrings('7.0.1', '7'), 1);
  assert.equal(compareBuildStrings('10', '9'), 1, 'numeric, not text');
  assert.equal(compareBuildStrings('7', 'abc'), null);
  assert.equal(compareBuildStrings('7', '1.2.3.4'), null, 'Apple allows three parts at most');
  assert.equal(compareBuildStrings(null, '7'), null);
  assert.equal(nextBuildNumber(['100.1', '6'], 6), 101, 'counted by its first part');
});

test('a tag vouches only for the build Apple dates inside its own upload window', () => {
  const t = { marketing: '2.2.12', n: 7, after: Date.parse('2026-11-09T03:00:00Z'), before: Date.parse('2026-11-09T03:02:00Z'), buildId: null };
  const b = (id, raw, marketing, uploaded) => ({ id, raw, marketing, uploaded });
  const before = b('old', '7', '2.2.12', '2026-11-09T02:00:00Z');
  const ours = b('ours', '7', '2.2.12', '2026-11-09T03:05:00Z');
  const later = b('later', '7', '2.2.12', '2026-11-09T05:00:00Z');
  assert.equal(buildOfTag(t, [later, before, ours])?.id, 'ours', 'not the one before, not a later reuse');
  assert.equal(buildOfTag(t, [before]), null, 'a build uploaded before ours is never vouched for');
  assert.equal(buildOfTag(t, [later]), null, 'a later upload reusing the pair (ours failed before Apple listed it) is never vouched for');
  assert.equal(buildOfTag(t, [b('x', '7', '2.2.13', '2026-11-09T03:05:00Z')]), null, 'the marketing version must match');
  assert.equal(buildOfTag(t, [b('x', '7.0', '2.2.12', '2026-11-09T03:05:00Z')]), null, 'the build string must match exactly');
  assert.equal(buildOfTag({ ...t, after: Number.NaN }, [ours]), null, 'a tag without its start vouches for nothing');
  assert.equal(buildOfTag({ ...t, before: Number.NaN }, [ours]), null, 'a tag without its end vouches for nothing');
  assert.equal(buildOfTag(t, [b('skew', '7', '2.2.12', '2026-11-09T02:59:00Z')])?.id, 'skew', 'a minute of clock skew is allowed');
  const bound = { ...t, buildId: 'ours' };
  assert.equal(buildOfTag(bound, [b('other', '7', '2.2.12', '2026-11-09T03:01:00Z'), ours])?.id, 'ours', 'a bound tag names its build');
  assert.equal(buildOfTag(bound, [b('other', '7', '2.2.12', '2026-11-09T03:01:00Z')]), null, 'and nothing else, even in the window');
});

test('tag messages round-trip', () => {
  const after = Date.parse('2026-11-09T03:00:00Z');
  const before = Date.parse('2026-11-09T03:02:00Z');
  assert.deepEqual(parseTagMessage(tagMessage('2.2.12', 7, after, before, null)), { after, before, buildId: null });
  assert.deepEqual(parseTagMessage(tagMessage('2.2.12', 7, after, before, 'a1b2-c3')), { after, before, buildId: 'a1b2-c3' });
  const none = parseTagMessage('iOS 2.2.12 (7)');
  assert.equal(Number.isNaN(none.after) && Number.isNaN(none.before) && none.buildId === null, true);
});

test('review notes that give the demo with https are refused', () => {
  const ok = { contactFirstName: 'A', contactLastName: 'B', contactPhone: '1', contactEmail: 'a@b.c', notes: 'Mac address demo.dobius, code 123456' };
  assert.deepEqual(reviewDetailProblems(ok), []);
  assert.equal(reviewDetailProblems({ ...ok, notes: 'Mac address https://demo.dobius, code 123456' }).length, 1);
  assert.equal(reviewDetailProblems({ ...ok, notes: 'Mac address http://demo.dobius, code 123456' }).length, 1, 'http without the port');
  assert.equal(reviewDetailProblems({ ...ok, notes: 'Mac address http://demo.dobius:84201, code 123456' }).length, 1, 'a longer port');
  assert.deepEqual(reviewDetailProblems({ ...ok, notes: 'Mac address http://demo.dobius:8420, code 123456' }), [], 'the exact address');
});
