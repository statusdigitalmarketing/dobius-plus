// SDK-driven sessions (entrypoint "sdk-*") can be excluded from loadAllSessions
// so History shows real chats. Real transcripts on Sam's Mac: 375 of the 400
// newest were sdk-py review/agent runs. HOME points at a throwaway dir before
// importing, same trick as preview-sanitize.test.mjs.
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const TMP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dobius-automated-home-'));
process.env.HOME = TMP_HOME;
const { loadAllSessions } = await import('../data-service.js');

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)}\n        want=${JSON.stringify(want)}`);
};

const dir = path.join(TMP_HOME, '.claude', 'projects', '-tmp-fakeproj');
await fs.mkdir(dir, { recursive: true });
const now = Date.now();
const rec = (type, entrypoint, text, t) => JSON.stringify({
  type, entrypoint, timestamp: new Date(t).toISOString(),
  message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] },
});
const write = (id, lines) => fs.writeFile(path.join(dir, `${id}.jsonl`), lines.join('\n') + '\n');

await write('cli-chat', [rec('user', 'cli', 'fix the login bug', now - 5000), rec('assistant', 'cli', 'done', now - 4000)]);
await write('sdk-review', [rec('user', 'sdk-py', 'Review this change for security vulnerabilities', now - 3000), rec('assistant', 'sdk-py', 'ok', now - 2000)]);
await write('sdk-then-cli', [rec('user', 'sdk-py', 'start job', now - 9000), rec('user', 'cli', 'continue by hand', now - 1000)]);
await write('no-entrypoint', [JSON.stringify({ type: 'user', timestamp: new Date(now - 7000).toISOString(), message: { role: 'user', content: 'old format' } })]);
// remote-control human chats are written as sdk-cli: must stay visible.
await write('remote-control', [rec('user', 'sdk-cli', 'hey from my phone', now - 6000), rec('assistant', 'sdk-cli', 'hi', now - 5500)]);
// Newest real record lacks entrypoint: must NOT inherit the older sdk-py.
await write('newest-unmarked', [
  rec('user', 'sdk-py', 'scripted start', now - 8000),
  JSON.stringify({ type: 'user', timestamp: new Date(now - 500).toISOString(), message: { role: 'user', content: 'typed by hand' } }),
]);
// A trailing non-message record with sdk-py after a cli turn is irrelevant.
await write('trailing-meta', [rec('user', 'cli', 'real question', now - 8500), JSON.stringify({ type: 'system', entrypoint: 'sdk-py', timestamp: new Date(now - 8400).toISOString() })]);

const all = await loadAllSessions();
const ids = (arr) => arr.map((s) => s.sessionId).sort();
const ALL = ['cli-chat', 'newest-unmarked', 'no-entrypoint', 'remote-control', 'sdk-review', 'sdk-then-cli', 'trailing-meta'];
check('default includes everything', ids(all), ALL);
check('automated flag comes from the newest user/assistant record only',
  Object.fromEntries(all.map((s) => [s.sessionId, s.automated]).sort(([a], [b]) => a.localeCompare(b))),
  {
    'cli-chat': false, 'newest-unmarked': false, 'no-entrypoint': false, 'remote-control': false,
    'sdk-review': true, 'sdk-then-cli': false, 'trailing-meta': false,
  });

const real = await loadAllSessions(undefined, { excludeAutomated: true });
check('excludeAutomated drops only Agent SDK runs', ids(real), ALL.filter((x) => x !== 'sdk-review'));

await fs.rm(TMP_HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
if (fail) process.exit(1);
