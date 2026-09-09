// The Updates tab's "latest release" lookup (v1.0.68). It used to fetch
// api.github.com from the RENDERER, which index.html's CSP
// (connect-src 'self' ...) blocks, so it failed with "Failed to fetch" every
// time and the panel showed "Couldn't reach GitHub" while the updater itself
// was downloading releases fine from the main process.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/updater-release.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { mapRelease } from '../release-info.js';

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

check('the fields the panel renders survive the mapping', () => {
  const r = mapRelease({
    tag_name: 'v1.0.67',
    name: '1.0.67',
    html_url: 'https://github.com/statusdigitalmarketing/dobius-plus/releases/tag/v1.0.67',
    body: 'notes',
    published_at: '2026-09-09T17:25:55Z',
    extra: 'dropped',
  });
  assert.equal(r.tag_name, 'v1.0.67');
  assert.equal(r.name, '1.0.67');
  assert.ok(r.html_url.endsWith('/v1.0.67'));
  assert.equal(r.body, 'notes');
  assert.equal(r.published_at, '2026-09-09T17:25:55Z');
  assert.equal(r.extra, undefined, 'unused fields are not forwarded');
});

check('a missing body becomes an empty string, never undefined', () => {
  assert.equal(mapRelease({ tag_name: 'v1' }).body, '');
});

check('release notes are capped so the panel cannot be handed a novel', () => {
  const r = mapRelease({ tag_name: 'v1', body: 'x'.repeat(50000) });
  assert.equal(r.body.length, 20000);
});

check('non-string fields are nulled rather than passed through', () => {
  const r = mapRelease({ tag_name: 123, name: {}, html_url: [], body: 7 });
  assert.equal(r.tag_name, null);
  assert.equal(r.name, null);
  assert.equal(r.html_url, null);
  assert.equal(r.body, '');
});

check('a null payload does not throw', () => {
  const r = mapRelease(null);
  assert.equal(r.tag_name, null);
  assert.equal(r.body, '');
});

// The regression itself: no renderer-side GitHub fetch may come back.
check('the renderer no longer fetches GitHub directly', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/components/Dashboard/Updates.jsx'), 'utf8');
  // Match a real call, not the word: the comment explaining this legitimately
  // names api.github.com.
  assert.equal(/fetch\(\s*[`'"]https:/.test(src), false,
    'CSP blocks connect-src to a remote host from the renderer');
  assert.ok(src.includes('updaterGetLatestRelease'), 'it must ask the main process instead');
});

check('the CSP that caused this is still restrictive, so the fix stays necessary', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
  const csp = /connect-src([^"]*)"/.exec(html)?.[1] || '';
  assert.ok(!csp.includes('api.github.com'),
    'if GitHub is ever added to connect-src, revisit this test and the comment in auto-updater.js');
});

console.log(`\nALL PASS  (${pass} passed)`);
