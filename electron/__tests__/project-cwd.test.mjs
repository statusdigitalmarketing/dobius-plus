// Each session's project folder comes from its own transcript's cwd, not from
// decoding the ~/.claude/projects dir name (Brett 2026-11-02: decoding gave
// "//Users/Billions/1/Projects//Code//b2b/portal" and every resume cd failed).
// HOME points at a throwaway dir before importing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'project-cwd-home-'));
process.env.HOME = home;
process.env.DOBIUS_TEST_USERDATA = path.join(home, 'userdata');
fs.mkdirSync(process.env.DOBIUS_TEST_USERDATA);
const { loadAllSessions, searchTranscripts, getTranscriptSig } = await import('../data-service.js');

const projects = path.join(home, '.claude', 'projects');
const NOW = Date.now();
let n = 0;
function session(dirName, records) {
  const dir = path.join(projects, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const id = `s${n++}`;
  const lines = records.map((r, i) => JSON.stringify({
    type: 'user', entrypoint: 'cli', timestamp: new Date(NOW - 60_000 + i).toISOString(),
    message: { role: 'user', content: `needle ${id}` }, ...r,
  }));
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
  return id;
}
const byId = async (opts) => Object.fromEntries((await loadAllSessions(opts?.filter ?? null)).map((s) => [s.sessionId, s]));

after(() => fs.rmSync(home, { recursive: true, force: true }));

test('a folder with spaces and brackets comes back exactly, not as a dash-to-slash guess', async () => {
  const real = '/Users/Billions 1/Projects (Code)/b2b-portal';
  const id = session('-Users-Billions-1-Projects--Code--b2b-portal', [{ cwd: real }]);
  const s = (await byId())[id];
  assert.equal(s.projectPath, real);
  assert.equal(s.projectName, 'b2b-portal');
});

test('dotted folders and the old slash-only dir names resolve too', async () => {
  const wt = '/Users/a/Projects (Code)/.app-worktrees/fix-1';
  const a = session('-Users-a-Projects--Code---app-worktrees-fix-1', [{ cwd: wt }]);
  const old = '/Users/a/Projects (Code)/legacy';
  const b = session('-Users-a-Projects (Code)-legacy', [{ cwd: old }]);
  const all = await byId();
  assert.equal(all[a].projectPath, wt);
  assert.equal(all[b].projectPath, old);
});

test('two folders that encode to one dir keep their own paths', async () => {
  const one = session('-w-foo-bar', [{ cwd: '/w/foo-bar' }]);
  const two = session('-w-foo-bar', [{ cwd: '/w/foo/bar' }]);
  const all = await byId();
  assert.equal(all[one].projectPath, '/w/foo-bar');
  assert.equal(all[two].projectPath, '/w/foo/bar');
});

test('a cwd that does not name this dir is ignored (the dir-level path stays)', async () => {
  const id = session('-Users-a-plain', [{ cwd: '/somewhere/else' }]);
  const s = (await byId())[id];
  assert.notEqual(s.projectPath, '/somewhere/else');
  const nested = session('-Users-a-nest', [{ cwd: '/Users/a/nest', message: { role: 'user', content: 'x', cwd: '/Users/a-nest' } }]);
  assert.equal((await byId())[nested].projectPath, '/Users/a/nest', 'only the record\'s own cwd counts');
});

test('a project window filtering by its real path finds sessions of an unconfigured dir', async () => {
  const real = '/Users/Billions 1/Projects (Code)/b2b-portal';
  const list = await loadAllSessions(real);
  assert.ok(list.length >= 1);
  assert.equal(list.every((s) => s.projectPath === real), true);
});

test('search hits carry the session\'s own folder', async () => {
  const real = '/Users/q/My Stuff (2)/site';
  const id = session('-Users-q-My-Stuff--2--site', [{ cwd: real }]);
  const hits = await searchTranscripts(`needle ${id}`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].projectPath, real);
});

test('a dotted folder\'s transcript is found from its real path (previews, hover)', async () => {
  const real = '/tmp/.dot-app';
  const id = session('-tmp--dot-app', [{ cwd: real }]);
  assert.equal(typeof await getTranscriptSig(id, real), 'string');
});

test('a tail of metadata without cwd falls back to the start of the file', async () => {
  const real = '/work/my app';
  const meta = Array.from({ length: 250 }, () => ({ type: 'file-history-snapshot', message: undefined }));
  const id = session('-work-my-app', [{ cwd: real }, ...meta]);
  assert.equal((await byId())[id].projectPath, real);
});

test('the fallback keeps the NEWEST matching cwd, past a huge opening record', async () => {
  const meta = Array.from({ length: 250 }, () => ({ type: 'file-history-snapshot' }));
  const big = { type: 'user', message: { role: 'user', content: 'x'.repeat(1536 * 1024) } };
  // /work/my-app and /work/my app both encode to -work-my-app; the newer one wins
  const id = session('-work-my-app', [big, { cwd: '/work/my-app' }, { cwd: '/work/my app' }, ...meta]);
  assert.equal((await byId())[id].projectPath, '/work/my app');
});
