// electron/history-index.js: ~/.claude/history.jsonl read in fixed chunks, then
// only what was appended. The crash it prevents: 2026-11-09, every window
// re-parsing the whole 14MB file on every prompt, ~2.7GB of main heap, SIGTRAP
// in a Buffer -> string decode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHistoryIndex, singleFlight, projectsSince } from '../history-index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-history-index-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const tmpFile = () => path.join(dir, `h${n++}.jsonl`);
const line = (sessionId, timestamp, extra = {}) => `${JSON.stringify({ display: `p ${sessionId} ${timestamp}`, pastedContents: {}, timestamp, project: `/p/${sessionId[0]}`, sessionId, ...extra })}\n`;
const T0 = new Date(2026, 10, 9, 13, 0, 0).getTime(); // local 13:00
const HOUR = 3600e3;
const DAY = 24 * HOUR;

// What loadHistory and computeStatsFromHistory computed before, straight from the whole file.
function naive(file) {
  const bySession = new Map();
  const days = new Map();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    const ts = typeof e.timestamp === 'number' ? e.timestamp : 0;
    if (e.sessionId) {
      const ex = bySession.get(e.sessionId);
      if (!ex || (ts && ts >= ex.timestamp)) bySession.set(e.sessionId, { sessionId: e.sessionId, project: e.project, display: e.display, timestamp: ts });
    }
    if (!ts) continue;
    const d = new Date(ts);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.set(k, (days.get(k) || 0) + 1);
  }
  return { bySession, days };
}
const dayCounts = (idx) => new Map([...idx.byDay].map(([k, v]) => [k, v.messageCount]));
const sessions = (m) => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));

test('matches a whole-file parse: newest entry per session, per-day and per-hour counts', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, [
    line('a1', T0), line('b1', T0 + HOUR), line('a1', T0 + 2 * HOUR),
    line('a1', T0 + HOUR), // older than the last a1: does not replace it
    'not json\n', 'null\n', '42\n', '\n',
    line('c1', T0 + DAY), line('d1', 0),
  ].join(''));
  const idx = await createHistoryIndex(f).read();
  const want = naive(f);
  assert.deepEqual(sessions(idx.bySession), sessions(want.bySession));
  assert.equal(idx.bySession.get('a1').timestamp, T0 + 2 * HOUR);
  assert.deepEqual(dayCounts(idx), want.days);
  assert.equal(idx.byDay.get([...want.days.keys()][0]).sessions.size, 2); // a1, b1
  assert.deepEqual(idx.hourCounts, { 13: 2, 14: 2, 15: 1 }); // a1 and c1 (next day) at 13:00
  assert.deepEqual([...idx.projects].sort(), ['/p/a', '/p/b', '/p/c']); // d1 has no timestamp
});

test('reads only what was appended, and a half-written last line waits for its newline', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('a1', T0) + line('b1', T0 + 1));
  const h = createHistoryIndex(f);
  const first = await h.read();
  const size1 = fs.statSync(f).size;
  assert.equal(first.offset, size1);

  const next = line('c1', T0 + 2);
  fs.appendFileSync(f, next.slice(0, 20)); // half a line
  let idx = await h.read();
  assert.equal(idx.offset, size1, 'a partial line is not consumed');
  assert.equal(idx.bySession.has('c1'), false);

  fs.appendFileSync(f, next.slice(20));
  idx = await h.read();
  assert.equal(idx.bySession.get('c1').timestamp, T0 + 2);
  assert.equal(dayCounts(idx).get([...dayCounts(idx).keys()][0]), 3, 'nothing counted twice');

  // Unchanged file: nothing new, nothing counted again.
  idx = await h.read();
  assert.equal(idx.offset, fs.statSync(f).size);
  assert.deepEqual(dayCounts(idx), naive(f).days);
});

test('lines that straddle the 1MB read boundary are read whole', async () => {
  const f = tmpFile();
  const big = 'x'.repeat(700 * 1024) + 'é'; // non-ASCII, so a split mid-character would corrupt it
  let body = '';
  for (let i = 0; i < 6; i++) body += line(`s${i}`, T0 + i, { display: `${i}:${big}` });
  fs.writeFileSync(f, body);
  const idx = await createHistoryIndex(f).read();
  assert.equal(idx.bySession.size, 6);
  for (let i = 0; i < 6; i++) assert.equal(idx.bySession.get(`s${i}`).display, `${i}:${big}`);
});

