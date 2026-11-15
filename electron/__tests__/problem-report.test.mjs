import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTail, cleanText, buildReport, createProblemReporter, MAX_TEXT } from '../problem-report.js';

const ENV = { version: '9.9.9', os: 'macOS 25.5.0', arch: 'arm64' };

test('readTail reads only the end of a growing log, from a line start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-'));
  try {
    const f = path.join(dir, 'error.log');
    const lines = Array.from({ length: 5000 }, (_, i) => `[t] [v1] kind: line ${i}`);
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const tail = readTail(f, 1024);
    assert.ok(Buffer.byteLength(tail) <= 1024);
    assert.match(tail, /^\[t\] \[v1\] kind: line \d+\n/, 'starts at a whole line');
    assert.match(tail, /line 4999\n$/);
    assert.equal(readTail(path.join(dir, 'missing.log')), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cleanText shortens the home folder, drops control bytes, caps the length', () => {
  assert.equal(cleanText('  it broke in /Users/sam/Projects/x\u0007  ', '/Users/sam'), 'it broke in ~/Projects/x');
  assert.equal(cleanText('a'.repeat(MAX_TEXT + 50)).length, MAX_TEXT);
  assert.equal(cleanText(null), '');
});

test('buildReport: title from the first line, errors scrubbed and fenced, no fence breakout', () => {
  const { title, body } = buildReport({
    text: 'Tabs froze after sleep\nthen ``` came back',
    log: '[t] [v1] main.stall: blocked token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 in /Users/sam/x\n',
    env: ENV, home: '/Users/sam',
  });
  assert.equal(title, '[report] Tabs froze after sleep');
  assert.match(body, /Dobius\+ 9\.9\.9 \(macOS 25\.5\.0, arm64\)/);
  assert.equal(body.split('```').length - 1, 2, 'only the report’s own fence pair');
  assert.doesNotMatch(body, /ghp_abcdefghij/);
  assert.doesNotMatch(body, /\/Users\/sam/);
  const long = buildReport({ text: 'x'.repeat(200), env: ENV });
  assert.ok(long.title.length <= '[report] '.length + 80);
  assert.doesNotMatch(buildReport({ text: 'hi', log: '', env: ENV }).body, /Recent errors/);
});

function fakeGh(answer) {
  const calls = [];
  return { calls, exec: async (bin, args) => { calls.push({ bin, args }); return answer(); } };
}

test('submit files one issue through gh and answers with its link', async () => {
  const gh = fakeGh(() => ({ ok: true, out: 'https://github.com/o/r/issues/42', err: '' }));
  const submit = createProblemReporter({ version: '1', repo: 'o/r', ghBin: () => '/gh', exec: gh.exec, logPath: null });
  assert.deepEqual(await submit({ text: 'broken' }), { ok: true, url: 'https://github.com/o/r/issues/42' });
  assert.deepEqual(gh.calls[0].args.slice(0, 4), ['issue', 'create', '-R', 'o/r']);
});

test('submit refuses empty text, and hands the report back when gh is missing or has no access', async () => {
  const none = createProblemReporter({ version: '1', ghBin: () => null, exec: async () => assert.fail('no gh call') });
  assert.equal((await none({ text: '   ' })).reason, 'empty');
  assert.equal((await none({})).reason, 'empty');
  const r = await none({ text: 'broken' });
  assert.equal(r.reason, 'no-gh');
  assert.equal(r.report.title, '[report] broken');
  const denied = createProblemReporter({ version: '1', ghBin: () => '/gh',
    exec: async () => ({ ok: false, out: '', err: 'GraphQL: Could not resolve to a Repository with the name' }) });
  const d = await denied({ text: 'broken' });
  assert.equal(d.reason, 'no-access');
  assert.match(d.report.body, /broken/);
  const odd = createProblemReporter({ version: '1', ghBin: () => '/gh', exec: async () => ({ ok: true, out: 'something else', err: '' }) });
  assert.equal((await odd({ text: 'broken' })).reason, 'failed', 'success needs an issue link');
});

test('submit: one at a time, then a short cooldown after a report is filed', async () => {
  let release;
  let t = 1000;
  const gh = fakeGh(() => new Promise((r) => { release = () => r({ ok: true, out: 'https://github.com/o/r/issues/1', err: '' }); }));
  const submit = createProblemReporter({ version: '1', ghBin: () => '/gh', exec: gh.exec, now: () => t });
  const first = submit({ text: 'a' });
  await new Promise((r) => setImmediate(r));
  assert.equal((await submit({ text: 'b' })).reason, 'busy');
  release();
  assert.equal((await first).ok, true);
  assert.equal((await submit({ text: 'c' })).reason, 'busy', 'cooldown');
  t += 20_000;
  const third = submit({ text: 'd' });
  await new Promise((r) => setImmediate(r));
  release();
  assert.equal((await third).ok, true);
  assert.equal(gh.calls.length, 2);
});

test('includeLog reads the log only when asked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prl-'));
  try {
    const f = path.join(dir, 'error.log');
    fs.writeFileSync(f, '[t] [v1] uncaught: boom\n');
    const gh = fakeGh(() => ({ ok: true, out: 'https://github.com/o/r/issues/7', err: '' }));
    let t = 0;
    const submit = createProblemReporter({ version: '1', ghBin: () => '/gh', exec: gh.exec, logPath: () => f, now: () => (t += 60_000) });
    await submit({ text: 'x', includeLog: true });
    await submit({ text: 'y' });
    const bodyOf = (i) => gh.calls[i].args[gh.calls[i].args.indexOf('--body') + 1];
    assert.match(bodyOf(0), /uncaught: boom/);
    assert.doesNotMatch(bodyOf(1), /uncaught: boom/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
