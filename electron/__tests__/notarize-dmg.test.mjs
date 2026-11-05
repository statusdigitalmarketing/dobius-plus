// scripts/notarize-dmg.sh against a fake xcrun, replaying what stopped the 2.2.2 release.
// Run: node --test ./electron/__tests__/notarize-dmg.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/notarize-dmg.sh', import.meta.url));

// The fake reads a plan: how each numbered submission behaves, as a list of statuses, the last repeating.
function run(plan, { failUploads = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notarize-'));
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
  fs.writeFileSync(path.join(dir, 'uploads'), '0');
  fs.writeFileSync(path.join(dir, 'xcrun'), `#!/usr/bin/env node
const fs = require('fs'); const d = ${JSON.stringify(dir)};
const a = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(d + '/plan.json'));
if (a[1] === 'submit') {
  const n = Number(fs.readFileSync(d + '/uploads')) + 1; fs.writeFileSync(d + '/uploads', String(n));
  if (n <= ${failUploads}) process.exit(1);
  console.log(JSON.stringify({ id: 'sub-' + (n - ${failUploads}) })); process.exit(0);
}
if (a[1] === 'info') {
  const id = a[2]; const f = d + '/' + id; const k = fs.existsSync(f) ? Number(fs.readFileSync(f)) : 0; fs.writeFileSync(f, String(k + 1));
  const list = plan[id] || ['In Progress'];
  const s = list[Math.min(k, list.length - 1)];
  if (s === 'DROP') process.exit(1);
  console.log(JSON.stringify({ status: s })); process.exit(0);
}
if (a[1] === 'log') { console.log('the log'); process.exit(0); }
process.exit(2);
`, { mode: 0o755 });
  const r = spawnSync('bash', [SCRIPT, 'x.dmg'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, APPLE_ID: 'a', APPLE_TEAM_ID: 'b', APPLE_APP_SPECIFIC_PASSWORD: 'SECRET-NOT-PRINTED', NOTARIZE_POLL_SECONDS: '0', NOTARIZE_RETRY_SECONDS: '0', NOTARIZE_RESUBMIT_AFTER_POLLS: '3', NOTARIZE_MAX_POLLS: '9' } });
  const uploads = Number(fs.readFileSync(path.join(dir, 'uploads')));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(`${r.stdout}${r.stderr}`.includes('SECRET-NOT-PRINTED'), false, 'the password is never printed');
  return { code: r.status, out: r.stdout, err: r.stderr, uploads };
}

test('accepted straight away', () => {
  const r = run({ 'sub-1': ['Accepted'] });
  assert.equal(r.code, 0);
  assert.equal(r.uploads, 1);
});

test('a dropped connection while waiting does not stop it', () => {
  const r = run({ 'sub-1': ['DROP', 'DROP', 'Accepted'] });
  assert.equal(r.code, 0);
  assert.equal(r.uploads, 1);
  assert.match(r.out, /no answer/);
});

test('stuck at Apple: a fresh copy goes in and whichever clears first wins (the 2.2.2 release)', () => {
  const r = run({ 'sub-1': ['In Progress'], 'sub-2': ['In Progress', 'Accepted'] });
  assert.equal(r.code, 0);
  assert.equal(r.uploads, 2);
  assert.match(r.out, /Accepted: sub-2/);
});

test('a failed upload is retried', () => {
  const r = run({ 'sub-1': ['Accepted'] }, { failUploads: 2 });
  assert.equal(r.code, 0);
  assert.equal(r.uploads, 3);
});

test('three failed uploads stop it, so nothing gets published', () => {
  const r = run({}, { failUploads: 3 });
  assert.equal(r.code, 1);
  assert.match(r.err, /could not upload/);
});

test('refused by Apple stops it and shows the log', () => {
  const r = run({ 'sub-1': ['In Progress', 'Invalid'] });
  assert.equal(r.code, 1);
  assert.match(r.err, /the log/);
  assert.match(r.err, /refused/);
});

test('still processing at the limit stops with that exact reason', () => {
  const r = run({});
  assert.equal(r.code, 1);
  assert.match(r.err, /still processing/);
  assert.equal(r.uploads, 4, 'one to start, one every third check');
});
