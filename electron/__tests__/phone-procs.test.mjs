import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parsePsAll, groupState, pidState, endGroup, endPid, taggedRows, judgeMembers, createRunStore, sweepAtLaunch,
} from '../phone-procs.js';

const RUN = 'ab'.repeat(16);
const OTHER_RUN = 'cd'.repeat(16);
const T0 = 'Sat Nov 14 10:00:00 2026';
const T_LATE = 'Sat Nov 14 11:00:00 2026';

// A fake process table with a virtual clock. `stubborn` processes ignore SIGTERM; `frozen` ignore everything but
// SIGKILL (as a SIGSTOPped process does); `eperm` belong to another user.
function fakeSys(procs, { boot = 1000 } = {}) {
  const table = new Map(procs.map((p) => [p.pid, { ...p }]));
  let clock = 0;
  const sent = [];
  const err = (code) => Object.assign(new Error(code), { code });
  const sys = {
    table, sent, onKill: null, psFails: null,
    // Real ps always lists at least one process (launchd, itself); a listing failure is psAll returning null.
    psAll: async () => (sys.psFails?.() ? null : [`1 1 0 ${T0} /sbin/launchd`, ...[...table.values()].map((p) => `${p.pid} ${p.pgid} ${p.ppid ?? 1} ${p.lstart} ${p.command}`)].join('\n')),
    psStart: async (pid) => table.get(pid)?.lstart ?? null,
    kill(pid, sig) {
      const targets = pid < 0 ? [...table.values()].filter((p) => p.pgid === -pid) : [table.get(pid)].filter(Boolean);
      if (targets.length === 0) throw err('ESRCH');
      if (targets.some((p) => p.eperm)) throw err('EPERM');
      if (sig !== 0) sent.push([pid, sig]);
      for (const p of targets) {
        if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !p.stubborn && !p.frozen)) table.delete(p.pid);
      }
      if (sig !== 0) sys.onKill?.(pid, sig, table);
    },
    bootSec: async () => boot,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return sys;
}

test('parsePsAll reads pid, pgid, ppid, a 24-char lstart and the command', () => {
  const rows = parsePsAll(`  612   612     1 Sat Nov  7 09:01:02 2026     /Applications/Dobius+.app/x phone-runner.mjs run ${RUN}\nbad line\n`);
  assert.deepEqual(rows, [{ pid: 612, pgid: 612, ppid: 1, lstart: 'Sat Nov 7 09:01:02 2026', command: `/Applications/Dobius+.app/x phone-runner.mjs run ${RUN}` }]);
});

test('tags match only the exact run id as its own word', () => {
  const rows = parsePsAll([
    `1 1 1 ${T0} node /a/phone-runner.mjs run ${RUN}`,
    `2 2 1 ${T0} node /a/phone-runner.mjs run ${RUN}ff`,
    `3 3 1 ${T0} node /a/phone-runner.mjs run ${OTHER_RUN}`,
    `4 4 1 ${T0} vim notes-about-phone-runner.mjs run ${RUN}`,
  ].join('\n'));
  assert.deepEqual(taggedRows(rows, RUN).map((r) => r.pid), [1]);
});

test('groupState and pidState: gone, alive, unknown on EPERM, and a reused pid is other', async () => {
  const sys = fakeSys([{ pid: 600, pgid: 600, lstart: T0, command: 'x' }, { pid: 9, pgid: 9, lstart: T0, command: 'y', eperm: true }]);
  assert.equal(groupState(sys, 600), 'alive');
  assert.equal(groupState(sys, 601), 'gone');
  assert.equal(groupState(sys, 9), 'unknown');
  assert.equal(await pidState(sys, 600, T0), 'same');
  assert.equal(await pidState(sys, 600, T_LATE), 'other');
  assert.equal(await pidState(sys, 601, T0), 'gone');
});

test('endGroup: SIGTERM, SIGKILL after the grace for a stubborn member, confirmed gone', async () => {
  const sys = fakeSys([{ pid: 600, pgid: 600, lstart: T0, command: 'r' }, { pid: 700, pgid: 600, lstart: T0, command: 'claude', stubborn: true }]);
  assert.equal(await endGroup(sys, 600, { graceMs: 5000 }), 'gone');
  assert.deepEqual(sys.sent.map((s) => s[1]), ['SIGTERM', 'SIGKILL']);
  assert.equal(sys.table.size, 0);
});

test('endGroup: a frozen group dies to SIGKILL; graceMs 0 sends SIGKILL first', async () => {
  const sys = fakeSys([{ pid: 600, pgid: 600, lstart: T0, command: 'r', frozen: true }]);
  assert.equal(await endGroup(sys, 600, { graceMs: 0 }), 'gone');
  assert.deepEqual(sys.sent, [[-600, 'SIGKILL']]);
});

test('endGroup: an already-gone group is never signalled; EPERM that lasts to the deadline is unknown', async () => {
  const sys = fakeSys([{ pid: 9, pgid: 9, lstart: T0, command: 'y', eperm: true }]);
  assert.equal(await endGroup(sys, 600), 'gone');
  assert.equal(await endGroup(sys, 9, { maxMs: 2000 }), 'unknown');
  assert.deepEqual(sys.sent, []);
});

