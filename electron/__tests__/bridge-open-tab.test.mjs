// /openTab (bridge-open-tab.js): body validation, message neutralising, the
// Claude-ready check against REAL captured screens, the request flow with fake
// deps (dedupe, concurrency, timeout, a closed tab), and the dobius-open
// script end to end against a local HTTP server.
// Run: node ./electron/__tests__/bridge-open-tab.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  sanitizeOpenMessage, validateOpenTabBody, isClaudePromptReady, createOpenTabService,
  buildOpenCliScript, MAX_OPEN_MESSAGE_BYTES, MAX_OPENS_IN_FLIGHT, MAX_REMEMBERED_REQUESTS,
} from '../bridge-open-tab.js';
import { renderScreenLines } from '../screen-render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (n) => { console.log(`PASS  ${n}`); pass += 1; };

// 1. Messages: line breaks survive as \n, nothing can act as Enter or a key.
assert.deepEqual(sanitizeOpenMessage('line one\r\nline two\rline three\n'), { text: 'line one\nline two\nline three\n' });
assert.equal(sanitizeOpenMessage('a\x1b[201~\rrm -rf ~\r').text, 'a\nrm -rf ~\n'); // cannot end the paste early
assert.equal(sanitizeOpenMessage('x\x1b]0;title\x07y\x1b]52;c;Zm9v\x1b\\z').text, 'xyz'); // OSC to BEL and to ST
assert.equal(sanitizeOpenMessage('x\x1bOAy\x1b7z\x1b(Bw\x1b').text, 'xyzw'); // SS3 arrow, ESC 7, charset, trailing ESC
assert.equal(sanitizeOpenMessage('a\x03b\x15c\x04d\x7fe\u009b31mf\tg').text, 'abcde31mf\tg'); // C0, DEL, C1 CSI; tab kept
assert.equal(sanitizeOpenMessage('café 🚀 日本').text, 'café 🚀 日本');
assert.ok(sanitizeOpenMessage('\x1b[2J\r\n').error, 'nothing left is an error');
assert.ok(sanitizeOpenMessage(42).error);
assert.ok(!sanitizeOpenMessage('a'.repeat(MAX_OPEN_MESSAGE_BYTES)).error);
assert.ok(sanitizeOpenMessage('é'.repeat(MAX_OPEN_MESSAGE_BYTES / 2 + 1)).error, 'the cap counts BYTES');
for (const s of ['\r', '\x1b', '\x03', '\x15', '\u009b', '\x00']) {
  assert.ok(!sanitizeOpenMessage(`a${s}b`).text.includes(s), JSON.stringify(s));
}
ok('message neutralising');

// 2. Body validation.
const good = { projectPath: '/Users/x/proj', message: 'hi', requestId: 'card:gmail.123_ab-C' };
assert.deepEqual(validateOpenTabBody(good), good);
for (const requestId of ['', '-lead', 'a b', 'a/b', 'é', 'x'.repeat(129), 7, undefined, '__proto__']) {
  assert.ok(validateOpenTabBody({ ...good, requestId }).error, String(requestId));
}
assert.ok(!validateOpenTabBody({ ...good, requestId: 'x'.repeat(128) }).error);
for (const projectPath of ['', 'rel/path', '~/proj', '/a\nb', '/a\x00b', `/${'a'.repeat(5000)}`, null]) {
  assert.ok(validateOpenTabBody({ ...good, projectPath }).error, String(projectPath));
}
assert.ok(validateOpenTabBody({ ...good, message: '' }).error);
assert.ok(validateOpenTabBody(null).error);
ok('body validation');

