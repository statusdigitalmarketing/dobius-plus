// Auto-move end to end against fake system deps (electron/account-headroom-service.js):
// one move per limit event, the notice when nowhere is left, and the guards on
// sending "continue". Plus the tab pin resolution at the spawn choke point.
// Run: node --import ./electron/__tests__/register.mjs ./electron/__tests__/account-headroom-service.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHeadroomService, isDraft, draftOnScreen } from '../account-headroom-service.js';
import { keychainServiceFor } from '../account-identity.js';
import { resolveClaudeAccountPin } from '../spawn-account-env.js';
import { pruneUsageRecords } from '../claude-usage.js';

let pass = 0;
const check = async (label, fn) => { await fn(); pass += 1; console.log(`PASS  ${label}`); };

const TAB = 'term-/proj-1';
const TAB2 = 'term-/proj-2';
const HOMEC = path.join(os.homedir(), '.claude');
const DIR_A = '/profiles/a';
const DIR_B = '/profiles/b';
const KEY_A = keychainServiceFor(DIR_A);
const KEY_B = keychainServiceFor(DIR_B);
const T0 = 1_800_000_000_000;
const R5 = T0 / 1000 + 3 * 3600;

function world(over = {}) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-headroom-'));
  const w = {
    now: T0,
    sent: [], notices: [], logs: [], submits: [],
    inputSeq: 5,
    pty: { pid: 1 },
    claude: { pid: 100, sessionId: null, startedAt: T0 - 3600_000 },
    limit: { at: T0 - 60_000, text: "You've hit your 5-hour limit" },
    procKey: KEY_A,
    records: [
      { key: KEY_A, receivedAt: T0 - 30_000, windows: { five_hour: { usedPercentage: 100, resetsAt: R5 } } },
      { key: KEY_B, receivedAt: T0 - 60_000, windows: { five_hour: { usedPercentage: 20, resetsAt: R5 } } },
    ],
    emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', [HOMEC]: 'd@x.com' },
    autoMove: true,
    tail: "You've hit your 5-hour limit",
    ...over,
  };
  const svc = createHeadroomService({
    userDataDir: ud,
    now: () => w.now,
    sleep: async (ms) => { w.now += ms; },
    getAccounts: () => [
      { id: 'a', type: 'claude', name: 'A', claudeJsonPath: `${DIR_A}/.claude.json` },
      { id: 'b', type: 'claude', name: 'B', claudeJsonPath: `${DIR_B}/.claude.json` },
      ...(w.extraAccount ? [{ id: 7, type: 'claude', name: 'Seven', claudeJsonPath: '/profiles/seven/.claude.json' }] : []),
      ...(w.extraAccounts || []),
    ],
    defaultDir: () => HOMEC,
    defaultEnvUnset: () => true,
    cliDefaultDir: () => HOMEC,
    keyFor: (dir) => keychainServiceFor(dir),
    login: async () => 'in',
    inputHeld: () => !!w.held,
    metadata: async (dir, opts) => {
      if (w.unreadableInner && opts?.envUnset === false) return { email: null, state: 'unreadable' };
      const email = opts?.envUnset === false && w.innerEmails?.[dir] !== undefined ? w.innerEmails[dir] : (w.emails[dir] ?? null);
      return { email, state: email ? 'address' : 'none' };
    },
    realpath: async (p) => (w.links?.[p] ?? p),
    isForeground: async () => w.foreground ?? true,
    sharesHistory: async (dir) => !(w.privateHistory && w.privateHistory.includes(dir)),
    processAuthOverride: async (pid) => (w.override && w.override[pid]) || null,
    settled: () => w.settled ?? true,
    selector: () => null,
    readRecords: async () => w.records,
    pruneRecords: async () => 0,
    scan: async () => ({ groups: w.procKey === null ? [] : [{ key: w.procKey, configDir: w.procDir ?? { [KEY_A]: DIR_A, [KEY_B]: DIR_B }[w.procKey], envUnset: false, pids: [w.claude.pid] }], unresolved: w.procKey === null ? [{ pid: w.claude.pid }] : [] }),
    autoMoveEnabled: () => w.autoMove,
    tabs: () => [{ id: TAB, cwd: '/proj', claudeConfigDir: DIR_A }, ...(w.secondTab ? [{ id: TAB2, cwd: '/proj', claudeConfigDir: DIR_A }] : [])],
    activity: () => ({ status: 'done', lastActivityAt: w.now - 60_000 }),
    claudeInfo: async () => w.claude,
    resolveSession: async () => ({ sessionId: 's1', sessionProject: '/proj' }),
    process: async () => null,
    limitRecord: async () => ({ found: true, limit: w.limit }),
    strippedTail: () => w.tail,
    screen: async () => ({ lines: [w.screenLine ?? "You've hit your 5-hour limit", '────', '❯ ', '────'], modes: { bracketedPaste: true } }),
    promptReady: () => true,
    promptBox: () => w.box ?? '',
    windowOf: () => 7,
    send: (id, channel, payload) => {
      if (channel === 'accounts:autoMoveNotice') w.notices.push(payload.text); else w.sent.push({ id, channel, payload });
      return 'sent';
    },
    inputAgeMs: () => w.inputAge ?? 10 * 60_000,
    inputSeq: () => w.inputSeq,
    outputSeq: () => 1,
    pty: () => w.pty,
    closing: () => false,
    processCwd: async (pid) => (pid === 200 ? (w.resumedCwd ?? '/proj') : '/proj'),
    samePath: async (a, b) => a === b,
    rows: () => 40,
    authOverride: () => w.authOverride ?? null,
    submit: async (id, text) => { w.submits.push(text); return true; },
    log: (kind, detail) => w.logs.push(detail),
  });
  return { w, svc };
}

