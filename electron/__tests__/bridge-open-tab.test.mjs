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
  buildOpenCliScript, isKeyboardInput, isUserInput, promptBoxText, boxHoldsMessage, boxStillHasMessage, CLAUDE_SCRIPT_RE, MAX_OPEN_MESSAGE_BYTES, MAX_OPENS_IN_FLIGHT, MAX_REMEMBERED_REQUESTS,
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

// Keyboard vs pointer: only a person's keys count as typing into the tab.
for (const m of ['\x1b[<35;10;5M', '\x1b[<0;3;4m\x1b[<35;11;5M', '\x1b[M #!', '\x1b[32;10;5M', '\x1b[I', '\x1b[O', '\x1b[0n', '\x1b[1;5R', '\x1b[0n\x1b[12;40R', '\x1b[?1;2c', '\x1b]11;rgb:0000/0000/0000\x07']) assert.equal(isKeyboardInput(m), false, JSON.stringify(m));
for (const k of ['a', '\r', 'hello', '\x1b[A', '\x1b[<35;10;5Mx', '\x15']) assert.equal(isKeyboardInput(k), true, JSON.stringify(k));
assert.equal(isUserInput('\x1b[<64;10;5M'), true, 'a wheel turn is a person');
assert.equal(isUserInput('\x1b[0n'), false);
assert.equal(isUserInput('\x1b[I'), false);
assert.equal(CLAUDE_SCRIPT_RE.test('/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js'), true);
assert.equal(CLAUDE_SCRIPT_RE.test('/Users/x/.local/share/claude/versions/2.1.314/cli.js'), true);
assert.equal(CLAUDE_SCRIPT_RE.test('/tmp/claude'), false);
assert.equal(CLAUDE_SCRIPT_RE.test('/tmp/claude tools/repl.js'), false);
ok('keyboard vs mouse input, claude script paths');

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
// openTab wrapper: tweak the new tab before Claude would come up.
const tweakTab = (d, fn) => { const o = d.openTab; d.openTab = async (p) => { const r = await o(p); fn(d.tabs.get(r.tabId)); return r; }; };
function fakeDeps(over = {}) {
  let t = 0;
  let n = 0;
  const log = [];
  const tabs = new Map(); // tabId -> { pty, frames, alive, claude }
  const deps = {
    log, tabs,
    resolveProject: async (p) => (p === '/missing' ? { status: 404, error: 'no such folder' } : { path: p }),
    openTab: async (p) => {
      n += 1;
      const id = `term-${p}-${n}`;
      const tab = { pty: { n }, alive: true, frames: [] };
      tabs.set(id, tab);
      log.push(['open', id]);
      // The New Tab's shell starts Claude by itself; it draws its prompt a
      // moment later (unless a test says it never comes up).
      setTimeout(() => {
        if (tab.noClaude || !tab.alive) return;
        tab.claude = true;
        tab.frames.push(PROMPT);
      }, 0);
      return { tabId: id };
    },
    tabAlive: (id) => !!tabs.get(id)?.alive,
    focusTab: (id) => { log.push(['focus', id]); return true; },
    ptyOf: (id) => (tabs.get(id)?.alive ? tabs.get(id).pty : null),
    claudeRunning: async (id, projectPath) => { log.push(['claudeCheck', projectPath]); return !!tabs.get(id)?.claude; },
    // Everything the tab drew since it started.
    watchOutput: (id) => {
      const tab = tabs.get(id);
      const from = 0;
      return {
        seq: () => tab.frames.length,
        keys: () => tab.keys || 0,
        input: () => (tab.keys || 0) + (tab.mouse || 0),
        // Like the emulator: everything drawn since stays on screen, newest at the bottom.
        screen: async () => (tab.frames.length > from
          ? { lines: tab.frames.slice(from).flatMap((f) => f.lines), modes: tab.frames.at(-1).modes }
          : { lines: [], modes: {} }),
        stop: () => log.push(['stop', id]),
      };
    },
    // Claude echoes the pasted text into its box (a new frame).
    paste: (id, text) => {
      log.push(['paste', id, text]);
      const tab = tabs.get(id);
      if (!tab.noEcho) tab.frames.push({ lines: [rule, `❯ ${text.split('\n')[0]}`, ...text.split('\n').slice(1).map((l) => `  ${l}`), rule], modes: { bracketedPaste: true } });
    },
    // Claude takes the message: the box empties.
    submit: (id) => { log.push(['submit', id]); tabs.get(id).frames.push({ lines: ['● Working', rule, '❯ ', rule], modes: { bracketedPaste: true } }); },
    inputBusy: () => false,
    // A real timer turn, so the tab's own setTimeout (Claude coming up) runs.
    sleep: async (ms) => { t += ms; await new Promise((r) => setTimeout(r, 0)); },
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
  assert.deepEqual(r.body, { ok: true, tabId: 'term-/p-1', submitted: true });
  // Exactly one Enter, as its own step, after the paste.
  // Nothing is typed to launch Claude (the New Tab starts it): one paste,
  // then exactly one Enter, as its own step.
  assert.deepEqual(d.log.filter((e) => e[0] !== 'claudeCheck'), [['open', 'term-/p-1'], ['paste', 'term-/p-1', 'Reply to Dom\nthanks'], ['submit', 'term-/p-1'], ['stop', 'term-/p-1']]);
  // Every claude check is asked about the PROJECT (its cwd must be it).
  assert.ok(d.log.filter((e) => e[0] === 'claudeCheck').length >= 2);
  assert.ok(d.log.filter((e) => e[0] === 'claudeCheck').every((e) => e[1] === '/p'));
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
  assert.deepEqual(reopened.body, { ok: true, tabId: 'term-/p-2', submitted: true });
  assert.equal(d.log.filter((e) => e[0] === 'submit').length, 2, 'the repeat that only focused submitted nothing');
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
  const d = fakeDeps();
  tweakTab(d, (t) => { t.noClaude = true; });
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
    claudeRunning: async () => true,
    watchOutput: () => ({ stop() {}, seq: () => 0, keys: () => 0, input: () => 0, screen: async () => { reads += 1; return reads === 3 ? PROMPT : { lines: [], modes: {} }; } }),
  });
  const r = await createOpenTabService(d, { readyTimeoutMs: 3000 }).open({ projectPath: '/p', message: 'go', requestId: 'flash' });
  assert.equal(r.status, 504);
  ok('one flashed frame does not count as ready');
}

