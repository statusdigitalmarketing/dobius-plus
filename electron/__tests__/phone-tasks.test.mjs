// The phone's Commands, To-do and Asana on the Mac side: a revoked phone is refused before anything runs, Run from the
// phone goes through the Mac's own checks (placeholder, still waiting, syntax, pairing right before the spawn) and the
// script start, task writes need the exact task and the version the phone showed, Asana's words never reach the phone,
// and the views are gated on the Mac's feature flags. Run: npm run test:phonetasks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleTasksMessage, setTasksBridge, taskForPhone, taskPrint, commandsForPhone, actOnProjectTask, addProjectTask, projectSummaries, syncErrorCode } from '../mobile-tasks.js';
import { checkCommandRun, phoneRun, afterRunSpawn } from '../command-run.js';
import { TODAY_FEATURES } from '../mobile-today.js';
import { viewsFor, currentView } from '../../mobile/tasks-views.js';
import { commandPlaceholder } from '../../shared/placeholder.js';
import { commandPlaceholder as fromHandoff } from '../../shared/handoff.js';

const flush = () => new Promise((r) => setTimeout(r, 5));
const here = path.dirname(fileURLToPath(import.meta.url));

test('the Mac advertises the new views, and the phone shows only what the Mac advertises', () => {
  for (const f of ['commands', 'projectTasks', 'today']) assert.ok(TODAY_FEATURES.includes(f), f);
  assert.equal(viewsFor(undefined), null, 'not known yet');
  // A Mac from before Tasks on the phone: Today only.
  assert.deepEqual(viewsFor([]).map((v) => v.id), []);
  // A Mac from before this feature (2.3: today but no commands / projectTasks): Today and Inbox, nothing new.
  assert.deepEqual(viewsFor(['ack', 'today', 'settings']).map((v) => v.id), ['today', 'inbox']);
  assert.deepEqual(viewsFor(TODAY_FEATURES).map((v) => v.id), ['today', 'commands', 'todo', 'asana', 'inbox']);
  // A remembered view the Mac cannot show falls back to the first one it can.
  assert.equal(currentView(viewsFor(['today']), 'commands'), 'today');
  assert.equal(currentView(viewsFor(TODAY_FEATURES), 'asana'), 'asana');
  assert.equal(currentView(viewsFor([]), 'today'), null);
});

function rig(overrides = {}) {
  const calls = [];
  const rec = (name, ret) => (...a) => { calls.push([name, ...a]); return typeof ret === 'function' ? ret(...a) : ret; };
  setTasksBridge({
    listCommands: rec('listCommands', []),
    dismissCommand: rec('dismiss', true),
    runCommand: rec('run', { ok: true, termId: 'term-mobile-7' }),
    projectSummaries: rec('summaries', (l) => l),
    listTasks: rec('listTasks', [{ id: 'task-1', title: 'A', source: 'manual', events: [{ big: 1 }], sessionId: 's' }]),
    actOnTask: rec('act', { ok: true }),
    addTask: rec('add', { ok: true, id: 'task-2' }),
    syncAsana: rec('sync', { ok: true, added: 2 }),
    ...overrides,
  });
  return calls;
}
const ctx = { knownProjects: async () => [{ path: '/p/one', name: 'one' }], newTerminalId: () => 'term-mobile-7', authorizeTab: () => {} };

test('a revoked or unpaired phone is refused before anything reaches the Mac', async () => {
  const calls = rig();
  const out = [];
  const msgs = [
    { type: 'commandsList' }, { type: 'commandsDismiss', tabId: 't', id: 'c' }, { type: 'commandsRun', tabId: 't', id: 'c' },
    { type: 'tasksProjects' }, { type: 'projectTasksRead', project: '/p/one' }, { type: 'projectTaskAct', project: '/p/one', id: 'task-1', kind: 'complete', print: 'x' },
    { type: 'projectTaskAdd', project: '/p/one', title: 'x' }, { type: 'asanaSync', project: '/p/one' },
  ];
  for (const m of msgs) assert.equal(handleTasksMessage({ ...m, reqId: 'r' }, (x) => out.push(x), () => false, ctx), true, m.type);
  await flush();
  assert.equal(calls.length, 0, 'nothing reached the bridge');
  assert.equal(out.length, msgs.length);
  assert.ok(out.every((m) => m.ok === false && m.error === 'unavailable' && m.reqId === 'r'));
});

