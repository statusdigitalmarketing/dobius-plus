// loadAllSessions keeps what a transcript's tail told it, per file, while size
// and mtime hold; the Tabs sidebars share one load. Each sidebar polls every 5s,
// and re-parsing 10,000 tails cost 9s of CPU a call. Reads are counted through
// fs/promises, the object data-utils' readTail opens files with. HOME points at
// a throwaway dir before importing.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/session-cache.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-cache-home-'));
process.env.HOME = home;
process.env.DOBIUS_TEST_USERDATA = path.join(home, 'userdata');
fs.mkdirSync(process.env.DOBIUS_TEST_USERDATA);
const { loadAllSessions, getAllProjectTabs, transcriptCache, TRANSCRIPT_CACHE_MAX } = await import('../data-service.js');
const { updateSettings } = await import('../config-manager.js');

let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };

const projects = path.join(home, '.claude', 'projects');
const dirA = path.join(projects, '-tmp-cachea');
const dirB = path.join(projects, '-tmp-cacheb');
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });

// Every read and stat of a transcript.
let opens = 0;
let stats = 0;
const realOpen = fsp.open;
const realStat = fsp.stat;
fsp.open = (p, ...r) => { if (String(p).endsWith('.jsonl')) opens += 1; return realOpen.call(fsp, p, ...r); };
fsp.stat = (p, ...r) => { if (String(p).endsWith('.jsonl')) stats += 1; return realStat.call(fsp, p, ...r); };
const counting = async (fn) => { const before = opens; const out = await fn(); return { out, reads: opens - before }; };

const realNow = Date.now;
const at = (ms) => { Date.now = () => ms; };
const NOW = realNow();

const rec = (role, text, t, extra = {}) => JSON.stringify({
  type: role, entrypoint: 'cli', timestamp: new Date(t).toISOString(),
  message: { role, content: role === 'user' ? text : [{ type: 'text', text }] }, ...extra,
});
const write = (dir, id, lines) => fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
const byId = (list) => Object.fromEntries(list.map((s) => [s.sessionId, s]));

write(dirA, 'chat', [rec('user', 'first ask', NOW - 30_000), rec('assistant', 'reply', NOW - 20_000)]);
write(dirA, 'asked', [rec('user', 'waiting on an answer', NOW - 500_000)]);
write(dirB, 'scripted', [
  JSON.stringify({ type: 'user', entrypoint: 'sdk-py', timestamp: new Date(NOW - 40_000).toISOString(), message: { role: 'user', content: 'scripted run' } }),
]);

// A hit does not read the file, and returns what a read did.
{
  const first = await counting(() => loadAllSessions());
  assert.equal(first.reads, 3);
  assert.equal(first.out.length, 3);
  const second = await counting(() => loadAllSessions());
  assert.equal(second.reads, 0, 'nothing changed: no file is opened');
  assert.deepEqual(second.out, first.out);
  assert.notEqual(second.out[0], first.out[0], 'each call gets its own rows');
  ok('a hit does not re-read');
}

// A change to either key re-reads that file alone.
{
  const f = path.join(dirA, 'chat.jsonl');
  fs.appendFileSync(f, `${rec('user', 'second ask', NOW - 10_000)}\n`);
  const grown = await counting(() => loadAllSessions());
  assert.equal(grown.reads, 1, 'size changed');
  assert.equal(byId(grown.out).chat.preview, 'second ask');
  assert.equal(byId(grown.out).chat.status, 'needs');
  const later = new Date(NOW + 5000);
  fs.utimesSync(f, later, later);
  assert.equal((await counting(() => loadAllSessions())).reads, 1, 'mtime changed, same size');
  assert.equal((await counting(() => loadAllSessions())).reads, 0);
  const sameMtime = fs.statSync(f);
  fs.appendFileSync(f, `${rec('assistant', 'answered', NOW - 5000)}\n`);
  fs.utimesSync(f, sameMtime.atime, sameMtime.mtime);
  assert.equal(fs.statSync(f).mtimeMs, sameMtime.mtimeMs);
  assert.equal((await counting(() => loadAllSessions())).reads, 1, 'size changed, same mtime');
  const touched = new Date(NOW + 6000);
  fs.utimesSync(f, touched, touched);
  await loadAllSessions();
  ok('a size or mtime change re-reads');
}

