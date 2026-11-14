import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  carryOverFlags, requestIdFor, cardFor, answerMisfit, resultFor, createPermissionRouter, createInputQueue,
  resolveEntrypoint, DENY_TEXT, TOO_MANY_TEXT,
} from '../phone-runner-core.mjs';
import { validateAnswer } from '../phone-protocol.js';

const ans = (a) => { const r = validateAnswer(a); assert.equal(r.ok, true, JSON.stringify(a)); return r.value; };
const ASK = { questions: [
  { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
  { question: 'Size?', header: 'Size', multiSelect: true, options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] },
] };

test('entrypoint: remote_mobile unless the shell already set one', () => {
  assert.equal(resolveEntrypoint(undefined), 'remote_mobile');
  assert.equal(resolveEntrypoint(''), 'remote_mobile');
  assert.equal(resolveEntrypoint('cli'), 'cli');
});

test('carryOverFlags: allowlisted mode and model, last wins, anything else dropped', () => {
  assert.deepEqual(carryOverFlags(['--resume', 'x', '--permission-mode', 'acceptEdits', '--model', 'opus']), { permissionMode: 'acceptEdits', model: 'opus' });
  assert.deepEqual(carryOverFlags(['--dangerously-skip-permissions']), { permissionMode: 'bypassPermissions', model: null });
  assert.deepEqual(carryOverFlags(['--permission-mode=plan', '--model=claude-opus-5-5[1m]']), { permissionMode: 'plan', model: 'claude-opus-5-5[1m]' });
  assert.deepEqual(carryOverFlags(['--permission-mode', 'acceptEdits', '--permission-mode', 'evil']), { permissionMode: null, model: null });
  assert.deepEqual(carryOverFlags(['--model', 'opus; rm -rf ~']), { permissionMode: null, model: null });
  assert.deepEqual(carryOverFlags(['--model']), { permissionMode: null, model: null });
  assert.deepEqual(carryOverFlags('--model opus'), { permissionMode: null, model: null });
});

test('requestIdFor: scoped by subagent, hashed when not printable', () => {
  assert.equal(requestIdFor({ toolUseID: 'toolu_1' }), 'toolu_1');
  assert.equal(requestIdFor({ toolUseID: 'toolu_1', agentID: 'a7' }), 'a7:toolu_1');
  assert.match(requestIdFor({ toolUseID: 'has space' }), /^r_[0-9a-f]{40}$/);
  assert.match(requestIdFor({ toolUseID: 'x'.repeat(300) }), /^r_[0-9a-f]{40}$/);
});

test('cards: question, plan and permission, with the SDK flags respected', () => {
  const q = cardFor('AskUserQuestion', ASK, { toolUseID: 't1' });
  assert.equal(q.kind, 'question');
  assert.deepEqual(q.questions.map((x) => x.question), ['Which color?', 'Size?']);
  assert.equal(q.questions[1].multiSelect, true);
  const p = cardFor('ExitPlanMode', { plan: 'x'.repeat(20000) }, { toolUseID: 't2' });
  assert.equal(p.kind, 'plan');
  assert.ok(p.summary.length <= 16384 + 3);
  const perm = cardFor('Bash', { command: 'ls' }, { toolUseID: 't3', title: 'Claude wants to run ls', suggestions: [{ type: 'addRules' }], mcpServer: { name: '<b>srv</b>', source: 'user' } });
  assert.equal(perm.kind, 'permission');
  assert.equal(perm.canAlways, true);
  assert.equal(perm.title, 'Claude wants to run ls');
  assert.equal(perm.mcpServer, '<b>srv</b>'); // carried as text; the phone never renders markup
  assert.equal(cardFor('Bash', {}, { toolUseID: 't', suggestions: [{}], suppressAlwaysAllowRule: true }).canAlways, false);
  assert.equal(cardFor('Bash', {}, { toolUseID: 't' }).canAlways, false);
  assert.equal(cardFor('Bash', {}, { toolUseID: 't', defaultToNo: true }).defaultToNo, true);
  assert.ok(cardFor('Write', { content: 'y'.repeat(10000) }, { toolUseID: 't' }).input.length <= 4096 + 3);
});