test('messages that are not ours are left alone; a missing bridge answers unavailable', async () => {
  rig();
  assert.equal(handleTasksMessage({ type: 'todayRead' }, () => {}, () => true, ctx), false);
  assert.equal(handleTasksMessage({ type: 'toString' }, () => {}, () => true, ctx), false);
  setTasksBridge(null);
  const out = [];
  assert.equal(handleTasksMessage({ type: 'commandsList', reqId: 'q' }, (m) => out.push(m), () => true, ctx), true);
  assert.deepEqual(out, [{ type: 'commands', reqId: 'q', ok: false, error: 'unavailable' }]);
});

test('projects: only one this Mac knows (the createTerminal allowlist); tasks go without their event log', async () => {
  const calls = rig();
  const out = [];
  const send = (m) => out.push(m);
  handleTasksMessage({ type: 'projectTasksRead', reqId: 'a', project: '/etc' }, send, () => true, ctx);
  handleTasksMessage({ type: 'projectTasksRead', reqId: 'b', project: 'main' }, send, () => true, ctx);
  handleTasksMessage({ type: 'projectTaskAdd', reqId: 'c', project: '/elsewhere', title: 'x' }, send, () => true, ctx);
  handleTasksMessage({ type: 'asanaSync', reqId: 'd', project: '/elsewhere' }, send, () => true, ctx);
  handleTasksMessage({ type: 'projectTaskAct', reqId: 'e', project: '/elsewhere', id: 'task-1', kind: 'delete', print: 'p' }, send, () => true, ctx);
  await flush();
  assert.ok(out.every((m) => m.ok === false && (m.error === 'unknown-project' || m.error === 'bad-request')), JSON.stringify(out));
  assert.equal(calls.length, 0);
  out.length = 0;
  handleTasksMessage({ type: 'projectTasksRead', reqId: 'f', project: '/p/one' }, send, () => true, ctx);
  await flush();
  assert.equal(out[0].ok, true);
  const [t] = out[0].tasks;
  assert.equal(t.id, 'task-1');
  assert.equal('events' in t || 'sessionId' in t, false);
  assert.equal(typeof t.print, 'string');
});