// 3. Ready check on REAL Claude Code 2.1.314 screens: the idle prompt is
// ready; the folder-trust question and AskUserQuestion popups are not.
const render = async (f) => renderScreenLines(new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', f))));
const idle = await render('opentab-idle-2.1.314-raw.bin');
assert.equal(idle.modes.bracketedPaste, true);
assert.equal(isClaudePromptReady(idle, idle.modes), true);
assert.equal(isClaudePromptReady(idle, { bracketedPaste: false }), false, 'no paste mode, not ready');
for (const f of ['opentab-trust-2.1.314-raw.bin', 'askq-2.1.224-raw.txt', 'askq-multi-q1-2.1.233-raw.bin', 'askq-multi-submit-2.1.233-raw.bin']) {
  const s = await render(f);
  assert.equal(isClaudePromptReady(s, s.modes), false, f);
}
const rule = '─'.repeat(40);
assert.equal(isClaudePromptReady([rule, '❯ ', rule], { bracketedPaste: true }), true);
assert.equal(isClaudePromptReady([rule, '❯ line one', '  line two', rule], { bracketedPaste: true }), true);
assert.equal(isClaudePromptReady([rule, '❯ 1. Yes', '  2. No', rule], { bracketedPaste: true }), false, 'a selector is not the prompt');
assert.equal(isClaudePromptReady([rule, '❯ ', 'no closing rule'], { bracketedPaste: true }), false);
assert.equal(isClaudePromptReady(['╭────────╮', '│ > hi   │', '╰────────╯'], { bracketedPaste: true }), true, 'older boxed prompt');
assert.equal(isClaudePromptReady(['user@mac proj % '], { bracketedPaste: true }), false, 'a shell is not Claude');
assert.equal(isClaudePromptReady([rule, '❯ ', rule, ...Array(20).fill('text shown after it'), '% '], { bracketedPaste: true }), false, 'a lookalike high up the screen');
assert.equal(isClaudePromptReady([rule, '❯ ', rule, '  ? for shortcuts', '', '', ''], { bracketedPaste: true }), true, 'trailing blank rows do not count');
ok('Claude ready check on real screens');

// 4. The request flow with fake deps.
const PROMPT = { lines: [rule, '❯ ', rule], modes: { bracketedPaste: true } };
function fakeDeps(over = {}) {
  let t = 0;
  let n = 0;
  const log = [];
  const tabs = new Map(); // tabId -> { pty, seq, frames, alive, claude }
  const deps = {
    log, tabs,
    resolveProject: async (p) => (p === '/missing' ? { status: 404, error: 'no such folder' } : { path: p }),
    openTab: async (p) => {
      n += 1;
      const id = `term-${p}-${n}`;
      tabs.set(id, { pty: { n }, seq: 1, alive: true, frames: [{ lines: ['% '], modes: { bracketedPaste: true } }] });
      log.push(['open', id]);
      return { tabId: id };
    },
    tabAlive: (id) => !!tabs.get(id)?.alive,
    focusTab: (id) => { log.push(['focus', id]); return true; },
    ptyOf: (id) => (tabs.get(id)?.alive ? tabs.get(id).pty : null),
    outputSeq: (id) => tabs.get(id)?.seq || 0,
    claudeRunning: async (id) => !!tabs.get(id)?.claude,
    shellForeground: async (id) => !tabs.get(id)?.claude && !tabs.get(id)?.otherProgram,
    shellInProject: async (id) => !tabs.get(id)?.cdAway,
    inputQuietMs: (id) => tabs.get(id)?.inputQuiet ?? Infinity,
    // "Claude" draws its prompt a few polls after the launch is typed.
    typeLaunch: (id) => {
      log.push(['launch', id]);
      const tab = tabs.get(id);
      setTimeout(() => { tab.claude = true; tab.frames.push(PROMPT); }, 0);
    },
    // Frames drawn since the watch began, or since mark().
    watchOutput: (id) => {
      const tab = tabs.get(id);
      let from = tab.frames.length;
      return {
        mark: () => { from = tab.frames.length; },
        seq: () => tab.frames.length,
        // Like the emulator: everything drawn since stays on screen, newest at the bottom.
        screen: async () => (tab.frames.length > from
          ? { lines: tab.frames.slice(from).flatMap((f) => f.lines), modes: tab.frames.at(-1).modes }
          : { lines: [], modes: {} }),
        stop: () => log.push(['stop', id]),
      };
    },
    paste: (id, text) => log.push(['paste', id, text]),
    inputBusy: () => false,
    sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); },
    now: () => t,
    ...over,
  };
  return deps;
}