// The clock is never cached: the same hit ages from working to done.
{
  at(NOW);
  const fresh = await counting(() => loadAllSessions());
  assert.equal(fresh.reads, 0);
  assert.equal(byId(fresh.out).chat.status, 'working');
  const ageNow = byId(fresh.out).chat.age;
  at(NOW + 130_000);
  const stale = await counting(() => loadAllSessions());
  assert.equal(stale.reads, 0);
  assert.equal(byId(stale.out).chat.status, 'done', 'past the 120s window on a hit');
  assert.notEqual(byId(stale.out).chat.age, ageNow, 'age too');
  assert.equal(byId(stale.out).asked.status, 'needs', 'a user-last row stays needs');
  Date.now = realNow;
  ok('status and age are recomputed on a hit');
}

// The caller's and the settings' choices apply after the cache, on a hit.
{
  const all = await counting(() => loadAllSessions());
  const real = await counting(() => loadAllSessions(undefined, { excludeAutomated: true }));
  assert.equal(all.reads + real.reads, 0);
  assert.equal(byId(all.out).scripted.automated, true);
  assert.equal(byId(real.out).scripted, undefined, 'excludeAutomated on a hit');
  const scoped = await counting(() => loadAllSessions(byId(all.out).chat.projectPath));
  assert.equal(scoped.reads, 0);
  assert.deepEqual(scoped.out.map((s) => s.sessionId).sort(), ['asked', 'chat']);
  ok('arguments apply after the cache');
}

// A read that failed is not remembered as an empty transcript.
{
  const f = path.join(dirA, 'chat.jsonl');
  fs.appendFileSync(f, `${rec('assistant', 'more', NOW - 4000)}\n`);
  const working = fsp.open;
  fsp.open = async () => { const e = new Error('too many open files'); e.code = 'EMFILE'; throw e; };
  const failed = await loadAllSessions();
  fsp.open = working;
  assert.equal(byId(failed).chat.preview, 'No preview available');
  const after = await counting(() => loadAllSessions());
  assert.equal(after.reads, 1, 'read again once it can be');
  assert.equal(byId(after.out).chat.preview, 'second ask');
  ok('a failed read is not cached');
}

// The tail reads fine, the wider read behind it fails: the message it would have
// found must not stay lost until the file changes.
{
  const f = path.join(dirA, 'buried.jsonl');
  write(dirA, 'buried', [
    rec('user', 'old ask', NOW - 3_600_000), rec('assistant', 'old reply', NOW - 3_590_000),
    ...Array.from({ length: 300 }, (_, i) => JSON.stringify({ type: 'progress', timestamp: new Date(NOW - 1000 + i).toISOString() })),
  ]);
  const working = fsp.open;
  let calls = 0;
  fsp.open = (p, ...r) => {
    if (p === f && (calls += 1) === 2) { const e = new Error('too many open files'); e.code = 'EMFILE'; throw e; }
    return working.call(fsp, p, ...r);
  };
  const failed = byId(await loadAllSessions());
  fsp.open = working;
  assert.equal(calls, 2, 'the wider read was tried');
  assert.equal(failed.buried.timestamp, NOW - 1000 + 299, 'it fell back to the bookkeeping stamp for now');
  assert.equal(transcriptCache.has(f), false);
  const retried = byId(await loadAllSessions());
  assert.equal(retried.buried.timestamp, NOW - 3_590_000, 'the next scan finds the message');
  assert.equal(transcriptCache.has(f), true);
  fs.rmSync(f);
  await loadAllSessions();
  ok('a failed wider read is not cached');
}

// Eviction: a full scan drops what it did not see; a scoped scan drops nothing.
{
  const gone = path.join(dirB, 'scripted.jsonl');
  const body = fs.readFileSync(gone);
  const st = fs.statSync(gone);
  const projectA = byId(await loadAllSessions()).chat.projectPath;
  fs.rmSync(gone);
  await loadAllSessions(projectA);
  assert.equal(transcriptCache.has(gone), true, 'a scan of one project says nothing of another');
  await loadAllSessions();
  assert.equal(transcriptCache.has(gone), false, 'a full scan evicts a deleted file');
  assert.equal(transcriptCache.size, 2);
  // Back with the same size and mtime: it really was forgotten.
  fs.writeFileSync(gone, body);
  fs.utimesSync(gone, st.atime, st.mtime);
  assert.equal((await counting(() => loadAllSessions())).reads, 1);
  ok('eviction');
}

