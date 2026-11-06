// Claude's picks and local snooze for Today. The failures that matter: card text steering the answer
// into anything but ids from the list, card text reaching ps, and a snooze hiding something new.
// Run: node --import ./electron/__tests__/register.mjs --test electron/__tests__/today-pick.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parsePicks, pickInput, needsPick, cardsKey, createPicker, runClaude, pickEnv, PICK_COUNT } from '../today-pick.js';
import { createSnoozes, stillSnoozed, snoozeUntil, cardPrint } from '../today-snooze.js';
import { arrange } from '../today.js';

const TODAY = '2026-11-05';
const NOW = new Date(2026, 10, 5, 15, 0).getTime();
const card = (id, over = {}) => ({ id, rev: 1, priority: 'medium', due: null, subject: `S ${id}`, summary: '', who: 'W', source: 'email', ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'today-pick-'));

test('only ids from the list come back, once each, with a short plain reason', () => {
  const cards = [card('a'), card('b')];
  const out = JSON.stringify({ result: 'Here you go:\n{"picks":[{"id":"b","reason":"Legal bill\\u0007 due"},{"id":"evil","reason":"x"},{"id":"b","reason":"again"},{"id":"a","reason":"' + 'y'.repeat(400) + '"},{"id":7}]}' });
  const picks = parsePicks(out, cards);
  assert.deepEqual(picks.map((p) => p.id), ['b', 'a']);
  assert.equal(picks[0].reason, 'Legal bill due');
  assert.equal(picks[1].reason.length, 140);
  assert.equal(parsePicks('no json here', cards), null);
  assert.deepEqual(parsePicks(JSON.stringify({ result: '', structured_output: { picks: [{ id: 'a', reason: 'r' }] } }), cards).map((p) => p.id), ['a'], 'the schema answer');
  assert.deepEqual(parsePicks('Thinking about {name} first. {"picks":[{"id":"a","reason":"r"}]}', cards).map((p) => p.id), ['a'], 'a stray brace before the JSON');
  assert.equal(parsePicks('{"picks":"nope"}', cards), null);
  const many = Array.from({ length: 40 }, (_, i) => card(`c${i}`));
  assert.equal(parsePicks(JSON.stringify({ picks: many.map((c) => ({ id: c.id, reason: 'r' })) }), many).length, PICK_COUNT);
});

test('the input carries display fields only', () => {
  const input = pickInput([{ ...card('a'), url: 'https://secret', token: 'x', rev: 9 }], TODAY);
  assert.match(input, /Today is 2026-11-05/);
  assert.doesNotMatch(input, /secret|token/);
});