{
  const d = fakeDeps();
  const svc = createOpenTabService(d);
  const r = await svc.open({ projectPath: '/p', message: 'Reply to Dom\r\nthanks', requestId: 'r1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, tabId: 'term-/p-1' });
  assert.deepEqual(d.log, [['open', 'term-/p-1'], ['launch', 'term-/p-1'], ['paste', 'term-/p-1', 'Reply to Dom\nthanks'], ['stop', 'term-/p-1']]);
  // Same id again: the same tab comes forward, nothing new opens or is typed.
  const again = await svc.open({ projectPath: '/p', message: 'Reply to Dom', requestId: 'r1' });
  assert.deepEqual(again, { status: 200, body: { ok: true, tabId: 'term-/p-1', existing: true } });
  assert.deepEqual(d.log.at(-1), ['focus', 'term-/p-1']);
  assert.equal(d.log.filter((e) => e[0] === 'open').length, 1);
  // Same id, different project: refused, not silently mapped.
  assert.equal((await svc.open({ projectPath: '/q', message: 'x', requestId: 'r1' })).status, 409);
  // The tab was closed: the same id opens a fresh one.
  d.tabs.get('term-/p-1').alive = false;
  const reopened = await svc.open({ projectPath: '/p', message: 'x', requestId: 'r1' });
  assert.deepEqual(reopened.body, { ok: true, tabId: 'term-/p-2' });
  ok('open, repeat focuses the same tab, closed tab reopens');
}

{
  // Two concurrent calls with one id open ONE tab.
  const d = fakeDeps();
  const svc = createOpenTabService(d);
  const body = { projectPath: '/p', message: 'go', requestId: 'same' };
  const [a, b, c] = await Promise.all([svc.open(body), svc.open(body), svc.open(body)]);
  assert.equal(d.log.filter((e) => e[0] === 'open').length, 1);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 1);
  assert.equal(a.body.tabId, 'term-/p-1');
  assert.equal(b.body.tabId, 'term-/p-1');
  assert.equal(c.body.tabId, 'term-/p-1');
  assert.equal(b.body.existing, true);
  ok('concurrent duplicates share one tab');
}

{
  // Claude never shows its prompt: 504 with the tab id, nothing typed.
  const d = fakeDeps({ typeLaunch: () => {} });
  const svc = createOpenTabService(d, { readyTimeoutMs: 5000 });
  const r = await svc.open({ projectPath: '/p', message: 'go', requestId: 'slow' });
  assert.equal(r.status, 504);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.tabId, 'term-/p-1');
  assert.match(r.body.error, /did not appear within 5s/);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  // A repeat brings that tab forward instead of opening another.
  const again = await svc.open({ projectPath: '/p', message: 'go', requestId: 'slow' });
  assert.deepEqual(again.body, { ok: true, tabId: 'term-/p-1', existing: true });
  ok('readiness timeout keeps the tab and types nothing');
}

{
  // The prompt must be seen on two polls in a row: a single frame is not enough.
  let reads = 0;
  const d = fakeDeps({
    typeLaunch: () => {},
    claudeRunning: async () => true,
    watchOutput: () => ({ mark() {}, stop() {}, seq: () => 0, screen: async () => { reads += 1; return reads === 3 ? PROMPT : { lines: [], modes: {} }; } }),
  });
  const r = await createOpenTabService(d, { readyTimeoutMs: 3000 }).open({ projectPath: '/p', message: 'go', requestId: 'flash' });
  assert.equal(r.status, 504);
  ok('one flashed frame does not count as ready');
}

{
  // A shell prompt drawn like Claude's box (a prompt theme's ruler + ❯) with
  // bracketed paste on is NOT Claude: no claude process, nothing pasted.
  const d = fakeDeps();
  d.typeLaunch = (id) => { d.tabs.get(id).frames.push({ lines: [rule, '❯ claude', 'zsh: command not found: claude', rule, '❯ '], modes: { bracketedPaste: true } }); };
  const r = await createOpenTabService(d, { readyTimeoutMs: 3000 }).open({ projectPath: '/p', message: 'go', requestId: 'shell' });
  assert.equal(r.status, 504);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  ok('a shell that looks like the prompt box gets nothing');
}

