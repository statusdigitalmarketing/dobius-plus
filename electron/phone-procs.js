/**
 * Phone mode: confirming a run's processes are gone, and the record that survives a crash
 * (docs/phone-mode-design.md, "The runner runs inside the tab", "End" and "Quit, restart and update").
 *
 * Rules that came out of the design review, kept here so no caller has to remember them:
 * - A pid is signalled only while its start time still matches what was recorded (a reused pid is never signalled).
 * - A process group id is safe to signal until its first ESRCH (an id is not reused while the group has a member);
 *   after that it is never signalled again.
 * - A record from an earlier boot is dropped without signalling anything.
 * - A leaderless group's member is killed only when it is provably the run's: started no later than the record's
 *   `aliveAt`, or tagged `phone-runner.mjs run <runId>`. Anything else keeps the record. A command line that runs
 *   Claude proves nothing (Codex P1, impl round 2: a recycled group id can hold someone else's Claude); the run's
 *   own Claude is ended by its recorded pid and start time instead.
 * - Every decision about a record is made from a process listing taken for that record, never one taken before an
 *   earlier record's cleanup awaited (Codex P1, impl round 2), and a leaderless group counts as cleaned only once
 *   `kill(-pgid, 0)` answers ESRCH after its members were ended (Codex P2, impl round 2: a member can fork while it
 *   is being killed).
 *
 * Accepted (Codex P1, impl round 2): a pid or group id checked and then signalled a few milliseconds later could in
 * principle belong to a new process by then. macOS has no pidfd to bind the two. XNU hands out pids by counting up
 * and wraps only after 99999, so the same number comes back only after tens of thousands of other processes have
 * started, which takes minutes even on a busy Mac, never the milliseconds between a check and its signal.
 *
 * Every system call goes through `sys`, so the rules are tested without touching real processes.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const RECORDS_MAX = 32; // records kept on disk; each run writes one, so this only bounds a pathological pile
export const TAG_RE = /(?:^|[\s/])phone-runner\.mjs run ([0-9a-f]{32})(?=\s|$)/;

const execP = (file, args, timeout) => new Promise((resolve) => {
  execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : stdout));
});

export const realSys = {
  /** Every process: pid, pgid, ppid, lstart (24 chars), command. Null when ps failed. */
  psAll: () => execP('/bin/ps', ['-A', '-ww', '-o', 'pid=,pgid=,ppid=,lstart=,command='], 3000),
  /** One process's lstart, or null. */
  psStart: async (pid) => {
    const out = await execP('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], 1000);
    const s = out?.trim();
    return s ? s.replace(/\s+/g, ' ') : null;
  },
  kill: (pid, sig) => process.kill(pid, sig),
  bootSec: async () => {
    const out = await execP('/usr/sbin/sysctl', ['-n', 'kern.boottime'], 1000);
    const m = out?.match(/sec\s*=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/** Parse `ps -A -o pid=,pgid=,ppid=,lstart=,command=` output. */
export function parsePsAll(out) {
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), ppid: Number(m[3]), lstart: m[4].replace(/\s+/g, ' '), command: m[5] });
  }
  return rows;
}

const sameStart = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ');

/** 'alive' | 'gone' | 'unknown' for a process group (kill -pgid 0). */
export function groupState(sys, pgid) {
  try { sys.kill(-pgid, 0); return 'alive'; } catch (e) { return e?.code === 'ESRCH' ? 'gone' : 'unknown'; }
}

/** 'same' | 'gone' | 'other' | 'unknown' for a pid recorded with a start time. */
export async function pidState(sys, pid, lstart) {
  try { sys.kill(pid, 0); } catch (e) { if (e?.code === 'ESRCH') return 'gone'; if (e?.code !== 'EPERM') return 'unknown'; }
  const now = await sys.psStart(pid);
  if (now == null) {
    try { sys.kill(pid, 0); } catch (e) { if (e?.code === 'ESRCH') return 'gone'; }
    return 'unknown';
  }
  return sameStart(now, lstart) ? 'same' : 'other';
}

/**
 * End a process group and confirm it: SIGTERM (unless graceMs is 0), SIGKILL after graceMs, poll until ESRCH.
 * Returns 'gone' | 'stuck' (still there at maxMs) | 'unknown' (EPERM or another error: not ours to decide).
 */
export async function endGroup(sys, pgid, { graceMs = 5000, pollMs = 250, maxMs = 30000 } = {}) {
  const t0 = sys.now();
  const send = (sig) => { try { sys.kill(-pgid, sig); return 'sent'; } catch (e) { return e?.code === 'ESRCH' ? 'gone' : 'unknown'; } };
  let s = send(graceMs > 0 ? 'SIGTERM' : 'SIGKILL');
  if (s !== 'sent') return s;
  let killed = graceMs === 0;
  for (;;) {
    const st = groupState(sys, pgid);
    if (st !== 'alive') return st;
    const waited = sys.now() - t0;
    if (!killed && waited >= graceMs) {
      s = send('SIGKILL');
      if (s !== 'sent') return s;
      killed = true;
    }
    if (waited >= maxMs) return 'stuck';
    await sys.sleep(pollMs);
  }
}

/** SIGKILL a recorded pid only while its start time matches, and confirm. 'gone' | 'stuck' | 'unknown'. */
export async function endPid(sys, pid, lstart, { pollMs = 250, maxMs = 30000 } = {}) {
  const t0 = sys.now();
  for (;;) {
    const st = await pidState(sys, pid, lstart);
    if (st === 'gone' || st === 'other') return 'gone'; // 'other': ours exited and the pid was reused
    if (st === 'unknown') return 'unknown';
    try { sys.kill(pid, 'SIGKILL'); } catch (e) { if (e?.code === 'ESRCH') return 'gone'; return 'unknown'; }
    if (sys.now() - t0 >= maxMs) return 'stuck';
    await sys.sleep(pollMs);
  }
}

