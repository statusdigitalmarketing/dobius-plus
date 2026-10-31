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
    emails: { [DIR_A]: 'a@x.com', [DIR_B]: 'b@x.com', '/home/.claude': 'd@x.com' },
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
    ],
    defaultDir: () => '/home/.claude',
    defaultEnvUnset: () => true,
    cliDefaultDir: () => '/home/.claude',
    keyFor: (dir) => keychainServiceFor(dir),
    identity: async (dir) => ({ email: w.emails[dir] ?? null, login: 'in' }),
    email: async (dir) => w.emails[dir] ?? null,
    inputHeld: () => !!w.held,
    selector: () => null,
    readRecords: async () => w.records,
    pruneRecords: async () => 0,
    scan: async () => ({ groups: [{ key: w.procKey, pids: [w.claude.pid] }], unresolved: [] }),
    autoMoveEnabled: () => w.autoMove,
    tabs: () => [{ id: TAB, cwd: '/proj', claudeConfigDir: DIR_A }],
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
    inputAgeMs: () => 10 * 60_000,
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

await check('a session matched only by a recent link needs the tab\'s own screen to show the limit', async () => {
  const { w, svc } = world({ screenLine: 'all quiet' });
  await svc.tick();
  assert.equal(w.sent.length, 0, 'a 100% account alone does not name this conversation');
  const named = world({ screenLine: 'all quiet' });
  named.w.claude = { ...named.w.claude, sessionId: 's1' }; // claude --resume s1
  await named.svc.tick();
  assert.equal(named.w.sent.length, 1);
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
  assert.equal(isDraft('Try "refactor the parser"'), false);
  assert.equal(isDraft('Try "git status" first, then explain'), true, 'a draft that starts like the placeholder');
  assert.equal(isDraft(null), false);
  // A box that cannot be read is a possible draft, unless a selector holds the screen.
  assert.equal(draftOnScreen(null, false), true);
  assert.equal(draftOnScreen(null, true), false);
  assert.equal(draftOnScreen('', false), false);
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