// What the window does: confirm right before the restart, then the resumed
// Claude appears on the target.
async function moved(w, svc) {
  await svc.tick();
  const { eventId } = w.sent[0].payload;
  const st = await svc.startAutoMove(TAB, eventId, 7);
  assert.equal(st.ok, true, JSON.stringify(st));
  assert.equal(st.inputSeq, w.inputSeq, 'the restart is conditional on this input count');
  w.claude = { pid: 200, sessionId: 's1', startedAt: T0 + 1000 };
  w.procKey = KEY_B;
  return eventId;
}

await check('a tab that hit its limit is moved once, to the account with headroom', async () => {
  const { w, svc } = world();
  await svc.tick();
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].payload.accountId, 'b');
  assert.match(w.logs[0], /from=A to=B .*result=moving/);
  // Next ticks: pending, then handled. Never a second move for this event.
  w.now += 61_000; await svc.tick();
  w.now += 61_000; await svc.tick();
  assert.equal(w.sent.length, 1);
});

await check('the tab\'s own screen must show the limit, even with --resume in argv (a /clear leaves the old record behind)', async () => {
  const { w, svc } = world({ screenLine: 'all quiet' });
  await svc.tick();
  assert.equal(w.sent.length, 0, 'a 100% account alone does not name this conversation');
  const named = world({ screenLine: 'all quiet' });
  named.w.claude = { ...named.w.claude, sessionId: 's1' }; // claude --resume s1, then /clear
  await named.svc.tick();
  assert.equal(named.w.sent.length, 0);
});

await check('no "continue" to a Claude that is not in the foreground', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.foreground = false;
  assert.equal((await svc.continueAfterMove(TAB, eventId, 7, null)).ok, false);
  assert.deepEqual(w.submits, []);
});

await check('a target whose figure is old and has no session running is never picked automatically', async () => {
  const { w, svc } = world();
  w.records[1].receivedAt = T0 - 3600_000;
  await svc.tick();
  assert.equal(w.sent.length, 0);
  assert.match(w.notices[0], /every other account/);
});