{
  // A prompt lookalike printed by the SHELL before the launch (a banner, a
  // file shown at login) is forgotten at the launch: Claude itself shows only
  // a trust question, so nothing is pasted.
  const d = fakeDeps();
  d.openTab = async (p) => {
    const id = `term-${p}-1`;
    d.tabs.set(id, { pty: {}, seq: 1, alive: true, frames: [] });
    return { tabId: id };
  };
  // The shell prints it while the service waits for the shell prompt, i.e.
  // after the watch began and before the launch.
  d.outputSeq = (id) => { const t = d.tabs.get(id); if (!t.frames.length) t.frames.push(PROMPT); return 1; };
  d.typeLaunch = (id) => { d.tabs.get(id).claude = true; d.tabs.get(id).frames.push({ lines: [rule, ' Accessing workspace:', '', ' ❯ No, exit', '   Yes, I trust this folder'], modes: { bracketedPaste: true } }); };
  const r = await createOpenTabService(d, { readyTimeoutMs: 3000 }).open({ projectPath: '/p', message: 'go', requestId: 'banner' });
  assert.equal(r.status, 504);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  ok('a prompt lookalike from before the launch does not count');
}

{
  // Claude exits WHILE the last process check runs: the check still said
  // yes, but the shell's redraw arrived meanwhile. Nothing is pasted.
  let calls = 0;
  let tabRef;
  const d = fakeDeps({
    claudeRunning: async () => {
      calls += 1;
      if (calls === 3) { tabRef.frames.push({ lines: ['% '], modes: { bracketedPaste: true } }); return true; } // exit output lands during the check
      return calls === 2;
    },
  });
  d.typeLaunch = (id) => { tabRef = d.tabs.get(id); tabRef.frames.push(PROMPT); };
  const r = await createOpenTabService(d, { readyTimeoutMs: 3000 }).open({ projectPath: '/p', message: 'go', requestId: 'exit' });
  assert.ok(calls >= 3);
  assert.equal(r.status, 504);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  ok('claude exits during the last check: nothing typed');
}

{
  // The shell is replaced while the pre-launch process check runs: the
  // launch is never typed into the replacement.
  const d = fakeDeps();
  d.claudeRunning = async (id) => { const t = d.tabs.get(id); if (!t.swapped) { t.swapped = true; t.pty = { replacement: true }; } return false; };
  const r = await createOpenTabService(d).open({ projectPath: '/p', message: 'go', requestId: 'swap-early' });
  assert.equal(r.status, 409);
  assert.equal(d.log.filter((e) => e[0] === 'launch' || e[0] === 'paste').length, 0);
  ok('replaced shell before the launch: nothing typed');
}

{
  // A Chat submit is mid-flight into the tab at paste time: refuse.
  const d = fakeDeps({ inputBusy: () => true });
  const r = await createOpenTabService(d).open({ projectPath: '/p', message: 'go', requestId: 'busy' });
  assert.equal(r.status, 409);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  ok('busy input: nothing typed');
}

{
  // The tab closes while Claude starts: 409, nothing typed into anything.
  const d = fakeDeps();
  d.typeLaunch = (id) => { d.tabs.get(id).alive = false; };
  const r = await createOpenTabService(d).open({ projectPath: '/p', message: 'go', requestId: 'closed' });
  assert.equal(r.status, 409);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  // A replaced shell (same id, new PTY) is also "gone".
  const d2 = fakeDeps();
  d2.typeLaunch = (id) => { d2.tabs.get(id).pty = { replaced: true }; };
  const r2 = await createOpenTabService(d2).open({ projectPath: '/p', message: 'go', requestId: 'swap' });
  assert.equal(r2.status, 409);
  assert.equal(d2.log.filter((e) => e[0] === 'paste').length, 0);
  ok('closed or replaced tab: nothing typed');
}

