// Account headroom: attribution, pace and forecast, ranking with unknowns,
// move refusals and the auto-move guard rails (electron/account-headroom.js).
// Run: node ./electron/__tests__/account-headroom.test.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  emptyHistory, sanitizeHistory, updateHistory, noteLogin, pruneHistory, paceFor, forecastFor, usageForKey,
  accountKeyRows, moveRefusal, rankTargets, limitFromEntries, liveLimitLine, decideAutoMove, AUTO, tabBusy, autoRefusal, freshUsage, userOverrideIn,
} from '../account-headroom.js';
import { keychainServiceFor } from '../account-identity.js';

let pass = 0;
const check = (label, fn) => { fn(); pass += 1; console.log(`PASS  ${label}`); };

const KEY_A = keychainServiceFor('/p/a');
const KEY_B = keychainServiceFor('/p/b');
const MIN = 60_000;
const T0 = 1_800_000_000_000; // ms
const R5 = T0 / 1000 + 3 * 3600; // five_hour reset 3h after T0 (seconds)
const R7 = T0 / 1000 + 4 * 86400;
const rec = (key, receivedAt, five, seven) => ({
  key, receivedAt,
  windows: {
    ...(five !== undefined ? { five_hour: { usedPercentage: five, resetsAt: R5 } } : {}),
    ...(seven !== undefined ? { seven_day: { usedPercentage: seven, resetsAt: R7 } } : {}),
  },
});

// ---- attribution ----

check('an account report is attributed by the same Keychain service the spawn path binds', () => {
  const rows = accountKeyRows([
    { id: 'a', type: 'claude', name: 'Work', claudeJsonPath: '/p/a/.claude.json' },
    { id: 'c', type: 'codex', name: 'Codex' },
    { id: 'b', type: 'claude', claudeJsonPath: '/p/b/.claude.json' },
  ], { defaultDir: path.join(os.homedir(), '.claude') });
  assert.equal(rows.accounts[0].key, KEY_A);
  assert.equal(rows.accounts[0].label, 'Work');
  assert.equal(rows.accounts[1], null, 'codex rows stay aligned as null');
  assert.equal(rows.accounts[2].key, KEY_B);
  // The default dir is the bare service, as Claude names it.
  assert.equal(rows.default.key, 'Claude Code-credentials');
});

check('a relative or missing profile path is not attributed at all', () => {
  const rows = accountKeyRows([
    { id: 'r', type: 'claude', claudeJsonPath: 'rel/.claude.json' },
    { id: 'n', type: 'claude', claudeJsonPath: 7 },
  ], { defaultDir: '/h/.claude' });
  assert.deepEqual(rows.accounts, [null, null]);
});

// ---- history ----

check('history keeps the FIRST time each value was seen, and a republished lower figure cannot pull it back', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, 10)], T0);
  updateHistory(h, [rec(KEY_A, T0 + 5 * MIN, 10)], T0 + 5 * MIN); // same value, later receipt
  updateHistory(h, [rec(KEY_A, T0 + 10 * MIN, 20), rec(KEY_A, T0 + 11 * MIN, 15)], T0 + 11 * MIN);
  const w = h.keys[KEY_A].windows.five_hour;
  assert.deepEqual(w.samples, [{ t: T0, p: 10 }, { t: T0 + 10 * MIN, p: 20 }]);
  assert.equal(w.seenAt, T0 + 11 * MIN);
});

check('a figure with no reset time is not kept (it would never expire)', () => {
  const h = emptyHistory();
  updateHistory(h, [{ key: KEY_A, receivedAt: T0, windows: { five_hour: { usedPercentage: 0, resetsAt: null } } }], T0);
  assert.equal(usageForKey(h, KEY_A, T0).known, false);
});

check('a new resets_at starts a new window and an expired window is dropped', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, 90)], T0);
  const next = { key: KEY_A, receivedAt: T0 + MIN, windows: { five_hour: { usedPercentage: 2, resetsAt: R5 + 5 * 3600 } } };
  updateHistory(h, [next], T0 + MIN);
  assert.deepEqual(h.keys[KEY_A].windows.five_hour.samples, [{ t: T0 + MIN, p: 2 }]);
  // A late record from the window that is over does not come back.
  updateHistory(h, [rec(KEY_A, T0 + 2 * MIN, 95)], T0 + 2 * MIN);
  assert.deepEqual(h.keys[KEY_A].windows.five_hour.samples, [{ t: T0 + MIN, p: 2 }]);
  updateHistory(h, [], (R5 + 5 * 3600) * 1000 + 1);
  assert.equal(h.keys[KEY_A], undefined);
});

