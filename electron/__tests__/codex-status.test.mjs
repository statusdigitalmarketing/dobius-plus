// Codex tab status: hooks.json merge, hook-head parsing, session -> tab routing.
import {
  CODEX_HOOK_STATES, codexHookCommand, stripCodexHooks, withCodexHooks, hasCodexHooks,
  parseHookHead, createCodexStatusRouter, buildCodexStatusScript, CODEX_HOOK_OFF,
} from '../codex-status.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const SCRIPT = '/Users/x/Library/Application Support/dobius-plus/bin/dobius-codex-status';
const SID = '01a19796-c73b-7980-9753-f335183de8ad';
const SID2 = '01a19797-6517-7b41-8a4a-6e8e598d8a8e';

// --- hooks.json merge -------------------------------------------------------
{
  const user = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, other: 1 };
  const once = withCodexHooks(user, SCRIPT);
  check('user hook kept first', once.hooks.Stop[0].hooks[0].command, 'say done');
  check('ours appended for every event', Object.keys(CODEX_HOOK_STATES).every((e) => hasCodexHooks({ hooks: { [e]: once.hooks[e] } })), true);
  check('unrelated keys kept', once.other, 1);
  check('idempotent', JSON.stringify(withCodexHooks(once, SCRIPT)), JSON.stringify(once));
  check('strip of ours-last restores the user file', JSON.stringify(stripCodexHooks(once)), JSON.stringify(user));
  check('strip of a file with only ours leaves nothing', stripCodexHooks(withCodexHooks({}, SCRIPT)), {});
  check('not installed', hasCodexHooks(user), false);
  check('installed', hasCodexHooks(once), true);
  check('command quotes a path with spaces', codexHookCommand(SCRIPT, 'needs'),
    `test -x '${SCRIPT}' && '${SCRIPT}' needs || true # dobius-codex-status`);

  // Codex trusts a hook by its POSITION: a user hook added after ours must
  // keep its index when ours is upgraded or removed.
  const ours = (s) => ({ hooks: [{ type: 'command', command: codexHookCommand('/old/path', s) }] });
  const later = { hooks: [{ type: 'command', command: 'notify-me' }] };
  const before = { hooks: { Stop: [ours('done'), later] } };
  const up = withCodexHooks(before, SCRIPT);
  check('upgrade rewrites ours in place', up.hooks.Stop.map((g) => g.hooks[0].command),
    [codexHookCommand(SCRIPT, 'done'), 'notify-me']);
  const off = stripCodexHooks(up);
  check('removal leaves a placeholder so the user hook keeps index 1', off.hooks.Stop.map((g) => g.hooks[0].command),
    [CODEX_HOOK_OFF, 'notify-me']);
  check('a placeholder is not "installed"', hasCodexHooks(off), false);
  check('re-enabling reuses the placeholder slot', withCodexHooks(off, SCRIPT).hooks.Stop.map((g) => g.hooks[0].command),
    [codexHookCommand(SCRIPT, 'done'), 'notify-me']);
  const mixed = { hooks: { Stop: [{ hooks: [{ type: 'command', command: codexHookCommand(SCRIPT, 'done') }, { type: 'command', command: 'say hi' }] }] } };
  check('ours inside a user group becomes a placeholder (handler index kept)', stripCodexHooks(mixed).hooks.Stop[0].hooks.map((h) => h.command), [CODEX_HOOK_OFF, 'say hi']);
  const mixedLast = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }, { type: 'command', command: codexHookCommand(SCRIPT, 'done') }] }] } };
  check('ours last inside a user group is removed', stripCodexHooks(mixedLast).hooks.Stop[0].hooks.map((h) => h.command), ['say hi']);
  const stale = { hooks: { Interrupt: [ours('done')], Stop: [ours('done')] } };
  check('an event we no longer use is switched off', withCodexHooks(stale, SCRIPT).hooks.Interrupt, undefined);
}