await check('a token or API key in Dobius\'s environment refuses every move', async () => {
  const { w, svc } = world({ authOverride: 'CLAUDE_CODE_OAUTH_TOKEN' });
  const r = await svc.moveTargets(TAB);
  assert.ok(r.targets.every((t) => /CLAUDE_CODE_OAUTH_TOKEN/.test(t.refusal)));
  await svc.tick();
  assert.equal(w.sent.length, 0);
});

await check('no "continue" if Claude came back in another folder (a worktree it could not re-enter)', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.resumedCwd = '/proj-root';
  const r = await svc.continueAfterMove(TAB, eventId, 7, null);
  assert.equal(r.ok, false);
  assert.deepEqual(w.submits, []);
});

await check('no "continue" once auto-move is switched off', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.autoMove = false;
  const r = await svc.continueAfterMove(TAB, eventId, 7, null);
  assert.equal(r.ok, false);
  assert.deepEqual(w.submits, []);
});

await check('auto-move off: nothing moves', async () => {
  const { w, svc } = world({ autoMove: false });
  await svc.tick();
  assert.equal(w.sent.length, 0);
});

await check('a limit older than the claude in the tab (a resumed transcript) never moves it', async () => {
  const { w, svc } = world();
  w.claude = { ...w.claude, startedAt: w.limit.at + 1000 };
  await svc.tick();
  assert.equal(w.sent.length, 0);
});

await check('nowhere left to go: one notice, no move', async () => {
  const { w, svc } = world();
  w.records[1].windows.five_hour.usedPercentage = 100;
  await svc.tick();
  assert.equal(w.sent.length, 0);
  assert.equal(w.notices.length, 1);
  assert.match(w.notices[0], /every other account is limited/);
  w.now += 61_000; await svc.tick();
  assert.equal(w.notices.length, 1, 'the notice is not repeated for the same event');
});

await check('the same login under another folder is never an automatic target', async () => {
  const { w, svc } = world();
  w.emails[DIR_B] = 'A@x.com';
  await svc.tick();
  assert.equal(w.sent.length, 0);
});

await check('"continue" goes out once Claude is back on the target account', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  const r = await svc.continueAfterMove(TAB, eventId, 7, null);
  assert.equal(r.ok, true);
  assert.deepEqual(w.submits, ['continue']);
  assert.match(w.logs.at(-1), /result=continued/);
});

await check('no "continue" from another window, or twice', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  assert.equal((await svc.continueAfterMove(TAB, eventId, 99, null)).ok, false);
  await svc.continueAfterMove(TAB, eventId, 7, null);
  assert.equal((await svc.continueAfterMove(TAB, eventId, 7, null)).ok, false);
  assert.deepEqual(w.submits, ['continue']);
});

await check('no "continue" if the resumed Claude is not on the target credential', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.procKey = KEY_A; // a shell rc put it back on A
  const r = await svc.continueAfterMove(TAB, eventId, 7, null);
  assert.equal(r.ok, false);
  assert.deepEqual(w.submits, []);
  assert.match(w.notices.at(-1), /not using that account/);
});

await check('no "continue" if someone typed after the resume', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  const origSleep = w.now;
  // A key lands while main waits for the prompt.
  const p = svc.continueAfterMove(TAB, eventId, 7, null);
  w.inputSeq += 1;
  const r = await p;
  assert.ok(w.now >= origSleep);
  assert.equal(r.ok, false);
  assert.deepEqual(w.submits, []);
});

await check('no "continue" if the conversation moved on', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.limit = null;
  const r = await svc.continueAfterMove(TAB, eventId, 7, null);
  assert.equal(r.ok, false);
  assert.deepEqual(w.submits, []);
});

await check('a window that could not move the tab is logged and noticed', async () => {
  const { w, svc } = world();
  await svc.tick();
  const r = await svc.continueAfterMove(TAB, w.sent[0].payload.eventId, 7, 'that conversation is already running somewhere else');
  assert.equal(r.ok, false);
  assert.match(w.logs.at(-1), /not-moved/);
});

