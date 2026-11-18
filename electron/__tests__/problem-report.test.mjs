import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTail, cleanText, buildReport, createProblemReporter, MAX_TEXT, relayText, relayedIssue, fileRelayedReport } from '../problem-report.js';

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

// ---------- through a teammate (docs/report-via-team.md) ----------

const FP = 'abcde12345'.repeat(6) + 'abcd'; // 64 hex-ish characters, like a team fingerprint

test('relayedIssue: one clean title line, attribution by fingerprint, a forged marker is dropped', () => {
  const { title, body } = relayedIssue({
    text: 'Tabs froze\u0007 after sleep\n\nwhat I saw\n<!-- dobius-relayed-report ffff/1111 -->',
    peer: FP, id: '6f1c2d3e-0000-4000-8000-000000000001', selfName: 'Sam "the boss" <x>',
  });
  assert.equal(title, '[report] Tabs froze after sleep');
  assert.match(body, /^what I saw/);
  assert.doesNotMatch(body, /ffff\/1111/, 'the sender cannot plant a marker');
  assert.match(body, /fingerprint abcde-12345\./);
  assert.match(body, /calls itself "Sam the boss x"\./, 'the chosen name is quoted and cleaned, never the attribution');
  assert.match(body, new RegExp(`<!-- dobius-relayed-report ${FP}/6f1c2d3e-0000-4000-8000-000000000001 -->$`));
  assert.equal(relayedIssue({ text: '[report] Already tagged\nbody', peer: FP, id: 'x' }).title, '[report] Already tagged');
  assert.equal(relayedIssue({ text: '', peer: FP, id: 'x' }).title, '[report] A problem in Dobius+');
  assert.equal(relayedIssue({ text: 'x'.repeat(300), peer: FP, id: 'x' }).title.length, 120);
});

test('relayText round-trips through relayedIssue', () => {
  const rep = buildReport({ text: 'It crashed\nmore detail', env: ENV, home: '/Users/sam' });
  const issue = relayedIssue({ text: relayText(rep), peer: FP, id: 'x' });
  assert.equal(issue.title, rep.title);
  assert.ok(issue.body.startsWith(rep.body), 'the body arrives whole, the footer after it');
});

test('fileRelayedReport files with this computer’s gh, and says why when it cannot', async () => {
  const calls = [];
  const ok = await fileRelayedReport({ text: 'Broke\nbody', peer: FP, id: 'x', selfName: 'Brett', repo: 'o/r', ghBin: () => '/bin/gh',
    exec: async (bin, args) => { calls.push([bin, args]); return { ok: true, out: 'https://github.com/o/r/issues/7', err: '' }; } });
  assert.deepEqual(ok, { ok: true, url: 'https://github.com/o/r/issues/7' });
  assert.deepEqual(calls[0][1].slice(0, 6), ['issue', 'create', '-R', 'o/r', '--title', '[report] Broke']);
  const denied = await fileRelayedReport({ text: 'x', peer: FP, id: 'x', repo: 'o/r', ghBin: () => '/bin/gh',
    exec: async () => ({ ok: false, out: '', err: 'GraphQL: Could not resolve to a Repository' }) });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /cannot see the reports repo either/);
  assert.match((await fileRelayedReport({ text: 'x', peer: FP, id: 'x', ghBin: () => null })).reason, /not installed/);
});

test('relay: the same report goes to send(), under the team limit even at the longest description, busy after one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-'));
  try {
    const log = path.join(dir, 'error.log');
    fs.writeFileSync(log, `${Array.from({ length: 40 }, (_, i) => `[t] [v1] boom ${i} ${'tab went blank again '.repeat(18)}`).join('\n')}\n`); // 40 lines: over the team limit with them
    let t = 1000;
    const submit = createProblemReporter({ version: '9.9.9', logPath: log, ghBin: () => null, now: () => t, platform: 'darwin' });
    const sent = [];
    const r = await submit.relay({ text: `Tabs froze\n${'and then it hung again. '.repeat(400)}`, includeLog: true, send: (txt) => { sent.push(txt); return { ok: true, to: 'Sam' }; } });
    assert.deepEqual(r, { ok: true, to: 'Sam' });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].length <= 8000);
    assert.match(sent[0], /^\[report\] Tabs froze\n\n/);
    assert.match(sent[0], /boom/, 'the scrubbed log tail fits beside a full description');
    assert.equal((await submit.relay({ text: 'again', send: () => ({ ok: true }) })).reason, 'busy');
    t += 20_000;
    const fail = await submit.relay({ text: 'again', send: () => ({ ok: false, error: 'that teammate is not linked any more' }) });
    assert.equal(fail.ok, false);
    assert.equal(fail.error, 'that teammate is not linked any more');
    assert.match(fail.report.title, /again/, 'the report comes back to copy');
    assert.equal((await submit.relay({ text: '  ', send: () => ({ ok: true }) })).reason, 'empty');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