// --- hook head parsing --------------------------------------------------------
{
  const head = `{"session_id":"${SID}","turn_id":"t","transcript_path":"/Users/x/.codex/sessions/2026/11/01/rollout-a-${SID}.jsonl","cwd":"/p","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo \\"session_id\\":\\"${SID2}\\" \\"tool_use_id\\":\\"fake\\""},"tool_use_id":"exec-1"}`;
  const h = parseHookHead(head);
  check('top-level fields', [h?.sessionId, h?.event, h?.toolUseId], [SID, 'PreToolUse', 'exec-1']);
  check('transcript path', h?.transcriptPath, `/Users/x/.codex/sessions/2026/11/01/rollout-a-${SID}.jsonl`);
  check('truncated head still parses', parseHookHead(head.slice(0, 160))?.sessionId, SID);
  check('no session id -> null', parseHookHead('{"turn_id":"x"}'), null);
  check('not a string -> null', parseHookHead(undefined), null);
}

// --- routing --------------------------------------------------------------------
const INFO = {
  tabA: { cwd: '/p/one', startedAt: 10, sessionId: null, pid: 101 },
  tabB: { cwd: '/p/two', startedAt: 20, sessionId: null, pid: 202 },
  tabC: null,
};
function mkRouter(over = {}) {
  const applied = [];
  const timers = [];
  let t = 100000;
  const enter = { tabA: t - 1000, tabB: t - 1000 };
  const answer = {};
  const deps = {
    liveIds: () => ['tabA', 'tabB', 'tabC'],
    codexInfo: async (id) => INFO[id],
    sessionFor: async ({ cwd }) => (cwd === '/p/one' ? SID : cwd === '/p/two' ? SID2 : null),
    rolloutMeta: async (_p, sid) => (sid === SID ? { sessionId: SID, cwd: '/p/one', isExec: false }
      : sid === SID2 ? { sessionId: SID2, cwd: '/p/two', isExec: false } : null),
    lastEnterAt: (id) => enter[id] || 0,
    lastAnswerAt: (id) => answer[id] || 0,
    apply: (id, s, tag) => applied.push(tag ? [id, s, tag] : [id, s]),
    now: () => t,
    later: (fn, ms) => timers.push({ fn, ms }),
    ...over,
  };
  return { router: createCodexStatusRouter(deps), applied, timers, enter, answer, tick: (ms) => { t += ms; } };
}
const ev = (sid, event, toolUseId) => `{"session_id":"${sid}","transcript_path":"/x/rollout-${sid}.jsonl","hook_event_name":"${event}"${toolUseId ? `,"tool_use_id":"${toolUseId}"` : ''}}`;
const send = (router, sid, event, id) => router.handle(CODEX_HOOK_STATES[event] || 'working', ev(sid, event, id));
const flush = async (timers) => { while (timers.length) { const { fn } = timers.shift(); fn(); await new Promise((r) => setTimeout(r, 0)); } };