test('a line over 4MB is skipped without being decoded, and the lines around it survive', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('a1', T0) + line('huge', T0 + 1, { display: 'y'.repeat(5 * 1024 * 1024) }) + line('b1', T0 + 2));
  const idx = await createHistoryIndex(f).read();
  assert.deepEqual([...idx.bySession.keys()].sort(), ['a1', 'b1']);
  assert.equal(idx.offset, fs.statSync(f).size);
});

test('a rewritten file starts over: shrunk, replaced, or changed before the read point', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('a1', T0) + line('b1', T0 + 1));
  const h = createHistoryIndex(f);
  await h.read();

  fs.writeFileSync(f, line('z1', T0)); // shorter, same inode
  let idx = await h.read();
  assert.deepEqual([...idx.bySession.keys()], ['z1']);

  // Same inode, longer, and the bytes before the old read point differ.
  fs.writeFileSync(f, line('q1', T0) + line('r1', T0 + 1) + line('s1', T0 + 2));
  idx = await h.read();
  assert.deepEqual([...idx.bySession.keys()].sort(), ['q1', 'r1', 's1']);
  assert.deepEqual(dayCounts(idx), naive(f).days);

  // Replaced by a new file (new inode) of the same size.
  const tmp = `${f}.new`;
  fs.writeFileSync(tmp, line('w1', T0) + line('x1', T0 + 1) + line('y1', T0 + 2));
  assert.equal(fs.statSync(tmp).size, fs.statSync(f).size);
  fs.renameSync(tmp, f);
  idx = await h.read();
  assert.deepEqual([...idx.bySession.keys()].sort(), ['w1', 'x1', 'y1']);
});

test('a missing file is an empty index, and it fills in once the file appears', async () => {
  const f = tmpFile();
  const h = createHistoryIndex(f);
  assert.equal((await h.read()).bySession.size, 0);
  fs.writeFileSync(f, line('a1', T0));
  assert.equal((await h.read()).bySession.size, 1);
});

test('singleFlight: callers share a run, and a call made during a run gets the next one', async () => {
  let runs = 0;
  const gates = [];
  const f = singleFlight(() => { runs++; return new Promise((r) => gates.push(() => r(runs))); });
  const a = f();
  const b = f(); // during run 1: waits for run 2
  const c = f(); // shares run 2 with b
  await Promise.resolve();
  assert.equal(runs, 1);
  gates.shift()();
  assert.equal(await a, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2);
  gates.shift()();
  assert.equal(await b, 2);
  assert.equal(await c, 2);
  // A failed run is reported to its callers and does not wedge the next one.
  const g = singleFlight(async () => { runs++; if (runs === 3) throw new Error('boom'); return runs; });
  await assert.rejects(g(), /boom/);
  assert.equal(await g(), 4);
});

test('concurrent reads of one index share one update', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('a1', T0));
  const h = createHistoryIndex(f);
  const [x, y, z] = await Promise.all([h.read(), h.read(), h.read()]);
  assert.equal(x, y);
  assert.equal(y, z);
  assert.deepEqual(dayCounts(x), naive(f).days);
});

test('an edit in place that keeps the size and the last 64 bytes is still noticed', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('a1', T0) + line('b1', T0 + 1));
  const h = createHistoryIndex(f);
  await h.read();
  const txt = fs.readFileSync(f, 'utf8').replace(`"timestamp":${T0},`, `"timestamp":${T0 + DAY},`);
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(f, txt); // same length, same inode, same tail
  fs.utimesSync(f, later, later);
  const idx = await h.read();
  assert.equal(idx.bySession.get('a1').timestamp, T0 + DAY);
  assert.deepEqual(dayCounts(idx), naive(f).days);
});

test('the rewrite probe is taken from the bytes that were parsed, across read boundaries', async () => {
  const f = tmpFile();
  let body = '';
  for (let i = 0; i < 5; i++) body += line(`s${i}`, T0 + i, { display: `${i}:${'z'.repeat(400 * 1024)}` });
  body += line('tiny', T0 + 9);
  fs.writeFileSync(f, body);
  const idx = await createHistoryIndex(f).read();
  const bytes = fs.readFileSync(f);
  assert.equal(idx.probe, bytes.subarray(bytes.length - 64).toString('hex'));
  // And from a resume point that lands in the next read.
  fs.appendFileSync(f, line('more', T0 + 10));
  const h = createHistoryIndex(f);
  await h.read();
  const after = fs.readFileSync(f);
  assert.equal((await h.read()).probe, after.subarray(after.length - 64).toString('hex'));
});

