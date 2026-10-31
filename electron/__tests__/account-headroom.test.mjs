// Account headroom: attribution, pace and forecast, ranking with unknowns and
// move refusals (electron/account-headroom.js).
// Run: node ./electron/__tests__/account-headroom.test.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  emptyHistory, sanitizeHistory, updateHistory, noteLogin, pruneHistory, UNKNOWN_LOGIN, paceFor, forecastFor, usageForKeys,
  accountKeyRows, moveRefusal, moveBlock, rankTargets, tabBusy, authOverrideIn, limitMenuOn, trustPromptOn,
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
  assert.equal(w.seenAt, T0 + 10 * MIN, 'the lower figure says nothing about when 20 was last true');
});

check('a figure with no reset time is not kept (it would never expire)', () => {
  const h = emptyHistory();
  updateHistory(h, [{ key: KEY_A, receivedAt: T0, windows: { five_hour: { usedPercentage: 0, resetsAt: null } } }], T0);
  assert.equal(usageForKeys(h, [KEY_A], T0).known, false);
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
  assert.equal(usageForKeys(h, [KEY_A], T0).windows.five_hour.used, 80);
  assert.equal(noteLogin(h, KEY_A, 'new@x.com', T0 + MIN), true);
  assert.equal(usageForKeys(h, [KEY_A], T0 + MIN).known, false);
  // The old login's record is still on disk and is read again: ignored.
  updateHistory(h, [rec(KEY_A, T0, 80), rec(KEY_A, T0 + 2 * MIN, 4)], T0 + 2 * MIN);
  assert.equal(usageForKeys(h, [KEY_A], T0 + 2 * MIN).windows.five_hour.used, 4);
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
  assert.equal(usageForKeys(h, [KEY_A], T0 + 2 * MIN).known, false);
  updateHistory(h, [{ ...rec(KEY_A, T0 + 3 * MIN, 4), sessionId: 'live1' }], T0 + 3 * MIN); // its first call on the new login
  assert.equal(usageForKeys(h, [KEY_A], T0 + 3 * MIN).windows.five_hour.used, 4);
});

check('a login is remembered before its first figure, so the next login does not inherit it', () => {
  const h = emptyHistory();
  noteLogin(h, KEY_A, 'alice@x', T0);
  pruneHistory(h, T0);
  updateHistory(h, [{ ...rec(KEY_A, T0 + MIN, 0), sessionId: 's' }], T0 + MIN); // Alice's session publishes
  noteLogin(h, KEY_A, 'bob@x', T0 + 2 * MIN, [{ ...rec(KEY_A, T0 + MIN, 0), sessionId: 's' }]);
  assert.equal(usageForKeys(h, [KEY_A], T0 + 2 * MIN).known, false);
});

check('figures saved with no owner are cleared when the login turns out unknown', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, 40)], T0); // an older build kept no owner
  assert.equal(noteLogin(h, KEY_A, UNKNOWN_LOGIN, T0 + MIN), true);
  assert.equal(usageForKeys(h, [KEY_A], T0 + MIN).known, false);
});

check('a folder whose login is unknown before it has any figure remembers the boundary', () => {
  const h = emptyHistory();
  assert.equal(noteLogin(h, KEY_A, UNKNOWN_LOGIN, T0), true);
  updateHistory(h, [{ ...rec(KEY_A, T0 + MIN, 0), sessionId: 'old' }], T0 + MIN); // published while unknown
  noteLogin(h, KEY_A, 'b@x', T0 + 2 * MIN, [{ ...rec(KEY_A, T0 + MIN, 0), sessionId: 'old' }]);
  updateHistory(h, [{ ...rec(KEY_A, T0 + 3 * MIN, 0), sessionId: 'old' }], T0 + 3 * MIN); // republished
  assert.equal(usageForKeys(h, [KEY_A], T0 + 3 * MIN).known, false);
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

check('each window stands on its own: weekly known with no five-hour figure, and nothing reads 0%', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, undefined, 40)], T0); // weekly only, as real records often are
  const u = usageForKeys(h, [KEY_A], T0 + MIN);
  assert.equal(u.known, true);
  assert.equal(u.windows.five_hour, undefined);
  assert.equal(u.windows.seven_day.used, 40);
  assert.equal(u.headroom, 60);
  assert.equal(u.ageMs, MIN);
  const none = usageForKeys(h, [KEY_B], T0);
  assert.equal(none.known, false);
  assert.equal(none.lastReportedAt, null);
  assert.equal(none.headroom, null);
});

