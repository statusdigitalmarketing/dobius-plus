import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planNudge, createNudger, textFor, NUDGE_PREFIX } from '../today-nudge.js';
import { nudgeSettings, checkSettingWrite, handleTodayMessage, setTodayBridge } from '../mobile-today.js';

const EM_DASH = String.fromCharCode(0x2014);
const at = (hh, mm = 0, day = 5) => new Date(2026, 10, day, hh, mm);
const card = (id, extra = {}) => ({ id, subject: `secret subject ${id}`, due: null, ...extra });
const todayOf = (ids, extra = {}) => ({ board: { state: 'ok', mode: 'claude', picking: false, suggested: ids.map((i) => (typeof i === 'string' ? card(i) : i)), ...extra } });
const cfg = { imessage: true, mac: true, push: true, morningAt: '08:00', quietAfter: '20:00' };
const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => `c${from + i}`);

test('morning sends the first five as a count, never a subject', () => {
  const t = todayOf([card('c1', { due: '2026-11-05' }), ...ids(7, 2)]);
  const r = planNudge({ state: {}, now: at(8, 5), settings: cfg, today: t, openIds: new Set(ids(8)), snoozedIds: new Set() });
  assert.equal(r.nudge.kind, 'morning');
  assert.deepEqual(r.state.batch, ids(5));
  assert.equal(r.nudge.text, `${NUDGE_PREFIX} 5 things to do, 1 due today. Open Today in Dobius to see them.`);
  assert.equal(r.nudge.text.includes('secret'), false);
});

test('nothing before morning, after quiet time, or while the board is down', () => {
  const t = todayOf(ids(3));
  const open = new Set(ids(3));
  assert.equal(planNudge({ state: {}, now: at(7, 59), settings: cfg, today: t, openIds: open, snoozedIds: new Set() }).nudge, null);
  assert.equal(planNudge({ state: {}, now: at(20, 0), settings: cfg, today: t, openIds: open, snoozedIds: new Set() }).nudge, null);
  assert.equal(planNudge({ state: {}, now: at(9), settings: cfg, today: { board: { state: 'not-running' } }, openIds: open, snoozedIds: new Set() }).nudge, null);
});

test('waits for Claude to finish picking, then falls back to the rules after 30 minutes', () => {
  const t = todayOf(ids(3), { mode: 'rules', picking: true });
  const open = new Set(ids(3));
  assert.equal(planNudge({ state: {}, now: at(8, 10), settings: cfg, today: t, openIds: open, snoozedIds: new Set() }).nudge, null);
  assert.equal(planNudge({ state: {}, now: at(8, 30), settings: cfg, today: t, openIds: open, snoozedIds: new Set() }).nudge.kind, 'morning');
});

test('the next five go out only once every card in the batch is done or snoozed', () => {
  const day = '2026-11-05';
  const state = { day, batch: ids(5), batchAt: at(8).getTime(), sentAt: at(8).getTime(), reminded: false, seen: ids(5) };
  const t = todayOf(ids(10));
  let r = planNudge({ state, now: at(9), settings: cfg, today: t, openIds: new Set(['c5', ...ids(5, 6)]), snoozedIds: new Set() });
  assert.equal(r.nudge, null);
  r = planNudge({ state, now: at(9), settings: cfg, today: t, openIds: new Set(['c5', ...ids(5, 6)]), snoozedIds: new Set(['c5']) });
  assert.equal(r.nudge.kind, 'next');
  assert.deepEqual(r.state.batch, ids(5, 6));
});

test('cards that merely drop out of the picks are not counted as handled (Codex)', () => {
  const state = { day: '2026-11-05', batch: ids(5), batchAt: at(8).getTime(), sentAt: at(8).getTime(), reminded: false, seen: ids(5) };
  const r = planNudge({ state, now: at(9), settings: cfg, today: todayOf(ids(5, 6)), openIds: new Set(ids(10)), snoozedIds: new Set() });
  assert.equal(r.nudge, null);
});

test('no second "next five" within 20 minutes, and an all-clear only speaks for the picks', () => {
  const sentAt = at(9).getTime();
  const state = { day: '2026-11-05', batch: ids(5), batchAt: sentAt, sentAt, reminded: false, seen: ids(5) };
  const open = new Set();
  assert.equal(planNudge({ state, now: at(9, 10), settings: cfg, today: todayOf([]), openIds: open, snoozedIds: new Set() }).nudge, null);
  const r = planNudge({ state, now: at(9, 25), settings: cfg, today: todayOf([]), openIds: open, snoozedIds: new Set() });
  assert.equal(r.nudge.kind, 'done');
  assert.equal(r.nudge.text, `${NUDGE_PREFIX} all handled. Nothing else picked for now.`);
  assert.deepEqual(r.state.batch, []);
});