test('a task write needs the exact task and the version the phone showed, and the pairing right before it', () => {
  const tasks = [
    { id: 'task-1', title: 'Discard test deployment', done: false, stage: 'approval', source: 'manual' },
    { id: 'task-2', title: 'Ship it', done: true, stage: 'done', source: 'asana' },
    { id: 'task-3', title: 'Old', done: true, stage: 'approval', source: 'manual' },
  ];
  const calls = [];
  const svc = {
    listTasks: () => tasks,
    completeTaskByRef: (...a) => { calls.push(['complete', ...a]); return { ok: true }; },
    reopenTask: (...a) => { calls.push(['reopen', ...a]); return { ok: true }; },
    updateTask: (...a) => { calls.push(['update', ...a]); return { ok: true }; },
    deleteTask: (...a) => { calls.push(['delete', ...a]); return { ok: true }; },
    changed: (p) => calls.push(['changed', p]),
  };
  const print1 = taskPrint(tasks[0]);
  // A title substring is not an id: completeTaskByRef would have matched it by title.
  assert.deepEqual(actOnProjectTask({ project: '/p', id: 'Discard', kind: 'complete', print: print1 }, () => true, svc), { ok: false, error: 'not-found' });
  // Edited on the Mac since the phone looked.
  assert.deepEqual(actOnProjectTask({ project: '/p', id: 'task-1', kind: 'delete', print: taskPrint({ ...tasks[0], title: 'Production rollback' }) }, () => true, svc), { ok: false, error: 'changed' });
  assert.deepEqual(actOnProjectTask({ project: '/p', id: 'task-1', kind: 'delete', print: print1 }, () => false, svc), { ok: false, error: 'unavailable' });
  assert.equal(calls.length, 0, 'nothing written for any of those');
  assert.deepEqual(actOnProjectTask({ project: '/p', id: 'task-1', kind: 'complete', print: print1 }, () => true, svc), { ok: true });
  assert.deepEqual(calls.shift(), ['complete', '/p', 'task-1']);
  assert.deepEqual(calls.shift(), ['changed', '/p']);
  // Reopen: a pipeline-done task through reopenTask (stage and done together), a plain one through updateTask.
  actOnProjectTask({ project: '/p', id: 'task-2', kind: 'reopen', print: taskPrint(tasks[1]) }, () => true, svc);
  assert.equal(calls.shift()[0], 'reopen');
  calls.shift();
  actOnProjectTask({ project: '/p', id: 'task-3', kind: 'reopen', print: taskPrint(tasks[2]) }, () => true, svc);
  assert.deepEqual(calls.shift(), ['update', '/p', 'task-3', { done: false }]);
  calls.shift();
  actOnProjectTask({ project: '/p', id: 'task-1', kind: 'delete', print: print1 }, () => true, svc);
  assert.deepEqual(calls.shift(), ['delete', '/p', 'task-1']);
  // Adding while unpaired writes nothing.
  const adds = [];
  assert.deepEqual(addProjectTask('/p', 'x', () => false, { addTask: (...a) => adds.push(a), changed: () => {} }), { ok: false, error: 'unavailable' });
  assert.equal(adds.length, 0);
});

test('a task write request without the print it was shown is refused', async () => {
  const calls = rig();
  const out = [];
  handleTasksMessage({ type: 'projectTaskAct', reqId: 'a', project: '/p/one', id: 'task-1', kind: 'complete' }, (m) => out.push(m), () => true, ctx);
  handleTasksMessage({ type: 'projectTaskAct', reqId: 'b', project: '/p/one', id: 'task-1', kind: 'rm -rf', print: 'p' }, (m) => out.push(m), () => true, ctx);
  await flush();
  assert.ok(out.every((m) => m.error === 'bad-request'));
  assert.equal(calls.length, 0);
});

test('Asana sync: the phone gets a fixed code, never Asana\'s words or the key\'s place', async () => {
  assert.equal(syncErrorCode({ ok: false, noKey: true, error: 'No Asana key yet...' }), 'no-key');
  assert.equal(syncErrorCode({ ok: false, unauthorized: true, refused: { hint: 'ab12' }, error: 'Asana turned down the key ending ab12' }), 'unauthorized');
  assert.equal(syncErrorCode({ ok: false, error: 'Asana 500: <html>secret</html>' }), 'failed');
  rig({ syncAsana: async () => ({ ok: false, error: 'unauthorized' }) });
  const out = [];
  handleTasksMessage({ type: 'asanaSync', reqId: 's', project: '/p/one' }, (m) => out.push(m), () => true, ctx);
  await flush();
  assert.deepEqual(out, [{ type: 'asanaSyncResult', reqId: 's', ok: false, added: undefined, error: 'unauthorized' }]);
});

test('project list: busiest first, counts split into to-do and Asana, a non-path dropped', () => {
  const lists = { '/a': [], '/b': [{ source: 'manual' }, { source: 'asana' }, { source: 'manual', done: true }], '/c': [{ source: 'asana' }] };
  const r = projectSummaries([{ path: '/a', name: 'a' }, { path: '/b', name: 'b' }, { path: 'main', name: 'x' }, { path: '/c', name: 'c' }], (p) => lists[p]);
  assert.deepEqual(r, [{ path: '/b', name: 'b', pending: 1, asana: 1 }, { path: '/c', name: 'c', pending: 0, asana: 1 }, { path: '/a', name: 'a', pending: 0, asana: 0 }]);
});

