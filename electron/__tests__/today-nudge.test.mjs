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
  const state = { day: '2026-11-05', batch: [], batchAt: sentAt, sentAt, reminded: true, seen: ids(5) };
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
  assert.equal(textFor('morning', 1, 0), `${NUDGE_PREFIX} 1 thing to do. Open Today in Dobius to see them.`);
  assert.equal(textFor('next', 5, 2), `${NUDGE_PREFIX} those are handled. 5 more picked for you, 2 due today.`);
  const all = ['morning', 'next', 'more', 'reminder', 'done'].map((k) => textFor(k, 3, 1, 5)).join(' ');
  assert.equal(all.includes(EM_DASH), false);
});

test('nudge settings: defaults, and a pair that leaves no daytime falls back', () => {
  assert.deepEqual(nudgeSettings(undefined), cfg);
  assert.deepEqual(nudgeSettings({ morningAt: '09:00', quietAfter: '07:00', mac: false }), { ...cfg, mac: false });
  assert.deepEqual(nudgeSettings({ morningAt: '07:30', quietAfter: '18:00' }), { ...cfg, morningAt: '07:30', quietAfter: '18:00' });
});

test('phone settings writes: only the allowlist, checked as a pair', () => {
  assert.deepEqual(checkSettingWrite('newTabTool', 'codex'), { ok: true, apply: { settings: { newTabTool: 'codex' } } });
  assert.equal(checkSettingWrite('newTabTool', 'rm -rf').ok, false);
  assert.deepEqual(checkSettingWrite('autoMode', true), { ok: true, apply: { autoMode: true } });
  assert.equal(checkSettingWrite('autoMode', 'yes').ok, false);
  assert.equal(checkSettingWrite('mobileServerEnabled', false).error, 'not-allowed');
  assert.equal(checkSettingWrite('__proto__', {}).error, 'not-allowed');
  assert.equal(checkSettingWrite('todayNudges', { quietAfter: '07:00' }, cfg).error, 'quiet-before-morning');
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
  assert.deepEqual(by.g, { type: 'settingsResult', reqId: 'g', key: 'mobileServerEnabled', ok: false, error: 'not-allowed' });
  setTodayBridge(null);
  out.length = 0;
  handleTodayMessage({ type: 'todayRead', reqId: 'z' }, send);
  assert.deepEqual(out, [{ type: 'today', reqId: 'z', ok: false, error: 'unavailable' }]);
});
