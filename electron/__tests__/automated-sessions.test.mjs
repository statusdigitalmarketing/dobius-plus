// SDK-driven sessions (entrypoint "sdk-*") can be excluded from loadAllSessions
// so History shows real chats. Real transcripts on Sam's Mac: 375 of the 400
// newest were sdk-py review/agent runs. HOME points at a throwaway dir before
// importing, same trick as preview-sanitize.test.mjs.
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const TMP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dobius-automated-home-'));
process.env.HOME = TMP_HOME;
// Own config dir: this suite records tab names through config-manager.
process.env.DOBIUS_TEST_USERDATA = path.join(TMP_HOME, 'userdata');
await fs.mkdir(process.env.DOBIUS_TEST_USERDATA, { recursive: true });
const { loadAllSessions } = await import('../data-service.js');
const { recordSessionTabNames, getSessionTabNames, flushConfig } = await import('../config-manager.js');

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

// Titles: Claude rewrites ai-title as a chat goes, so the newest wins, and it
// may sit behind more records than the preview/role signals need.
await write('titled', [
  JSON.stringify({ type: 'ai-title', aiTitle: 'Old name' }),
  rec('user', 'cli', 'first ask', now - 9500),
  JSON.stringify({ type: 'ai-title', aiTitle: '  Fix the\nlogin bug ' }),
  rec('user', 'cli', 'second ask', now - 9400),
  rec('assistant', 'cli', 'done', now - 9300),
  'null',
]);

// Clock moved back: an OLDER record carries a LATER stamp. The title lookup
// must not drag the session's timestamp onto it (the walk used to stop at the
// newest user/assistant pair; it still must).
await write('clock-skew', [
  rec('user', 'cli', 'from the future', now + 3_600_000),
  rec('user', 'cli', 'latest ask', now - 600_000),
  rec('assistant', 'cli', 'done', now - 599_000),
]);

// Ordering is by the last MESSAGE (Brett: "in order from the most recently
// messaged one"). Resuming a chat writes hook output, file snapshots and
// queue records; none of them is a message, so none may float it up.
const meta = (type, t, extra = {}) => JSON.stringify({ type, timestamp: new Date(t).toISOString(), ...extra });
await write('resumed-old', [
  rec('user', 'cli', 'old question', now - 3_600_000),
  rec('assistant', 'cli', 'old answer', now - 3_590_000),
  meta('attachment', now - 100, { attachment: { type: 'hook_success' } }),
  meta('file-history-snapshot', now - 90),
  meta('queue-operation', now - 80),
  meta('system', now - 70, { subtype: 'local_command' }),
  JSON.stringify({ type: 'user', isMeta: true, timestamp: new Date(now - 60).toISOString(), message: { role: 'user', content: 'SessionStart hook context' } }),
  rec('user', 'cli', '<task-notification><task-id>x</task-id>', now - 50),
]);
await write('messaged-later', [
  rec('user', 'cli', 'newer question', now - 1_800_000),
  rec('assistant', 'cli', 'newer answer', now - 1_790_000),
]);
await write('only-meta', [meta('file-history-snapshot', now - 7_200_000)]);

const all = await loadAllSessions();
const ids = (arr) => arr.map((s) => s.sessionId).sort();
const ALL = ['cli-chat', 'clock-skew', 'messaged-later', 'newest-unmarked', 'no-entrypoint', 'only-meta', 'remote-control', 'resumed-old', 'sdk-review', 'sdk-then-cli', 'titled', 'trailing-meta'];
const byId = (id) => all.find((s) => s.sessionId === id);
check('timestamp is the last real message, not later metadata', byId('resumed-old')?.timestamp, now - 3_590_000);
check('activityAt still sees the newest write', byId('resumed-old')?.activityAt, now - 50);
check('a later message sorts above a later metadata write',
  all.map((s) => s.sessionId).filter((id) => id === 'resumed-old' || id === 'messaged-later'), ['messaged-later', 'resumed-old']);
check('a trailing system record does not move the timestamp', byId('trailing-meta')?.timestamp, now - 8500);
check('no message at all falls back to the newest record', byId('only-meta')?.timestamp, now - 7_200_000);
check('list is sorted newest message first',
  all.every((s, i) => i === 0 || (all[i - 1].timestamp || 0) >= (s.timestamp || 0)), true);
const skew = all.find((s) => s.sessionId === 'clock-skew');
check('untitled session keeps the newest pair\'s timestamp and status', [skew?.timestamp === now - 599_000, skew?.status], [true, 'done']);
const titled = all.find((s) => s.sessionId === 'titled');
check('newest ai-title wins, whitespace collapsed', titled?.title, 'Fix the login bug');
check('preview is still the newest prompt', titled?.preview, 'second ask');
check('a null line does not drop the session', !!titled, true);
check('no ai-title gives an empty title', all.find((s) => s.sessionId === 'cli-chat')?.title, '');
check('default includes everything', ids(all), ALL);
check('automated flag comes from the newest user/assistant record only',
  Object.fromEntries(all.map((s) => [s.sessionId, s.automated]).sort(([a], [b]) => a.localeCompare(b))),
  {
    'cli-chat': false, 'clock-skew': false, 'messaged-later': false, 'newest-unmarked': false, 'no-entrypoint': false,
    'only-meta': false, 'remote-control': false, 'resumed-old': false,
    'sdk-review': true, 'sdk-then-cli': false, 'titled': false, 'trailing-meta': false,
  });

const real = await loadAllSessions(undefined, { excludeAutomated: true });
check('excludeAutomated drops only Agent SDK runs', ids(real), ALL.filter((x) => x !== 'sdk-review'));

// Tab names: recorded by main while a session runs, merged onto the list.
check('no tab name until one is recorded', byId('cli-chat')?.tabName, undefined);
check('recording a name reports a change', recordSessionTabNames([['cli-chat', 'Email'], ['__proto__', 'x'], ['constructor', 'y'], ['titled', '']]), true);
check('the same name again is not a change', recordSessionTabNames([['cli-chat', 'Email']]), false);
const named = await loadAllSessions();
check('the tab name rides on the session', named.find((s) => s.sessionId === 'cli-chat')?.tabName, 'Email');
check('unsafe ids and empty names are never stored', [...getSessionTabNames().keys()], ['cli-chat']);
const many = Array.from({ length: 1005 }, (_, i) => [`s-${i}`, `n${i}`]);
recordSessionTabNames(many.slice(0, 600), 1);
recordSessionTabNames(many.slice(600), 2);
const kept = getSessionTabNames();
check('names are capped, oldest sighting dropped first', [kept.size, kept.has('cli-chat'), kept.has('s-1004')], [1000, true, true]);
flushConfig?.();

await fs.rm(TMP_HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
if (fail) process.exit(1);