test('the command list for the phone: the Mac\'s placeholder check comes with it, nothing the Mac keeps to itself', () => {
  const list = commandsForPhone([{ tabId: 'term-/p-1', projectPath: '/p', cwd: '/p', at: 1, commands: [
    { id: 'c1', text: 'echo <your-key>', why: 'set it', state: 'waiting', cwd: '/p', reply: 'r', at: 1 },
    { id: 'c2', text: 'ls', state: 'done', exit: 0, edited: true, runTabId: 'term-mobile-1', exitFile: '/tmp/x', ran: 'ls --secret' },
  ] }], () => ({ label: 'Tab 1', project: 'p' }));
  assert.equal(list[0].tabLabel, 'Tab 1');
  assert.equal(list[0].commands[0].hole, '<your-key>');
  assert.equal(list[0].commands[1].hole, null);
  const json = JSON.stringify(list);
  assert.ok(!json.includes('--secret') && !json.includes('/tmp/x'), 'the text that ran and the exit file never go');
});

// ---- Run from the phone ----

function runDeps(over = {}) {
  const calls = [];
  const cmd = { tabId: 'term-/p-1', projectPath: '/p', cwd: '/p/sub', text: 'echo hi' };
  const deps = {
    stillOk: () => true,
    peek: () => ({ ...cmd }),
    syntaxOk: () => true,
    shell: '/bin/zsh',
    newTerminalId: () => 'term-mobile-9',
    writeRunScript: (text, cwd, shown) => { calls.push(['write', text, cwd, shown]); return { file: '/run/dobius-run-aaaaaaaaaaaaaaaa.sh', cmdFile: '/run/dobius-run-aaaaaaaaaaaaaaaa.cmd', exitFile: '/run/x.exit' }; },
    spawn: (termId, script) => { calls.push(['spawn', termId, script]); return { id: termId }; },
    startRun: (...a) => calls.push(['startRun', ...a]),
    track: (...a) => calls.push(['track', ...a]),
    unlink: (f) => calls.push(['unlink', f]),
    authorizeTab: (id) => calls.push(['authorize', id]),
    watchStart: (id) => calls.push(['watch', id]),
    ...over,
  };
  return { deps, calls };
}
const req = { tabId: 'term-/p-1', id: 'c1' };

test('Run from the phone: the pairing is checked before anything, and again right before anything is written', () => {
  let { deps, calls } = runDeps({ stillOk: () => false });
  assert.deepEqual(phoneRun(req, deps), { ok: false, error: 'unavailable' });
  assert.equal(calls.length, 0);
  // Unpaired while bash -n ran.
  let n = 0;
  ({ deps, calls } = runDeps({ stillOk: () => (n += 1) === 1 }));
  assert.deepEqual(phoneRun(req, deps), { ok: false, error: 'unavailable' });
  assert.equal(calls.length, 0, 'no script written, no terminal started');
});

test('Run from the phone: a placeholder keeps Run off unless the person said it is real syntax', () => {
  let { deps, calls } = runDeps({ peek: () => ({ tabId: 't', projectPath: '/p', cwd: '/p', text: 'export KEY=<your-api-key>' }) });
  assert.deepEqual(phoneRun(req, deps), { ok: false, error: 'placeholder' });
  assert.equal(calls.length, 0);
  // An edit that still holds one, or adds one, is refused too.
  ({ deps, calls } = runDeps());
  assert.deepEqual(phoneRun({ ...req, edited: 'echo YOUR_TOKEN' }, deps), { ok: false, error: 'placeholder' });
  assert.equal(calls.length, 0);
  // "Run as is": only the placeholder check is skipped.
  ({ deps, calls } = runDeps({ peek: () => ({ tabId: 't', projectPath: '/p', cwd: '/p', text: 'echo <tag>' }) }));
  assert.equal(phoneRun({ ...req, asIs: true }, deps).ok, true);
  assert.equal(calls.filter((c) => c[0] === 'spawn').length, 1);
});

