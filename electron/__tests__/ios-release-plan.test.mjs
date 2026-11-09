// The iOS release script's decisions (scripts/lib/ios-release-plan.mjs) and its App Store Connect token.
// Run: npm run test:iosrelease
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions, nextBuildNumber, planVersion, liveVersion, lastBuildTag, buildTagNumbers, whatsNewText, reviewDetailCopy,
  reviewDetailProblems, depsChanged, manifestChanged, APP_PATHS,
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

test('the last build tag is the highest number, not the last listed', () => {
  assert.equal(lastBuildTag(['ios-build-7', 'ios-build-12', 'ios-build-9', 'v2.2.12']), 'ios-build-12');
  assert.equal(lastBuildTag(['v1', 'ios-build-x']), null);
  assert.deepEqual(buildTagNumbers(['ios-build-7', 'v2.2.12', 'ios-build-12', 'ios-build-1a', '']), [7, 12]);
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
});