{
  const { router, applied } = mkRouter();
  await send(router, SID, 'UserPromptSubmit');
  await send(router, SID, 'PreToolUse', 'e1');
  await send(router, SID, 'PermissionRequest');
  check('a turn in tab A: working, working, red', applied, [['tabA', 'working'], ['tabA', 'working'], ['tabA', 'needs']]);
  await send(router, SID, 'PostToolUse', 'e1');
  await send(router, SID, 'Stop');
  check('approved then finished: working, green', applied.slice(3), [['tabA', 'working'], ['tabA', 'done']]);
  await send(router, SID2, 'UserPromptSubmit');
  check('another session, its own tab', applied.at(-1), ['tabB', 'working']);
  check('bad state refused', (await router.handle('red', ev(SID, 'Stop'))).ok, false);
}
{
  // Order: a slow first lookup must not let the second event apply first.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { router, applied } = mkRouter({ rolloutMeta: async () => { await gate; return { sessionId: SID, cwd: '/p/one', isExec: false }; } });
  const a = send(router, SID, 'PreToolUse', 'e1');
  const b = send(router, SID, 'PermissionRequest');
  release();
  await Promise.all([a, b]);
  check('events apply in arrival order', applied, [['tabA', 'working'], ['tabA', 'needs']]);
}
{
  const calls = [];
  const { router, applied } = mkRouter({ rolloutMeta: async (p, sid) => { calls.push(sid); return { sessionId: sid, cwd: '/p/one', isExec: true }; } });
  await send(router, SID, 'UserPromptSubmit');
  await send(router, SID, 'Stop');
  check('codex exec sessions are ignored', applied, []);
  check('and not looked up again', calls.length, 1);
}
{
  // Finding 2: a Codex OUTSIDE Dobius in the same folder as tab A.
  const { router, applied, enter } = mkRouter();
  enter.tabA = 0; // nothing typed in tab A
  INFO.tabA.startedAt = 10;
  await send(router, SID, 'UserPromptSubmit');
  await send(router, SID, 'PermissionRequest');
  check('a session no tab submitted is never routed', applied, []);
}
{
  // Two Codex TUIs in one folder that both just had Enter: no dot.
  const { router, applied } = mkRouter({
    codexInfo: async (id) => (id === 'tabC' ? null : { cwd: '/p/one', startedAt: 10, sessionId: null, pid: id === 'tabA' ? 1 : 2 }),
  });
  await send(router, SID, 'UserPromptSubmit');
  check('ambiguous folder colours nothing', applied, []);
}
{
  const { router, applied } = mkRouter({
    codexInfo: async (id) => (id === 'tabB' ? { cwd: '/p/one', startedAt: 10, sessionId: SID, pid: 2 } : id === 'tabA' ? { cwd: '/p/one', startedAt: 10, sessionId: null, pid: 1 } : null),
  });
  await send(router, SID, 'PermissionRequest');
  check('argv resume id picks the tab', applied, [['tabB', 'needs']]);
}
{
  // Finding 1: the owner is the PROCESS, not just the tab.
  let pid = 101;
  const { router, applied } = mkRouter({
    codexInfo: async (id) => (id === 'tabA' ? { ...INFO.tabA, pid, startedAt: pid === 101 ? 10 : 90000 } : INFO[id]),
    // The new process started after the session's last write, so its rollout is not that one.
    sessionFor: async ({ cwd, startedAt }) => (cwd === '/p/one' && startedAt < 50 ? SID : null),
  });
  await send(router, SID, 'UserPromptSubmit');
  pid = 999; // Codex quit in tab A and another one started there
  await send(router, SID, 'PermissionRequest');
  check('a later Codex in the same tab does not inherit the session', applied, [['tabA', 'working']]);
}
{
  // Finding 9: the red is retried until the rollout is readable.
  let readable = false;
  const { router, applied, timers } = mkRouter({ rolloutMeta: async (_p, sid) => (readable ? { sessionId: sid, cwd: '/p/one', isExec: false } : null) });
  await send(router, SID, 'PreToolUse', 'e1');
  await send(router, SID, 'PermissionRequest');
  check('nothing applied yet', applied, []);
  readable = true;
  await flush(timers);
  check('the red lands on retry', applied.at(-1), ['tabA', 'needs']);
}
{
  // Finding 6: Enter pressed before the red was applied.
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = mkRouter({ rolloutMeta: async (_p, sid) => { await gate; return { sessionId: sid, cwd: '/p/one', isExec: false }; } });
  const p = send(m.router, SID, 'PermissionRequest');
  m.tick(500); m.answer.tabA = 100000 + 500;
  release(); await p;
  check('an answer typed after the event cancels its red', m.applied, []);
}
{
  // Finding 8: a tool that was already running finishes while another waits.
  const { router, applied, tick } = mkRouter();
  await send(router, SID, 'UserPromptSubmit');
  await send(router, SID, 'PreToolUse', 'slow');
  await send(router, SID, 'PreToolUse', 'needsok');
  await send(router, SID, 'PermissionRequest');
  await send(router, SID, 'PostToolUse', 'slow');
  check('the other tool finishing keeps the tab red', applied.at(-1), ['tabA', 'needs']);
  await send(router, SID, 'PostToolUse', 'needsok');
  check('its own PostToolUse clears it', applied.at(-1), ['tabA', 'working']);
  await send(router, SID, 'PreToolUse', 'x');
  await send(router, SID, 'PermissionRequest');
  await send(router, SID, 'PreToolUse', 'sibling');
  check('a sibling started in the same burst keeps it red', applied.at(-1), ['tabA', 'needs']);
  tick(3000); // a person reads the box and says no
  await send(router, SID, 'PreToolUse', 'y');
  check('a new tool after a denial clears it', applied.at(-1), ['tabA', 'working']);
}
{
  let live = ['tabA', 'tabB'];
  const { router, applied } = mkRouter({ liveIds: () => live });
  await send(router, SID, 'UserPromptSubmit');
  live = ['tabB'];
  await send(router, SID, 'Stop');
  check('a closed tab is dropped', applied, [['tabA', 'working']]);
}

