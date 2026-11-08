// Phone notifications by event (Settings > Notifications on the phone). Docs: docs/mobile-ws-protocol.md, docs/native-push.md.
//
// Four switches: a tab needs you (red: a permission prompt or a handed-back `!` command), a tab finished (green), a
// command was handed back (Tasks > Commands), a team message arrived. main feeds the events in; this decides what is
// worth a buzz and hands a label-only notification to `send`, which fans it out to Web Push and APNs.
//
// PRIVACY: a notification is built here from a tab label, a project name or a team peer's display name, plus a fixed
// phrase per kind. Nothing that comes in carries terminal text, command text, a message body or a recap, and nothing
// here reads any.
//
// Spam rules:
//   - Debounce. A permission prompt answered at the Mac within 1.5 s, or a turn that ends and a new one starts within
//     2 s, never notifies: at send time the tab's live status must still match.
//   - A needs;handoff red waits up to 10 s for Tasks > Commands to list the command, so one buzz says "handed back".
//   - Per tab, 30 s between buzzes. An event inside the gap is held (the newest one) and goes out when the gap ends if
//     it still holds. A red may follow a green at once.
//   - At most 20 a 10 minutes over everything; past that they are dropped.
//   - Everything due in one flush is coalesced: three or more become one summary.
//   - Quiet hours (off by default) reuse Today's "Quiet after" and "Morning" times.
//   - Never for the tab the person is looking at on the Mac right now (isLooking).
//
// Pure and clock-injectable; tested in electron/__tests__/phone-notifier.test.mjs.

import crypto from 'node:crypto';

// names: tab, project and teammate names in the text (off: only the app name and the event kind).
export const ALERT_DEFAULTS = Object.freeze({ needs: true, done: true, handoff: true, team: true, quiet: false, names: true });
const ALERT_KEYS = Object.keys(ALERT_DEFAULTS);

export const NEEDS_DEBOUNCE_MS = 1500;
export const DONE_DEBOUNCE_MS = 2000;
export const HANDOFF_WAIT_MS = 10_000;
export const TEAM_DEBOUNCE_MS = 2000;
export const TAB_GAP_MS = 30_000;
export const GLOBAL_WINDOW_MS = 10 * 60_000;
export const GLOBAL_MAX = 20;
export const SUMMARY_AT = 3;
export const COALESCE_MS = 1000;

const RANK = { done: 1, failed: 2, needs: 3, handoff: 4, team: 0 };
const PHRASE = {
  needs: 'needs you',
  handoff: 'handed back a command to run',
  done: 'finished',
  failed: 'stopped with an error',
};

/** The alert switches with defaults filled in; anything that is not a boolean is replaced. */
export function alertSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...ALERT_DEFAULTS };
  // Own properties only: an inherited value (a __proto__ key in a stored object) never turns a switch.
  for (const k of ALERT_KEYS) if (Object.prototype.hasOwnProperty.call(r, k) && typeof r[k] === 'boolean') out[k] = r[k];
  return out;
}