check('a lower figure republished later does not refresh an older, higher one', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, 90)], T0);
  updateHistory(h, [rec(KEY_A, T0 + 70 * MIN, 10)], T0 + 70 * MIN);
  const u = usageForKeys(h, [KEY_A], T0 + 70 * MIN);
  assert.equal(u.windows.five_hour.used, 90);
  assert.equal(u.ageMs, 70 * MIN);
  updateHistory(h, [rec(KEY_A, T0 + 71 * MIN, 90)], T0 + 71 * MIN);
  assert.equal(usageForKeys(h, [KEY_A], T0 + 71 * MIN).ageMs, 0, 'the same figure again does');
});

check('a weekly-only report does not make an old five-hour figure look fresh', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, 20, 10)], T0);
  updateHistory(h, [rec(KEY_A, T0 + 60 * MIN, undefined, 11)], T0 + 60 * MIN);
  const u = usageForKeys(h, [KEY_A], T0 + 61 * MIN);
  assert.equal(u.known, true);
  assert.equal(u.ageMs, 61 * MIN, 'the headline age is the five-hour figure\'s');
  assert.equal(u.lastReportedAt, T0);
  assert.equal(u.windows.five_hour.ageMs, 61 * MIN);
  assert.equal(u.windows.seven_day.ageMs, MIN);
});

check('one login under two folders: within a window the highest figure stands, a later window replaces', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, 20), rec(KEY_B, T0 - MIN, 70)], T0);
  assert.equal(usageForKeys(h, [KEY_A, KEY_B], T0).windows.five_hour.used, 70);
  assert.equal(usageForKeys(h, [KEY_B, KEY_A], T0).windows.five_hour.used, 70);
  assert.equal(usageForKeys(h, [KEY_A], T0).windows.five_hour.used, 20);
  updateHistory(h, [{ key: KEY_A, receivedAt: T0 + MIN, windows: { five_hour: { usedPercentage: 3, resetsAt: R5 + 5 * 3600 } } }], T0 + MIN);
  assert.equal(usageForKeys(h, [KEY_B, KEY_A], T0 + MIN).windows.five_hour.used, 3);
});