test('Run from the phone: only a waiting command, only one plain line, only valid shell, only zsh or bash', () => {
  for (const [over, r, code] of [
    [{ peek: () => null }, req, 'not-waiting'],
    [{}, { ...req, edited: 'echo a\necho b' }, 'bad-edit'],
    [{}, { ...req, edited: '   ' }, 'bad-edit'],
    [{ syntaxOk: () => false }, req, 'syntax'],
    [{ syntaxOk: () => false }, { ...req, edited: 'echo "oops' }, 'bad-edit-syntax'],
    [{ shell: '/opt/homebrew/bin/fish' }, req, 'shell'],
  ]) {
    const { deps, calls } = runDeps(over);
    assert.deepEqual(phoneRun(r, deps), { ok: false, error: code }, code);
    assert.equal(calls.length, 0, code);
  }
});

test('Run from the phone: the script start the Mac uses, then Running, the terminal authorized for this phone', () => {
  const { deps, calls } = runDeps();
  assert.deepEqual(phoneRun({ ...req, edited: 'echo sk-live-123' }, deps), { ok: true, termId: 'term-mobile-9' });
  const write = calls.find((c) => c[0] === 'write');
  // What runs is the edit; what the terminal SHOWS is the card's text marked edited (the edit may hold a key).
  assert.deepEqual(write, ['write', 'echo sk-live-123', '/p/sub', 'echo hi   (edited)']);
  assert.deepEqual(calls.map((c) => c[0]), ['write', 'spawn', 'startRun', 'track', 'watch', 'authorize']);
  assert.deepEqual(calls.find((c) => c[0] === 'startRun'), ['startRun', 'term-/p-1', 'c1', 'term-mobile-9', 'echo sk-live-123', '/run/x.exit']);
});

test('Run from the phone: a terminal that does not start leaves the command waiting and removes its files', () => {
  const { deps, calls } = runDeps({ spawn: () => { throw new Error('pty'); } });
  assert.deepEqual(phoneRun(req, deps), { ok: false, error: 'spawn-failed' });
  assert.deepEqual(calls.filter((c) => c[0] === 'unlink').map((c) => c[1]).sort(), ['/run/dobius-run-aaaaaaaaaaaaaaaa.cmd', '/run/dobius-run-aaaaaaaaaaaaaaaa.sh']);
  assert.equal(calls.some((c) => c[0] === 'startRun' || c[0] === 'authorize'), false);
  const w = runDeps({ writeRunScript: () => { throw new Error('disk'); } });
  assert.deepEqual(phoneRun(req, w.deps), { ok: false, error: 'write-failed' });
  assert.equal(w.calls.length, 0);
  // The Mac's own Run tab uses the same after-spawn step.
  const seen = [];
  assert.equal(afterRunSpawn(null, { file: 'a', cmdFile: 'b' }, 't', { startRun: () => seen.push('start'), track: () => {}, unlink: (f) => seen.push(f) }), false);
  assert.deepEqual(seen, ['a', 'b']);
});