{
  // A shell prompt drawn like Claude's box (a prompt theme's ruler + ❯) with
  // bracketed paste on is NOT Claude: no claude process, nothing pasted.
  const d = fakeDeps();
  tweakTab(d, (t) => { t.noClaude = true; t.frames.push({ lines: [rule, '❯ claude', 'zsh: command not found: claude', rule, '❯ '], modes: { bracketedPaste: true } }); });
  const r = await createOpenTabService(d, { readyTimeoutMs: 3000 }).open({ projectPath: '/p', message: 'go', requestId: 'shell' });
  assert.equal(r.status, 504);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  ok('a shell that looks like the prompt box gets nothing');
}

{
  // Claude exits WHILE the last process check runs: the check still said
  // yes, but the shell's redraw arrived meanwhile. Nothing is pasted.
  let calls = 0;
  let tabRef;
  const d = fakeDeps({
    claudeRunning: async () => {
      calls += 1;
      if (calls === 2) { tabRef.frames.push({ lines: ['% '], modes: { bracketedPaste: true } }); return true; } // exit output lands during the check
      return calls === 1;
    },
  });
  tweakTab(d, (t) => { tabRef = t; });
  const r = await createOpenTabService(d, { readyTimeoutMs: 3000 }).open({ projectPath: '/p', message: 'go', requestId: 'exit' });
  assert.ok(calls >= 2);
  assert.equal(r.status, 504);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  ok('claude exits during the last check: nothing typed');
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
  tweakTab(d, (t) => { setImmediate(() => { t.alive = false; }); });
  const r = await createOpenTabService(d).open({ projectPath: '/p', message: 'go', requestId: 'closed' });
  assert.equal(r.status, 409);
  assert.equal(d.log.filter((e) => e[0] === 'paste').length, 0);
  // A replaced shell (same id, new PTY) is also "gone".
  const d2 = fakeDeps();
  tweakTab(d2, (t) => { setImmediate(() => { t.pty = { replaced: true }; }); });
  const r2 = await createOpenTabService(d2).open({ projectPath: '/p', message: 'go', requestId: 'swap' });
  assert.equal(r2.status, 409);
  assert.equal(d2.log.filter((e) => e[0] === 'paste').length, 0);
  ok('closed or replaced tab: nothing typed');
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
  const d2 = fakeDeps();
  tweakTab(d2, (t) => { t.noClaude = true; });
  const svc2 = createOpenTabService(d2, { readyTimeoutMs: 2000 });
  const body2 = { projectPath: '/p', message: 'go', requestId: 'trust' };
  const [c, e] = await Promise.all([svc2.open(body2), svc2.open(body2)]);
  assert.equal(c.status, 504);
  assert.deepEqual(e, c);
  assert.equal(d2.log.filter((x) => x[0] === 'open').length, 1);
  ok('concurrent duplicate shares a failure, no second tab');
}