check('headroom is what the fullest live window leaves', () => {
  const h = emptyHistory();
  updateHistory(h, [rec(KEY_A, T0, 30, 85)], T0);
  const u = usageForKeys(h, [KEY_A], T0);
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

check('a login nobody can name fails closed, on either side', () => {
  assert.match(moveRefusal({ key: KEY_A, email: 'a@x' }, { key: KEY_B, email: null, login: 'in' }), /which login that account is/);
  assert.match(moveRefusal({ key: KEY_A, email: null, login: 'in' }, { key: KEY_B, email: 'b@x', login: 'in' }), /which login this tab is on/);
  assert.match(moveRefusal({ key: KEY_A, email: null, login: 'unknown' }, { key: KEY_B, email: 'b@x', login: 'in' }), /which login this tab is on/);
  assert.match(moveRefusal({ key: null, email: null, login: 'unknown' }, { key: KEY_B, email: 'b@x', login: 'in' }), /which login this tab is on/);
  // A source with no credential at all is on no login: nothing can be shared.
  assert.equal(moveRefusal({ key: KEY_A, email: null, login: 'out' }, { key: KEY_B, email: 'b@x', login: 'in' }), null);
});

check('a move needs one child Claude, its conversation and its folder; a warned person may move a busy tab', () => {
  const ok = { running: 'claude', session: { sessionId: 's', project: '/p' }, busy: false, draft: false };
  assert.equal(moveBlock(ok), null);
  assert.match(moveBlock({ ...ok, running: 'shell' }), /no Claude/);
  assert.match(moveBlock({ ...ok, running: 'other' }, { allowBusy: true }), /other than one Claude/);
  assert.match(moveBlock({ ...ok, session: null }, { allowBusy: true }), /could not be identified/);
  assert.match(moveBlock({ ...ok, session: { sessionId: 's', project: null } }, { allowBusy: true }), /folder/);
  assert.match(moveBlock({ ...ok, busy: true }), /middle of a turn/);
  assert.match(moveBlock({ ...ok, busy: true, status: 'needs' }), /question/);
  assert.match(moveBlock({ ...ok, draft: true }), /unsent text/);
  assert.equal(moveBlock({ ...ok, busy: true, draft: true }, { allowBusy: true, allowDraft: true }), null);
  assert.match(moveBlock({ ...ok, busy: true, draft: true }, { allowBusy: true }), /unsent text/, 'told about the turn, not about a draft that appeared since');
  assert.match(moveBlock({ ...ok, busy: true, draft: true }, { allowDraft: true }), /middle of a turn/);
  assert.match(moveBlock({ ...ok, override: 'ANTHROPIC_API_KEY' }, { allowBusy: true }), /ANTHROPIC_API_KEY is set/);
  assert.match(moveBlock({ ...ok, override: 'unreadable' }, { allowBusy: true }), /could not be read/);
});

check('an auth override is read from the environment only, and a HOME other than ours counts', () => {
  const names = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
  assert.equal(authOverrideIn(null, names, '/Users/x'), 'unreadable');
  assert.equal(authOverrideIn(' PATH=/bin HOME=/Users/x USER=x', names, '/Users/x'), null);
  assert.equal(authOverrideIn(' PATH=/bin HOME=/Users/x', names, '/Users/x'), null);
  assert.equal(authOverrideIn(' PATH=/bin', names, '/Users/x'), null);
  assert.equal(authOverrideIn(' ANTHROPIC_API_KEY=abc HOME=/Users/x', names, '/Users/x'), 'ANTHROPIC_API_KEY');
  assert.equal(authOverrideIn(' ANTHROPIC_API_KEY= HOME=/Users/x', names, '/Users/x'), null, 'set empty signs nothing in');
  assert.equal(authOverrideIn(' HOME=/Users/x/.claude-profiles/b USER=x', names, '/Users/x'), 'HOME');
  assert.equal(authOverrideIn(' HOME=/Users/xy USER=x', names, '/Users/x'), 'HOME');
  assert.equal(authOverrideIn(' HOME=/Users/x more USER=x', names, '/Users/x'), 'HOME');
});

// The menu exactly as the real frame draws it (fixture in the service test).
const MENU = ['▔▔▔▔▔▔▔▔', '   What do you want to do?', '   ❯ 1. Stop and wait for limit to reset', '     2. Wait here, then continue automatically at Nov 4 at 12am', '     3. Switch to usage credits', '   Enter to confirm · Esc to cancel'];
const BOX = ['────────', '❯ ', '────────', '  ⏵⏵ auto mode on'];
check('the limit menu is read by structure from the live bottom, not by its words', () => {
  assert.equal(limitMenuOn(['some transcript', '', ...MENU, '']), true);
  assert.equal(limitMenuOn([...MENU.slice(0, 2), '     1. Stop and wait for limit to reset', '   ❯ 2. Wait here', ...MENU.slice(4)]), true, 'pointer moved down');
  // Lookalikes: the same words where a person or a tool can put them.
  assert.equal(limitMenuOn([...MENU, ...BOX]), false, 'transcript or tool output above an input box');
  assert.equal(limitMenuOn(['────────', '❯ What do you want to do?', '  ❯ 1. Stop and wait for limit to reset', '    2. Wait here', '  Enter to confirm · Esc to cancel', '────────', '  ⏵⏵ auto mode on']), false, 'a draft quoting it');
  assert.equal(limitMenuOn(['⎿ What do you want to do?', '  ❯ 1. Stop and wait for limit to reset', '    2. Wait here', '  Enter to confirm · Esc to cancel']), false, 'tool output as the last rows, no top edge');
  assert.equal(limitMenuOn(['▔▔▔▔', 'What do you want to do? (limit to reset, usage credits)', '❯ 1. Yes', '  2. No', 'Enter to confirm · Esc to cancel']), false, 'the old word match');
  assert.equal(limitMenuOn(['▔▔▔▔', 'What do you want to do?', '  1. Stop and wait for limit to reset', '  2. Wait here', 'Enter to confirm · Esc to cancel']), false, 'no pointer');
  assert.equal(limitMenuOn(['▔▔▔▔', 'What do you want to do?', '❯ 1. Yes', '  2. No', 'Enter to confirm · Esc to cancel']), false, 'some other question');
  assert.equal(limitMenuOn([...MENU.slice(0, -1)]), false, 'no footer');
  assert.equal(limitMenuOn(['▔▔▔▔', 'printed by a tool', '❯ 1. Stop and wait for limit to reset', '  2. Wait here', 'Enter to confirm · Esc to cancel']), false, 'no question row');
  assert.equal(limitMenuOn(['printed by a tool', 'What do you want to do?', '❯ 1. Stop and wait for limit to reset', '  2. Wait here', 'Enter to confirm · Esc to cancel']), false, 'no top edge');
  assert.equal(limitMenuOn(null), false);
});

check('the trust prompt is read the same way', () => {
  const T = [' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'];
  assert.equal(trustPromptOn(['Security guide', ...T, '']), true);
  assert.equal(trustPromptOn(['   No, exit', ' ❯ Yes, I trust this folder', T[2]]), true);
  assert.equal(trustPromptOn([...T, ...BOX]), false, 'quoted above an input box');
  assert.equal(trustPromptOn(['Yes, I trust this folder', ...BOX]), false);
  assert.equal(trustPromptOn(['   No, exit', '   Yes, I trust this folder', T[2]]), false, 'no pointer');
  assert.equal(trustPromptOn(null), false);
});

const cand = (id, known, headroom, lastReportedAt = T0, extra = {}) => ({
  id, usage: { known, headroom: known ? headroom : null, limited: known && headroom <= 0, lastReportedAt }, refusal: null, ...extra,
});

check('ranking puts every known account above every unknown one, most headroom first', () => {
  const ranked = rankTargets([cand('u1', false), cand('k10', true, 10), cand('k80', true, 80), cand('u2', false), cand('k80new', true, 80, T0 + MIN)]);
  assert.deepEqual(ranked.map((c) => c.id), ['k80new', 'k80', 'k10', 'u1', 'u2']);
});

check('busy means a permission prompt, or a working tab still drawing; a stale working is not busy', () => {
  const now = T0;
  assert.equal(tabBusy({ status: 'needs', lastActivityAt: now - 3600_000 }, now), true);
  assert.equal(tabBusy({ status: 'working', lastActivityAt: now - 2000 }, now), true);
  assert.equal(tabBusy({ status: 'working', lastActivityAt: now - 60_000 }, now), false);
  assert.equal(tabBusy({ status: 'done', lastActivityAt: now }, now), false);
  assert.equal(tabBusy(null, now), false);
  // Claude's own record, when there is one, says more than the hook can.
  assert.equal(tabBusy({ status: 'done', lastActivityAt: now - 60_000 }, now, 'busy'), true);
  assert.equal(tabBusy(null, now, 'shell'), true);
  assert.equal(tabBusy({ status: 'working', lastActivityAt: now - 60_000 }, now, 'idle'), false);
});

console.log(`\n${pass} passed`);