test('after a cleared batch, new cards come at most hourly and never repeat one already sent', () => {
  const sentAt = at(10).getTime();
  const state = { day: '2026-11-05', batch: [], batchAt: sentAt, sentAt, reminded: true, seen: ids(5).map((i) => `${i}:`) };
  const t = todayOf([...ids(5), 'n1']);
  const open = new Set([...ids(5), 'n1']);
  assert.equal(planNudge({ state, now: at(10, 30), settings: cfg, today: t, openIds: open, snoozedIds: new Set() }).nudge, null);
  const r = planNudge({ state, now: at(11, 1), settings: cfg, today: t, openIds: open, snoozedIds: new Set() });
  assert.equal(r.nudge.kind, 'more');
  assert.deepEqual(r.state.batch, ['n1']);
});

test('one reminder after three hours, with how many are left', () => {
  const state = { day: '2026-11-05', batch: ids(5), batchAt: at(8).getTime(), sentAt: at(8).getTime(), reminded: false, seen: ids(5) };
  const open = new Set(['c1', 'c2']);
  assert.equal(planNudge({ state, now: at(10, 59), settings: cfg, today: todayOf(ids(5)), openIds: open, snoozedIds: new Set() }).nudge, null);
  const r = planNudge({ state, now: at(11), settings: cfg, today: todayOf(ids(5)), openIds: open, snoozedIds: new Set() });
  assert.equal(r.nudge.text, `${NUDGE_PREFIX} 2 of your 5 still open.`);
  assert.equal(planNudge({ state: r.state, now: at(15), settings: cfg, today: todayOf(ids(5)), openIds: open, snoozedIds: new Set() }).nudge, null);
});

test('a new day starts over', () => {
  const state = { day: '2026-11-04', batch: ['old'], batchAt: 0, sentAt: 0, reminded: true, seen: ['old'] };
  const r = planNudge({ state, now: at(8), settings: cfg, today: todayOf(['old', 'c2']), openIds: new Set(['old', 'c2']), snoozedIds: new Set() });
  assert.equal(r.nudge.kind, 'morning');
  assert.deepEqual(r.state.batch, ['old', 'c2']);
});

