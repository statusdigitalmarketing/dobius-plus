// The in-process main-process profiler (electron/perf-profile.js, bridge /perfProfile).
// Run: npm run -s test:perfprofile
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { summarizeProfile, profileMain, clampSeconds, MIN_SECONDS, MAX_SECONDS } from '../perf-profile.js';

const node = (id, functionName, url, lineNumber, children = []) => ({ id, callFrame: { functionName, url, lineNumber }, children });

test('summary: busy share, self time, and app-only inclusive time', () => {
  const profile = {
    nodes: [
      node(1, '(root)', '', -1, [2, 5]),
      node(2, 'pollStatusTick', 'file:///Applications/Dobius+.app/Contents/Resources/app.asar/electron/mobile-server.js', 517, [3]),
      node(3, 'stripAnsi', 'file:///x/app.asar/electron/selector-parser.js', 33, [4]),
      node(4, 'slice', 'node:buffer', 10),
      node(5, '(idle)', '', -1),
    ],
    samples: [5, 5, 5, 5, 5, 5, 3, 3, 4, 2],
  };
  const s = summarizeProfile(profile);
  assert.equal(s.samples, 10);
  assert.equal(s.busyPct, 40);
  assert.deepEqual(s.topSelf[0], { pct: 20, fn: 'stripAnsi electron/selector-parser.js:34' });
  assert.equal(s.topSelf.length, 3);
  // Inclusive: pollStatusTick holds all 4 busy samples (its own and the 3 under stripAnsi), stripAnsi holds 3.
  assert.deepEqual(s.topApp, [
    { pct: 40, fn: 'pollStatusTick electron/mobile-server.js:518' },
    { pct: 30, fn: 'stripAnsi electron/selector-parser.js:34' },
  ]);
  // No home folder or app path leaks into the summary: only the last two path segments.
  assert.ok(!JSON.stringify(s).includes('Applications'));
});

test('summary of an empty or malformed profile', () => {
  assert.deepEqual(summarizeProfile(null), { samples: 0, busyPct: 0, topSelf: [], topApp: [] });
  assert.deepEqual(summarizeProfile({ nodes: 'x', samples: {} }), { samples: 0, busyPct: 0, topSelf: [], topApp: [] });
});

test('a real profile of this process: written, summarized, one at a time, only our old files pruned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-perf-'));
  try {
    // Ours from a clock that ran ahead (2031), ours from before, and files that only look like ours.
    const ours = ['main-2031-01-01T00-00-00-000Z.cpuprofile', 'main-2031-01-02T00-00-00-000Z.cpuprofile', 'main-2020-01-01T00-00-00-000Z.cpuprofile'];
    const theirs = ['main-2020-baseline.cpuprofile', 'other.txt'];
    for (const n of [...ours, ...theirs]) fs.writeFileSync(path.join(dir, n), '{}');
    let t = 0;
    const spin = setInterval(() => { const end = Date.now() + 5; while (Date.now() < end) t += Math.sqrt(t + 1); }, 10);
    const first = profileMain(0, dir, { now: () => new Date('2030-01-01T00:00:00Z') }); // 0 means the minimum
    const second = await profileMain(5, dir);
    assert.deepEqual(second, { ok: false, error: 'a profile is already running' });
    const r = await first;
    clearInterval(spin);
    assert.equal(r.ok, true);
    assert.equal(r.seconds, MIN_SECONDS);
    assert.ok(r.samples > 100, `samples ${r.samples}`);
    assert.ok(r.busyPct > 5, `busy ${r.busyPct}`);
    // The file NAME only: the folder holds the user's home path.
    assert.equal(r.file, 'main-2030-01-01T00-00-00-000Z.cpuprofile');
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, r.file), 'utf8')).nodes.length > 0);
    // The new profile and the two newest others are kept even though the clock made the new one sort "older";
    // files that only resemble ours are never touched.
    assert.deepEqual(fs.readdirSync(dir).sort(), [
      'main-2020-baseline.cpuprofile', 'main-2030-01-01T00-00-00-000Z.cpuprofile',
      'main-2031-01-01T00-00-00-000Z.cpuprofile', 'main-2031-01-02T00-00-00-000Z.cpuprofile', 'other.txt',
    ]);
    // A symlink already at the next name is never followed: no file, and its target is untouched.
    const target = path.join(dir, 'other.txt');
    fs.symlinkSync(target, path.join(dir, 'main-2032-01-01T00-00-00-000Z.cpuprofile'));
    const s2 = await profileMain(2, dir, { now: () => new Date('2032-01-01T00:00:00Z') });
    assert.equal(s2.ok, true);
    assert.equal(s2.file, null);
    assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seconds: only a real number counts, clamped to 2..60', () => {
  const hostile = { toString: null, valueOf: null };
  assert.throws(() => Number(hostile), TypeError); // what the old code did with it, outside any handler
  assert.equal(clampSeconds(hostile), 10);
  assert.equal(clampSeconds(Object.create(null)), 10);
  assert.equal(clampSeconds('30'), 10);
  assert.equal(clampSeconds(undefined), 10);
  assert.equal(clampSeconds(NaN), 10);
  assert.equal(clampSeconds(Infinity), 10);
  assert.equal(clampSeconds(0), MIN_SECONDS);
  assert.equal(clampSeconds(-5), MIN_SECONDS);
  assert.equal(clampSeconds(20.4), 20);
  assert.equal(clampSeconds(1e9), MAX_SECONDS);
});