{
  // An agent CLI already runs in the new tab: do not type `claude` into it.
  const d = fakeDeps({ claudeRunning: async () => true, watchOutput: () => ({ mark() {}, stop() {}, seq: () => 0, screen: async () => PROMPT }) });
  const r = await createOpenTabService(d).open({ projectPath: '/p', message: 'go', requestId: 'running' });
  assert.equal(r.status, 200);
  assert.equal(d.log.filter((e) => e[0] === 'launch').length, 0);
  ok('no launch typed when Claude already runs');
}

{
  // Errors before a tab exists forget the id so the board can retry.
  const d = fakeDeps();
  const svc = createOpenTabService(d);
  const r = await svc.open({ projectPath: '/missing', message: 'go', requestId: 'retry' });
  assert.deepEqual(r, { status: 404, body: { ok: false, error: 'no such folder' } });
  assert.equal(svc._requests.has('retry'), false);
  const thrown = await createOpenTabService(fakeDeps({ openTab: async () => { throw new Error('boom'); } }))
    .open({ projectPath: '/p', message: 'go', requestId: 'x' });
  assert.equal(thrown.status, 500);
  assert.match(thrown.body.error, /boom/);
  assert.equal((await svc.open({ projectPath: '/p', message: 'x', requestId: 'bad id' })).status, 400);
  ok('errors without a tab are retryable');
}

{
  // A concurrent duplicate shares a FAILED first outcome instead of opening
  // a second tab (a slow shell that missed its deadline).
  const d = fakeDeps({ openTab: async (p) => { d.log.push(['open']); return { error: 'the new tab\'s terminal did not start', tabId: `term-${p}-9` }; } });
  const svc = createOpenTabService(d);
  const body = { projectPath: '/p', message: 'go', requestId: 'slowpty' };
  const [a, b] = await Promise.all([svc.open(body), svc.open(body)]);
  assert.equal(d.log.filter((e) => e[0] === 'open').length, 1);
  assert.equal(a.status, 500);
  assert.deepEqual(b, a);
  // ...also when the failed request's tab is alive (a trust question is
  // waiting): the duplicate reports the failure, not a success.
  const d2 = fakeDeps({ typeLaunch: () => {} });
  const svc2 = createOpenTabService(d2, { readyTimeoutMs: 2000 });
  const body2 = { projectPath: '/p', message: 'go', requestId: 'trust' };
  const [c, e] = await Promise.all([svc2.open(body2), svc2.open(body2)]);
  assert.equal(c.status, 504);
  assert.deepEqual(e, c);
  assert.equal(d2.log.filter((x) => x[0] === 'open').length, 1);
  ok('concurrent duplicate shares a failure, no second tab');
}

{
  // Something other than the shell owns the terminal (a login script started
  // Codex): `claude` + Enter is never typed into it.
  const d = fakeDeps();
  const orig = d.openTab;
  d.openTab = async (p) => { const r = await orig(p); d.tabs.get(r.tabId).otherProgram = true; return r; };
  const r = await createOpenTabService(d, { readyTimeoutMs: 2000 }).open({ projectPath: '/p', message: 'go', requestId: 'codex' });
  assert.equal(r.status, 504);
  assert.equal(d.log.filter((e) => e[0] === 'launch' || e[0] === 'paste').length, 0);
  ok('no launch typed into a foreground program that is not the shell');
}

{
  // A login script cd'd the shell away from the project: no launch.
  const d = fakeDeps();
  const orig = d.openTab;
  d.openTab = async (p) => { const r = await orig(p); d.tabs.get(r.tabId).cdAway = true; return r; };
  const r = await createOpenTabService(d).open({ projectPath: '/p', message: 'go', requestId: 'cd' });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /not in the project folder/);
  assert.equal(d.log.filter((e) => e[0] === 'launch' || e[0] === 'paste').length, 0);
  ok('shell outside the project: nothing typed');
}

{
  // The person is typing in the tab (their Enter may still be coming): wait.
  const d = fakeDeps();
  const orig = d.openTab;
  d.openTab = async (p) => { const r = await orig(p); d.tabs.get(r.tabId).inputQuiet = 5; return r; };
  const r = await createOpenTabService(d, { readyTimeoutMs: 20000 }).open({ projectPath: '/p', message: 'go', requestId: 'typing' });
  assert.equal(r.status, 504);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  // Same tab once the typing stopped: pasted.
  const d2 = fakeDeps();
  const r2 = await createOpenTabService(d2, { readyTimeoutMs: 20000 }).open({ projectPath: '/p', message: 'go', requestId: 'typing' });
  assert.equal(r2.status, 200);
  ok('no paste while someone is typing in the tab');
}