test('cards go to claude on stdin, never in argv, with no tools and no saved session', async () => {
  let args; let stdin = '';
  const spawnFn = (bin, a) => {
    args = a;
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stdin = new EventEmitter();
    p.stdin.end = (d) => { stdin = d; setImmediate(() => { p.stdout.emit('data', Buffer.from('{"result":"ok"}')); p.emit('close', 0); }); };
    p.kill = () => {};
    return p;
  };
  const out = await runClaude('CARD TEXT', { bin: 'claude', env: {}, cwd: '/tmp', spawnFn });
  assert.equal(out, '{"result":"ok"}');
  assert.equal(stdin, 'CARD TEXT');
  assert.equal(args.includes('CARD TEXT'), false);
  for (const f of ['-p', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(f), f);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.ok(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.picks, 'the answer shape is enforced');
  const failing = (bin, a) => { const p = spawnFn(bin, a); p.stdin.end = () => setImmediate(() => p.emit('close', 1)); return p; };
  assert.equal(await runClaude('x', { bin: 'claude', env: {}, cwd: '/tmp', spawnFn: failing }), null);
});

test('a pick is redone on a new day, or when the cards changed and it is a few hours old, never in a tight loop', () => {
  const cache = { day: TODAY, key: 'k', pickedAt: NOW - 60_000 };
  assert.equal(needsPick(null, { today: TODAY, key: 'k', nowMs: NOW }), true);
  assert.equal(needsPick({ ...cache, day: '2026-11-04' }, { today: TODAY, key: 'k', nowMs: NOW }), true);
  assert.equal(needsPick(cache, { today: TODAY, key: 'other', nowMs: NOW }), false, 'changed, but picked a minute ago');
  assert.equal(needsPick({ ...cache, pickedAt: NOW - 4 * 3600_000 }, { today: TODAY, key: 'other', nowMs: NOW }), true);
  assert.equal(needsPick(null, { today: TODAY, key: 'k', nowMs: NOW, lastFailAt: NOW - 60_000 }), false, 'a failure waits before trying again');
  assert.equal(cardsKey([card('a'), card('b')]), cardsKey([card('b'), card('a')]));
  assert.notEqual(cardsKey([card('a')]), cardsKey([card('a', { rev: 2 })]));
});

test('the picker never waits for Claude, keeps one run at a time, and saves the result', async () => {
  const dir = tmp(); let runs = 0;
  try {
    const cards = [card('a'), card('b')];
    const picker = createPicker({ file: path.join(dir, 'p.json'), now: () => NOW, run: async () => { runs += 1; return JSON.stringify({ picks: [{ id: 'b', reason: 'r' }] }); } });
    const first = picker.current(cards, TODAY);
    assert.equal(first.picks, null);
    assert.equal(first.picking, true);
    picker.current(cards, TODAY);
    await picker.whenIdle();
    assert.equal(runs, 1);
    assert.deepEqual(picker.current(cards, TODAY).picks, [{ id: 'b', reason: 'r' }]);
    const again = createPicker({ file: path.join(dir, 'p.json'), now: () => NOW, run: async () => { throw new Error('should not run'); } });
    assert.deepEqual(again.current(cards, TODAY).picks.map((p) => p.id), ['b'], 'read back from disk');
    const broken = createPicker({ file: path.join(dir, 'q.json'), now: () => NOW, run: async () => 'garbage' });
    broken.current(cards, TODAY); await broken.whenIdle();
    assert.equal(broken.current(cards, TODAY).picking, false, 'a bad answer is not retried at once');
    assert.equal(broken.current([], TODAY).picking, false, 'nothing to pick from, nothing runs');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Today shows Claude\'s picks with reasons, else says it is sorting by date', () => {
  const cards = [card('a', { due: TODAY }), card('b'), card('gone')];
  const withPicks = arrange(cards, { today: TODAY, nowMs: NOW, picker: { current: () => ({ picks: [{ id: 'b', reason: 'why b' }, { id: 'missing', reason: 'x' }], pickedAt: NOW, picking: false }) } });
  assert.equal(withPicks.mode, 'claude');
  assert.deepEqual(withPicks.suggested.map((c) => [c.id, c.reason]), [['b', 'why b']]);
  assert.equal(withPicks.otherCount, 2);
  const without = arrange(cards, { today: TODAY, nowMs: NOW, picker: { current: () => ({ picks: null, picking: true }) } });
  assert.equal(without.mode, 'rules');
  assert.equal(without.picking, true);
  assert.deepEqual(without.suggested.map((c) => c.id), ['a']);
});

test('snooze: back when time is up, when anything about the card changes, or when the due date arrives', () => {
  const base = card('a');
  const e = { print: cardPrint(base), due: null, day: TODAY, until: NOW + 3600_000 };
  const at = { today: TODAY, nowMs: NOW };
  assert.equal(stillSnoozed(e, base, at), true);
  assert.equal(stillSnoozed(e, base, { today: TODAY, nowMs: NOW + 2 * 3600_000 }), false, 'time is up');
  for (const [why, change] of [['a new message', { rev: 2 }], ['priority raised', { priority: 'high' }], ['a due date was set', { due: '2026-11-07' }], ['title edited, same revision', { subject: 'Now urgent' }], ['notes edited', { summary: 'changed' }]]) {
    assert.equal(stillSnoozed(e, { ...base, ...change }, at), false, why);
  }
  const dueCard = card('a', { due: '2026-11-07' });
  const week = { print: cardPrint(dueCard), due: '2026-11-07', day: TODAY, until: NOW + 6 * 86_400_000 };
  assert.equal(stillSnoozed(week, dueCard, { today: '2026-11-06', nowMs: NOW + 86_400_000 }), true);
  assert.equal(stillSnoozed(week, dueCard, { today: '2026-11-07', nowMs: NOW + 2 * 86_400_000 }), false, 'its due date arrived');
  assert.equal(new Date(snoozeUntil('tomorrow', NOW)).getDate(), 6);
  assert.equal(new Date(snoozeUntil('week', NOW)).getDay(), 1);
});

test('the picker gets no telemetry settings, so card text cannot reach a collector', () => {
  const env = pickEnv({ PATH: '/bin', OTEL_LOGS_EXPORTER: 'otlp', OTEL_LOG_USER_PROMPTS: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
  assert.equal(env.PATH, '/bin');
  assert.equal(Object.keys(env).some((k) => k.startsWith('OTEL_')), false);
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '0');
});

test('a pick refreshes when a due date or priority changes, which the board does without a new revision', () => {
  assert.notEqual(cardsKey([card('a')]), cardsKey([card('a', { due: TODAY })]));
  assert.notEqual(cardsKey([card('a')]), cardsKey([card('a', { priority: 'high' })]));
});

test('a run that will not stop is killed, and the result waits for it to exit', async () => {
  const signals = [];
  const spawnFn = () => {
    const p = new EventEmitter();
    p.pid = 999999; p.stdout = new EventEmitter(); p.stdin = new EventEmitter(); p.stdin.end = () => {};
    p.kill = (sig) => { signals.push(sig); if (sig === 'SIGKILL') setImmediate(() => p.emit('close', null)); };
    return p;
  };
  const t0 = Date.now();
  const out = await runClaude('x', { bin: 'claude', env: {}, cwd: '/tmp', spawnFn, timeoutMs: 20, killGraceMs: 20 });
  assert.equal(out, null);
  assert.deepEqual(signals.slice(0, 2), ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - t0 >= 40);
});

test('a stopped run whose wrapper exits still has its whole group killed', async () => {
  const signals = [];
  const spawnFn = () => {
    const p = new EventEmitter();
    p.pid = 999998; p.stdout = new EventEmitter(); p.stdin = new EventEmitter(); p.stdin.end = () => {};
    p.kill = (sig) => { signals.push(sig); if (sig === 'SIGTERM') setImmediate(() => p.emit('close', 143)); };
    return p;
  };
  assert.equal(await runClaude('x', { bin: 'claude', env: {}, cwd: '/tmp', spawnFn, timeoutMs: 10, killGraceMs: 5000 }), null);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'the group is killed when the wrapper exits early');
});

test('snooze is counted, survives a board that is down, and refuses odd ids', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 's.json');
    const s = createSnoozes({ file, now: () => NOW });
    assert.equal(s.snooze(card('a'), 'tomorrow', TODAY), true);
    assert.equal(s.snooze(card('__proto__'), 'tomorrow', TODAY), false);
    assert.equal(s.snooze({ id: 7 }, 'tomorrow', TODAY), false);
    const r = arrange([card('a'), card('b', { due: TODAY })], { today: TODAY, nowMs: NOW, snoozes: s });
    assert.equal(r.suggested[0].print, cardPrint(card('b', { due: TODAY })), 'each card carries what snooze will check');
    assert.deepEqual(r.suggested.map((c) => c.id).includes('a'), false);
    assert.deepEqual(r.snoozed.map((c) => c.id), ['a']);
    s.split([], TODAY);
    assert.equal(createSnoozes({ file, now: () => NOW }).split([card('a')], TODAY).snoozed.length, 1, 'an empty read did not forget it');
    assert.equal(s.unsnooze('a'), true);
    assert.equal(s.split([card('a')], TODAY).snoozed.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