check('history is bounded and rejects hostile names on load', () => {
  const h = emptyHistory();
  for (let i = 0; i < 300; i += 1) updateHistory(h, [rec(KEY_A, T0 + i * 10_000, i / 3)], T0 + i * 10_000);
  assert.ok(h.keys[KEY_A].windows.five_hour.samples.length <= 120);
  const loaded = sanitizeHistory(JSON.parse(JSON.stringify({
    v: 1,
    keys: {
      '__proto__': { windows: { five_hour: { r: R5, seenAt: T0, samples: [{ t: T0, p: 1 }] } } },
      'evil': { windows: {} },
      [KEY_A]: { windows: { '__proto__': { r: R5, seenAt: T0, samples: [{ t: T0, p: 1 }] }, five_hour: { r: R5, seenAt: T0, samples: [{ t: T0, p: 5 }, { t: T0 - 1, p: 9 }] } } },
    },
  })));
  assert.deepEqual(Object.keys(loaded.keys), [KEY_A]);
  assert.deepEqual(Object.keys(loaded.keys[KEY_A].windows), ['five_hour']);
  assert.deepEqual(loaded.keys[KEY_A].windows.five_hour.samples, [{ t: T0, p: 5 }], 'out-of-order sample dropped');
  assert.equal(Object.getPrototypeOf(loaded.keys), null);
  const noReset = sanitizeHistory({ v: 1, keys: { [KEY_A]: { windows: { five_hour: { r: null, seenAt: T0, samples: [{ t: T0, p: 0 }] } } } } });
  assert.equal(noReset.keys[KEY_A], undefined, 'a saved window with no reset time is dropped on load');
});

check('a re-login of the same folder drops the old login\'s figures and ignores its leftover records', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, 80)], T0);
  assert.equal(noteLogin(h, KEY_A, 'Old@x.com', T0), true);
  assert.equal(noteLogin(h, KEY_A, 'old@x.com', T0), false);
  assert.equal(usageForKey(h, KEY_A, T0).windows.five_hour.used, 80);
  assert.equal(noteLogin(h, KEY_A, 'new@x.com', T0 + MIN), true);
  assert.equal(usageForKey(h, KEY_A, T0 + MIN).known, false);
  // The old login's record is still on disk and is read again: ignored.
  updateHistory(h, [rec(KEY_A, T0, 80), rec(KEY_A, T0 + 2 * MIN, 4)], T0 + 2 * MIN);
  assert.equal(usageForKey(h, KEY_A, T0 + 2 * MIN).windows.five_hour.used, 4);
  const reloaded = sanitizeHistory(JSON.parse(JSON.stringify(h)));
  assert.equal(reloaded.keys[KEY_A].since, T0 + MIN);
});

check('after a re-login, a running session republishing the old login\'s cached figure is ignored until it says something new', () => {
  const h = emptyHistory();
  const old = { ...rec(KEY_A, T0, 90), sessionId: 'live1' };
  updateHistory(h, [old], T0);
  noteLogin(h, KEY_A, 'a@x', T0);
  assert.equal(noteLogin(h, KEY_A, 'b@x', T0 + MIN, [old]), true);
  updateHistory(h, [{ ...old, receivedAt: T0 + 2 * MIN }], T0 + 2 * MIN); // same figure, new file time
  assert.equal(usageForKey(h, KEY_A, T0 + 2 * MIN).known, false);
  updateHistory(h, [{ ...rec(KEY_A, T0 + 3 * MIN, 4), sessionId: 'live1' }], T0 + 3 * MIN); // its first call on the new login
  assert.equal(usageForKey(h, KEY_A, T0 + 3 * MIN).windows.five_hour.used, 4);
});

check('a key kept only for its re-login boundary is not the one the key cap evicts', () => {
  const h = emptyHistory();
  const recs = [];
  for (let i = 0; i < 40; i += 1) recs.push(rec(`Claude Code-credentials-${(0x10000000 + i).toString(16)}`, T0 + i, 10));
  recs.push({ ...rec(KEY_A, T0 + 100, 50), sessionId: 'old' });
  updateHistory(h, recs, T0 + MIN);
  noteLogin(h, KEY_A, 'a@x', T0 + MIN);
  noteLogin(h, KEY_A, 'b@x', T0 + 2 * MIN, [recs.at(-1)]);
  // One more credential reports: the cap must evict someone, never the boundary.
  updateHistory(h, [rec('Claude Code-credentials-2fffffff', T0 + 2 * MIN, 10)], T0 + 2 * MIN);
  pruneHistory(h, T0 + 2 * MIN);
  assert.ok(h.keys[KEY_A], 'the re-login boundary survives');
  updateHistory(h, [{ ...recs.at(-1), receivedAt: T0 + 3 * MIN }], T0 + 3 * MIN);
  assert.equal(usageForKey(h, KEY_A, T0 + 3 * MIN).known, false);
});