{
  // In-flight cap: distinct ids beyond the cap get 429, not a queue.
  let release;
  const gate = new Promise((r) => { release = r; });
  const d = fakeDeps({ resolveProject: async (p) => { await gate; return { path: p }; } });
  const svc = createOpenTabService(d);
  const running = Array.from({ length: MAX_OPENS_IN_FLIGHT }, (_, i) => svc.open({ projectPath: '/p', message: 'go', requestId: `f${i}` }));
  const extra = await svc.open({ projectPath: '/p', message: 'go', requestId: 'overflow' });
  assert.equal(extra.status, 429);
  release();
  await Promise.all(running);
  assert.equal((await svc.open({ projectPath: '/p', message: 'go', requestId: 'after' })).status, 200);
  ok('in-flight cap');
}

{
  // Remembered ids are bounded; the oldest settled go first.
  const d = fakeDeps();
  const svc = createOpenTabService(d);
  for (let i = 0; i < MAX_REMEMBERED_REQUESTS + 25; i += 1) await svc.open({ projectPath: '/p', message: 'go', requestId: `m${i}` });
  assert.equal(svc._requests.size, MAX_REMEMBERED_REQUESTS);
  assert.equal(svc._requests.has('m0'), false);
  assert.equal(svc._requests.has(`m${MAX_REMEMBERED_REQUESTS + 24}`), true);
  await svc.open({ projectPath: '/p', message: 'go', requestId: 'constructor' });
  assert.equal(svc._requests.get('constructor').projectPath, '/p'); // a Map, not an object
  ok('bounded memory');
}

// 5. dobius-open, the REAL generated script, against a local server.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-open-test-'));
const tokenFile = path.join(dir, "token with space's");
fs.writeFileSync(tokenFile, 'b'.repeat(64));
const seen = [];
let reply = { ok: true, tabId: 'term-/p-1' };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body });
    res.writeHead(reply.ok ? 200 : 504, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const script = path.join(dir, 'dobius-open');
fs.writeFileSync(script, buildOpenCliScript({ port, tokenFile }), { mode: 0o755 });
const run = (args, stdin) => new Promise((resolve) => {
  const p = spawn(script, args, { env: { ...process.env } });
  let out = '';
  let err = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { err += c; });
  p.on('close', (code) => resolve({ code, out, err }));
  if (stdin !== undefined) p.stdin.end(stdin); else p.stdin.end();
});

let r = await run(['/Users/x/my proj', 'card-1', "it's\nmulti-line"]);
assert.equal(r.code, 0, r.err);
assert.equal(seen.at(-1).url, '/openTab');
assert.equal(seen.at(-1).headers.authorization, `Bearer ${'b'.repeat(64)}`);
assert.equal(seen.at(-1).headers.host, `127.0.0.1:${port}`);
assert.match(seen.at(-1).headers['content-type'], /^application\/json/);
assert.deepEqual(JSON.parse(seen.at(-1).body), { projectPath: '/Users/x/my proj', requestId: 'card-1', message: "it's\nmulti-line" });
assert.match(r.out, /"tabId"/);
r = await run(['/p', 'card-2', '-'], 'from stdin\nline 2\n');
assert.equal(r.code, 0, r.err);
assert.equal(JSON.parse(seen.at(-1).body).message, 'from stdin\nline 2');
reply = { ok: false, error: 'timed out', tabId: 'term-/p-1' };
r = await run(['/p', 'card-3', 'x']);
assert.equal(r.code, 1, 'ok:false exits non-zero');
assert.match(r.out, /timed out/);
r = await run(['/p']);
assert.equal(r.code, 1);
assert.match(r.err, /usage/);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
ok('dobius-open script end to end');

console.log(`\n${pass} passed`);
