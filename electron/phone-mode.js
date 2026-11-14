/**
 * Phone mode, main's side (docs/phone-mode-design.md, "Main: electron/phone-mode.js" and "End").
 *
 * Owns the registry (claims, generations, pending cards), the socket the gate, runner and `done` talk to, the record
 * that survives a crash (phone-runs.json), and the timers that end and confirm a run's processes. Everything outside
 * (terminals, Claude's records, the screen, settings, the phones) comes in through `d`, so every rule is tested with
 * fakes. The wire protocol is listed at the top of phone-runner.mjs.
 *
 * Stability: one socket, at most 4 runs, one start at a time, one settle pass at a time (a timer that finds the last
 * pass still running skips), and no start while the Mac is short on memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPhoneRegistry } from './phone-registry.js';
import {
  realSys, parsePsAll, groupState, pidState, endGroup, endPid, taggedRows, createRunStore, sweepAtLaunch,
} from './phone-procs.js';
import {
  ensureRunDir, ticketPath, donePath, writeTokenFile, dropTokenFile, startPhoneSocket,
} from './phone-socket.js';
import { carryOverFlags } from './phone-runner-core.mjs';

export const HELLO_MS = 30_000; // the gate's and the runner's hellos must arrive within this of the restart
export const TICKET_MS = 60_000; // an unredeemed ticket file is deleted after this
export const ENDING_KILL_MS = 20_000; // a run still `ending` with its group alive this long has the group ended
export const SHELL_KILL_MS = 5_000; // a closed tab's shell still there after this is SIGKILLed
export const ALIVE_MS = 60_000; // how often a live run's record has its aliveAt refreshed
export const STOP_MS = 10_000; // the TUI Claude must exit within this of SIGHUP
export const COMMAND_MS = 10_000; // a command to the runner must be answered within this
export const SPAWN_WAIT_MS = 5_000; // a runner hello waits this long for its gate's spawn report
const TICK_MS = 1_000;

const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;
const CARD_KINDS = new Set(['question', 'permission', 'plan']);
const STATUSES = new Set(['idle', 'working', 'waiting']);
const sameStart = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ');
const plain = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, n);

/** True when `pid` has `ancestor` among its parents in one ps listing (bounded walk). */
export function descends(rows, pid, ancestor) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  let cur = byPid.get(pid);
  for (let i = 0; cur && i < 64; i++) {
    if (cur.ppid === ancestor) return true;
    if (cur.ppid <= 1) return false;
    cur = byPid.get(cur.ppid);
  }
  return false;
}