// ---- pace and forecast ----

check('pace is percent per hour over the lookback, from the step value at its start', () => {
  const ent = { samples: [{ t: T0, p: 10 }, { t: T0 + 30 * MIN, p: 20 }, { t: T0 + 90 * MIN, p: 40 }], seenAt: T0 + 120 * MIN };
  // Lookback 60 min ending at T0+120: value at T0+60 is 20, last is 40 -> 20 over 1h.
  assert.equal(paceFor(ent, 60 * MIN), 20);
  // Shorter history than the lookback: from the first sample.
  const young = { samples: [{ t: T0, p: 10 }, { t: T0 + 15 * MIN, p: 15 }], seenAt: T0 + 30 * MIN };
  assert.equal(paceFor(young, 60 * MIN), 10);
});

check('pace needs ten minutes of history and reads 0 when nothing moved', () => {
  assert.equal(paceFor({ samples: [{ t: T0, p: 10 }], seenAt: T0 + 5 * MIN }, 60 * MIN), null);
  assert.equal(paceFor({ samples: [{ t: T0, p: 10 }], seenAt: T0 + 50 * MIN }, 60 * MIN), 0);
});

check('forecast runs to 100 at the current pace, capped by the reset', () => {
  const resetsAt = (T0 + 10 * 3600_000) / 1000;
  assert.deepEqual(forecastFor({ p: 50, pace: 25, seenAt: T0, resetsAt }), { at: T0 + 2 * 3600_000 });
  assert.deepEqual(forecastFor({ p: 50, pace: 5, seenAt: T0, resetsAt }), { resetsFirst: true });
  assert.deepEqual(forecastFor({ p: 100, pace: 5, seenAt: T0, resetsAt }), { limited: true, until: resetsAt * 1000 });
  assert.deepEqual(forecastFor({ p: 50, pace: 0, seenAt: T0, resetsAt }), { steady: true });
  assert.deepEqual(forecastFor({ p: 50, pace: null, seenAt: T0, resetsAt }), { unknown: true });
});

check('an account with no live five-hour figure is unknown, never 0%', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, undefined, 40)], T0); // weekly only
  const u = usageForKey(h, KEY_A, T0 + MIN);
  assert.equal(u.known, false);
  assert.equal(u.headroom, null);
  const none = usageForKey(h, KEY_B, T0);
  assert.equal(none.known, false);
  assert.equal(none.lastReportedAt, null);
});

check('headroom is what the fullest live window leaves', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, 30, 85)], T0);
  const u = usageForKey(h, KEY_A, T0);
  assert.equal(u.known, true);
  assert.equal(u.headroom, 15);
  assert.equal(u.limited, false);
});

// ---- refusals and ranking ----

check('moving to the same credential, the same login, or a logged-out account is refused', () => {
  assert.match(moveRefusal({ key: KEY_A }, { key: KEY_A, login: 'in' }), /already on/);
  assert.match(moveRefusal({ key: KEY_A, email: 'Sam@x.com' }, { key: KEY_B, email: 'sam@X.com', login: 'in' }), /same login/);
  assert.match(moveRefusal({ key: KEY_A }, { key: KEY_B, login: 'out' }), /not logged in/);
  assert.match(moveRefusal({ key: KEY_A }, { key: KEY_B, login: 'unknown' }), /could not confirm/);
  assert.equal(moveRefusal({ key: KEY_A, email: 'a@x' }, { key: KEY_B, email: 'b@x', login: 'in' }), null);
});

const cand = (id, known, headroom, lastReportedAt = T0, extra = {}) => ({
  id, usage: { known, headroom: known ? headroom : null, limited: known && headroom <= 0, lastReportedAt }, refusal: null, ...extra,
});

check('ranking puts every known account above every unknown one, most headroom first', () => {
  const ranked = rankTargets([cand('u1', false), cand('k10', true, 10), cand('k80', true, 80), cand('u2', false), cand('k80new', true, 80, T0 + MIN)]);
  assert.deepEqual(ranked.map((c) => c.id), ['k80new', 'k80', 'k10', 'u1', 'u2']);
});