test('the nudger saves before it sends, and overlapping ticks send once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-'));
  const file = path.join(dir, 'n.json');
  const sent = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const n = createNudger({
    file, now: () => at(8, 5), settings: () => cfg,
    read: async () => { await gate; return { today: todayOf(ids(2)), openIds: new Set(ids(2)), snoozedIds: new Set() }; },
    send: async (nudge) => { sent.push(nudge.kind); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).day, '2026-11-05'); return { mac: 'ok' }; },
  });
  const a = n.tick();
  const b = n.tick();
  release();
  await Promise.all([a, b]);
  await n.tick();
  assert.deepEqual(sent, ['morning']);
  const again = [];
  const m = createNudger({ file, now: () => at(8, 10), settings: () => cfg, read: async () => ({ today: todayOf(ids(2)), openIds: new Set(ids(2)), snoozedIds: new Set() }), send: async (x) => { again.push(x.kind); return {}; } });
  await m.tick();
  assert.deepEqual(again, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('all three channels off: the board is not even read', async () => {
  let reads = 0;
  const n = createNudger({ file: path.join(os.tmpdir(), `nudge-off-${process.pid}.json`), settings: () => ({ ...cfg, imessage: false, mac: false, push: false }), read: async () => { reads += 1; return null; }, send: async () => ({}) });
  await n.tick();
  assert.equal(reads, 0);
});

test('text wording', () => {
  assert.equal(textFor('morning', 1), `${NUDGE_PREFIX} 1 thing to do. Open Today in Dobius to see them.`);
  assert.equal(textFor('next', 5, { overdue: 1, today: 2 }), `${NUDGE_PREFIX} those are handled. 5 more picked for you, 1 overdue, 2 due today.`);
  const all = ['morning', 'next', 'more', 'reminder', 'done'].map((k) => textFor(k, 3, { overdue: 1, today: 1 }, 5)).join(' ');
  assert.equal(all.includes(EM_DASH), false);
});

test('nudge settings: defaults, and a pair that leaves no daytime falls back', () => {
  assert.deepEqual(nudgeSettings(undefined), cfg);
  assert.deepEqual(nudgeSettings({ morningAt: '09:00', quietAfter: '07:00', mac: false }), { ...cfg, mac: false });
  assert.deepEqual(nudgeSettings({ morningAt: '07:30', quietAfter: '18:00' }), { ...cfg, morningAt: '07:30', quietAfter: '18:00' });
  assert.deepEqual(nudgeSettings({ morningAt: '08:00', quietAfter: '08:15' }), cfg); // no room for the morning nudge
});

test('phone settings writes: only the allowlist, checked as a pair', () => {
  assert.deepEqual(checkSettingWrite('newTabTool', 'codex'), { ok: true, apply: { settings: { newTabTool: 'codex' } } });
  assert.equal(checkSettingWrite('newTabTool', 'rm -rf').ok, false);
  assert.deepEqual(checkSettingWrite('autoMode', true), { ok: true, apply: { autoMode: true } });
  assert.equal(checkSettingWrite('autoMode', 'yes').ok, false);
  assert.equal(checkSettingWrite('mobileServerEnabled', false).error, 'not-allowed');
  assert.equal(checkSettingWrite('__proto__', {}).error, 'not-allowed');
  assert.equal(checkSettingWrite('todayNudges', { quietAfter: '07:00' }, cfg).error, 'quiet-before-morning');
  assert.equal(checkSettingWrite('todayNudges', { quietAfter: '09:30' }, cfg).error, 'quiet-before-morning');
  assert.equal(checkSettingWrite('todayNudges', { morningAt: '04:00' }, cfg).error, 'bad-time');
  assert.equal(checkSettingWrite('todayNudges', { mac: 'yes' }, cfg).ok, false);
  assert.equal(checkSettingWrite('todayNudges', ['x'], cfg).ok, false);
  const ok = checkSettingWrite('todayNudges', { mac: false, extra: 'dropped' }, cfg);
  assert.deepEqual(ok.apply.settings.todayNudges, { ...cfg, mac: false });
});

test('phone messages: replies carry the reqId, the board url never leaves, failures say nothing', async () => {
  const out = [];
  const send = (m) => out.push(m);
  setTodayBridge({
    readToday: async () => ({ board: { state: 'ok' }, url: 'http://127.0.0.1:8765/' }),
    readInbox: async () => { throw new Error('secret subject in an error'); },
    snooze: (id, choice, print) => ({ ok: print === 'p1', changed: print !== 'p1' }),
    unsnooze: () => ({ ok: true }),
    act: async (r) => ({ ok: r.kind === 'done', reason: r.kind === 'done' ? undefined : 'changed' }),
    readSettings: async () => ({ newTabTool: 'claude' }),
    writeSetting: async () => ({ ok: false, error: 'not-allowed' }),
  });
  assert.equal(handleTodayMessage({ type: 'listTerminals' }, send), false);
  handleTodayMessage({ type: 'todayRead', reqId: 'a' }, send);
  handleTodayMessage({ type: 'inboxRead', reqId: 'b' }, send);
  handleTodayMessage({ type: 'todaySnooze', reqId: 'c', id: 'x', choice: 'week', print: 'p2' }, send);
  handleTodayMessage({ type: 'todaySnooze', reqId: 'd', id: 'x', choice: 'forever', print: 'p1' }, send);
  handleTodayMessage({ type: 'inboxAct', reqId: 'e', kind: 'delete', id: 'x', rev: 1 }, send);
  handleTodayMessage({ type: 'inboxAct', reqId: 'f', kind: 'undo', id: 'x', rev: 1 }, send);
  handleTodayMessage({ type: 'inboxAct', reqId: 'h', kind: 'done', id: 'x', rev: 1 }, send);
  handleTodayMessage({ type: 'todayUnsnooze', reqId: 'i', id: 'x', print: 'p' }, send);
  handleTodayMessage({ type: 'settingsWrite', reqId: 'g', key: 'mobileServerEnabled', value: false }, send);
  await new Promise((r) => setTimeout(r, 20));
  const by = Object.fromEntries(out.map((m) => [m.reqId, m]));
  assert.deepEqual(by.a, { type: 'today', reqId: 'a', ok: true, data: { board: { state: 'ok' } } });
  assert.deepEqual(by.b, { type: 'inbox', reqId: 'b', ok: false, error: 'failed' });
  assert.equal(JSON.stringify(out).includes('secret'), false);
  assert.deepEqual(by.c, { type: 'todayResult', reqId: 'c', op: 'snooze', id: 'x', ok: false, changed: true });
  assert.equal(by.d.error, 'bad-request');
  assert.equal(by.e.error, 'bad-request');
  assert.equal(by.f.changed, true);
  assert.equal(by.h.error, 'bad-request'); // Done without the print it showed
  assert.equal(by.i.error, 'bad-request'); // Bring back without the snooze it saw
  assert.deepEqual(by.g, { type: 'settingsResult', reqId: 'g', key: 'mobileServerEnabled', ok: false, error: 'not-allowed' });
  setTodayBridge(null);
  out.length = 0;
  handleTodayMessage({ type: 'todayRead', reqId: 'z' }, send);
  assert.deepEqual(out, [{ type: 'today', reqId: 'z', ok: false, error: 'unavailable' }]);
});

test('overdue and due today are counted apart', () => {
  const t = todayOf([card('c1', { due: '2026-11-04' }), card('c2', { due: '2026-11-05' }), card('c3')]);
  const r = planNudge({ state: {}, now: at(8, 5), settings: cfg, today: t, openIds: new Set(['c1', 'c2', 'c3']), snoozedIds: new Set() });
  assert.equal(r.nudge.text, `${NUDGE_PREFIX} 3 things to do, 1 overdue, 1 due today. Open Today in Dobius to see them.`);
});

test('a reopened card that was already nudged comes back instead of a false all-clear (Codex)', () => {
  const sentAt = at(9).getTime();
  // A was nudged at 08:00, handled, then reopened; B (the current batch) is now done.
  const state = { day: '2026-11-05', batch: ['B'], batchAt: sentAt, sentAt, reminded: false, seen: ['A:', 'B:'] };
  const r = planNudge({ state, now: at(9, 30), settings: cfg, today: todayOf(['A']), openIds: new Set(['A']), snoozedIds: new Set() });
  assert.equal(r.nudge.kind, 'next');
  assert.deepEqual(r.state.batch, ['A']);
});

test('a card that woke with a new message is new work, even after a cleared batch', () => {
  const sentAt = at(9).getTime();
  const state = { day: '2026-11-05', batch: [], batchAt: sentAt, sentAt, reminded: true, seen: ['A:p1'] };
  const r = planNudge({ state, now: at(10, 5), settings: cfg, today: todayOf([card('A', { print: 'p2' })]), openIds: new Set(['A']), snoozedIds: new Set() });
  assert.equal(r.nudge.kind, 'more');
});

test('a second Dobius never nudges, and a nudge another process sent is not sent again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge2-'));
  const file = path.join(dir, 'n.json');
  const read = async () => ({ today: todayOf(ids(2)), openIds: new Set(ids(2)), snoozedIds: new Set() });
  const sent = [];
  const blocked = createNudger({ file, now: () => at(8, 5), settings: () => cfg, read, send: async (x) => { sent.push(`b:${x.kind}`); return {}; }, mayRun: () => false });
  const a = createNudger({ file, now: () => at(8, 5), settings: () => cfg, read, send: async (x) => { sent.push(`a:${x.kind}`); return {}; } });
  const c = createNudger({ file, now: () => at(8, 6), settings: () => cfg, read, send: async (x) => { sent.push(`c:${x.kind}`); return {}; } });
  await blocked.tick();
  await a.tick();
  await c.tick(); // loaded before a sent, but re-reads the file
  assert.deepEqual(sent, ['a:morning']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Bring back with the snooze it saw leaves a newer snooze alone', async () => {
  const { createSnoozes } = await import('../today-snooze.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snz-'));
  const s = createSnoozes({ file: path.join(dir, 's.json'), now: () => 1000 });
  const c = { id: 'A', rev: 1, subject: 'x' };
  s.snooze(c, 'tomorrow', '2026-11-05');
  const old = JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')).A.sid;
  // Snoozed again, unchanged and to the very same wake time: still a different snooze.
  s.snooze(c, 'tomorrow', '2026-11-05');
  assert.equal(s.unsnooze('A', old), false);
  assert.equal(s.unsnooze('A'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a card brought back after the all-clear is nudged again (Codex)', () => {
  const sentAt = at(8, 20).getTime();
  const state = { day: '2026-11-05', batch: [], batchAt: sentAt, sentAt, reminded: true, seen: ['A:'] };
  const r = planNudge({ state, now: at(9, 25), settings: cfg, today: todayOf(['A']), openIds: new Set(['A']), snoozedIds: new Set() });
  assert.equal(r.nudge.kind, 'more');
});

