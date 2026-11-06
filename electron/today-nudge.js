// Today comes to you: a morning nudge with the day's first five, the next five once those are
// handled, a reminder when they sit for hours, and new ones when more come in. Sam, 2026-11-05: "i
// rarely go to those dashabords anyways" and "i have to kep dealing with them even once i do the
// top 5".
//
// Every nudge carries COUNTS ONLY. Cards can hold patient and customer subjects, and a nudge lands
// on a lock screen and in Messages history; the cards themselves are read inside Dobius (Codex).
//
// planNudge is pure. createNudger runs it one tick at a time, saves the decision BEFORE sending so
// two ticks can never send the same nudge, and never retries a send (a nudge twice is worse than a
// nudge missed: the next tick has its own chance).

import fs from 'node:fs';
import path from 'node:path';
import { nudgeSettings } from './mobile-today.js';

export const BATCH = 5;
const NEXT_GAP_MS = 20 * 60 * 1000; // at most one "next five" per 20 minutes
const REMIND_AFTER_MS = 3 * 60 * 60 * 1000;
const MORE_GAP_MS = 60 * 60 * 1000; // new cards after a cleared batch: at most hourly
const PICK_WAIT_MIN = 30; // past this after morningAt, the rule list goes out instead of waiting on Claude

const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Decide what to send now. `today` is readToday's result, `openIds` every open card id the read
 * saw, `snoozedIds` the snoozed ones. Returns { state, nudge } where nudge is null or
 * { kind, text }. A card in the batch counts as handled when it is no longer open or is snoozed,
 * never merely because it left the suggestions (a re-pick is not work done, Codex).
 */
export function planNudge({ state, now, settings, today, openIds, snoozedIds }) {
  const s = state && typeof state === 'object' ? state : {};
  const cfg = nudgeSettings(settings);
  const board = today?.board;
  if (!board || board.state !== 'ok' || !Array.isArray(board.suggested)) return { state: s, nudge: null };
  const day = localDay(now);
  const mins = now.getHours() * 60 + now.getMinutes();
  const morning = minutesOf(cfg.morningAt);
  if (mins < morning || mins >= minutesOf(cfg.quietAfter)) return { state: s, nudge: null };
  const nowMs = now.getTime();
  const handled = (id) => !openIds.has(id) || snoozedIds.has(id);
  const fresh = (exclude) => board.suggested.filter((c) => !handled(c.id) && !exclude.has(c.id)).slice(0, BATCH);
  const dueToday = (cards) => cards.filter((c) => c.due && c.due <= day).length;
  const start = (cards, kind, extra = {}) => ({
    state: { day, batch: cards.map((c) => c.id), batchAt: nowMs, sentAt: nowMs, reminded: false, seen: [...new Set([...(s.day === day ? s.seen || [] : []), ...cards.map((c) => c.id)])], ...extra },
    nudge: { kind, text: textFor(kind, cards.length, dueToday(cards)) },
  });

  if (s.day !== day) {
    const ready = (board.mode === 'claude' && !board.picking) || mins >= morning + PICK_WAIT_MIN;
    if (!ready) return { state: s, nudge: null };
    const cards = fresh(new Set());
    if (cards.length === 0) return { state: { day, batch: [], batchAt: nowMs, sentAt: 0, reminded: true, seen: [] }, nudge: null };
    return start(cards, 'morning');
  }

  const batch = Array.isArray(s.batch) ? s.batch : [];
  const left = batch.filter((id) => !handled(id));
  const seen = new Set(Array.isArray(s.seen) ? s.seen : []);
  if (batch.length > 0 && left.length === 0) {
    if (nowMs - (s.sentAt || 0) < NEXT_GAP_MS) return { state: s, nudge: null };
    const cards = fresh(seen);
    if (cards.length > 0) return start(cards, 'next');
    return { state: { ...s, batch: [], sentAt: nowMs, reminded: true }, nudge: { kind: 'done', text: textFor('done', batch.length, 0) } };
  }
  if (batch.length === 0) {
    // Cleared earlier: anything picked since then that was never in a nudge.
    if (nowMs - (s.sentAt || 0) < MORE_GAP_MS) return { state: s, nudge: null };
    const cards = fresh(seen);
    return cards.length > 0 ? start(cards, 'more') : { state: s, nudge: null };
  }
  if (!s.reminded && nowMs - (s.batchAt || 0) >= REMIND_AFTER_MS) {
    return { state: { ...s, reminded: true, sentAt: nowMs }, nudge: { kind: 'reminder', text: textFor('reminder', left.length, 0, batch.length) } };
  }
  return { state: s, nudge: null };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Fixed wording with numbers only. The prefix marks it as automatic for anything that reads
// Messages, and is checked against the iMessage bridge's trigger before sending.
export const NUDGE_PREFIX = 'Dobius Today:';
export function textFor(kind, n, due, of = 0) {
  const dueBit = due > 0 ? `, ${due} due today` : '';
  switch (kind) {
    case 'morning': return `${NUDGE_PREFIX} ${plural(n, 'thing', 'things')} to do${dueBit}. Open Today in Dobius to see them.`;
    case 'next': return `${NUDGE_PREFIX} those are handled. ${n} more picked for you${dueBit}.`;
    case 'more': return `${NUDGE_PREFIX} ${n} new to do${dueBit}.`;
    case 'reminder': return `${NUDGE_PREFIX} ${n} of your ${of} still open.`;
    case 'done': return `${NUDGE_PREFIX} all handled. Nothing else picked for now.`;
    default: return NUDGE_PREFIX;
  }
}

/**
 * The timer side. `read` returns { today, openIds, snoozedIds } or null; `send(nudge, cfg)` sends to
 * the channels the settings allow and returns per-channel outcomes for the log.
 */
export function createNudger({ file, read, settings, send, log = () => {}, now = () => new Date() }) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { state = {}; }
  let busy = false;
  const save = (next) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  async function tick() {
    if (busy) return null;
    busy = true;
    try {
      const cfg = settings();
      if (!cfg.imessage && !cfg.mac && !cfg.push) return null;
      const got = await read();
      if (!got) return null;
      const { state: next, nudge } = planNudge({ state, now: now(), settings: cfg, ...got });
      if (next !== state) {
        // Saved before sending: a crash or an overlapping tick then cannot send it again.
        try { save(next); } catch { log('save failed'); return null; }
        state = next;
      }
      if (!nudge) return null;
      const outcome = await send(nudge, cfg);
      log(`${nudge.kind} ${Object.entries(outcome || {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      return nudge;
    } catch {
      log('tick failed');
      return null;
    } finally {
      busy = false;
    }
  }
  return { tick, current: () => state };
}