test('request snapshot lines are skipped, as parseJsonl always did', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('a1', T0) + `${JSON.stringify({ type: 'api-request-blob', sessionId: 'a1', timestamp: T0 + 5 })}\n`);
  const idx = await createHistoryIndex(f).read();
  assert.equal(idx.bySession.get('a1').timestamp, T0);
  assert.equal(dayCounts(idx).get([...dayCounts(idx).keys()][0]), 1);
});

test('the probe joins the previous read when the last newline sits just past a read boundary', async () => {
  const f = tmpFile();
  const base = line('edge', T0, { display: '' }).length;
  const ln = line('edge', T0, { display: 'q'.repeat(1024 * 1024 + 10 - base) });
  assert.equal(Buffer.byteLength(ln), 1024 * 1024 + 10); // newline at index 9 of the second read
  fs.writeFileSync(f, ln);
  const idx = await createHistoryIndex(f).read();
  assert.equal(idx.bySession.has('edge'), true);
  const bytes = fs.readFileSync(f);
  assert.equal(idx.probe, bytes.subarray(bytes.length - 64).toString('hex'));
});

test('a same-size edit is noticed while an unfinished last line is waiting', async () => {
  const f = tmpFile();
  const partial = line('c1', T0 + 2).slice(0, 30);
  fs.writeFileSync(f, line('a1', T0) + line('b1', T0 + 1) + partial);
  const h = createHistoryIndex(f);
  await h.read();
  const txt = fs.readFileSync(f, 'utf8').replace(`"timestamp":${T0},`, `"timestamp":${T0 + DAY},`);
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(f, txt);
  fs.utimesSync(f, later, later);
  let idx = await h.read();
  assert.equal(idx.bySession.get('a1').timestamp, T0 + DAY);
  fs.appendFileSync(f, line('c1', T0 + 2).slice(30));
  idx = await h.read();
  assert.equal(idx.bySession.get('c1').timestamp, T0 + 2);
  assert.deepEqual(dayCounts(idx), naive(f).days);
});

test('a read that fails part way is thrown away, so the retry starts from the beginning', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('a1', T0) + line('b1', T0 + 1));
  const real = fs.promises.open;
  let opens = 0;
  fs.promises.open = async (...a) => {
    const fh = await real(...a);
    if (++opens === 1) {
      let reads = 0;
      const read = fh.read.bind(fh);
      fh.read = (...r) => (++reads === 2 ? Promise.reject(new Error('EIO')) : read(...r));
    }
    return fh;
  };
  const h = createHistoryIndex(f);
  try {
    fs.writeFileSync(f, line('a1', T0) + 'x'.repeat(1024 * 1024) + '\n' + line('b1', T0 + 1)); // spans two reads
    await assert.rejects(h.read(), /EIO/);
  } finally { fs.promises.open = real; }
  // Same size, edited more than 64 bytes before the old read point, where the probe cannot see it.
  const txt = fs.readFileSync(f, 'utf8').replace(`"display":"p a1 ${T0}"`, `"display":"Q a1 ${T0}"`);
  assert.notEqual(txt, fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, txt);
  const idx = await h.read();
  assert.equal(idx.bySession.get('a1').display, `Q a1 ${T0}`);
});

test('projectsSince names the projects that had a prompt after an earlier reading', async () => {
  const f = tmpFile();
  fs.writeFileSync(f, line('a1', T0) + line('b1', T0 + 1)); // projects /p/a, /p/b
  const h = createHistoryIndex(f);
  const first = await h.read();
  const seq = first.seq;
  assert.equal(seq, 2);
  assert.equal(projectsSince(first, null, NaN), null, 'no earlier reading: unknown');
  fs.appendFileSync(f, line('c1', T0 + 2) + line('a2', T0 + 3) + line('c2', T0 + 4));
  const idx = await h.read();
  assert.equal(idx, first, 'same index object after an append');
  assert.deepEqual(projectsSince(idx, first, seq).sort(), ['/p/a', '/p/c']);
  assert.deepEqual(projectsSince(idx, idx, idx.seq), [], 'nothing new');
  // A rewrite builds a new index: which projects changed cannot be told.
  fs.writeFileSync(f, line('z1', T0));
  const fresh = await h.read();
  assert.notEqual(fresh, first);
  assert.equal(projectsSince(fresh, first, seq), null);
});
