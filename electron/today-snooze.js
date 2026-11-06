/**
 * Snooze for Today, kept on this Mac only: it never writes to the board, so it cannot change
 * a shared Asana task or anyone else's view. A snoozed card comes back when its time is up,
 * when anything about it changes (new message, due date, priority), or when its due date
 * arrives during the snooze. The list always says how many are snoozed.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// What the person saw. The board edits titles and notes without a new revision, so those count too.
export const cardPrint = (c) => crypto.createHash('sha256').update(JSON.stringify([c.rev ?? null, c.due || null, c.priority, c.subject || '', c.summary || '', c.who || ''])).digest('hex').slice(0, 16);
const WAKE_HOUR = 8;

/** Next morning, or next Monday morning, local time. */
export function snoozeUntil(choice, nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setHours(WAKE_HOUR, 0, 0, 0);
  if (choice === 'week') {
    const toMonday = ((8 - d.getDay()) % 7) || 7;
    d.setDate(d.getDate() + toMonday);
  } else {
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

/** True while the snooze still holds for this card as it is now. */
export function stillSnoozed(entry, card, { today, nowMs = Date.now() }) {
  if (!entry || nowMs >= entry.until) return false;
  if (entry.print !== cardPrint(card)) return false;
  // A due date that arrives while snoozed wakes the card.
  if (card.due && card.due > entry.day && card.due <= today) return false;
  return true;
}

export function createSnoozes({ file, now = () => Date.now() }) {
  let all = {};
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); if (v && typeof v === 'object' && !Array.isArray(v)) all = v; } catch { all = {}; }
  // Snoozes saved before snoozes had ids get one now, so Bring back can name them (Codex).
  let migrated = false;
  for (const e of Object.values(all)) if (e && typeof e === 'object' && !e.sid) { e.sid = crypto.randomUUID(); migrated = true; }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(all));
    fs.renameSync(`${file}.tmp`, file);
  };
  if (migrated) { try { save(); } catch { /* kept in memory; saved with the next change */ } }
  return {
    snooze(card, choice, today) {
      if (!card || typeof card.id !== 'string' || !card.id || card.id.length > 200 || card.id === '__proto__') return false;
      // sid names this one snooze, so Bring back from an old screen cannot remove a newer one.
      all[card.id] = { print: cardPrint(card), due: card.due || null, day: today, until: snoozeUntil(choice, now()), sid: crypto.randomUUID() };
      save();
      return true;
    },
    // With `sid`, only the snooze the person saw: any newer snooze of the card stays (Codex).
    unsnooze(id, sid) {
      if (typeof id !== 'string' || !Object.hasOwn(all, id)) return false;
      if (sid !== undefined && all[id].sid !== sid) return false;
      delete all[id];
      save();
      return true;
    },
    /**
     * Splits cards into shown and snoozed. Forgets a snooze once it has ended or its card woke,
     * but keeps one whose card is simply not in this read (a board that is down is not a wake).
     */
    split(cards, today) {
      const shown = [];
      const snoozed = [];
      let changed = false;
      for (const c of cards) {
        const e = Object.hasOwn(all, c.id) ? all[c.id] : null;
        if (stillSnoozed(e, c, { today, nowMs: now() })) snoozed.push({ ...c, snoozedUntil: e.until, snoozeId: e.sid || null });
        else { shown.push(c); if (e) { delete all[c.id]; changed = true; } }
      }
      for (const [id, e] of Object.entries(all)) if (now() >= e.until) { delete all[id]; changed = true; }
      if (changed) { try { save(); } catch { /* the next change retries */ } }
      return { shown, snoozed };
    },
  };
}