/** A label fit for a lock screen: one line, no control or invisible characters, at most `max` characters. */
export function cleanLabel(s, max = 60) {
  const one = String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...one].slice(0, max).join('');
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const mins = (s) => { const m = HHMM.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

/** True between quietAfter and the next morningAt (local minutes of the day). */
export function inQuietHours(minuteOfDay, morningAt, quietAfter) {
  const m = mins(morningAt);
  const q = mins(quietAfter);
  if (m === null || q === null || q === m) return false;
  return q > m ? (minuteOfDay >= q || minuteOfDay < m) : (minuteOfDay >= q && minuteOfDay < m);
}

/** The tag a tab's notifications share, so each replaces the last one on the phone. Opaque: never the tab id, which
 *  names the project folder and would travel through Apple in the APNs collapse id. */
export function tabTag(tabId) {
  return `t${crypto.createHash('sha256').update(String(tabId)).digest('hex').slice(0, 16)}`;
}

/**
 * deps:
 *   now(), setTimer(fn, ms) -> handle, clearTimer(handle)
 *   settings() -> { alerts (raw phoneAlerts), morningAt, quietAfter }
 *   minuteOfDay(nowMs) -> local minutes since midnight
 *   statusOf(tabId) -> 'working' | 'done' | 'needs' | 'idle' | null (main's terminal-status)
 *   labelFor(tabId) -> { label, project }
 *   isLooking(tabId) -> boolean
 *   send({ kind, title, body, tag, tabId|null }) -> Promise
 *   quitting() -> boolean
 */
export function createPhoneNotifier(deps) {
  const d = { quitting: () => false, isLooking: () => false, minuteOfDay: (t) => { const x = new Date(t); return x.getHours() * 60 + x.getMinutes(); }, ...deps };
  const pending = new Map(); // key -> { key, tabId, kind, dueAt, awaitHandoff, count, name }
  const lastSent = new Map(); // key -> { at, kind }
  const lastHook = new Map(); // tabId -> last hook state seen
  let sentTimes = [];
  let timer = null;
  let timerAt = Infinity;

  const keyOf = (tabId) => `tab:${tabId}`;
  // Per tab, a number that moves on every new hook state and every input: a notification about a prompt or a finish
  // is current only while it has not moved (a later prompt in the same tab is a different one: Codex round 3).
  const gen = new Map();
  const bump = (tabId) => { const g = (gen.get(tabId) || 0) + 1; gen.set(tabId, g); return g; };

  function schedule() {
    let next = Infinity;
    for (const p of pending.values()) next = Math.min(next, p.dueAt);
    if (next === timerAt) return;
    if (timer) { d.clearTimer(timer); timer = null; }
    timerAt = next;
    if (next === Infinity) return;
    timer = d.setTimer(() => { timer = null; timerAt = Infinity; flush(); }, Math.max(0, next - d.now()));
  }

  function put(entry) {
    pending.set(entry.key, entry);
    schedule();
  }

  // What a tab's pending notification no longer means once the tab moved on. A failure is its own key and outlives the
  // tab (it is about the exit); a handed-back command stays true while it waits in Tasks > Commands, whatever turn runs.
  function dropTab(tabId, { keepHandoff = false } = {}) {
    const p = pending.get(keyOf(tabId));
    if (!p || (keepHandoff && p.kind === 'handoff')) return;
    pending.delete(keyOf(tabId));
    schedule();
  }

  // A pending handed-back command still waiting in Tasks > Commands (one run or dismissed meanwhile is not).
  const liveHandoff = (p) => p?.kind === 'handoff' && (typeof d.handoffWaiting !== 'function' || !!d.handoffWaiting(p.tabId));

  /** A hook state for a tab: Claude's marker (terminal-status onHookState) or Codex's (codex-status router). */
  function tabHook(tabId, state, tag) {
    if (typeof tabId !== 'string' || !tabId) return;
    const prev = lastHook.get(tabId);
    // lastSent is kept: a failure buzz right after the exit still respects the tab's gap (pruned in flush).
    if (state === 'exit') { lastHook.delete(tabId); bump(tabId); dropTab(tabId); return; }
    if (state === 'done' && tag === 'idle') return; // Claude idle for a minute: never a "finished"
    // The same red told twice (PermissionRequest, then Claude's permission_prompt backstop seconds later) is one
    // prompt: it neither restarts the debounce nor queues a second buzz. An answer (tabInput) or a new hook state
    // in between makes the next red a new one.
    if (state === 'needs' && prev === 'needs') return;
    // The same finish told twice: before the generation moves, or the first one's notification would stop being
    // current (Codex round 4).
    if (state === 'done' && prev === 'done') return;
    lastHook.set(tabId, state);
    const g = bump(tabId);
    const t = d.now();
    const key = keyOf(tabId);
    if (state === 'working') {
      // A new turn, or a prompt answered: whatever was waiting for this tab is no longer true.
      dropTab(tabId, { keepHandoff: true });
      return;
    }
    if (state === 'needs') {
      const handoff = tag === 'handoff';
      const p = pending.get(key);
      // The commands are listed and still waiting: that is the better buzz. The red is remembered on it, so if the
      // command is run or dismissed before it goes out, the red still does (Codex round 2).
      // It keeps its own debounce and its own generation (Codex round 3).
      if (liveHandoff(p)) { pending.set(key, { ...p, behind: { kind: 'needs', handoff, gen: g, at: t + (handoff ? HANDOFF_WAIT_MS : NEEDS_DEBOUNCE_MS) } }); return; }
      put({ key, tabId, kind: 'needs', gen: g, awaitHandoff: handoff, dueAt: t + (handoff ? HANDOFF_WAIT_MS : NEEDS_DEBOUNCE_MS) });
      return;
    }
    if (state === 'done') {
      // Behind a live handoff a finish is remembered the same way, and goes out if the command stops waiting (round 5).
      const p = pending.get(key);
      if (liveHandoff(p)) { pending.set(key, { ...p, behind: { kind: 'done', gen: g, at: t + DONE_DEBOUNCE_MS } }); return; }
      put({ key, tabId, kind: 'done', gen: g, dueAt: t + DONE_DEBOUNCE_MS });
    }
  }

  /**
   * Somebody answered the tab's prompt or ran its handed-back command (main's terminal-status noteInput said so). No
   * hook follows an answer, so without this a red pending in the debounce would stay, and the next red would look like
   * the same prompt told twice.
   */
  function tabInput(tabId) {
    if (typeof tabId !== 'string' || !tabId) return;
    // Whatever the tab said last is over: the next red is a new prompt and the next green a new finish (Codex round 2:
    // a 'done' kept here swallowed the finish of work started by this very input).
    if (lastHook.has(tabId)) lastHook.set(tabId, 'working');
    bump(tabId); // a notification already on its way about this tab stops before the next phone
    // Somebody is at the Mac answering this very tab: nothing pending for it is news to them.
    dropTab(tabId);
  }

  /** Tasks > Commands listed at least one new handed-back command for this tab. */
  // repeat: the turn handed back only commands already waiting (deduplicated by capture). Not news, but it does mean
  // the red behind a waiting handoff has its command listed (Codex round 9).
  function handoffAdded(tabId, { repeat = false } = {}) {
    if (typeof tabId !== 'string' || !tabId) return;
    const key = keyOf(tabId);
    const p = pending.get(key);
    if (repeat) {
      if (p?.kind === 'handoff' && p.behind?.handoff && !p.behind.listed) pending.set(key, { ...p, behind: { ...p.behind, listed: true } });
      // A red still waiting for its command, and the command is one already announced: nothing new to say, whether it
      // is later run, dismissed or left waiting (Codex round 11).
      else if (p?.kind === 'needs' && p.awaitHandoff) { pending.delete(key); schedule(); }
      return;
    }
    const t = d.now();
    if (p && (p.kind === 'needs' || p.kind === 'done')) { put({ ...p, kind: 'handoff', awaitHandoff: false, dueAt: Math.min(p.dueAt, t + 300) }); return; }
    // A handoff already waiting. If a handed-back red waits behind it, that red's own command is now listed: remember it,
    // so a later dismissal of both is silence, not a fallback "needs you" (Codex round 8).
    if (p) { if (p.kind === 'handoff' && p.behind?.handoff && !p.behind.listed) pending.set(key, { ...p, behind: { ...p.behind, listed: true } }); return; }
    // The red already went out as "needs you" a moment ago: that buzz covered it.
    const last = lastSent.get(key);
    if (last && (last.kind === 'needs' || last.kind === 'handoff') && t - last.at < HANDOFF_WAIT_MS * 3) return;
    put({ key, tabId, kind: 'handoff', dueAt: t + 300 });
  }

  /**
   * A tab's program exited with a nonzero code (the shell or Claude crashed). Under the "needs you" switch. Its own key,
   * and the label is taken now: the tab is gone by the time it goes out.
   */
  function tabFailed(tabId, cwd) {
    if (typeof tabId !== 'string' || !tabId) return;
    let info = {};
    try { info = d.labelFor(tabId, cwd) || {}; } catch { info = {}; }
    put({ key: `fail:${tabId}`, tabId, kind: 'failed', info, dueAt: d.now() + 500 });
  }

  /** A team message arrived. `name` is the linked peer's display name. */
  function teamMessage(name) {
    const p = pending.get('team');
    put({ key: 'team', tabId: null, kind: 'team', name: cleanLabel(name, 40) || 'a teammate', count: (p?.count || 0) + 1, dueAt: d.now() + TEAM_DEBOUNCE_MS });
  }

  // Which switch an entry answers to, as sent: a handed-back command goes out as "handed back" with its own switch on,
  // as "needs you" with only that one on (it is a red tab), or not at all.
  function effectiveKind(kind, alerts) {
    if (kind === 'handoff') return alerts.handoff ? 'handoff' : alerts.needs ? 'needs' : null;
    if (kind === 'needs' || kind === 'failed') return alerts.needs ? kind : null;
    if (kind === 'done') return alerts.done ? 'done' : null;
    if (kind === 'team') return alerts.team ? 'team' : null;
    return null;
  }

  function stillTrue(p) {
    if (!p.tabId || p.kind === 'failed') return true;
    if (p.kind === 'handoff' && typeof d.handoffWaiting === 'function') return !!d.handoffWaiting(p.tabId);
    const st = d.statusOf(p.tabId);
    if (p.kind === 'needs' || p.kind === 'handoff') return st === 'needs';
    if (p.kind === 'done') return st !== 'working' && st !== 'needs';
    return true;
  }

  // Still true AND still the same event: a prompt or a finish is current only while its tab's generation has not moved
  // (an answer, a new turn or a later prompt moves it). A handed-back command follows its command; failures and team
  // messages stay true.
  function isCurrent(p) {
    if ((p.kind === 'needs' || p.kind === 'done') && p.tabId && p.gen !== undefined && gen.get(p.tabId) !== p.gen) return false;
    return stillTrue(p);
  }

  // A notification built WITH names must not reach another phone after "Show tab names" was turned off (round 5).
  function namesStill(builtWithNames) {
    if (!builtWithNames) return true;
    try { return alertSettings(d.settings()?.alerts).names; } catch { return false; }
  }

  // Its switch still on and not quiet hours now: a switch turned off mid-send stops it before the next phone (round 6).
  // sentAs: the kind the notification already went out as. A switch changed mid-send stops it unless the same kind is
  // still allowed (a handoff sent as "handed back" does not continue once only "needs you" is on, Codex round 9).
  function allowedNow(kind, sentAs) {
    try {
      const cfg = d.settings() || {};
      const a = alertSettings(cfg.alerts);
      if (a.quiet && inQuietHours(d.minuteOfDay(d.now()), cfg.morningAt, cfg.quietAfter)) return false;
      const k = effectiveKind(kind, a);
      return sentAs ? k === sentAs : !!k;
    } catch { return false; }
  }

  // names off ("Tab names" switch): nothing but the app name and the event kind, for a lock screen others can see.
  function build(p, kind, names) {
    if (kind === 'team') {
      const who = names ? ` from ${p.name}` : '';
      return { kind, title: 'Team', body: p.count > 1 ? `${p.count} new team messages` : `New team message${who}`, tag: 'team', tabId: null, label: 'Team' };
    }
    let info = p.info;
    if (!info) { try { info = d.labelFor(p.tabId) || {}; } catch { info = {}; } }
    const label = (names && cleanLabel(info.label)) || 'A tab';
    const project = names ? cleanLabel(info.project) : '';
    // A failed tab is gone: nothing to open.
    return { kind, title: project || 'Dobius+', body: `${label} ${PHRASE[kind]}`, tag: tabTag(p.tabId), tabId: kind === 'failed' ? null : p.tabId, label };
  }

  function flush() {
    const t = d.now();
    const all = [...pending.values()];
    if (!all.length || Math.min(...all.map((p) => p.dueAt)) > t) { schedule(); return; }
    // A burst: wait (never more than a second past the oldest due one) for whatever else falls due in that second, so
    // they go out together and can be one summary. Waiting, not sending early: no entry ever skips its own debounce.
    const oldest = Math.min(...all.map((p) => p.dueAt));
    const soon = all.filter((p) => p.dueAt > t && p.dueAt <= oldest + COALESCE_MS);
    if (soon.length) {
      const until = Math.max(...soon.map((p) => p.dueAt));
      if (timer) d.clearTimer(timer);
      timerAt = until;
      timer = d.setTimer(() => { timer = null; timerAt = Infinity; flush(); }, Math.max(0, until - t));
      return;
    }
    const due = all.filter((p) => p.dueAt <= t);
    // Nobody to tell (no subscribed phone): nothing is sent, nothing counts against the limits, nothing is held.
    if (typeof d.hasRecipients === 'function' && !d.hasRecipients()) {
      for (const p of due) pending.delete(p.key);
      schedule();
      return;
    }
    let cfg;
    try { cfg = d.settings() || {}; } catch { cfg = {}; }
    const alerts = alertSettings(cfg.alerts);
    const quiet = alerts.quiet && inQuietHours(d.minuteOfDay(t), cfg.morningAt, cfg.quietAfter);
    // A tab's gap is one gap whatever the event (a failure right after a red waits too); entries past it are forgotten.
    const gapKey = (p) => (p.tabId ? keyOf(p.tabId) : p.key);
    for (const [k, v] of lastSent) if (t - v.at >= TAB_GAP_MS) lastSent.delete(k);
    const out = [];
    const admitted = new Set(); // tabs given a buzz in this flush: a second one for the same tab waits its gap
    for (const due0 of due) {
      pending.delete(due0.key);
      let p = due0;
      // A handoff whose command was run or dismissed meanwhile, with a red that arrived behind it: the red goes out,
      // as that red, after its own debounce.
      // So does it when the handoff's own switch (and "needs you") is off: what waited behind it still counts (round 6).
      // A red that was itself a handed-back command is not news once no command waits (dismissed or run: round 7).
      // A handed-back red waiting behind it whose own command is NOT listed yet goes back to waiting for that command
      // (handoffAdded turns it into a handoff), and out as "needs you" when the wait ends without one: "not captured
      // yet" is not "dismissed" (Codex round 8). One whose command was listed and is gone too stays silent (round 7).
      const behindStale = due0.behind?.handoff && !liveHandoff(due0);
      if (due0.kind === 'handoff' && due0.behind && behindStale) {
        if (due0.behind.listed) continue;
        const red = { key: due0.key, tabId: due0.tabId, kind: 'needs', gen: due0.behind.gen, awaitHandoff: true, dueAt: due0.behind.at };
        if (red.dueAt > t) { pending.set(red.key, red); continue; }
        p = red;
      } else if (due0.kind === 'handoff' && due0.behind && (!liveHandoff(due0) || !effectiveKind('handoff', alerts))) {
        const red = { key: due0.key, tabId: due0.tabId, kind: due0.behind.kind, gen: due0.behind.gen, dueAt: due0.behind.at };
        if (red.dueAt > t) { pending.set(red.key, red); continue; }
        p = red;
      }
      // A handoff red still waiting for its command to be listed: out as "needs you" now (the wait is over).
      const kind = effectiveKind(p.kind, alerts);
      if (!kind || quiet || d.quitting()) continue;
      if (!isCurrent(p)) continue;
      if (p.tabId && d.isLooking(p.tabId)) continue;
      const last = lastSent.get(gapKey(p));
      const redAfterGreen = (kind === 'needs' || kind === 'handoff') && last?.kind === 'done';
      if (last && t - last.at < TAB_GAP_MS && !redAfterGreen) {
        // Held, not dropped: the newest event for this key goes out when the gap ends, if it still holds then.
        pending.set(p.key, { ...p, dueAt: last.at + TAB_GAP_MS });
        continue;
      }
      if (admitted.has(gapKey(p))) { pending.set(p.key, { ...p, dueAt: t + TAB_GAP_MS }); continue; }
      admitted.add(gapKey(p));
      out.push({ p, kind });
    }
    sentTimes = sentTimes.filter((x) => t - x < GLOBAL_WINDOW_MS);
    if (out.length) {
      if (sentTimes.length >= GLOBAL_MAX) {
        // Over the cap: nothing more for a while. They are not held (a backlog would land all at once later).
      } else if (out.length >= SUMMARY_AT) {
        const labels = alerts.names ? out.map(({ p, kind }) => build(p, kind, true).label) : [];
        const reds = out.filter((o) => o.kind === 'needs' || o.kind === 'handoff' || o.kind === 'failed').length;
        const body = cleanLabel(`${reds ? `${reds} need you. ` : ''}${labels.join(', ')}`, 160) || 'Several tabs changed';
        sentTimes.push(t);
        for (const o of out) lastSent.set(gapKey(o.p), { at: t, kind: o.kind });
        // Its text is fixed, so it goes to the next phone only while ALL of what it sums up is still true (Codex round 4).
        // And nobody started looking at any of those tabs on the Mac meanwhile, as for a single notification (Codex round 8).
        const current = () => !d.quitting() && namesStill(alerts.names) && out.every((o) => allowedNow(o.p.kind, o.kind) && isCurrent(o.p) && !(o.p.tabId && d.isLooking(o.p.tabId)));
        Promise.resolve(d.send({ kind: 'summary', title: `${out.length} updates`, body, tag: 'summary', tabId: null, current })).catch(() => { /* the sender logs by code */ });
      } else {
        for (const { p, kind } of out) {
          if (sentTimes.length >= GLOBAL_MAX) break;
          sentTimes.push(t);
          lastSent.set(gapKey(p), { at: t, kind });
          const n = build(p, kind, alerts.names);
          // current(): asked by the sender before each phone, so news that stopped being true mid-send stops there. The
          // same test the flush used, on the entry as it was (a handoff sent as "needs you" is still judged by its command).
          // And nobody started looking at the tab on the Mac meanwhile (round 7).
          const current = () => !d.quitting() && namesStill(alerts.names) && allowedNow(p.kind, kind) && isCurrent(p) && !(p.tabId && d.isLooking(p.tabId));
          Promise.resolve(d.send({ kind: n.kind, title: n.title, body: n.body, tag: n.tag, tabId: n.tabId, current })).catch(() => { /* the sender logs by code */ });
        }
      }
    }
    schedule();
  }

  return {
    tabHook,
    tabInput,
    handoffAdded,
    tabFailed,
    teamMessage,
    /** Stop: nothing pending goes out. */
    stop() { pending.clear(); if (timer) d.clearTimer(timer); timer = null; timerAt = Infinity; },
    _pending: () => [...pending.values()].map((p) => ({ ...p })),
  };
}