await check('unsent text in the prompt holds an automatic move', async () => {
  assert.equal(isDraft('half a thought'), true);
  assert.equal(isDraft(''), false);
  assert.equal(isDraft('Try "git status"'), true, 'placeholder-shaped text is still treated as the person\'s');
  assert.equal(isDraft('Try "git status" first, then explain'), true);
  assert.equal(isDraft(null), false);
  // A box that cannot be read is always a possible draft.
  assert.equal(draftOnScreen(null), true);
  assert.equal(draftOnScreen(''), false);
});

await check('the window must confirm right before restarting: typing, a draft or a busy tab since the decision cancels it', async () => {
  for (const spoil of [(w) => { w.inputSeq += 1; }, (w) => { w.box = 'new words'; }, (w) => { w.held = true; }]) {
    const { w, svc } = world();
    await svc.tick();
    spoil(w);
    const st = await svc.startAutoMove(TAB, w.sent[0].payload.eventId, 7);
    assert.equal(st.ok, false);
    assert.match(w.logs.at(-1), /not-moved/);
    // and nothing can be continued for it afterwards
    assert.equal((await svc.continueAfterMove(TAB, w.sent[0].payload.eventId, 7, null)).ok, false);
  }
});

await check('a move that was never started cannot be continued', async () => {
  const { w, svc } = world();
  await svc.tick();
  w.claude = { pid: 200, sessionId: 's1', startedAt: T0 + 1000 };
  w.procKey = KEY_B;
  assert.equal((await svc.continueAfterMove(TAB, w.sent[0].payload.eventId, 7, null)).ok, false);
  assert.deepEqual(w.submits, []);
});

await check('no "continue" while the window holds input for the tab (an image paste being saved)', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.held = true;
  const r = await svc.continueAfterMove(TAB, eventId, 7, null);
  assert.equal(r.ok, false);
  assert.deepEqual(w.submits, []);
});

await check('an account whose id is not a string can never be a target (it would read as Default)', async () => {
  const { w, svc } = world();
  w.extraAccount = true;
  const r = await svc.moveTargets(TAB);
  const odd = r.targets.find((t) => t.label === 'Seven');
  assert.match(odd.refusal, /no usable id/);
});

await check('usage rows: every account, unknown where nothing reported', async () => {
  const { svc } = world({ records: [{ key: KEY_B, receivedAt: T0 - 60_000, windows: { five_hour: { usedPercentage: 20, resetsAt: R5 } } }] });
  const u = await svc.usage();
  assert.deepEqual(u.accounts.map((r) => [r.label, r.usage.known]), [['Default', false], ['A', false], ['B', true]]);
  assert.equal(u.accounts[2].usage.headroom, 80);
});

await check('move targets refuse the tab\'s own account', async () => {
  const { svc } = world();
  const r = await svc.moveTargets(TAB);
  const a = r.targets.find((t) => t.label === 'A');
  assert.match(a.refusal, /already on/);
  assert.equal(r.targets[0].label, 'B');
});

await check('a folder logged into the same address shows that login\'s figures, marked with where they came from', async () => {
  const { w, svc } = world();
  w.emails[DIR_A] = 'b@x.com'; // A and B: one login, two folders
  w.records = [{ key: KEY_B, receivedAt: T0 - 60_000, windows: { five_hour: { usedPercentage: 30, resetsAt: R5 } } }];
  const u = await svc.usage();
  const a = u.accounts.find((r) => r.label === 'A');
  assert.equal(a.usage.known, true);
  assert.equal(a.usage.windows.five_hour.used, 30);
  assert.equal(a.usage.via, 'B');
});

await check('a re-login of a folder clears its figures; a credential two files disagree on is left alone', async () => {
  const { w, svc } = world({ records: [{ key: KEY_B, receivedAt: T0 - 60_000, windows: { five_hour: { usedPercentage: 30, resetsAt: R5 } } }] });
  assert.equal((await svc.usage()).accounts.find((r) => r.label === 'B').usage.known, true);
  w.emails[DIR_B] = 'new@x.com';
  w.now += 1000;
  assert.equal((await svc.usage()).accounts.find((r) => r.label === 'B').usage.known, false);
});