/** Processes tagged `phone-runner.mjs run <runId>` in a ps listing. */
export function taggedRows(rows, runId) {
  return rows.filter((r) => r.command.match(TAG_RE)?.[1] === runId);
}

/**
 * Decide, for a leaderless group's members, which are provably the run's. Returns { kill: rows, keep: rows }.
 * `aliveAtMs` is when main last confirmed the group was this run's.
 */
export function judgeMembers(rows, pgid, runId, aliveAtMs) {
  const kill = [], keep = [];
  for (const r of rows) {
    if (r.pgid !== pgid) continue;
    const started = Date.parse(r.lstart);
    const early = Number.isFinite(started) && Number.isFinite(aliveAtMs) && started <= aliveAtMs;
    const tagged = r.command.match(TAG_RE)?.[1] === runId;
    (early || tagged ? kill : keep).push(r);
  }
  return { kill, keep };
}

const MEMBER_ROUNDS = 3; // ponytail: a group that keeps forking past 3 list-and-kill rounds keeps its record for next launch

/** End a leaderless group's provable members until the group is empty. 'gone' | 'left' (something remains). */
async function endLeaderless(sys, rec, endOpts, log) {
  for (let round = 0; round < MEMBER_ROUNDS; round++) {
    const rows = parsePsAll(await sys.psAll());
    if (rows.length === 0) return 'left'; // ps failed: cannot judge
    const { kill, keep } = judgeMembers(rows, rec.pgid, rec.runId, rec.aliveAt);
    let left = false;
    for (const r of kill) if ((await endPid(sys, r.pid, r.lstart, endOpts)) !== 'gone') left = true;
    if (keep.length) {
      log.push(`run ${rec.runId.slice(0, 8)}: ${keep.length} later process(es) in its old group left running`);
      return 'left';
    }
    if (left) return 'left';
    const st = groupState(sys, rec.pgid);
    if (st === 'gone') return 'gone';
    if (st === 'unknown') return 'left';
  }
  return 'left';
}

// ---- the record on disk ----

function validRecord(r) {
  return r && typeof r === 'object' && /^[0-9a-f]{32}$/.test(r.runId) && typeof r.sessionId === 'string'
    && Number.isSafeInteger(r.boot) && (r.pgid == null || Number.isSafeInteger(r.pgid))
    && (r.claudePid == null || Number.isSafeInteger(r.claudePid)) && Number.isFinite(r.aliveAt ?? 0);
}

export function createRunStore(file, log = () => {}) {
  const read = () => {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    let v;
    try { v = JSON.parse(raw); } catch (e) {
      // An unreadable file is set aside, never deleted: it may name processes still running.
      const aside = `${file}.unreadable-${Date.now()}`;
      try { fs.renameSync(file, aside); log(`phone-runs.json unreadable (${e.message}), set aside as ${path.basename(aside)}`); } catch (e2) { log(`phone-runs.json unreadable and could not be set aside: ${e2.message}`); }
      return [];
    }
    return Array.isArray(v) ? v.filter(validRecord).slice(-RECORDS_MAX) : [];
  };
  const write = (records) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify(records.slice(-RECORDS_MAX))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  };
  return {
    read,
    upsert(rec) { write([...read().filter((r) => r.runId !== rec.runId), rec]); },
    remove(runId) { const all = read(); if (all.some((r) => r.runId === runId)) write(all.filter((r) => r.runId !== runId)); },
  };
}

/**
 * At launch, before auto-resume and before any claim is answered: clean up after a crash. Returns
 * { blocked: Set<sessionId> still unsafe, log: string[] }. Records are removed only when nothing of the run is left.
 */
export async function sweepAtLaunch(sys, store, { endOpts } = {}) {
  const log = [];
  const blocked = new Set();
  const records = store.read();
  if (records.length === 0) return { blocked, log };
  const boot = await sys.bootSec();
  for (const rec of records) {
    if (boot != null && rec.boot !== boot) { store.remove(rec.runId); log.push(`run ${rec.runId.slice(0, 8)}: earlier boot, dropped`); continue; }
    // A listing taken for THIS record, after any earlier record's cleanup finished awaiting.
    const rows = boot == null ? [] : parsePsAll(await sys.psAll());
    if (boot == null || rows.length === 0) { blocked.add(rec.sessionId); log.push(`run ${rec.runId.slice(0, 8)}: cannot check this boot, kept`); continue; }
    let left = false;
    if (rec.pgid != null) {
      const leader = rows.find((r) => r.pid === rec.pgid);
      if (leader && sameStart(leader.lstart, rec.leaderStart)) {
        if ((await endGroup(sys, rec.pgid, { graceMs: 0, ...endOpts })) !== 'gone') left = true;
      } else if (!leader) {
        if ((await endLeaderless(sys, rec, endOpts, log)) !== 'gone') left = true;
      }
      // A leader alive with a different start is a new process: the old group cannot still exist under its id.
    }
    for (const r of taggedRows(parsePsAll(await sys.psAll()), rec.runId)) if ((await endPid(sys, r.pid, r.lstart, endOpts)) !== 'gone') left = true;
    if (rec.claudePid != null && rec.claudeStart) {
      if ((await endPid(sys, rec.claudePid, rec.claudeStart, endOpts)) !== 'gone') left = true;
    }
    if (left) { blocked.add(rec.sessionId); log.push(`run ${rec.runId.slice(0, 8)}: not all gone, session held`); } else { store.remove(rec.runId); log.push(`run ${rec.runId.slice(0, 8)}: cleaned up`); }
  }
  return { blocked, log };
}