test('endGroup: a group of zombies answers EPERM until it is reaped, then ESRCH: that is gone, not unknown', async () => {
  const sys = fakeSys([{ pid: 9, pgid: 9, lstart: T0, command: 'zombie', eperm: true }]);
  let polls = 0;
  const kill = sys.kill;
  sys.kill = (pid, sig) => { if (++polls === 4) sys.table.delete(9); return kill(pid, sig); }; // launchd reaps it
  assert.equal(await endGroup(sys, 9, { graceMs: 500 }), 'gone');
});

test('endPid: a pid whose start time changed is never signalled', async () => {
  const sys = fakeSys([{ pid: 700, pgid: 50, lstart: T_LATE, command: 'someone else' }]);
  assert.equal(await endPid(sys, 700, T0), 'gone');
  assert.deepEqual(sys.sent, []);
  assert.equal(sys.table.has(700), true);
});

test('endPid: the matching pid is SIGKILLed and confirmed', async () => {
  const sys = fakeSys([{ pid: 700, pgid: 50, lstart: T0, command: 'claude', frozen: true }]);
  assert.equal(await endPid(sys, 700, T0), 'gone');
  assert.deepEqual(sys.sent, [[700, 'SIGKILL']]);
});

test('judgeMembers: early or tagged members are killed; a later one is kept, even a Claude (Codex impl r2)', () => {
  const aliveAt = Date.parse(T0) + 30_000;
  const rows = parsePsAll([
    `701 600 1 ${T0} /bin/zsh -c make test`,
    `702 600 1 ${T_LATE} /usr/bin/python3 server.py`,
    `703 600 1 ${T_LATE} /Users/x/.local/bin/claude --resume s`,
    `704 600 1 ${T_LATE} /a/Dobius /a/phone-runner.mjs run ${RUN}`,
    `705 999 1 ${T0} /bin/zsh`,
  ].join('\n'));
  const { kill, keep } = judgeMembers(rows, 600, RUN, aliveAt);
  assert.deepEqual(kill.map((r) => r.pid), [701, 704]);
  assert.deepEqual(keep.map((r) => r.pid), [702, 703]);
});

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-procs-'));
  const file = path.join(dir, 'run', 'phone-runs.json');
  const logs = [];
  return { dir, file, logs, store: createRunStore(file, (m) => logs.push(m)) };
}