// Codex, PR 6: a disk that fills during the write left a partial profile behind and skipped pruning, so every later
// attempt added another file. Old profiles now go first and a failed write removes its own partial file.
test('a write that fails part way: our partial file is removed and old profiles were already pruned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-perf-full-'));
  const old = ['2020', '2021', '2022', '2023'].map((y) => `main-${y}-01-01T00-00-00-000Z.cpuprofile`);
  for (const n of old) fs.writeFileSync(path.join(dir, n), '{}');
  const real = fs.promises.writeFile;
  fs.promises.writeFile = async (file, _data, opts) => {
    await real(file, 'partial', opts); // created, then the disk fills
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  try {
    const r = await profileMain(2, dir, { now: () => new Date('2031-01-01T00:00:00Z') });
    assert.equal(r.ok, true, 'the summary is still returned');
    assert.equal(r.file, null, 'no file is reported saved');
    await new Promise((res) => setTimeout(res, 50)); // the unlink is not awaited
    assert.deepEqual(fs.readdirSync(dir).sort(), old.slice(-2), 'the partial file is gone and only the two newest old ones remain');
  } finally {
    fs.promises.writeFile = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a name already taken (EEXIST) is never removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-perf-taken-'));
  const taken = 'main-2031-01-01T00-00-00-000Z.cpuprofile';
  fs.writeFileSync(path.join(dir, taken), 'someone else');
  try {
    const r = await profileMain(2, dir, { now: () => new Date('2031-01-01T00:00:00Z') });
    assert.equal(r.file, null);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(fs.readFileSync(path.join(dir, taken), 'utf8'), 'someone else');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Codex, PR 6 round 3: a folder that can be written but not listed (mode 0300) skipped pruning and saved anyway, one
// more profile per request. Pruning that cannot keep the limit now skips the save, and never removes the name it chose.
test('a folder that cannot be listed: nothing is saved and nothing there is removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-perf-nolist-'));
  const taken = 'main-2031-01-01T00-00-00-000Z.cpuprofile';
  fs.writeFileSync(path.join(dir, taken), 'someone else');
  fs.chmodSync(dir, 0o300);
  try {
    assert.throws(() => fs.readdirSync(dir), /EACCES/, 'the folder really cannot be listed');
    const r = await profileMain(2, dir, { now: () => new Date('2032-01-01T00:00:00Z') }); // a free name: only the prune stops it
    assert.equal(r.ok, true);
    assert.equal(r.file, null, 'not saved: the limit could not be kept');
    // Same, when the name it picks is already someone's: the failed prune must not remove that file.
    const r2 = await profileMain(2, dir, { now: () => new Date('2031-01-01T00:00:00Z') });
    assert.equal(r2.file, null);
    await new Promise((res) => setTimeout(res, 50));
    fs.chmodSync(dir, 0o700);
    assert.deepEqual(fs.readdirSync(dir), [taken], 'no new profile');
    assert.equal(fs.readFileSync(path.join(dir, taken), 'utf8'), 'someone else');
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