test('answerMisfit: every question and only those; Always only when offered; kinds must match', () => {
  const q = cardFor('AskUserQuestion', ASK, { toolUseID: 't1' });
  assert.equal(answerMisfit(q, ans({ kind: 'question', answers: { 'Which color?': 'Red', 'Size?': 'S, L' } })), null);
  assert.match(answerMisfit(q, ans({ kind: 'question', answers: { 'Which color?': 'Red' } })), /every question/);
  assert.match(answerMisfit(q, ans({ kind: 'question', answers: { 'Which color?': 'Red', 'Size?': 'S', Other: 'x' } })), /every question/);
  assert.match(answerMisfit(q, ans({ kind: 'permission', allow: true })), /does not match/);
  const perm = cardFor('Bash', {}, { toolUseID: 't' });
  assert.match(answerMisfit(perm, ans({ kind: 'permission', allow: true, always: true })), /not offered/);
});

test('resultFor: the SDK results for each answer', () => {
  const input = { questions: ASK.questions };
  const q = cardFor('AskUserQuestion', input, { toolUseID: 't1' });
  const r = resultFor(q, ans({ kind: 'question', answers: { 'Which color?': 'Teal (typed)', 'Size?': 'S, L' } }), input);
  assert.equal(r.behavior, 'allow');
  assert.deepEqual({ ...r.updatedInput.answers }, { 'Which color?': 'Teal (typed)', 'Size?': 'S, L' });
  assert.equal(Object.getPrototypeOf(r.updatedInput.answers), null);
  assert.equal(r.updatedInput.questions, input.questions);
  const perm = cardFor('Bash', { command: 'ls' }, { toolUseID: 't', suggestions: [{ type: 'addRules' }] });
  const sugg = [{ type: 'addRules' }];
  assert.deepEqual(resultFor(perm, ans({ kind: 'permission', allow: true, always: true }), { command: 'ls' }, sugg), { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: sugg, decisionClassification: 'user_permanent' });
  assert.deepEqual(resultFor(perm, ans({ kind: 'permission', allow: false }), {}), { behavior: 'deny', message: DENY_TEXT, decisionClassification: 'user_reject' });
  assert.equal(resultFor(perm, ans({ kind: 'permission', allow: false, note: 'use foo' }), {}).message, 'use foo');
  const plan = cardFor('ExitPlanMode', { plan: 'p' }, { toolUseID: 'p1' });
  assert.equal(resultFor(plan, ans({ kind: 'plan', approve: true }), { plan: 'p' }).behavior, 'allow');
  assert.equal(resultFor(plan, ans({ kind: 'plan', approve: false, note: 'more tests' }), {}).message, 'more tests');
});

function router(extra = {}) {
  const cards = [], gone = [], modes = [];
  const r = createPermissionRouter({ onCard: (c) => cards.push(c), onGone: (id, why) => gone.push([id, why]), setMode: async (m) => { modes.push(m); }, ...extra });
  return { r, cards, gone, modes };
}

test('router: a card per request, answered once, a second answer refused', async () => {
  const { r, cards } = router();
  const p = r.canUseTool('Bash', { command: 'ls' }, { toolUseID: 't1' });
  assert.equal(cards.length, 1);
  assert.deepEqual(await r.answer('t1', ans({ kind: 'permission', allow: true })), { ok: true });
  assert.equal((await p).behavior, 'allow');
  assert.equal((await r.answer('t1', ans({ kind: 'permission', allow: true }))).code, 'not_pending');
  assert.equal((await r.answer('nope', ans({ kind: 'permission', allow: true }))).code, 'not_pending');
});

test('router: a misfit answer leaves the request pending', async () => {
  const { r } = router();
  const p = r.canUseTool('AskUserQuestion', ASK, { toolUseID: 'q1' });
  assert.equal((await r.answer('q1', ans({ kind: 'question', answers: { 'Which color?': 'Red' } }))).code, 'bad_answer');
  assert.equal(r.size(), 1);
  await r.answer('q1', ans({ kind: 'question', answers: { 'Which color?': 'Red', 'Size?': 'L' } }));
  assert.equal((await p).behavior, 'allow');
});

test('router: plan approval switches mode before allowing; default when none chosen', async () => {
  const { r, modes } = router();
  const p1 = r.canUseTool('ExitPlanMode', { plan: 'x' }, { toolUseID: 'p1' });
  await r.answer('p1', ans({ kind: 'plan', approve: true, mode: 'acceptEdits' }));
  assert.equal((await p1).behavior, 'allow');
  const p2 = r.canUseTool('ExitPlanMode', { plan: 'x' }, { toolUseID: 'p2' });
  await r.answer('p2', ans({ kind: 'plan', approve: true }));
  await p2;
  assert.deepEqual(modes, ['acceptEdits', 'default']);
});