await check('one login under two folders: the highest figure in the window stands, a republished low one cannot hide a limit', async () => {
  const { w, svc } = world();
  w.emails[DIR_A] = 'b@x.com';
  w.records = [
    { key: KEY_A, receivedAt: T0 - 120_000, windows: { five_hour: { usedPercentage: 100, resetsAt: R5 } } },
    { key: KEY_B, receivedAt: T0 - 10_000, windows: { five_hour: { usedPercentage: 20, resetsAt: R5 } } },
  ];
  const u = await svc.usage();
  for (const label of ['A', 'B']) {
    const r = u.accounts.find((x) => x.label === label);
    assert.equal(r.usage.windows.five_hour.used, 100, label);
    assert.equal(r.usage.limited, true, label);
  }
});

await check('a target re-logged into another account while the move waited is called off', async () => {
  const { w, svc } = world();
  await svc.tick();
  w.emails[DIR_B] = 'someone-else@x.com';
  const st = await svc.startAutoMove(TAB, w.sent[0].payload.eventId, 7);
  assert.equal(st.ok, false);
  assert.match(st.error, /different account/);
});

await check('no "continue" if the target folder was re-logged after the restart', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.emails[DIR_B] = 'a@x.com';
  assert.equal((await svc.continueAfterMove(TAB, eventId, 7, null)).ok, false);
  assert.deepEqual(w.submits, []);
});

await check('no "continue" when Claude\'s box already holds text (input that arrived before the check)', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.box = 'only explain ';
  assert.equal((await svc.continueAfterMove(TAB, eventId, 7, null)).ok, false);
  assert.deepEqual(w.submits, []);
});

await check('a token exported into the resumed Claude\'s shell stops "continue"; one in the limited tab stops the move', async () => {
  const a = world();
  const eventId = await moved(a.w, a.svc);
  a.w.override = { 200: 'CLAUDE_CODE_OAUTH_TOKEN' };
  assert.equal((await a.svc.continueAfterMove(TAB, eventId, 7, null)).ok, false);
  assert.deepEqual(a.w.submits, []);
  const b = world();
  b.w.override = { 100: 'ANTHROPIC_API_KEY' };
  await b.svc.tick();
  assert.equal(b.w.sent.length, 0);
  assert.match(b.w.notices[0], /ANTHROPIC_API_KEY/);
});

await check('a move the window never started gives its event back when it expires', async () => {
  const { w, svc } = world();
  await svc.tick();
  assert.equal(w.sent.length, 1);
  w.now += 4 * 60_000;
  await svc.tick(); // expires the pending move
  assert.match(w.logs.find((l) => /abandoned/.test(l)), /never started/);
  w.now += 61_000;
  await svc.tick(); // the same limit, still there, is acted on again
  assert.equal(w.sent.length, 2);
});

await check('an auth environment that cannot be read stops "continue" (never read as "none")', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.override = { 200: 'unreadable' };
  assert.equal((await svc.continueAfterMove(TAB, eventId, 7, null)).ok, false);
  assert.deepEqual(w.submits, []);
});

await check('a screen that has not caught up with input is not trusted to show an empty box', async () => {
  const { w, svc } = world();
  const eventId = await moved(w, svc);
  w.settled = false;
  w.inputAge = 100; // input just arrived and the screen has not redrawn since
  assert.equal((await svc.continueAfterMove(TAB, eventId, 7, null)).ok, false);
  assert.deepEqual(w.submits, []);
});

await check('a move called off before it started gives its event back', async () => {
  const { w, svc } = world();
  await svc.tick();
  w.inputSeq += 1;
  assert.equal((await svc.startAutoMove(TAB, w.sent[0].payload.eventId, 7)).ok, false);
  w.now += 2 * 60_000;
  await svc.tick();
  assert.equal(w.sent.length, 2, 'the same limit is acted on again later');
});

await check('the default credential whose two metadata files disagree has no known login', async () => {
  const { w, svc } = world();
  w.innerEmails = { [HOMEC]: 'other@x.com' };
  const u = await svc.usage();
  assert.equal(u.accounts.find((r) => r.isDefault).email, null);
});