{
  // A person typed into the new tab (their own Enter may still be coming):
  // nothing is pasted, whether they typed before Claude came up or while it was.
  const d = fakeDeps();
  tweakTab(d, (t) => { t.keys = 1; });
  const r = await createOpenTabService(d).open({ projectPath: '/p', message: 'go', requestId: 'typing' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /someone typed/);
  assert.equal(d.log.filter((e) => ['paste', 'submit'].includes(e[0])).length, 0);
  const d2 = fakeDeps();
  tweakTab(d2, (t) => { setImmediate(() => { t.keys = 2; }); });
  const r2 = await createOpenTabService(d2).open({ projectPath: '/p', message: 'go', requestId: 'typing' });
  assert.equal(r2.status, 409);
  assert.equal(d2.log.filter((e) => e[0] === 'paste' || e[0] === 'submit').length, 0);
  ok('a person typing into the tab: no paste, no Enter');
}

{
  // The Enter: withheld whenever anything that cleared the paste stopped holding.
  const rule2 = '─'.repeat(40);
  const cases = [
    ['no echo', (d) => tweakTab(d, (t) => { t.noEcho = true; }), /did not show the pasted text/],
    ['claude gone at the Enter', (d) => { const o = d.paste; d.paste = (id, t) => { o(id, t); d.tabs.get(id).claude = false; }; }, /not in the foreground/],
    ['someone typed after the paste', (d) => { const o = d.paste; d.paste = (id, t) => { o(id, t); setImmediate(() => { d.tabs.get(id).keys = 1; }); }; }, /someone typed/],
    ['box gone after the paste', (d) => { const o = d.paste; d.paste = (id, t) => { o(id, t); d.tabs.get(id).frames.push({ lines: [...Array(15).fill('a dialog took over'), '❯ 1. Yes'], modes: { bracketedPaste: true } }); }; }, /did not show the message/],
    // The screen became a permission dialog QUOTING a prompt box (a heredoc):
    // an Enter would answer the dialog. Never sent.
    ['dialog quoting a box', (d) => { const o = d.paste; d.paste = (id, t) => { o(id, t); d.tabs.get(id).frames.push({ lines: [' Bash command', '   cat <<EOF', rule2, `❯ ${t}`, rule2, 'EOF', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'], modes: { bracketedPaste: true } }); }; }, /did not show the message/],
    // Something cleared the prompt (a window closing sends Ctrl+C) and Claude
    // redrew it empty: the box no longer holds the message. Never sent.
    ['prompt cleared', (d) => { const o = d.paste; d.paste = (id, t) => { o(id, t); d.tabs.get(id).frames.push({ lines: [rule2, '❯ ', rule2], modes: { bracketedPaste: true } }); }; }, /did not show the message/],
  ];
  for (const [name, setup, why] of cases) {
    const d = fakeDeps();
    setup(d);
    const r = await createOpenTabService(d).open({ projectPath: '/p', message: 'go', requestId: 'enter' });
    assert.equal(r.status, 200, name);
    assert.equal(r.body.submitted, false, name);
    assert.match(r.body.note, why, name);
    assert.equal(d.log.filter((e) => e[0] === 'paste').length, 1, name);
    assert.equal(d.log.filter((e) => e[0] === 'submit').length, 0, name);
  }
  // A card starting with a Claude mode character (! runs a shell command with
  // no permission prompt) is typed, never sent.
  for (const lead of ['!rm -rf ~', '  /logout', '#remember this', '&go']) {
    const dm = fakeDeps();
    const rm = await createOpenTabService(dm).open({ projectPath: '/p', message: lead, requestId: 'mode' });
    assert.equal(rm.body.submitted, false, lead);
    assert.match(rm.body.note, /treats as a command/, lead);
    assert.equal(dm.log.filter((e) => e[0] === 'paste').length, 1, lead);
    assert.equal(dm.log.filter((e) => e[0] === 'submit').length, 0, lead);
  }
  // A trailing backslash turns the Enter into a new line: typed, never sent.
  const db = fakeDeps();
  const rb = await createOpenTabService(db).open({ projectPath: '/p', message: 'hello\\', requestId: 'bslash' });
  assert.equal(rb.body.submitted, false);
  assert.match(rb.body.note, /backslash/);
  assert.equal(db.log.filter((e) => e[0] === 'submit').length, 0);
  // Something else replaced the box's text after the paste (a history entry
  // recalled by the wheel): the Enter is withheld.
  const dh = fakeDeps();
  const oh = dh.paste;
  dh.paste = (id, t) => { oh(id, t); dh.tabs.get(id).frames.push({ lines: [rule, '❯ go delete the backups', rule], modes: { bracketedPaste: true } }); };
  const rh = await createOpenTabService(dh).open({ projectPath: '/p', message: 'go', requestId: 'history' });
  assert.equal(rh.body.submitted, false);
  assert.equal(dh.log.filter((e) => e[0] === 'submit').length, 0);
  // A wheel turn after the paste (history:previous can be bound to it):
  // the Enter is withheld even though no key was typed.
  const dw = fakeDeps();
  const ow = dw.paste;
  dw.paste = (id, t) => { ow(id, t); setImmediate(() => { dw.tabs.get(id).mouse = 1; }); };
  const rw = await createOpenTabService(dw).open({ projectPath: '/p', message: 'go', requestId: 'wheel' });
  assert.equal(rw.body.submitted, false);
  assert.match(rw.body.note, /mouse/);
  assert.equal(dw.log.filter((e) => e[0] === 'submit').length, 0);
  const dn = fakeDeps();
  assert.equal((await createOpenTabService(dn).open({ projectPath: '/p', message: 'Reply: 50% off! /cc #3', requestId: 'mode2' })).body.submitted, true, 'only the FIRST character matters');
  // A long multi-line message grows the box: still recognised, still sent.
  const d = fakeDeps();
  const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const r = await createOpenTabService(d).open({ projectPath: '/p', message: long, requestId: 'tall' });
  assert.equal(r.body.submitted, true);
  assert.equal(isClaudePromptReady([rule2, '❯ a', ...Array(30).fill('  b'), rule2, '  ? for shortcuts'], { bracketedPaste: true }), true);
  const forty = Array.from({ length: 41 }, (_, i) => `l${i}`).join('\n');
  assert.equal(boxHoldsMessage('[Pasted text #1 +40 lines]', forty), true, 'this card, collapsed');
  assert.equal(boxHoldsMessage('[Pasted text #1 +40 lines]', 'go'), false, 'a marker for some other text');
  assert.equal(boxHoldsMessage('[Pasted text #2 +40 lines]', forty), false, 'not this tab\'s first paste');
  assert.equal(boxHoldsMessage('hello there', 'hello there\nmore'), false, 'only part of the message');
  assert.equal(boxHoldsMessage('hello there\n  more', 'hello there\nmore'), true);
  assert.equal(boxHoldsMessage('go delete the backups', 'go'), false, 'a recalled history entry is not the message');
  assert.equal(boxHoldsMessage('[Pasted text #1 +40 lines] and more', 'x'), false, 'marker plus other text');
  assert.equal(boxHoldsMessage('', 'hello'), false);
  assert.equal(boxHoldsMessage('Hi', '\n\nHi'), true, 'leading blank lines');
  assert.equal(boxHoldsMessage('Reply    to Dom', 'Reply\tto Dom'), true, 'a tab drawn as spaces');
  assert.equal(boxHoldsMessage('Reply to Bob', 'Reply to Dom'), false);
  assert.equal(boxStillHasMessage('he\nllo', 'hello'), true, 'split by a stray newline: not sent');
  assert.equal(boxStillHasMessage('', 'hello'), false);
  assert.equal(boxStillHasMessage('Try "refactor ProjectView.jsx"', 'hello'), false, 'placeholder');
  assert.equal(boxStillHasMessage('Try "refactor ProjectView.jsx"', 'Try'), false, 'a placeholder that starts like the message');
  assert.equal(boxStillHasMessage(null, 'hello'), false);
  assert.equal(boxStillHasMessage(promptBoxText([rule2, '❯ a', '  >b', rule2], { bracketedPaste: true }), 'a>b'), true, 'a ">" on a later row is message text');
  assert.equal(boxStillHasMessage(promptBoxText([rule2, '❯ a', '  │b', rule2], { bracketedPaste: true }), 'a│b'), true, 'a "│" in the flat prompt is message text');
  assert.equal(promptBoxText(['╭────────╮', '│ > hi   │', '│ there  │', '╰────────╯'], { bracketedPaste: true }), 'hi\nthere', 'boxed prompt borders stripped');
  // The message itself may read like a dialog: only rows outside the box count.
  assert.equal(promptBoxText([rule2, '❯ Do you want to meet at 3? Esc to cancel', rule2, '  ? for shortcuts'], { bracketedPaste: true }), 'Do you want to meet at 3? Esc to cancel');
  assert.equal(promptBoxText([' Do you want to proceed?', rule2, '❯ hi', rule2], { bracketedPaste: true }), null);
  assert.equal(boxHoldsMessage(null, 'hello'), false);
  assert.equal(promptBoxText([rule2, '❯ a', '  b', rule2], { bracketedPaste: true }), 'a\nb');
  ok('Enter withheld unless everything still holds; tall box still sent');
}

{
  // Enter bound to "new line": the message stays in the box. Reported unsent.
  const d = fakeDeps();
  d.submit = (id) => d.log.push(['submit', id]);
  const r = await createOpenTabService(d).open({ projectPath: '/p', message: 'go', requestId: 'newline' });
  assert.equal(r.body.submitted, false);
  assert.match(r.body.note, /still in Claude's prompt/);
  assert.equal(d.log.filter((e) => e[0] === 'submit').length, 1);
  // A confirmation read that FAILS proves nothing: still not sent.
  const d2 = fakeDeps();
  const ow = d2.watchOutput;
  let submitted = false;
  d2.submit = (id) => { submitted = true; d2.log.push(['submit', id]); };
  d2.watchOutput = (id, c) => { const w = ow(id, c); const sc = w.screen; w.screen = async () => (submitted ? null : sc()); return w; };
  const r2 = await createOpenTabService(d2).open({ projectPath: '/p', message: 'go', requestId: 'newline2' });
  assert.equal(r2.body.submitted, false);
  // ...and neither does a frame with no recognisable input box (a repaint).
  const d3 = fakeDeps();
  d3.submit = (id) => { d3.log.push(['submit', id]); d3.tabs.get(id).frames.push({ lines: Array(20).fill('repainting'), modes: { bracketedPaste: true } }); };
  const r3 = await createOpenTabService(d3).open({ projectPath: '/p', message: 'go', requestId: 'newline3' });
  assert.equal(r3.body.submitted, false);
  // ...nor an empty box after someone typed (a Ctrl+C clears an unsent draft).
  const d4 = fakeDeps();
  d4.submit = (id) => { d4.log.push(['submit', id]); const t = d4.tabs.get(id); t.keys = 1; t.frames.push({ lines: [rule, '❯ ', rule], modes: { bracketedPaste: true } }); };
  const r4 = await createOpenTabService(d4).open({ projectPath: '/p', message: 'go', requestId: 'newline4' });
  assert.equal(r4.body.submitted, false);
  assert.match(r4.body.note, /someone typed/);
  // ...nor an empty box because the window is closing (its Ctrl+C is not a key).
  const d5 = fakeDeps();
  d5.submit = (id) => { d5.log.push(['submit', id]); const t = d5.tabs.get(id); t.alive = false; t.frames.push({ lines: [rule, '❯ ', rule], modes: { bracketedPaste: true } }); };
  const r5 = await createOpenTabService(d5).open({ projectPath: '/p', message: 'go', requestId: 'newline5' });
  assert.equal(r5.body.submitted, false);
  assert.match(r5.body.note, /tab closed/);
  ok('an Enter that did not send is reported as not sent');
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
// The token and the message never ride on a command line (ps shows argv to
// every local user): only builtins and files/stdin carry them.
const scriptText = buildOpenCliScript({ port, tokenFile });
assert.equal(/-H "Authorization/.test(scriptText), false);
assert.equal(/--data-binary "\$BODY"/.test(scriptText), false);
assert.equal(/sys\.argv/.test(scriptText.split('\n').find((l) => l.startsWith('BODY=')) || 'sys.argv'), false);
const run = (args, stdin) => new Promise((resolve) => {
  // A proxy in the environment must be ignored for the loopback bridge.
  const p = spawn(script, args, { env: { ...process.env, http_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9' } });
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
const big = 'é'.repeat(16384); // 32768 bytes of UTF-8: at the message cap
r = await run(['/p', 'card-4', '-'], big);
assert.equal(r.code, 1, 'reply ok:false still exits 1');
assert.equal(JSON.parse(seen.at(-1).body).message, big);
assert.ok(Buffer.byteLength(seen.at(-1).body) < 64 * 1024, 'body fits the bridge limit');
r = await run(['/p']);
assert.equal(r.code, 1);
assert.match(r.err, /usage/);
server.close();
fs.rmSync(dir, { recursive: true, force: true });
ok('dobius-open script end to end');

console.log(`\n${pass} passed`);