test('Run from the phone over the socket: a second tap finds it already running; failures are codes only', async () => {
  let waiting = true;
  const spawned = [];
  rig({
    runCommand: (r, stillOk) => phoneRun(r, {
      ...runDeps().deps,
      stillOk,
      peek: () => (waiting ? { tabId: 't', projectPath: '/p', cwd: '/p', text: 'echo once' } : null),
      spawn: (id) => { spawned.push(id); return { id }; },
      startRun: () => { waiting = false; },
    }),
  });
  const out = [];
  handleTasksMessage({ type: 'commandsRun', reqId: '1', tabId: 't', id: 'c1' }, (m) => out.push(m), () => true, ctx);
  handleTasksMessage({ type: 'commandsRun', reqId: '2', tabId: 't', id: 'c1' }, (m) => out.push(m), () => true, ctx);
  await flush();
  assert.equal(spawned.length, 1);
  assert.deepEqual(out.map((m) => [m.reqId, m.ok, m.error]), [['1', true, undefined], ['2', false, 'not-waiting']]);
  // Oversized or non-string edits never reach the Mac's checks.
  const calls = rig();
  handleTasksMessage({ type: 'commandsRun', reqId: '3', tabId: 't', id: 'c1', edited: 'x'.repeat(5000) }, (m) => out.push(m), () => true, ctx);
  handleTasksMessage({ type: 'commandsRun', reqId: '4', tabId: 't', id: 'c1', edited: { toString: 1 } }, (m) => out.push(m), () => true, ctx);
  await flush();
  assert.equal(calls.length, 0);
});

test('the Mac\'s Run (prepare) and the phone\'s share one check', () => {
  const cmd = { text: 'echo <your-key>' };
  assert.equal(checkCommandRun({ cmd, syntaxOk: () => true, shell: '/bin/bash' }).code, 'placeholder');
  // The Mac's window still gets its full sentence, naming the placeholder.
  assert.match(checkCommandRun({ cmd, syntaxOk: () => true, shell: '/bin/bash' }).error, /Fill in <your-key> first/);
  assert.equal(checkCommandRun({ cmd, edited: 'echo real-key', syntaxOk: () => true, shell: '/bin/bash' }).text, 'echo real-key');
});

test('the placeholder rule loads on an old iPhone: no lookbehind regex literal anywhere the phone bundle imports', () => {
  assert.equal(fromHandoff, commandPlaceholder);
  assert.equal(commandPlaceholder('echo <your-key>'), '<your-key>');
  assert.equal(commandPlaceholder('git log main...HEAD'), null);
  // iOS 15 (the app's minimum) cannot parse (?<= or (?<! in a regex literal, which breaks the whole bundle.
  const root = path.join(here, '..', '..');
  const files = [
    ...fs.readdirSync(path.join(root, 'mobile')).filter((f) => /\.(jsx?|mjs)$/.test(f)).map((f) => path.join(root, 'mobile', f)),
    ...fs.readdirSync(path.join(root, 'shared')).filter((f) => /\.m?js$/.test(f)).map((f) => path.join(root, 'shared', f)),
  ];
  const imported = new Set();
  const visit = (f) => {
    if (imported.has(f) || !fs.existsSync(f)) return;
    imported.add(f);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)) visit(path.resolve(path.dirname(f), m[1]));
  };
  for (const f of files.filter((x) => x.includes(`${path.sep}mobile${path.sep}`))) visit(f);
  // Any lookbehind at all, except inside the one String.raw source that is compiled at run time.
  const bad = [...imported].filter((f) => fs.readFileSync(f, 'utf8').split('\n')
    .some((line) => /\(\?<[=!]/.test(line) && !line.startsWith('const PLACEHOLDER_SOURCE = String.raw`')));
  assert.deepEqual(bad, []);
  assert.ok([...imported].some((f) => f.endsWith(`shared${path.sep}placeholder.js`)), 'the phone does import the rule');
});

test('a task as the phone sees it', () => {
  const t = taskForPhone({ id: 'task-1', title: 'x', done: 1, url: 'javascript:alert(1)', dueOn: '2026-11-08T00:00', lane: 'evil', createdAt: 5 });
  assert.equal(t.done, false);
  assert.equal(t.url, null);
  assert.equal(t.dueOn, '2026-11-08');
  assert.equal(t.lane, null);
  assert.equal(t.createdAt, 5);
});