await check('reservations count per login: two folders of one login cannot both take tabs on the same headroom', async () => {
  const { w, svc } = world();
  // A third account C, a fresh figure of 75% (25% headroom), and B also has a second folder B2.
  w.extraAccounts = [
    { id: 'b2', type: 'claude', name: 'B2', claudeJsonPath: '/profiles/b2/.claude.json' },
    { id: 'c', type: 'claude', name: 'C', claudeJsonPath: '/profiles/c/.claude.json' },
  ];
  w.emails['/profiles/b2'] = 'b@x.com';
  w.emails['/profiles/c'] = 'c@x.com';
  w.records[1].windows.five_hour.usedPercentage = 72; // B: 28% headroom
  w.records.push({ key: keychainServiceFor('/profiles/c'), receivedAt: T0 - 60_000, windows: { five_hour: { usedPercentage: 76, resetsAt: R5 } } });
  w.secondTab = true;
  await svc.tick();
  const targets = w.sent.map((m) => m.payload.accountId);
  assert.equal(targets.length, 2);
  assert.ok(targets.includes('c'), `second tab must go to the other login, got ${targets}`);
});

await check('a Claude pointed at an unlisted folder is judged by THAT folder\'s login, not the tab\'s', async () => {
  const { w, svc } = world();
  // The tab was spawned on A, but its Claude runs on an unsaved folder X
  // logged into B's address: B is the same login and must not be a target.
  w.procKey = keychainServiceFor('/profiles/x');
  w.procDir = '/profiles/x';
  w.emails['/profiles/x'] = 'b@x.com';
  w.records.push({ key: w.procKey, receivedAt: T0 - 30_000, windows: { five_hour: { usedPercentage: 100, resetsAt: R5 } } });
  const r = await svc.moveTargets(TAB);
  assert.match(r.targets.find((t) => t.label === 'B').refusal, /same login/);
});

await check('a restart the window could not do gives the event back', async () => {
  const { w, svc } = world();
  await svc.tick();
  const { eventId } = w.sent[0].payload;
  assert.equal((await svc.startAutoMove(TAB, eventId, 7)).ok, true);
  await svc.continueAfterMove(TAB, eventId, 7, 'the tab was not restarted');
  w.now += 2 * 60_000;
  await svc.tick();
  assert.equal(w.sent.length, 2);
});

await check('an unreadable second metadata file on the default credential makes its login unknown', async () => {
  const { w, svc } = world();
  w.unreadableInner = true;
  const u = await svc.usage();
  assert.equal(u.accounts.find((r) => r.isDefault).email, null);
});

await check('a folder whose conversations are not the shared store is refused (the resume would read another copy)', async () => {
  const { w, svc } = world();
  w.privateHistory = [DIR_B];
  const r = await svc.moveTargets(TAB);
  assert.match(r.targets.find((t) => t.label === 'B').refusal, /history is not linked/);
  await svc.tick();
  assert.equal(w.sent.length, 0);
});

await check('a hold taken with no known window is not released by a late cached figure', async () => {
  const { w, svc } = world();
  w.records = [{ key: KEY_B, receivedAt: T0 - 60_000, windows: { five_hour: { usedPercentage: 20, resetsAt: R5 } } }]; // A has no figure
  w.tail = "You've hit your 5-hour limit";
  w.claude = { ...w.claude, sessionId: 's1' };
  await svc.tick(); // A (no figure) is held, tab moves to B
  w.now += 60_000;
  w.records.push({ key: KEY_A, receivedAt: w.now - 1000, windows: { five_hour: { usedPercentage: 20, resetsAt: R5 } } });
  await svc.usage();
  const r = await svc.moveTargets(TAB);
  assert.equal(r.targets.find((t) => t.label === 'A').usage.limited, true);
});