test('router: a cancel during the mode switch wins; the approval is refused, never allowed late', async () => {
  let release;
  const { r, gone } = router({ setMode: () => new Promise((res) => { release = res; }) });
  const p = r.canUseTool('ExitPlanMode', { plan: 'x' }, { toolUseID: 'p1' });
  const answering = r.answer('p1', ans({ kind: 'plan', approve: true }));
  assert.equal((await r.answer('p1', ans({ kind: 'plan', approve: true }))).code, 'not_pending'); // second answer
  r.cancelAll('give-back');
  release();
  assert.equal((await answering).code, 'not_pending');
  assert.equal((await p).behavior, 'deny');
  assert.deepEqual(gone, [['p1', 'give-back']]);
});

test('router: the SDK abort signal ends a pending request as a deny and tells main', async () => {
  const { r, gone } = router();
  const ac = new AbortController();
  const p = r.canUseTool('Bash', {}, { toolUseID: 't1', signal: ac.signal });
  ac.abort();
  assert.equal((await p).behavior, 'deny');
  assert.deepEqual(gone, [['t1', 'aborted']]);
  assert.equal((await r.answer('t1', ans({ kind: 'permission', allow: true }))).code, 'not_pending');
  const already = new AbortController(); already.abort();
  assert.equal((await r.canUseTool('Bash', {}, { toolUseID: 't2', signal: already.signal })).behavior, 'deny');
});

test('router: at most 8 pending, a duplicate id is denied, cancelAll denies the rest', async () => {
  const { r, gone } = router();
  const ps = [];
  for (let i = 0; i < 8; i++) ps.push(r.canUseTool('Bash', {}, { toolUseID: `t${i}` }));
  assert.equal((await r.canUseTool('Bash', {}, { toolUseID: 't9' })).message, TOO_MANY_TEXT);
  r.cancelAll('ended');
  for (const p of ps) assert.equal((await p).behavior, 'deny');
  assert.equal(gone.length, 8);
  const a = r.canUseTool('Bash', {}, { toolUseID: 'dup' });
  assert.match((await r.canUseTool('Bash', {}, { toolUseID: 'dup' })).message, /already waiting/);
  r.cancelAll();
  await a;
});

test('input queue: delivers in order, waits between turns, bounded, closes', async () => {
  const q = createInputQueue(2);
  const it = q[Symbol.asyncIterator]();
  const first = it.next();
  assert.equal(q.push('hello'), true);
  assert.deepEqual((await first).value, { type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null });
  assert.equal(q.push('a'), true);
  assert.equal(q.push('b'), true);
  assert.equal(q.push('c'), false); // full: refused, never dropped silently
  assert.equal((await it.next()).value.message.content, 'a');
  const waiting = (async () => { await it.next(); return it.next(); })();
  q.close();
  assert.equal((await waiting).done, true);
  assert.equal(q.push('late'), false);
});

test('a shortened question is answered under its ORIGINAL text (Codex impl r3)', async () => {
  const long = 'Q'.repeat(9000);
  const input = { questions: [{ question: long, header: 'h', multiSelect: false, options: [] }, { question: 'Short?', header: 'h', multiSelect: false, options: [] }] };
  const { r } = router();
  const p = r.canUseTool('AskUserQuestion', input, { toolUseID: 'q' });
  const card = r.pendingCards()[0];
  assert.ok(card.questions[0].question.length < long.length);
  const answers = { [card.questions[0].question]: 'yes', 'Short?': 'no' };
  assert.deepEqual(await r.answer('q', ans({ kind: 'question', answers })), { ok: true });
  const res = await p;
  assert.deepEqual({ ...res.updatedInput.answers }, { [long]: 'yes', 'Short?': 'no' });
});

test('a question named __proto__ keeps its answer (Codex impl r3)', async () => {
  const input = { questions: [{ question: '__proto__', header: 'h', multiSelect: false, options: [] }] };
  const { r } = router();
  const p = r.canUseTool('AskUserQuestion', input, { toolUseID: 'q' });
  assert.deepEqual(await r.answer('q', ans({ kind: 'question', answers: JSON.parse('{"__proto__":"no"}') })), { ok: true });
  const res = await p;
  assert.equal(Object.prototype.hasOwnProperty.call(res.updatedInput.answers, '__proto__'), true);
  assert.equal(JSON.parse(JSON.stringify(res.updatedInput)).answers.__proto__, 'no'); // survives the SDK's JSON
});