test('held cards count as open, and do not block other cards (Codex)', async () => {
  const { cardsFrom } = await import('../inbox-board.js');
  const got = cardsFrom({ items: [{ id: 'A', status: 'open', held: true, subject: 'x' }, { id: 'B', status: 'open', subject: 'y' }] }, '2026-11-05');
  assert.deepEqual(got.heldIds, ['A']);
  assert.deepEqual(got.cards.map((c) => c.id), ['B']);
  // Batch [A] with A held: still open, so nothing is "handled" yet.
  const state = { day: '2026-11-05', batch: ['A'], batchAt: at(8).getTime(), sentAt: at(8).getTime(), reminded: false, seen: ['A:'] };
  assert.equal(planNudge({ state, now: at(9), settings: cfg, today: todayOf(['B']), openIds: new Set(['A', 'B']), snoozedIds: new Set() }).nudge, null);
  // Batch [C] done, with some unrelated card held: D still goes out.
  const s2 = { ...state, batch: ['C'], seen: ['C:'] };
  assert.equal(planNudge({ state: s2, now: at(9), settings: cfg, today: todayOf(['D'], { held: 1 }), openIds: new Set(['A', 'D']), snoozedIds: new Set() }).nudge.kind, 'next');
});

test('alerts switched off while a tick is reading send nothing', async () => {
  let on = true;
  const sent = [];
  const n = createNudger({
    file: path.join(os.tmpdir(), `nudge-mid-${process.pid}.json`), now: () => at(8, 5),
    settings: () => (on ? cfg : { ...cfg, imessage: false, mac: false, push: false }),
    read: async () => { on = false; return { today: todayOf(ids(2)), openIds: new Set(ids(2)), snoozedIds: new Set() }; },
    send: async (x) => { sent.push(x.kind); return {}; },
  });
  await n.tick();
  assert.deepEqual(sent, []);
  fs.rmSync(path.join(os.tmpdir(), `nudge-mid-${process.pid}.json`), { force: true });
});