{
  // Codex 0.166: no rollout yet when the prompt is submitted. The claim made
  // on the next event still uses the prompt's Enter evidence.
  let readable = false;
  const m = mkRouter({
    rolloutMeta: async (_p, sid) => (readable ? { sessionId: sid, cwd: '/p/one', isExec: false } : null),
    sessionFor: async () => null, // the mtime fallback cannot see it either
  });
  await send(m.router, SID, 'UserPromptSubmit');
  readable = true;
  await send(m.router, SID, 'PreToolUse', 'e1');
  check('claimed on the next event by the prompt\'s Enter', m.applied, [['tabA', 'working']]);
}
{
  // A detached session (its window quit) is reclaimed only by `codex resume <id>`.
  let pid = 101; let resumedIn = null;
  const { router, applied, tick } = mkRouter({
    codexInfo: async (id) => {
      if (id === 'tabA') return { ...INFO.tabA, pid };
      if (id === 'tabB' && resumedIn === 'tabB') return { cwd: '/p/one', startedAt: 99999, sessionId: SID, pid: 303 };
      return INFO[id];
    },
  });
  await send(router, SID, 'UserPromptSubmit');
  pid = 404; // the window that ran it quit; a new Codex runs in tab A
  await send(router, SID, 'PreToolUse', 'e2');
  check('a detached session colours no tab', applied, [['tabA', 'working']]);
  resumedIn = 'tabB';
  tick(6000); // an unowned session looks for a resume at most every 5s
  await send(router, SID, 'PermissionRequest');
  check('codex resume <id> in tab B brings it back there', applied.at(-1), ['tabB', 'needs']);
}

{
  // Review r1 lens 1 #1: a tab whose argv names ANOTHER session is not claimed
  // by Enter evidence.
  const { router, applied } = mkRouter({
    codexInfo: async (id) => (id === 'tabA' ? { cwd: '/p/one', startedAt: 10, sessionId: SID2, pid: 1 } : null),
  });
  await send(router, SID, 'UserPromptSubmit');
  await send(router, SID, 'PermissionRequest');
  // `codex resume SID2` then /new: the new session is this tab's, by its Enter.
  check('a resumed tab that started a new session (/new) is claimed by it', applied, [['tabA', 'working'], ['tabA', 'needs']]);
}
{
  // #2: a session first seen outside Dobius can still be resumed in a tab.
  let resumed = false;
  const { router, applied, enter, tick } = mkRouter({
    codexInfo: async (id) => (id === 'tabA' ? { cwd: '/p/one', startedAt: 10, sessionId: resumed ? SID : null, pid: resumed ? 7 : 1 } : null),
  });
  enter.tabA = 0;
  await send(router, SID, 'UserPromptSubmit');
  check('outside session: no dot', applied, []);
  resumed = true; tick(6000);
  await send(router, SID, 'PermissionRequest');
  check('then `codex resume` in tab A claims it', applied, [['tabA', 'needs']]);
}
{
  // #3: the tab's Codex changed while the lookup was in flight.
  let pid = 101; let probes = 0;
  const { router, applied } = mkRouter({
    codexInfo: async (id) => { if (id !== 'tabA') return INFO[id]; probes += 1; const p = pid; if (probes === 1) pid = 202; return { ...INFO.tabA, pid: p }; },
  });
  await send(router, SID, 'UserPromptSubmit');
  check('a claim on a process that just went away is not applied', applied, []);
}
{
  // #4: parallel tools, the approval belongs to the tool with the same command.
  const { router, applied } = mkRouter();
  const evc = (event, id, cmd) => router.handle(CODEX_HOOK_STATES[event], `{"session_id":"${SID}","transcript_path":"/x/rollout-${SID}.jsonl","hook_event_name":"${event}","tool_name":"Bash","tool_input":{"command":"${cmd}"}${id ? `,"tool_use_id":"${id}"` : ''}}`);
  await send(router, SID, 'UserPromptSubmit');
  await evc('PreToolUse', 'A', 'rm -rf build');
  await evc('PreToolUse', 'B', 'ls');
  await evc('PermissionRequest', null, 'rm -rf build');
  await evc('PostToolUse', 'B', 'ls');
  check('B finishing does not answer A', applied.at(-1), ['tabA', 'needs']);
  await evc('PostToolUse', 'A', 'rm -rf build');
  check('A finishing does', applied.at(-1), ['tabA', 'working']);
}
{
  // Lens 3 #4/#5: oversized ids are not kept; a flooded session is capped.
  const { router } = mkRouter({ codexInfo: async () => new Promise(() => {}) }); // lookups never finish
  const big = 'x'.repeat(5000);
  const results = [];
  for (let i = 0; i < 70; i += 1) results.push(router.handle('working', `{"session_id":"${SID}","hook_event_name":"PreToolUse","tool_use_id":"${big}${i}"}`));
  const settled = await Promise.race([Promise.all(results.slice(64)), new Promise((r) => setTimeout(() => r('pending'), 50))]);
  check('events past the per-session queue cap are refused at once', settled === 'pending' ? 'pending' : settled.map((r) => r.error), ['queue full', 'queue full', 'queue full', 'queue full', 'queue full', 'queue full']);
  check('an oversized tool id is not parsed', parseHookHead(`{"session_id":"${SID}","tool_use_id":"${big}"}`).toolUseId, null);
}