export function createPhoneMode(d) {
  const sys = d.sys || realSys;
  const log = d.log || (() => {});
  const now = d.now || Date.now;
  const reg = createPhoneRegistry({ now });
  const store = createRunStore(path.join(d.userData, 'phone-runs.json'), log);
  const conns = new Map(); // runId -> runner connection
  const replies = new Map(); // reqId -> { resolve, timer }
  const spawnWaits = new Map(); // runId -> wake: a runner hello waiting for its gate's spawn report (one per run)
  const blocked = new Set(); // sessions a launch sweep could not clean up: held until the next launch
  let runDir = null;
  let server = null;
  let ready = false;
  let starting = false;
  let ticking = false;
  let tickTimer = null;
  let boot = null;
  let reqSeq = 0;

  const fail = (code, error) => ({ ok: false, code, error });
  const notify = (run) => { try { d.notify?.(run.tabId, reg.stateOf(run.tabId)); } catch (e) { log(`phone: notify failed: ${e.message}`); } };

  function record(run) {
    try {
      store.upsert({
        runId: run.runId, sessionId: run.sessionId, boot: boot ?? 0, pgid: run.runnerPgid, leaderStart: run.runnerStart,
        claudePid: run.claudePid, claudeStart: run.claudeStart, aliveAt: run.aliveAt ?? now(),
      });
    } catch (e) { log(`phone: could not save the run record: ${e.message}`); }
  }

  function filesOf(run) { return [ticketPath(runDir, run.runId), donePath(runDir, run.runId)]; }

  // ---- launch ----

  /** Start the socket after cleaning up what a crash left. Call before auto-resume answers any claim. */
  async function init() {
    runDir = ensureRunDir(d.userData);
    boot = await sys.bootSec();
    // Leftover one-time files from an earlier run of Dobius: their tokens died with it.
    for (const name of fs.readdirSync(runDir)) {
      if (/^phone-[0-9a-f]{32}\.(?:ticket|done)(?:\.taken-[0-9a-f]{16})?$/.test(name)) dropTokenFile(path.join(runDir, name), log);
    }
    const swept = await sweepAtLaunch(sys, store);
    for (const s of swept.blocked) blocked.add(s);
    for (const line of swept.log) log(`phone: ${line}`);
    server = await startPhoneSocket(runDir, { handler: (conn, msg) => { void onMessage(conn, msg); }, onClose, log });
    ready = true;
    return { blocked: [...blocked] };
  }

  // ---- claims and checks the rest of Dobius asks ----

  /** Sessions no other surface may resume now: phone claims, and what a launch sweep could not clean. */
  const heldSessions = () => {
    const out = new Set(blocked);
    for (const r of reg.list()) if (!r.released) out.add(r.sessionId);
    return out;
  };
  /** A tab whose input belongs to phone mode (every typing path refuses it). */
  const isPhoneTab = (tabId) => { const r = reg.runOfTab(tabId); return !!r && !r.released; };

  // ---- start ----

  async function take(tabId, { sessionId, gen } = {}) {
    if (!d.on()) return fail('off', 'phone mode is off on this Mac');
    if (!ready) return fail('not_ready', 'phone mode is still starting on this Mac');
    if (starting) return fail('busy', 'another conversation is moving to the phone; try again in a moment');
    starting = true;
    try { return await takeLocked(tabId, sessionId, gen); }
    finally { starting = false; }
  }

  async function takeLocked(tabId, sessionId, gen) {
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(gen) || reg.gen(tabId) !== gen) return fail('stale_view', 'the tab changed; look again');
    if (reg.runOfTab(tabId)) return fail('on_phone', 'this tab is already on the phone');
    if (blocked.has(sessionId) || reg.claimOf(sessionId)) return fail('claimed', 'that conversation is still coming back from the phone');
    if (d.memoryLow?.()) return fail('memory', 'the Mac is short on memory right now, so nothing new was started');
    const tab = d.tabs().find((t) => t.id === tabId);
    if (!tab) return fail('no_tab', 'that tab has no terminal running');
    const cannot = d.cannotRestart(tabId);
    if (cannot) return fail('cannot', cannot);
    const inputSeq = d.inputSeq(tabId);
    const info = await d.claudeInfo(tabId).catch(() => null);
    if (!info) return fail('no_claude', 'Claude is not running in that tab');
    if (info.soleChild === false) return fail('other', 'another program shares the tab with Claude');
    const claudeStart = await sys.psStart(info.pid).catch(() => null);
    if (!claudeStart) return fail('unreadable', 'Claude in that tab could not be identified');
    const rec = await d.presence(info).catch(() => null);
    if (!rec?.sessionId) return fail('unreadable', "Claude's own record of its conversation could not be read");
    if (rec.sessionId !== sessionId) return fail('stale_view', 'the tab is on a different conversation now; look again');
    if (!(await d.hasTranscript(sessionId).catch(() => false))) return fail('no_transcript', 'that conversation has nothing to resume yet');
    const act = d.activity(tabId);
    if (rec.status === 'busy' || act?.status === 'working') return fail('working', 'Claude is working; move it when the turn is over');
    const sc = await d.screen(tabId).catch(() => null);
    const box = sc ? d.promptBox(sc.lines, sc.modes) : null;
    if (d.inputHeld(tabId) || typeof box !== 'string' || box.trim()) return fail('draft', "there is unsent text in the tab's prompt, or it could not be read");
    const argv = await d.processArgv(info.pid).catch(() => null);
    const pcwd = await d.processCwd(info.pid).catch(() => null);
    const cwd = pcwd && d.isDir(pcwd) ? pcwd : null;
    if (!cwd) return fail('no_folder', "Claude's folder could not be read");
    const waitingOnPerson = rec.status === 'waiting' || act?.status === 'needs';
    // The pid read at the start must still be that Claude (a pid freed and reused meanwhile is never stopped).
    if (!sameStart(await sys.psStart(info.pid).catch(() => null), claudeStart)) return fail('stale_view', 'Claude in that tab changed; look again');
    // No await from here to the stop.
    if (reg.gen(tabId) !== gen) return fail('stale_view', 'the tab changed; look again');
    if (d.inputSeq(tabId) !== inputSeq || d.inputHeld(tabId)) return fail('typed', 'something was typed in the tab, so it was left alone');
    const b = reg.begin(tabId, sessionId);
    if (!b.ok) return fail(b.code, b.code === 'too_many' ? 'four conversations are already on the phone' : 'that conversation is busy');
    const run = b.run;
    Object.assign(run, {
      carry: carryOverFlags(argv), resendNote: waitingOnPerson, ptyPid: null, ptyStart: null, cwd, aliveAt: now(),
      startedAt: now(), endingAt: null, gateStart: null, closedAt: null,
    });
    const manual = `The conversation is safe: run claude --resume ${sessionId} in ${cwd}, in this tab.`;
    const cancel = (code, error) => {
      reg.cancel(run);
      for (const f of filesOf(run)) dropTokenFile(f, log);
      store.remove(run.runId);
      notify(run);
      return fail(code, error);
    };
    try {
      writeTokenFile(ticketPath(runDir, run.runId), b.gateToken);
      writeTokenFile(donePath(runDir, run.runId), b.doneToken);
    } catch (e) { return cancel('failed', `could not prepare the move (${e.message})`); }
    record(run);
    try { d.stop(info.pid); } catch (e) { if (e?.code !== 'ESRCH') return cancel('failed', `Claude could not be stopped: ${e.message}`); }
    // Everything above left the tab as it was. From here it only reports.
    const stopBy = now() + STOP_MS;
    while (d.alive(info.pid) && now() < stopBy) await d.sleep(100);
    if (d.alive(info.pid)) return cancel('failed', `Claude did not stop within ${STOP_MS / 1000} seconds, so nothing else was changed`);
    if (d.inputSeq(tabId) !== inputSeq) return cancel('typed', `Claude stopped, but something was typed in the tab, so it was not moved. ${manual}`);
    let restarted = false;
    try {
      restarted = d.restart(tabId, cwd, {
        sessionId, cwd, ticket: ticketPath(runDir, run.runId), runId: run.runId, exe: d.exe, runner: d.runnerPath,
      });
    } catch (e) { return cancel('failed', `Claude stopped, but the tab could not restart: ${e.message}. ${manual}`); }
    if (!restarted) return cancel('failed', `Claude stopped, but the tab could not restart. ${manual}`);
    // The restart made a new terminal: its shell is what the runner must descend from, and what a closed tab's
    // cleanup confirms gone (by pid AND start time, never a bare pid).
    const fresh = d.tabs().find((t) => t.id === tabId);
    run.ptyPid = Number.isSafeInteger(fresh?.pid) ? fresh.pid : null;
    run.ptyStart = null;
    for (let i = 0; i < 3 && !run.ptyStart && (await readShellStart(run)) === null; i++) await d.sleep(200);
    notify(run);
    schedule();
    return { ok: true, runId: run.runId, gen: reg.gen(tabId) };
  }

  /**
   * Read the restarted shell's start time, only while the tab still owns that pid (open, listing it), and keep the
   * answer only if it still does once the read returns: after the tab closes the pid may belong to anything (Codex P1,
   * impl round 8). Returns the start time, or null.
   */
  async function readShellStart(run) {
    const owned = () => !run.tabClosed && Number.isSafeInteger(run.ptyPid)
      && d.tabs().some((x) => x.id === run.tabId && x.pid === run.ptyPid);
    if (!owned()) return null;
    const start = await sys.psStart(run.ptyPid).catch(() => null);
    if (!start || !owned()) return null;
    run.ptyStart = start;
    return start;
  }

  // ---- the socket ----

  function runOf(conn, role) {
    const run = conn.data.runId ? reg.get(conn.data.runId) : null;
    return run && conn.data.role === role ? run : null;
  }

  async function onMessage(conn, m) {
    if (m.t === 'gate') return onGate(conn, m);
    if (m.t === 'runner') return onRunner(conn, m);
    if (m.t === 'done') return onDone(conn, m);
    if (m.t === 'runner-spawned') {
      const run = runOf(conn, 'gate');
      if (run && reg.noteRunnerSpawned(run, m.pid, m.lstart)) record(run);
      if (run) spawnWaits.get(run.runId)?.();
      return undefined;
    }
    const run = runOf(conn, 'runner');
    if (!run) { conn.close('not proved'); return undefined; }
    if (m.t === 'claude') {
      if (run.status === 'ending' || !reg.noteClaude(run, m.pid, m.lstart)) { conn.send({ t: 'refused', code: 'not_live', error: 'the phone session is ending' }); return undefined; }
      record(run);
      conn.send({ t: 'claude-ok' });
      return undefined;
    }
    if (m.t === 'state') { if (STATUSES.has(m.status) && reg.setStatus(run, m.status)) notify(run); return undefined; }
    if (m.t === 'card') {
      const c = m.card;
      if (c && typeof c === 'object' && REQUEST_ID.test(String(c.requestId)) && CARD_KINDS.has(c.kind) && reg.addPending(run, c)) notify(run);
      return undefined;
    }
    if (m.t === 'gone') { if (reg.dropPending(run, m.requestId)) notify(run); return undefined; }
    if (m.t === 'reply') {
      const w = replies.get(m.reqId);
      if (w && w.runId === run.runId) { replies.delete(m.reqId); clearTimeout(w.timer); w.resolve(m); }
      return undefined;
    }
    if (m.t === 'ended') { endRun(run, plain(m.reason, 200) || 'ended'); return undefined; }
    return undefined;
  }

  async function onGate(conn, m) {
    const r = reg.redeem(m.token, 'gate');
    if (!r.ok) {
      conn.send({ t: 'refused', code: r.code, error: r.run?.error || 'that ticket is not valid' });
      if (r.run) afterChange(r.run);
      conn.close('refused');
      return;
    }
    const run = r.run;
    dropTokenFile(ticketPath(runDir, run.runId), log); // already consumed by the gate; a leftover would be a bug
    const start = Number.isSafeInteger(m.pid) && m.pid > 1 ? await sys.psStart(m.pid) : null;
    const a = start ? reg.acceptGate(run, m.pid) : { ok: false, code: 'bad_pid' };
    if (!a.ok) {
      reg.end(run, 'the tab could not start phone mode');
      conn.send({ t: 'refused', code: a.code, error: 'phone mode could not start in this tab' });
      afterChange(run);
      conn.close('refused');
      return;
    }
    run.gateStart = start;
    conn.authed = true;
    conn.data.runId = run.runId;
    conn.data.role = 'gate';
    conn.send({ t: 'gate-ok', runId: run.runId, runnerToken: a.runnerToken });
  }

  async function onRunner(conn, m) {
    const r = reg.redeem(m.token, 'runner');
    if (!r.ok) {
      conn.send({ t: 'refused', code: r.code, error: r.run?.error || 'that ticket is not valid' });
      if (r.run) afterChange(r.run);
      conn.close('refused');
      return;
    }
    const run = r.run;
    // The gate starts the runner before it reports the spawn, so the hello can arrive first: wait for the report
    // (one waiter per run, since the runner token is redeemed once; at most SPAWN_WAIT_MS).
    if (run.runnerPid == null && run.status !== 'ending') {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { spawnWaits.delete(run.runId); resolve(); }, SPAWN_WAIT_MS);
        timer.unref?.();
        spawnWaits.set(run.runId, () => { clearTimeout(timer); spawnWaits.delete(run.runId); resolve(); });
      });
    }
    // One ps: the pid is the one the gate reported, started when it said, and runs under this tab's terminal.
    const rows = parsePsAll(await sys.psAll());
    const row = rows.find((x) => x.pid === m.pid);
    const verified = !!row && run.runnerPid === m.pid && sameStart(row.lstart, run.runnerStart)
      && Number.isSafeInteger(run.ptyPid) && descends(rows, m.pid, run.ptyPid);
    const a = reg.acceptRunner(run, m.pid, verified);
    if (!a.ok) {
      reg.end(run, a.code === 'not_verified' ? 'the phone side could not be confirmed as this tab\'s' : 'the phone session had already ended');
      conn.send({ t: 'refused', code: a.code, error: 'phone mode stopped' });
      afterChange(run);
      conn.close('refused');
      return;
    }
    conn.authed = true;
    conn.data.runId = run.runId;
    conn.data.role = 'runner';
    conns.set(run.runId, conn);
    conn.send({ t: 'runner-ok', permissionMode: run.carry?.permissionMode ?? null, model: run.carry?.model ?? null, resendNote: run.resendNote === true });
    notify(run);
  }

  async function onDone(conn, m) {
    const r = reg.redeem(m.token, 'done');
    if (!r.ok) { conn.send({ t: 'refused', code: r.code }); if (r.run) afterChange(r.run); conn.close('refused'); return; }
    const run = r.run;
    // The real `done` runs only after the gate line finished: its gate is gone by now. Asked a few times, since a
    // failed ps is not an answer.
    let gone = !run.gateAccepted;
    for (let i = 0; !gone && i < 3; i++) {
      const st = await pidState(sys, run.gatePid, run.gateStart);
      if (st === 'gone' || st === 'other') gone = true;
      else if (st === 'same') break;
      else await d.sleep(200);
    }
    reg.noteDone(run, gone);
    conn.send({ t: 'done-ok' });
    conn.close('done');
    afterChange(run);
  }

  function onClose(conn) {
    if (conn.data.role !== 'runner') return;
    const run = reg.get(conn.data.runId);
    if (conns.get(conn.data.runId) === conn) conns.delete(conn.data.runId);
    if (run && run.status !== 'ending') endRun(run, 'the phone side disconnected');
  }

  // ---- ending and cleanup ----

  function endRun(run, reason) {
    if (reg.end(run, reason)) run.endingAt = now();
    for (const [id, w] of replies) if (w.runId === run.runId) { replies.delete(id); clearTimeout(w.timer); w.resolve({ ok: false, code: 'ending', error: 'the phone session is ending' }); }
    afterChange(run);
  }

  function afterChange(run) {
    if (run.status === 'ending' && run.endingAt == null) run.endingAt = now();
    notify(run);
    schedule();
  }

  /** The tab closed (its PTY is gone or going). */
  function tabClosed(tabId) {
    const run = reg.tabClosed(tabId);
    if (!run) return;
    run.closedAt = now();
    run.endingAt = run.endingAt ?? now();
    // At once: no grace for a group whose tab is gone.
    if (run.runnerPgid != null && !run.groupGone) void endGroup(sys, run.runnerPgid, { graceMs: 0 }).then((s) => { if (s === 'gone') reg.noteGroupGone(run); schedule(); });
    afterChange(run);
  }

  async function settleOne(run) {
    const t = now();
    if (run.status === 'starting' && t - run.startedAt > HELLO_MS) endRun(run, 'phone mode did not start in time');
    if (t - run.startedAt > TICKET_MS) dropTokenFile(ticketPath(runDir, run.runId), log);
    // A shell whose start time could not be read at the restart: read it while the tab still owns that pid.
    if (!run.ptyStart) await readShellStart(run);
    if (run.status !== 'ending') {
      if (t - (run.aliveAt ?? 0) > ALIVE_MS) { run.aliveAt = t; record(run); }
      return;
    }
    if (run.runnerPgid != null && !run.groupGone) {
      const st = groupState(sys, run.runnerPgid);
      if (st === 'gone') reg.noteGroupGone(run);
      else if (t - run.endingAt > ENDING_KILL_MS && !run.killing) {
        run.killing = true;
        const s = await endGroup(sys, run.runnerPgid, { graceMs: 5000 });
        run.killing = false;
        if (s === 'gone') reg.noteGroupGone(run); else log(`phone: run ${run.runId.slice(0, 8)} group ${s}; the conversation stays held`);
      }
    }
    if (run.claudePid != null && !run.claudeGone) {
      const st = await pidState(sys, run.claudePid, run.claudeStart);
      if (st === 'gone' || st === 'other') reg.noteClaudeGone(run);
      else if (st === 'same' && run.groupGone) { if ((await endPid(sys, run.claudePid, run.claudeStart, { maxMs: 5000 })) === 'gone') reg.noteClaudeGone(run); }
    }
    if (run.gateAccepted && !run.gateGone) {
      const st = await pidState(sys, run.gatePid, run.gateStart);
      if (st === 'gone' || st === 'other') reg.noteGateGone(run);
    }
    if (run.gateAccepted && run.gateGone && run.runnerPgid == null && !run.tagSweepClean) {
      const rows = parsePsAll(await sys.psAll());
      if (rows.length) {
        const tagged = taggedRows(rows, run.runId);
        if (tagged.length === 0) reg.noteTagSweepClean(run);
        else for (const r of tagged) await endPid(sys, r.pid, r.lstart, { maxMs: 5000 });
      }
    }
    if (run.tabClosed && !run.shellGone) {
      // Without the shell's start time only "no such pid" proves it gone: the claim stays held otherwise, and a pid
      // that cannot be identified is never signalled. No pid at all (the restart's tab had none) holds it too.
      let st = 'unknown';
      if (Number.isSafeInteger(run.ptyPid) && run.ptyStart) st = await pidState(sys, run.ptyPid, run.ptyStart);
      else if (Number.isSafeInteger(run.ptyPid)) { try { sys.kill(run.ptyPid, 0); } catch (e) { if (e?.code === 'ESRCH') st = 'gone'; } }
      if (st === 'gone' || st === 'other') reg.noteShellGone(run);
      else if (st === 'same' && t - run.closedAt > SHELL_KILL_MS) {
        if ((await endPid(sys, run.ptyPid, run.ptyStart, { maxMs: 2000 })) === 'gone') reg.noteShellGone(run);
      }
    }
    if (!run.released && !run.tabClosed) {
      const ids = await d.tuiSessionIds(run.tabId).catch(() => []);
      if (ids.includes(run.sessionId)) reg.noteTuiRunning(run.tabId, run.sessionId);
    }
    const s = reg.settle(run);
    if (s.released) notify(run);
    if (s.forgotten) {
      store.remove(run.runId);
      for (const f of filesOf(run)) dropTokenFile(f, log);
      notify(run);
    }
  }

  async function tick() {
    if (ticking) return; // the last pass is still running: skip, never stack
    ticking = true;
    try { for (const run of reg.list()) { try { await settleOne(run); } catch (e) { log(`phone: settle failed: ${e.message}`); } } }
    finally { ticking = false; }
    if (reg.list().length === 0 && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function schedule() {
    if (d.manualTick) return; // tests drive tick() themselves
    if (!tickTimer) { tickTimer = setInterval(() => { void tick(); }, TICK_MS); tickTimer.unref?.(); }
    void tick();
  }

  /** Quit: every runner group SIGKILLed at once (no waiting); the records stay for the next launch's sweep. */
  function quitSweep() {
    for (const run of reg.list()) {
      if (run.runnerPgid != null && !run.groupGone) { try { sys.kill(-run.runnerPgid, 'SIGKILL'); } catch { /* gone or not ours */ } }
    }
  }

  // ---- what the phone asks ----

  function liveRun(tabId, runId) {
    if (!d.on()) return { error: fail('off', 'phone mode is off on this Mac') };
    const run = reg.runOfTab(tabId);
    if (!run || run.released || run.runId !== runId) return { error: fail('stale_run', 'that phone session is over') };
    if (!['idle', 'working', 'waiting'].includes(run.status)) return { error: fail('not_live', run.status === 'ending' ? 'the phone session is ending' : 'the phone session is still starting') };
    const conn = conns.get(run.runId);
    if (!conn) return { error: fail('not_live', 'the phone session is not connected') };
    return { run, conn };
  }

  function command(run, conn, obj) {
    const reqId = `c${++reqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { replies.delete(reqId); resolve({ ok: false, code: 'timeout', error: 'the phone session did not answer' }); }, COMMAND_MS);
      replies.set(reqId, { runId: run.runId, resolve: (m) => resolve(m.ok ? { ok: true } : fail(m.code || 'failed', m.error || 'refused')), timer });
      if (!conn.send({ ...obj, reqId })) { replies.delete(reqId); clearTimeout(timer); resolve(fail('not_live', 'the phone session is not connected')); }
    });
  }

  async function send(tabId, runId, text, sendId) {
    const { run, conn, error } = liveRun(tabId, runId);
    if (error) return error;
    if (!reg.firstSend(run, sendId)) return { ok: true, duplicate: true };
    return command(run, conn, { t: 'send', text });
  }

  async function answer(tabId, runId, requestId, ans) {
    const { run, conn, error } = liveRun(tabId, runId);
    if (error) return error;
    const card = reg.takePending(run, requestId);
    if (!card) return fail('not_pending', 'that request is no longer waiting');
    const r = await command(run, conn, { t: 'answer', requestId, answer: ans });
    // A refused answer (a misfit) leaves the request waiting on the runner: show it again so it can be fixed.
    if (!r.ok && r.code === 'bad_answer') reg.addPending(run, card);
    notify(run);
    return r;
  }

  async function stopTurn(tabId, runId) {
    const { run, conn, error } = liveRun(tabId, runId);
    if (error) return error;
    return command(run, conn, { t: 'stop' });
  }

  async function giveBack(tabId, runId) {
    const run = reg.runOfTab(tabId);
    if (!run || run.released || run.runId !== runId) return fail('stale_run', 'that phone session is over');
    const conn = conns.get(run.runId);
    if (conn && run.status !== 'ending') {
      const r = await command(run, conn, { t: 'give-back' });
      if (r.ok) return r;
    }
    endRun(run, 'given back on the phone');
    return { ok: true };
  }

  return {
    init, take, send, answer, stopTurn, giveBack, tabClosed, quitSweep, heldSessions, isPhoneTab,
    gen: (tabId) => reg.gen(tabId),
    stateOf: (tabId) => reg.stateOf(tabId),
    close: async () => { if (tickTimer) clearInterval(tickTimer); tickTimer = null; await server?.close(); ready = false; },
    // tests
    _registry: reg, _tick: tick, _runDir: () => runDir,
  };
}