test('snoozes saved before ids existed get one, so they can be brought back', async () => {
  const { createSnoozes } = await import('../today-snooze.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snz-old-'));
  const file = path.join(dir, 's.json');
  fs.writeFileSync(file, JSON.stringify({ A: { print: 'p', due: null, day: '2026-11-05', until: Date.now() + 3600e3 } }));
  const s = createSnoozes({ file });
  const sid = JSON.parse(fs.readFileSync(file, 'utf8')).A.sid;
  assert.equal(typeof sid, 'string');
  assert.equal(s.unsnooze('A', sid), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quiet time moved while a tick reads is what the plan uses', async () => {
  let quiet = '20:00';
  const sent = [];
  const n = createNudger({
    file: path.join(os.tmpdir(), `nudge-quiet-${process.pid}.json`), now: () => at(10, 5),
    settings: () => ({ ...cfg, quietAfter: quiet }),
    read: async () => { quiet = '10:00'; return { today: todayOf(ids(2)), openIds: new Set(ids(2)), snoozedIds: new Set() }; },
    send: async (x) => { sent.push(x.kind); return {}; },
  });
  await n.tick();
  assert.deepEqual(sent, []);
  fs.rmSync(path.join(os.tmpdir(), `nudge-quiet-${process.pid}.json`), { force: true });
});

test('a phone unpaired while its write waits changes nothing', async () => {
  const out = [];
  let acted = 0;
  setTodayBridge({ snooze: () => { acted += 1; return { ok: true }; }, unsnooze: () => { acted += 1; return { ok: true }; }, act: async (_r, ok) => (ok() ? (acted += 1, { ok: true }) : { ok: false, reason: 'revoked' }), writeSetting: async () => { acted += 1; return { ok: true }; } });
  const no = () => false;
  handleTodayMessage({ type: 'todaySnooze', reqId: 'a', id: 'x', choice: 'week', print: 'p' }, (m) => out.push(m), no);
  handleTodayMessage({ type: 'todayUnsnooze', reqId: 'b', id: 'x', sid: 's' }, (m) => out.push(m), no);
  handleTodayMessage({ type: 'inboxAct', reqId: 'c', kind: 'done', id: 'x', rev: 1, print: 'p' }, (m) => out.push(m), no);
  handleTodayMessage({ type: 'settingsWrite', reqId: 'd', key: 'newTabTool', value: 'shell' }, (m) => out.push(m), no);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(acted, 0);
  assert.equal(out.every((m) => m.ok === false), true);
  setTodayBridge(null);
});