await check('a limit hold ends when that folder\'s five-hour window has reset since', async () => {
  const { w, svc } = world();
  // Tab 1 on A hits a limit: A is held. Then A's window resets and reports 1%.
  w.emails[DIR_B] = 'b@x.com';
  await svc.tick(); // moves tab 1 to B, holds A
  w.now += 6 * 60_000;
  const R5b = R5 + 5 * 3600;
  w.records = [
    { key: KEY_A, receivedAt: w.now - 1000, windows: { five_hour: { usedPercentage: 1, resetsAt: R5b } } },
    { key: KEY_B, receivedAt: w.now - 1000, windows: { five_hour: { usedPercentage: 100, resetsAt: R5 } } },
  ];
  const u = await svc.usage();
  const r = await svc.moveTargets(TAB);
  assert.equal(u.accounts.find((x) => x.label === 'A').usage.windows.five_hour.used, 1);
  assert.equal(r.targets.find((t) => t.label === 'A').usage.limited, false, 'the new window is not held');
});

await check('two configured folders that are one folder on disk have no known login', async () => {
  const { w, svc } = world();
  w.links = { [DIR_B]: DIR_A }; // B is a symlink to A: one metadata file, two Keychain items
  const u = await svc.usage();
  assert.equal(u.accounts.find((r) => r.label === 'A').email, null);
  assert.equal(u.accounts.find((r) => r.label === 'B').email, null);
  await svc.tick();
  assert.equal(w.sent.length, 0);
});

await check('a credential whose login becomes unknown loses its figures', async () => {
  const { w, svc } = world({ records: [{ key: KEY_B, receivedAt: T0 - 60_000, windows: { five_hour: { usedPercentage: 30, resetsAt: R5 } } }] });
  assert.equal((await svc.usage()).accounts.find((r) => r.label === 'B').usage.known, true);
  w.links = { [DIR_B]: DIR_A };
  w.now += 1000;
  assert.equal((await svc.usage()).accounts.find((r) => r.label === 'B').usage.known, false);
});

await check('while a login stays unknown, new reports are not kept for it', async () => {
  const { w, svc } = world({ records: [{ key: KEY_B, receivedAt: T0 - 60_000, windows: { five_hour: { usedPercentage: 30, resetsAt: R5 } }, sessionId: 'x1' }] });
  await svc.usage();
  w.emails[DIR_B] = null; // its metadata no longer names anyone
  w.now += 1000;
  assert.equal((await svc.usage()).accounts.find((r) => r.label === 'B').usage.known, false);
  w.records = [{ key: KEY_B, receivedAt: w.now, windows: { five_hour: { usedPercentage: 35, resetsAt: R5 } }, sessionId: 'x1' }];
  w.now += 1000;
  assert.equal((await svc.usage()).accounts.find((r) => r.label === 'B').usage.known, false);
});

await check('every row on a folder that another spelling links to loses its login, duplicates included', async () => {
  const { w, svc } = world();
  w.extraAccounts = [
    { id: 'a2', type: 'claude', name: 'A2', claudeJsonPath: `${DIR_A}/.claude.json` },
    { id: 'l', type: 'claude', name: 'L', claudeJsonPath: '/profiles/l/.claude.json' },
  ];
  w.links = { '/profiles/l': DIR_A };
  w.emails['/profiles/l'] = 'b@x.com';
  const u = await svc.usage();
  for (const label of ['A', 'A2', 'L']) assert.equal(u.accounts.find((r) => r.label === label).email, null, label);
});

await check('a credential file that lives outside its folder makes that folder\'s login unknown, whatever it links to', async () => {
  const { w, svc } = world();
  w.links = { [`${DIR_B}/.credentials.json`]: '/profiles/unlisted/.credentials.json' };
  const u = await svc.usage();
  assert.equal(u.accounts.find((r) => r.label === 'B').email, null);
  assert.equal(u.accounts.find((r) => r.label === 'A').email, 'a@x.com');
});