{
  // Round 2: long commands sharing a 200+ char prefix are different tools.
  const { router, applied } = mkRouter();
  const pad = ' '.repeat(300);
  const evc = (event, id, cmd) => router.handle(CODEX_HOOK_STATES[event], `{"session_id":"${SID}","transcript_path":"/x/rollout-${SID}.jsonl","hook_event_name":"${event}","tool_name":"Bash","tool_input":{"command":"${pad}${cmd}"}${id ? `,"tool_use_id":"${id}"` : ''}}`);
  await send(router, SID, 'UserPromptSubmit');
  await evc('PreToolUse', 'A', 'rm -rf build');
  await evc('PreToolUse', 'B', 'ls');
  await evc('PermissionRequest', null, 'rm -rf build');
  await evc('PostToolUse', 'B', 'ls');
  check('a shared long prefix does not confuse the tools', applied.at(-1), ['tabA', 'needs']);
}
{
  // Round 2: a resume during the unowned cooldown still gets its red.
  let resumed = false;
  const { router, applied, enter } = mkRouter({
    codexInfo: async (id) => (id === 'tabA' ? { cwd: '/p/one', startedAt: 10, sessionId: resumed ? SID : null, pid: resumed ? 7 : 1 } : null),
  });
  enter.tabA = 0;
  await send(router, SID, 'UserPromptSubmit'); // seen outside Dobius: unowned now
  resumed = true; // `codex resume` a second later, inside the cooldown
  await send(router, SID, 'PermissionRequest');
  check('the red skips the cooldown', applied, [['tabA', 'needs']]);
}
{
  // Round 2: a transcript_path nested in tool_input is not the hook's own.
  const h = parseHookHead(`{"session_id":"${SID}","hook_event_name":"PreToolUse","tool_input":{"transcript_path":"/tmp/x.jsonl"}}`);
  check('nested transcript_path ignored', h.transcriptPath, null);
}

{
  // Round 3: the Enter that ran `codex resume` is not an answer to the red.
  let resumed = false;
  const m = mkRouter({
    codexInfo: async (id) => (id === 'tabA' ? { cwd: '/p/one', startedAt: resumed ? 102000 : 10, sessionId: resumed ? SID : null, pid: resumed ? 7 : 1 } : null),
  });
  m.enter.tabA = 0;
  await send(m.router, SID, 'UserPromptSubmit');
  m.tick(1000);
  const p = send(m.router, SID, 'PermissionRequest');
  resumed = true; m.answer.tabA = 100000 + 2000; // Enter on `codex resume <id>`, as that Codex starts
  await p;
  check('a resumed session keeps its red', m.applied, [['tabA', 'needs']]);
}
{
  // ...but an approval typed once the resumed Codex is up does answer it.
  let resumed = false;
  const m = mkRouter({
    codexInfo: async (id) => (id === 'tabA' ? { cwd: '/p/one', startedAt: resumed ? 102000 : 10, sessionId: resumed ? SID : null, pid: resumed ? 7 : 1 } : null),
  });
  m.enter.tabA = 0;
  await send(m.router, SID, 'UserPromptSubmit');
  m.tick(1000);
  const p = send(m.router, SID, 'PermissionRequest');
  resumed = true; m.answer.tabA = 100000 + 6000; // approved 4s after the resume started
  await p;
  check('a real answer after the resume still cancels the red', m.applied, []);
}