// A hidden project is skipped by full scans, but its own window still lists it:
// a full scan must not throw those entries away and force a re-read every time.
{
  const projectB = byId(await loadAllSessions()).scripted.projectPath;
  const kept = path.join(dirB, 'scripted.jsonl');
  updateSettings({ hiddenSessionPaths: [projectB] });
  assert.equal(byId(await loadAllSessions()).scripted, undefined, 'hidden from the full scan');
  assert.equal(transcriptCache.has(kept), true, 'and still cached');
  const own = await counting(() => loadAllSessions(projectB));
  assert.equal(own.reads, 0, 'its own window reads nothing');
  assert.equal(byId(own.out).scripted.preview, 'scripted run');
  updateSettings({ hiddenSessionPaths: [] });
  ok('a full scan keeps a hidden project\'s entries');
}

// The cap: a full cache takes no new file, keeps what it has and still updates it.
{
  const projectA = byId(await loadAllSessions()).chat.projectPath;
  const known = path.join(dirA, 'chat.jsonl');
  for (let i = transcriptCache.size; i < TRANSCRIPT_CACHE_MAX; i += 1) transcriptCache.set(`/nowhere/${i}.jsonl`, { size: 0, mtimeMs: 0, facts: {} });
  write(dirA, 'overflow', [rec('user', 'one too many', NOW - 1000)]);
  const scoped = await counting(() => loadAllSessions(projectA));
  assert.equal(scoped.reads, 1);
  assert.equal(byId(scoped.out).overflow.preview, 'one too many', 'still listed');
  assert.equal(transcriptCache.size, TRANSCRIPT_CACHE_MAX);
  assert.equal(transcriptCache.has(path.join(dirA, 'overflow.jsonl')), false);
  fs.appendFileSync(known, `${rec('user', 'latest ask', NOW - 500)}\n`);
  await loadAllSessions(projectA);
  assert.equal(transcriptCache.get(known).facts.preview, 'latest ask', 'a known file still updates when full');
  await loadAllSessions();
  assert.equal(transcriptCache.size, 4, 'the next full scan clears the junk, the overflow file gets in');
  ok('the cap holds');
}

// Windows share one load: at once, and within the TTL. Each caller's own rows
// stay its own, so `live` is never a stale copy of another window's.
{
  transcriptCache.clear();
  const sid = 'aaaaaaaa-0000-0000-0000-000000000000';
  write(dirA, sid, [rec('user', 'shared', NOW - 1000)]);
  const projectPath = byId(await loadAllSessions()).chat.projectPath;
  transcriptCache.clear();
  const torn = [{ projectPath, tabId: 'term-/x-1', label: 'One' }];
  const beforeOpens = opens;
  const [a, b, c] = await Promise.all([
    getAllProjectTabs({ liveTabIds: new Set(['term-/x-1']), tearOffTabs: torn }),
    getAllProjectTabs({ liveTabIds: new Set(), tearOffTabs: torn }),
    getAllProjectTabs({ tearOffTabs: torn }),
  ]);
  assert.equal(opens - beforeOpens, transcriptCache.size, 'three callers, one scan');
  assert.equal(a[0].tabs[0].live, true);
  assert.equal(b[0].tabs[0].live, false, 'fresh inputs per caller');
  assert.equal(c[0].tabs[0].live, false);

  const statsAt = stats;
  await getAllProjectTabs({ tearOffTabs: torn });
  assert.equal(stats, statsAt, 'within the TTL: not even a stat');
  at(realNow() + 3500);
  await getAllProjectTabs({ tearOffTabs: torn });
  assert.ok(stats > statsAt, 'past the TTL: a new scan');
  Date.now = realNow;
  ok('concurrent callers share one load');
}

fsp.open = realOpen;
fsp.stat = realStat;
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed`);