await check('a folder whose login was unknown from the start keeps its boundary, so old records never reach the next login', async () => {
  const { w, svc } = world({ records: [{ key: KEY_B, receivedAt: T0 - 60_000, windows: { five_hour: { usedPercentage: 0, resetsAt: R5 } }, sessionId: 'x1' }] });
  w.emails[DIR_B] = null;
  assert.equal((await svc.usage()).accounts.find((r) => r.label === 'B').usage.known, false, 'figures nobody can be named for are not shown');
  w.now += 16_000; await svc.usage();
  w.emails[DIR_B] = 'someone@x.com';
  w.now += 16_000;
  assert.equal((await svc.usage()).accounts.find((r) => r.label === 'B').usage.known, false);
});

await check('a move request that outlived its expiry cannot be taken for a later retry of the same limit', async () => {
  const { w, svc } = world();
  await svc.tick();
  const first = w.sent[0].payload.eventId;
  w.now += 4 * 60_000;
  await svc.tick();
  w.now += 61_000;
  await svc.tick();
  const second = w.sent[1].payload.eventId;
  assert.notEqual(first, second);
  assert.equal((await svc.startAutoMove(TAB, first, 7)).ok, false);
  assert.equal((await svc.startAutoMove(TAB, second, 7)).ok, true);
});

await check('Move all stays available on the account this tab is already on', async () => {
  const { svc } = world();
  const r = await svc.moveTargets(TAB);
  const a = r.targets.find((t) => t.label === 'A');
  assert.match(a.refusal, /already on/);
  assert.equal(a.allRefusal, null);
});

await check('a Claude whose folder the process scan cannot read is not moved automatically', async () => {
  const { w, svc } = world();
  w.procKey = null; // its environment could not be read
  await svc.tick();
  assert.equal(w.sent.length, 0);
});

await check('a hold ends at the reset of the window it was taken in, whichever folder reports next', async () => {
  const { w, svc } = world();
  const soon = T0 / 1000 + 600; // A's five-hour window resets ten minutes from now
  w.records[0].windows.five_hour.resetsAt = soon;
  await svc.tick(); // A held (30 minutes), taken in the window that resets at `soon`
  w.now = soon * 1000 + 60_000;
  const r = await svc.moveTargets(TAB);
  assert.notEqual(r.targets.find((t) => t.label === 'A').usage.limited, true);
});

// ---- pin at the spawn choke point ----

await check('a tab pin names exactly one Claude account, or Default, or nothing', async () => {
  const accts = [
    { id: 'a', type: 'claude', claudeJsonPath: '/p/a/.claude.json' },
    { id: 'dup', type: 'claude', claudeJsonPath: '/p/1/.claude.json' },
    { id: 'dup', type: 'claude', claudeJsonPath: '/p/2/.claude.json' },
    { id: 'c', type: 'codex' },
  ];
  assert.equal(resolveClaudeAccountPin({ id: 'a' }, accts).id, 'a');
  assert.equal(resolveClaudeAccountPin({ id: null }, accts), null);
  assert.equal(resolveClaudeAccountPin({ id: 'dup' }, accts), undefined);
  assert.equal(resolveClaudeAccountPin({ id: 'c' }, accts), undefined);
  assert.equal(resolveClaudeAccountPin({ id: '/etc' }, accts), undefined);
  assert.equal(resolveClaudeAccountPin(undefined, accts), undefined);
  assert.equal(resolveClaudeAccountPin({}, accts), undefined);
});

// ---- record pruning ----

await check('old usage records and stray temp files are pruned, nothing else', async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dobius-prune-'));
  const dir = path.join(ud, 'usage');
  fs.mkdirSync(dir);
  const old = (Date.now() - 10 * 86400_000) / 1000;
  for (const n of ['old.json', 'fresh.json', '.tmp.s1.123', 'keep.txt']) fs.writeFileSync(path.join(dir, n), 'x');
  for (const n of ['old.json', '.tmp.s1.123', 'keep.txt']) fs.utimesSync(path.join(dir, n), old, old);
  const removed = await pruneUsageRecords(ud, 8 * 86400_000);
  assert.equal(removed, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['fresh.json', 'keep.txt']);
});

console.log(`\n${pass} passed`);