{
  // A Codex turn that ends handing back a `! command` is red, tagged handoff.
  const { router, applied } = mkRouter();
  await send(router, SID, 'UserPromptSubmit');
  await router.handle('done', `{"session_id":"${SID}","transcript_path":"/x/rollout-${SID}.jsonl","hook_event_name":"Stop","last_assistant_message":"Blocked by the sandbox. Run this yourself:\\n! gh pr merge 12 --squash"}`);
  check('handoff Stop is red', applied.at(-1), ['tabA', 'needs', 'handoff']);
  await send(router, SID, 'UserPromptSubmit');
  await router.handle('done', `{"session_id":"${SID}","transcript_path":"/x/rollout-${SID}.jsonl","hook_event_name":"Stop","last_assistant_message":"Done, the tests pass."}`);
  check('a plain Stop is green', applied.at(-1), ['tabA', 'done']);
}

{
  // A digit typed while copying a handed-back command is no answer to it.
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = mkRouter({ rolloutMeta: async (_p, sid) => { await gate; return { sessionId: sid, cwd: '/p/one', isExec: false }; } });
  const p = m.router.handle('done', `{"session_id":"${SID}","transcript_path":"/x/rollout-${SID}.jsonl","hook_event_name":"Stop","last_assistant_message":"Run:\\n! gh pr merge 12"}`);
  m.tick(500); m.answer.tabA = 100000 + 500; // a digit, recorded as a prompt answer
  release(); await p;
  check('a handoff survives a digit typed while it was routed', m.applied.at(-1), ['tabA', 'needs', 'handoff']);
}

// --- the installed script against a real HTTP server ---------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-status-'));
  const tokenFile = path.join(dir, 'tok en');
  fs.writeFileSync(tokenFile, 'a'.repeat(64));
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { got.push({ url: req.url, state: req.headers['x-dobius-codex-state'], auth: req.headers.authorization, len: body.length, sid: parseHookHead(body)?.sessionId }); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const script = path.join(dir, 'dobius-codex-status');
  fs.writeFileSync(script, buildCodexStatusScript({ port, tokenFile }), { mode: 0o755 });
  const big = `{"session_id":"${SID}","transcript_path":"${dir}/rollout-${SID}.jsonl","tool_input":"${'x'.repeat(300000)}"}`;
  const runHook = (cmd, input) => new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.on('error', (e) => { stderr += `stdin ${e.code}`; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  const out = await runHook(codexHookCommand(script, 'needs'), big);
  check('script prints nothing, exits 0, reads all 300KB (no EPIPE)', [out.status, out.stdout, out.stderr], [0, '', '']);
  check('server got the head with state + token', got.map((g) => [g.url, g.state, g.auth, g.len, g.sid]),
    [['/codexStatus', 'needs', `Bearer ${'a'.repeat(64)}`, 65536, SID]]);
  const ephemeral = await runHook(codexHookCommand(script, 'done'), `{"session_id":"${SID}","hook_event_name":"Stop"}`);
  fs.writeFileSync(path.join(dir, `rollout-x-${SID2}.jsonl`), '{"type":"session_meta","payload":{"id":"x","originator":"codex_exec"}}\n');
  const execRun = await runHook(codexHookCommand(script, 'done'), `{"session_id":"${SID2}","transcript_path":"${dir}/rollout-x-${SID2}.jsonl"}`);
  const nested = await runHook(codexHookCommand(script, 'working'), `{"session_id":"${SID}","hook_event_name":"PreToolUse","tool_input":{"transcript_path":"/tmp/nope-${SID}.jsonl"}}`);
  await new Promise((r) => setTimeout(r, 200));
  check('no transcript (ephemeral exec), a nested one, and codex exec send nothing', [ephemeral.status, nested.status, execRun.status, got.length], [0, 0, 0, 1]);
  check('the token never appears in the helper\'s argv', fs.readFileSync(script, 'utf8').includes('-H "Authorization'), false);
  server.close();
  const missing = await runHook(codexHookCommand(path.join(dir, 'gone'), 'done'), '{}');
  check('a missing script is a silent success', [missing.status, missing.stdout, missing.stderr], [0, '', '']);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