// ---- limit signals ----

const limitEntry = (ts, extra = {}) => ({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', timestamp: ts, message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 6am" }] }, ...extra });

check('the transcript limit record is found only when it is the newest turn', () => {
  const ts = '2026-10-30T10:00:00.000Z';
  assert.deepEqual(limitFromEntries([{ type: 'user', message: { content: 'go' } }, limitEntry(ts), { type: 'system' }, { type: 'user', isMeta: true }]),
    { at: Date.parse(ts), text: "You've hit your 5-hour limit · resets 6am" });
  assert.equal(limitFromEntries([limitEntry(ts), { type: 'user', message: { content: 'continue' } }]), null);
  assert.equal(limitFromEntries([limitEntry(ts, { error: 'overloaded' })]), null);
  assert.equal(limitFromEntries([limitEntry(ts, { isSidechain: true })]), null);
});

check('the screen limit line counts only in the live region, never higher up', () => {
  const screen = Array(60).fill('');
  screen[50] = "  ⎿  You've   hit   your   5-hour   limit · resets 6am";
  screen[55] = '────────';
  screen[56] = '❯ ';
  screen[57] = '────────';
  assert.match(liveLimitLine(screen), /5-hour/);
  const old = Array(60).fill('x');
  old[5] = "You've hit your weekly limit";
  assert.equal(liveLimitLine(old), null);
  assert.match(liveLimitLine(['Usage limit reached · continuing automatically']), /Usage limit/);
  assert.equal(liveLimitLine(['You hit a wall']), null);
});

check('only a recent report, or a running session, makes usage live enough to act on', () => {
  assert.equal(freshUsage({ known: true, ageMs: 60_000 }, 0), true);
  assert.equal(freshUsage({ known: true, ageMs: 3600_000 }, 0), false);
  assert.equal(freshUsage({ known: true, ageMs: 3600_000 }, 2), true);
  assert.equal(freshUsage({ known: true, ageMs: 3600_000 }, null), false);
  assert.equal(freshUsage({ known: false, ageMs: 1 }, 3), false);
});

check('the live region is never taller than the real terminal', () => {
  const screen = Array(40).fill('x');
  screen[30] = "You've hit your 5-hour limit";
  assert.match(liveLimitLine(screen, 24), /5-hour/);
  assert.equal(liveLimitLine(screen, 8), null);
});

check('a USER in the resumed Claude\'s environment that is not exactly ours is an override; anything ambiguous is unreadable', () => {
  assert.equal(userOverrideIn('node /x/claude --resume s HOME=/h USER=sam PATH=/b', 'sam', 'sam'), null);
  assert.equal(userOverrideIn('node /x/claude HOME=/h USER=sam', 'sam', 'sam'), null);
  assert.equal(userOverrideIn('node /x/claude HOME=/h USER=other PATH=/b', 'sam', 'sam'), 'USER');
  assert.equal(userOverrideIn('node /x/claude HOME=/h USER=sam spare PATH=/b', 'sam', 'sam'), 'USER');
  assert.equal(userOverrideIn('node /x/claude --x USER=sam HOME=/h USER=other', 'sam', 'sam'), 'unreadable');
  assert.equal(userOverrideIn('node /x/claude HOME=/h', 'alias', 'sam'), 'USER', 'unset USER falls back to the OS user');
  assert.equal(userOverrideIn('node /x/claude HOME=/h', 'sam', 'sam'), null);
});

// ---- auto-move guard rails ----

const base = (over = {}) => ({
  enabled: true, now: T0 + 60 * MIN, limit: { at: T0 + 59 * MIN }, processStartedAt: T0, corroboration: { statusLine: true, screen: true }, draft: false, busy: false,
  inputAgeMs: 10 * MIN, tabState: { handled: new Set(), lastMoveAt: 0 }, recentMoves: [],
  ranked: rankTargets([cand('u', false), cand('k', true, 60)]), ...over,
});

check('auto-move picks the known account with the most headroom', () => {
  const d = decideAutoMove(base());
  assert.equal(d.action, 'move');
  assert.equal(d.target.id, 'k');
  assert.equal(d.eventId, `${T0 + 59 * MIN}`);
});

check('auto-move is off unless switched on', () => {
  assert.equal(decideAutoMove(base({ enabled: false })).action, 'none');
});

check('one auto-move per limit event', () => {
  const d = decideAutoMove(base());
  const again = decideAutoMove(base({ tabState: { handled: new Set([d.eventId]), lastMoveAt: 0 } }));
  assert.equal(again.action, 'none');
});

check('a limit recorded before the last move never moves the tab again', () => {
  const d = decideAutoMove(base({ tabState: { handled: new Set(), lastMoveAt: T0 + 59 * MIN + 1 } }));
  assert.equal(d.action, 'none');
});

check('a new limit inside the cooldown waits', () => {
  const d = decideAutoMove(base({ limit: { at: T0 + 59 * MIN }, tabState: { handled: new Set(), lastMoveAt: T0 + 58 * MIN } }));
  assert.equal(d.action, 'wait');
});

check('a tab someone typed in recently, or one still busy, waits', () => {
  assert.equal(decideAutoMove(base({ inputAgeMs: AUTO.TYPED_RECENTLY_MS - 1 })).action, 'wait');
  assert.equal(decideAutoMove(base({ busy: true })).action, 'wait');
});

check('busy means a permission prompt, or a working tab still drawing; a stale working is not busy', () => {
  const now = T0;
  assert.equal(tabBusy({ status: 'needs', lastActivityAt: now - 3600_000 }, now), true);
  assert.equal(tabBusy({ status: 'working', lastActivityAt: now - 2000 }, now), true);
  assert.equal(tabBusy({ status: 'working', lastActivityAt: now - 60_000 }, now), false);
  assert.equal(tabBusy({ status: 'done', lastActivityAt: now }, now), false);
  assert.equal(tabBusy(null, now), false);
});

check('the global cap holds a storm back', () => {
  const recentMoves = Array(AUTO.GLOBAL_MAX).fill(T0 + 55 * MIN);
  assert.equal(decideAutoMove(base({ recentMoves })).action, 'wait');
});

check('an uncorroborated limit record does nothing', () => {
  assert.equal(decideAutoMove(base({ corroboration: { statusLine: false, screen: false } })).action, 'none');
});

check('the limit must be on this tab\'s screen; without a 100% report only while it is recent', () => {
  const screenOnly = { statusLine: false, screen: true };
  assert.equal(decideAutoMove(base({ corroboration: screenOnly })).action, 'move');
  const old = { at: T0 + 60 * MIN - AUTO.SCREEN_FRESH_MS - 1 };
  assert.equal(decideAutoMove(base({ corroboration: screenOnly, limit: old })).action, 'none');
  assert.equal(decideAutoMove(base({ corroboration: { statusLine: true, screen: true }, limit: old })).action, 'move');
  // /clear: the old record and a 100% account, but nothing on this tab's screen.
  assert.equal(decideAutoMove(base({ corroboration: { statusLine: true, screen: false } })).action, 'none');
});

check('a limit from before this claude process started (a resumed transcript) never moves it', () => {
  assert.equal(decideAutoMove(base({ processStartedAt: T0 + 59 * MIN + 1000 })).action, 'none');
  // ps rounds the start DOWN to the second: a limit in that same second may be the old process's.
  assert.equal(decideAutoMove(base({ processStartedAt: T0 + 59 * MIN - 500 })).action, 'none');
  assert.equal(decideAutoMove(base({ processStartedAt: T0 + 59 * MIN - 1000 })).action, 'move');
});

check('unsent text in the prompt waits rather than being thrown away', () => {
  assert.equal(decideAutoMove(base({ draft: true })).action, 'wait');
});

check('auto-move never picks a login it cannot tell apart from the tab\'s', () => {
  assert.match(autoRefusal({ email: null }, { email: 'b@x' }), /not recorded/);
  assert.match(autoRefusal({ email: 'a@x' }, { email: '' }), /not recorded/);
  assert.equal(autoRefusal({ email: 'a@x' }, { email: 'b@x' }, { fresh: true }), null);
  assert.match(autoRefusal({ email: 'a@x' }, { email: 'b@x' }, { fresh: false }), /not reported recently/);
  const ranked = rankTargets([cand('noaddr', true, 90, T0, { autoRefusal: 'not recorded' })]);
  assert.equal(decideAutoMove(base({ ranked })).action, 'notice');
});

check('every account limited or unknown gives a notice, never a move to an unknown account', () => {
  const ranked = rankTargets([cand('u', false), cand('full', true, 0), cand('near', true, AUTO.MIN_HEADROOM - 1)]);
  assert.equal(decideAutoMove(base({ ranked })).action, 'notice');
  const refused = rankTargets([cand('same', true, 90, T0, { refusal: 'same login' })]);
  assert.equal(decideAutoMove(base({ ranked: refused })).action, 'notice');
});

console.log(`\n${pass} passed`);