test('run store: 0600 file, upsert replaces by run id, unreadable file is set aside not deleted', () => {
  const { dir, file, logs, store } = tmpStore();
  try {
    const rec = { runId: RUN, sessionId: 's', boot: 1000, pgid: 600, leaderStart: T0, claudePid: null, aliveAt: 0 };
    store.upsert(rec);
    store.upsert({ ...rec, aliveAt: 5 });
    assert.deepEqual(store.read(), [{ ...rec, aliveAt: 5 }]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    store.remove(RUN);
    assert.deepEqual(store.read(), []);
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(store.read(), []);
    assert.equal(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('phone-runs.json.unreadable-')), true);
    assert.match(logs[0], /set aside/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep: a record from an earlier boot is dropped without signalling anything', async () => {
  const { dir, store } = tmpStore();
  try {
    store.upsert({ runId: RUN, sessionId: 's1', boot: 999, pgid: 600, leaderStart: T0, claudePid: 700, claudeStart: T0, aliveAt: 0 });
    const sys = fakeSys([{ pid: 600, pgid: 600, lstart: T0, command: 'r' }, { pid: 700, pgid: 600, lstart: T0, command: 'c' }]);
    const r = await sweepAtLaunch(sys, store);
    assert.equal(r.blocked.size, 0);
    assert.deepEqual(sys.sent, []);
    assert.deepEqual(store.read(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep: same boot, live matching group and Claude are killed, record removed', async () => {
  const { dir, store } = tmpStore();
  try {
    store.upsert({ runId: RUN, sessionId: 's1', boot: 1000, pgid: 600, leaderStart: T0, claudePid: 700, claudeStart: T0, aliveAt: 0 });
    const sys = fakeSys([{ pid: 600, pgid: 600, lstart: T0, command: 'r', frozen: true }, { pid: 700, pgid: 600, lstart: T0, command: 'c', frozen: true }]);
    const r = await sweepAtLaunch(sys, store);
    assert.equal(r.blocked.size, 0);
    assert.equal(sys.table.size, 0);
    assert.deepEqual(store.read(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep: leaderless group with a later untagged member keeps the record and holds the session', async () => {
  const { dir, store } = tmpStore();
  try {
    store.upsert({ runId: RUN, sessionId: 's1', boot: 1000, pgid: 600, leaderStart: T0, claudePid: null, aliveAt: Date.parse(T0) });
    const sys = fakeSys([{ pid: 701, pgid: 600, lstart: T0, command: 'zsh -c x' }, { pid: 702, pgid: 600, lstart: T_LATE, command: 'python3 y' }]);
    const r = await sweepAtLaunch(sys, store);
    assert.deepEqual([...r.blocked], ['s1']);
    assert.equal(sys.table.has(701), false);
    assert.equal(sys.table.has(702), true);
    assert.equal(store.read().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep: a reused leader pid is left alone; a tagged orphan runner is killed', async () => {
  const { dir, store } = tmpStore();
  try {
    store.upsert({ runId: RUN, sessionId: 's1', boot: 1000, pgid: 600, leaderStart: T0, claudePid: null, aliveAt: 0 });
    const sys = fakeSys([{ pid: 600, pgid: 600, lstart: T_LATE, command: 'unrelated' }, { pid: 650, pgid: 650, lstart: T0, command: `/a/D /a/phone-runner.mjs run ${RUN}` }]);
    const r = await sweepAtLaunch(sys, store);
    assert.equal(r.blocked.size, 0);
    assert.equal(sys.table.has(600), true);
    assert.equal(sys.table.has(650), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep: when ps or the boot time cannot be read, nothing is signalled and the session is held', async () => {
  const { dir, store } = tmpStore();
  try {
    store.upsert({ runId: RUN, sessionId: 's1', boot: 1000, pgid: 600, leaderStart: T0, claudePid: null, aliveAt: 0 });
    const sys = fakeSys([{ pid: 600, pgid: 600, lstart: T0, command: 'r' }]);
    sys.bootSec = async () => null;
    const r = await sweepAtLaunch(sys, store);
    assert.deepEqual([...r.blocked], ['s1']);
    assert.deepEqual(sys.sent, []);
    assert.equal(store.read().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep: a member that forks while being killed keeps the record (Codex impl r2)', async () => {
  const { dir, store } = tmpStore();
  try {
    store.upsert({ runId: RUN, sessionId: 's1', boot: 1000, pgid: 600, leaderStart: T0, claudePid: null, aliveAt: Date.parse(T0) });
    const sys = fakeSys([{ pid: 701, pgid: 600, lstart: T0, command: 'make test' }]);
    sys.onKill = (pid, sig, table) => { if (pid === 701) table.set(702, { pid: 702, pgid: 600, lstart: T_LATE, command: 'cc -c x.c' }); };
    const r = await sweepAtLaunch(sys, store);
    assert.deepEqual([...r.blocked], ['s1']);
    assert.equal(sys.table.has(702), true);
    assert.equal(store.read().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep: a provable member that forks a provable child is cleaned up over rounds', async () => {
  const { dir, store } = tmpStore();
  try {
    store.upsert({ runId: RUN, sessionId: 's1', boot: 1000, pgid: 600, leaderStart: T0, claudePid: null, aliveAt: Date.parse(T_LATE) });
    const sys = fakeSys([{ pid: 701, pgid: 600, lstart: T0, command: 'make test' }]);
    sys.onKill = (pid, sig, table) => { if (pid === 701) table.set(702, { pid: 702, pgid: 600, lstart: T0, command: 'cc -c x.c' }); };
    const r = await sweepAtLaunch(sys, store);
    assert.equal(r.blocked.size, 0);
    assert.equal(sys.table.size, 0);
    assert.deepEqual(store.read(), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep: each record is judged from its own listing, not one taken before an earlier cleanup (Codex impl r2)', async () => {
  const { dir, store } = tmpStore();
  const RUN_B = 'ef'.repeat(16);
  try {
    store.upsert({ runId: RUN, sessionId: 'sA', boot: 1000, pgid: null, claudePid: 800, claudeStart: T0, aliveAt: 0 });
    store.upsert({ runId: RUN_B, sessionId: 'sB', boot: 1000, pgid: 600, leaderStart: T0, claudePid: null, aliveAt: 0 });
    const sys = fakeSys([{ pid: 800, pgid: 800, lstart: T0, command: 'claude', frozen: true }, { pid: 600, pgid: 600, lstart: T0, command: 'runner B' }]);
    // While A's Claude is being ended, B's group empties and its id is taken by an unrelated process.
    sys.onKill = (pid, sig, table) => { if (pid === 800) table.set(600, { pid: 600, pgid: 600, lstart: T_LATE, command: 'unrelated' }); };
    await sweepAtLaunch(sys, store);
    assert.equal(sys.table.has(600), true);
    assert.equal(sys.sent.some(([p]) => p === -600 || p === 600), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sweep: a failed listing after the cleanup keeps the record (Codex impl r3)', async () => {
  const { dir, store } = tmpStore();
  try {
    store.upsert({ runId: RUN, sessionId: 's1', boot: 1000, pgid: null, claudePid: null, aliveAt: 0 });
    const sys = fakeSys([{ pid: 650, pgid: 650, lstart: T0, command: `/a/D /a/phone-runner.mjs run ${RUN}` }]);
    let calls = 0;
    sys.psFails = () => ++calls >= 2; // the first listing works, every later one fails
    const r = await sweepAtLaunch(sys, store);
    assert.deepEqual([...r.blocked], ['s1']);
    assert.equal(store.read().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
