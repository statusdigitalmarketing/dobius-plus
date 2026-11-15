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
import { createPhoneRegistry, MAX_SEND_IDS } from './phone-registry.js';
import {
  realSys, parsePsAll, groupState, pidState, endGroup, endPid, taggedRows, createRunStore, sweepAtLaunch,
} from './phone-procs.js';
import {
  ensureRunDir, ticketPath, donePath, writeTokenFile, dropTokenFile, startPhoneSocket,
} from './phone-socket.js';
import { carryOverFlags } from './phone-runner-core.mjs';
import { ASK_MAX } from './phone-protocol.js';

export const HELLO_MS = 30_000; // the gate's and the runner's hellos must arrive within this of the restart
export const TICKET_MS = 60_000; // an unredeemed ticket file is deleted after this
export const ENDING_KILL_MS = 20_000; // a run still `ending` with its group alive this long has the group ended
export const SHELL_KILL_MS = 5_000; // a closed tab's shell still there after this is SIGKILLed
export const ALIVE_MS = 60_000; // how often a live run's record has its aliveAt refreshed
export const STOP_MS = 10_000; // the TUI Claude must exit within this of SIGHUP
export const COMMAND_MS = 10_000; // a command to the runner must be answered within this
const LATE_MS = 5 * 60_000; // a send that timed out still hears the runner's late answer this long
export const SPAWN_WAIT_MS = 5_000; // a runner hello waits this long for its gate's spawn report
const TICK_MS = 1_000;
const MODE_RETRY_MS = 300; // between looks at the screen for the permission mode
const MODE_LOOKS = 4; // looks before a mode that never reads the same twice refuses the move
// What became of a run's phone messages is kept after the run ends, so a phone that comes back later learns which never
// reached Claude (Codex r34). ponytail: memory only, at most ENDED_TABS tabs x ENDED_RUNS runs x ENDED_LOST ids, for a
// day; a phone asking after a Mac restart finds nothing and shows those messages as not confirmed.
const ENDED_TABS = 64;
const ENDED_RUNS = 4;
const ENDED_LOST = 64;
const ENDED_MS = 24 * 3600_000;
const DELIVERED_SHOWN = 64; // the newest sendIds a live run reports as read by Claude

const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;
const CARD_KINDS = new Set(['question', 'permission', 'plan']);
const STATUSES = new Set(['idle', 'working', 'waiting']);
const sameStart = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\s+/g, ' ') === b.replace(/\s+/g, ' ');
const plain = (s, n = 300) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, n);

/**
 * The modes a move carries. The mode read off the screen can only make either side STRICTER than the launch flag,
 * never looser: screen text is a read of rows, the flag is what the person started Claude with (security review of
 * 6e6a31c). The TUI comes back in the shown mode when it is no looser than the flag (with no flag, only a strict shown
 * mode, else no flag at all, which is how it started). The phone never runs looser than asking first: the stricter of
 * the shown mode and the flag, capped at default.
 */
const LOOSENESS = { dontAsk: 0, plan: 1, default: 2, acceptEdits: 3, auto: 4, bypassPermissions: 5 };
const STRICT_MODES = new Set(['plan', 'default', 'dontAsk']);
const stricter = (a, b) => (LOOSENESS[a] <= LOOSENESS[b] ? a : b);
export function carryFlags(flags, shownMode) {
  const launch = flags?.permissionMode in LOOSENESS ? flags.permissionMode : null;
  const shown = shownMode in LOOSENESS ? shownMode : null;
  const permissionMode = launch ? (shown ? stricter(shown, launch) : launch) : (STRICT_MODES.has(shown) ? shown : null);
  const phoneMode = [shown, launch].filter(Boolean).reduce(stricter, 'default');
  return { permissionMode, model: flags?.model ?? null, phoneMode };
}

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
  // The dark flag alone (phone-main.js phoneLabsOn), apart from the setting. Turning the SETTING off only stops new
  // moves; deleting the flag file is the kill switch and sends every conversation on the phone back to its tab (Codex
  // r38). Without the dep (tests) it reads as unlocked.
  const unlocked = () => { try { return d.unlocked ? d.unlocked() === true : true; } catch { return false; } };
  // isLive is asked only when the generation map is full (2000 tabs moved in one launch).
  const reg = createPhoneRegistry({ isLive: (id) => { try { return d.tabs().some((t) => t.id === id); } catch { return true; } } });
  const store = createRunStore(path.join(d.userData, 'phone-runs.json'), log);
  // Sessions an earlier Dobius's runs may still be writing: held from construction, read synchronously, until the
  // startup sweep says which are safe (Codex P1, impl round 16: History could resume one while init was awaiting). A
  // failed init keeps them held for this launch, the safe side.
  let startHeld = new Set();
  try { for (const r of store.read()) if (typeof r?.sessionId === 'string' && r.sessionId) startHeld.add(r.sessionId); }
  catch (e) { log(`phone: could not read earlier runs: ${e.message}`); }
  // Settles when init's sweep has decided (or init failed): a launch resume waits on it before claiming a session the
  // start hold covers, instead of being refused once and never retried (Codex P1, impl round 17).
  let sweptDone;
  const swept = new Promise((resolve) => { sweptDone = resolve; });
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
  const notify = (run) => { try { d.notify?.(run.tabId, stateOf(run.tabId)); } catch (e) { log(`phone: notify failed: ${e.message}`); } };

  // tabId -> [{ runId, at, lost: Map(sendId -> 'not_sent' | 'unsure'), truncated }], oldest tab first.
  const endedByTab = new Map();
  const endedOf = (tabId) => (endedByTab.get(tabId) || []).filter((e) => now() - e.at < ENDED_MS);
  const endedRun = (run) => endedOf(run.tabId).find((e) => e.runId === run.runId);

  // The run is ending: every phone message not known to have reached Claude is lost until the runner says otherwise
  // (its `ended` names those that never left its queue; a later `delivered` takes one off). Once per run.
  function noteEnded(run) {
    if (endedRun(run)) return;
    const ids = [...(run.sendIds || [])].filter(([, st]) => st !== 'delivered').map(([id]) => id);
    const lost = new Map(ids.slice(-ENDED_LOST).map((id) => [id, 'unsure']));
    const list = [...endedOf(run.tabId), { runId: run.runId, at: now(), lost, truncated: ids.length > ENDED_LOST }].slice(-ENDED_RUNS);
    endedByTab.delete(run.tabId);
    endedByTab.set(run.tabId, list);
    if (endedByTab.size > ENDED_TABS) endedByTab.delete(endedByTab.keys().next().value);
  }

  /**
   * The phone's view of a tab: the registry's state, the sendIds Claude read in the live run, and ended runs' losses.
   * `ask` (Codex r35): sendIds the asking phone still waits on. The live run's list holds only its newest reads, so a
   * phone that was away while others were read learns its own from the registry (every sendId of the run, bounded).
   */
  function stateOf(tabId, ask) {
    const s = { ...reg.stateOf(tabId) };
    const run = reg.runOfTab(tabId);
    if (s.on && run) {
      const read = new Set(run.delivered || []);
      for (const id of (Array.isArray(ask) ? ask.slice(0, ASK_MAX) : [])) {
        if (reg.sendStateOf(run, id) === 'delivered') read.add(id);
      }
      if (read.size) s.delivered = [...read];
    }
    const ended = endedOf(tabId);
    if (ended.length) {
      s.ended = ended.map((e) => ({
        runId: e.runId, lost: [...e.lost].map(([sendId, why]) => ({ sendId, why })), ...(e.truncated ? { truncated: true } : {}),
      }));
    }
    return s;
  }

  // Main's request id of each send the runner took, so its `delivered` and `ended` can be mapped back to sendIds.
  function noteSendReq(run, reqId, sendId) {
    if (!run.sendReqs) run.sendReqs = new Map();
    run.sendReqs.set(reqId, sendId);
    if (run.sendReqs.size > MAX_SEND_IDS) run.sendReqs.delete(run.sendReqs.keys().next().value);
  }
  function onDelivered(run, reqIds) {
    let changed = false;
    for (const reqId of reqIds) {
      const sendId = run.sendReqs?.get(reqId);
      if (!sendId) continue;
      run.sendReqs.delete(reqId);
      reg.setSendState(run, sendId, 'delivered');
      run.delivered = [...(run.delivered || []), sendId].slice(-DELIVERED_SHOWN);
      endedRun(run)?.lost.delete(sendId);
      changed = true;
    }
    if (changed) notify(run);
  }

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
    try { return await initNow(); } finally { sweptDone(); }
  }
  async function initNow() {
    runDir = ensureRunDir(d.userData);
    boot = await sys.bootSec();
    // Leftover one-time files from an earlier run of Dobius: their tokens died with it.
    for (const name of fs.readdirSync(runDir)) {
      if (/^phone-[0-9a-f]{32}\.(?:ticket|done)(?:\.taken-[0-9a-f]{16})?$/.test(name)) dropTokenFile(path.join(runDir, name), log);
    }
    const swept = await sweepAtLaunch(sys, store);
    for (const s of swept.blocked) blocked.add(s);
    startHeld = new Set();
    for (const line of swept.log) log(`phone: ${line}`);
    server = await startPhoneSocket(runDir, { handler: (conn, msg) => { void onMessage(conn, msg); }, onClose, log });
    ready = true;
    return { blocked: [...blocked] };
  }

  // ---- claims and checks the rest of Dobius asks ----

  /** Sessions no other surface may resume now: phone claims, and what a launch sweep could not clean. */
  const heldSessions = () => {
    const out = new Set([...blocked, ...startHeld]);
    for (const r of reg.list()) if (!r.released) out.add(r.sessionId);
    return out;
  };
  /** A tab whose input belongs to phone mode (every typing path refuses it). */
  /** Whether a session is held only until the launch sweep decides (the claim would be refused now, maybe not later). */
  const heldUntilSwept = (sessionId) => startHeld.has(sessionId);
  /** Settles once the launch sweep has decided, whatever it found. */
  const whenSwept = () => swept;
  const isPhoneTab = (tabId) => { const r = reg.runOfTab(tabId); return !!r && !r.released; };

  // ---- start ----

  // stillOk: the asking phone's pairing is still valid. Checked again right before Claude is stopped and before the tab
  // restarts, so a pairing revoked during the checks moves nothing (Codex P1, impl round 14).
  async function take(tabId, { sessionId, gen, stillOk = () => true } = {}) {
    if (!d.on()) return fail('off', 'phone mode is off on this Mac');
    if (!ready) return fail('not_ready', 'phone mode is still starting on this Mac');
    if (starting) return fail('busy', 'another conversation is moving to the phone; try again in a moment');
    starting = true;
    try { return await takeLocked(tabId, sessionId, gen, stillOk); }
    finally { starting = false; }
  }

  async function takeLocked(tabId, sessionId, gen, stillOk) {
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
    const rec = await d.presence(info, tabId).catch(() => null);
    if (!rec?.sessionId) return fail('unreadable', "Claude's own record of its conversation could not be read");
    // The account it runs on must be the tab's own, or the restart would bring it back on another login.
    const acct = d.accountProblem ? d.accountProblem(tabId, info.pid) : null;
    if (acct) return fail('cannot', acct);
    // The binding the gate must find once the new shell has run its startup files (undefined: not checked).
    const binding = d.binding ? d.binding(tabId) : undefined;
    if (rec.sessionId !== sessionId) return fail('stale_view', 'the tab is on a different conversation now; look again');
    if (!(await d.hasTranscript(sessionId).catch(() => false))) return fail('no_transcript', 'that conversation has nothing to resume yet');
    const act = d.activity(tabId);
    if (rec.status === 'busy' || act?.status === 'working') return fail('working', 'Claude is working; move it when the turn is over');
    // The mode Claude shows now: Shift+Tab changes it with no flag or record saying so, so the launch flags alone could
    // run the phone side looser than what the person was looking at (round 34 ship-test). The screen is a rolling
    // buffer, so a redraw caught halfway can read as no mode, or as a statusLine's own mode line while Claude's is
    // half drawn (Codex r36). So it is read until two looks in a row show the SAME SCREEN (every row, not just the
    // mode: two frames of one redraw can read alike) with a mode, each an idle prompt with no draft (the look that
    // supplies the mode is the one checked); never settled, the move is refused rather than made with the launch
    // flag, which can be looser than the screen.
    const modeOf = (s) => (s && d.promptMode ? d.promptMode(s.lines, s.modes) : null);
    let shownMode = null;
    let prev = null;
    let prevRows = null;
    for (let look = 0; look < MODE_LOOKS && !shownMode; look += 1) {
      if (look) await new Promise((r) => setTimeout(r, MODE_RETRY_MS));
      const sc = await d.screen(tabId).catch(() => null);
      const box = sc ? d.promptBox(sc.lines, sc.modes) : null;
      if (d.inputHeld(tabId) || typeof box !== 'string' || box.trim()) return fail('draft', "there is unsent text in the tab's prompt, or it could not be read");
      const m = modeOf(sc);
      const rows = sc && Array.isArray(sc.lines) ? sc.lines.join('\n') : null;
      if (m && m === prev && rows !== null && rows === prevRows) shownMode = m;
      prev = m;
      prevRows = rows;
    }
    if (!shownMode) return fail('cannot', "Claude's permission mode could not be read in the tab; try again in a moment");
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
    if (!stillOk()) return fail('revoked', 'this phone is no longer paired with the Mac');
    if (!d.on()) return fail('off', 'phone mode is off on this Mac'); // turned off during the checks above (Codex r37)
    const b = reg.begin(tabId, sessionId);
    if (!b.ok) return fail(b.code, b.code === 'too_many' ? 'four conversations are already on the phone' : 'that conversation is busy');
    const run = b.run;
    Object.assign(run, {
      carry: carryFlags(carryOverFlags(argv), shownMode), resendNote: waitingOnPerson, ptyPid: null, ptyStart: null, cwd, aliveAt: now(), binding,
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
    if (!stillOk()) return cancel('revoked', `Claude stopped, but this phone is no longer paired, so it was not moved. ${manual}`);
    if (!d.on()) return cancel('off', `Claude stopped, but phone mode was turned off, so it was not moved. ${manual}`); // Codex r38
    let restarted = false;
    try {
      restarted = d.restart(tabId, cwd, {
        sessionId, cwd, ticket: ticketPath(runDir, run.runId), runId: run.runId, exe: d.exe, runner: d.runnerPath,
        // The TUI comes back with the flags it was stopped with (shared/new-tab.js, the phone launch).
        permissionMode: run.carry?.permissionMode || '', model: run.carry?.model || '',
      }, info.pid);
    } catch (e) { return cancel('failed', `Claude stopped, but the tab could not restart: ${e.message}. ${manual}`); }
    if (!restarted) return cancel('failed', `Claude stopped, but the tab could not restart. ${manual}`);
    // The restart made a new terminal: its shell is what the runner must descend from, and what a closed tab's
    // cleanup confirms gone (by pid AND start time, never a bare pid).
    const fresh = d.tabs().find((t) => t.id === tabId);
    run.ptyPid = Number.isSafeInteger(fresh?.pid) ? fresh.pid : null;
    // Its start time is learned only from the gate's hello listing, where a live child proves the pid is still it.
    run.ptyStart = null;
    notify(run);
    schedule();
    return { ok: true, runId: run.runId, gen: reg.gen(tabId) };
  }

  /**
   * The tab's shell start time, taken from one ps listing in which `childPid` (the gate or the runner, alive and
   * talking to us) descends from the shell's pid. A pid cannot be freed and reused while a child of it is still
   * parented to it, so that row IS the shell: no tab list or separate read is trusted for it (Codex P1, impl rounds 8
   * and 9: a retry after the close, then a tab entry lagging the shell's exit, adopted an unrelated process).
   */
  function learnShellStart(run, rows, childPid) {
    if (run.ptyStart || !Number.isSafeInteger(run.ptyPid) || !descends(rows, childPid, run.ptyPid)) return;
    const shell = rows.find((x) => x.pid === run.ptyPid);
    if (shell?.lstart) run.ptyStart = shell.lstart;
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
    if (m.t === 'delivered') { if (Array.isArray(m.reqIds)) onDelivered(run, m.reqIds.slice(0, 256)); return undefined; }
    if (m.t === 'ended') {
      noteEnded(run);
      const lost = endedRun(run)?.lost;
      for (const reqId of Array.isArray(m.notSent) ? m.notSent.slice(0, 256) : []) {
        const sendId = run.sendReqs?.get(reqId);
        if (sendId && lost?.has(sendId)) lost.set(sendId, 'not_sent');
      }
      endRun(run, plain(m.reason, 200) || 'ended');
      notify(run);
      return undefined;
    }
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
    // Turned off between the take and the gate's hello: nothing starts (Codex r38). A refused gate exits non-zero.
    if (!d.on()) {
      reg.end(run, 'phone mode was turned off on this Mac, so the conversation was not moved');
      conn.send({ t: 'refused', code: 'off', error: 'phone mode is off on this Mac' });
      afterChange(run);
      conn.close('refused');
      return;
    }
    // The new shell's startup files or prompt hooks can change CLAUDE_CONFIG_DIR after the spawn chose the account: the
    // gate reports what it inherited and must match what the conversation ran on, or nothing starts (Codex P1, impl
    // round 16). The gate exits non-zero on a refusal, so the launch's own `claude --resume` does not run either.
    if (run.binding !== undefined && (m.cfg === undefined || (m.cfg !== null && typeof m.cfg !== 'string') || m.cfg !== run.binding)) {
      reg.end(run, "the tab's shell switched to another Claude account, so the conversation was not moved");
      conn.send({ t: 'refused', code: 'account', error: "the tab's shell switched to another Claude account" });
      afterChange(run);
      conn.close('refused');
      return;
    }
    // One ps: the gate's own start time, and that it runs under this tab's shell (whose identity this fixes).
    const rows = Number.isSafeInteger(m.pid) && m.pid > 1 ? parsePsAll(await sys.psAll().catch(() => '')) : [];
    const gateRow = rows.find((x) => x.pid === m.pid);
    const start = gateRow && Number.isSafeInteger(run.ptyPid) && descends(rows, m.pid, run.ptyPid) ? gateRow.lstart : null;
    const a = start ? reg.acceptGate(run, m.pid) : { ok: false, code: 'bad_pid' };
    if (!a.ok) {
      reg.end(run, 'the tab could not start phone mode');
      conn.send({ t: 'refused', code: a.code, error: 'phone mode could not start in this tab' });
      afterChange(run);
      conn.close('refused');
      return;
    }
    run.gateStart = start;
    learnShellStart(run, rows, m.pid);
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
    if (verified) learnShellStart(run, rows, m.pid);
    // Turned off while the runner was starting: it is refused and the tab gets the conversation back (Codex r38).
    const a = d.on() && unlocked() ? reg.acceptRunner(run, m.pid, verified) : { ok: false, code: 'off' };
    if (!a.ok) {
      reg.end(run, a.code === 'off' ? 'phone mode was turned off on this Mac' : a.code === 'not_verified' ? 'the phone side could not be confirmed as this tab\'s' : 'the phone session had already ended');
      conn.send({ t: 'refused', code: a.code, error: 'phone mode stopped' });
      afterChange(run);
      conn.close('refused');
      return;
    }
    conn.authed = true;
    conn.data.runId = run.runId;
    conn.data.role = 'runner';
    conns.set(run.runId, conn);
    conn.send({ t: 'runner-ok', permissionMode: run.carry?.phoneMode ?? 'default', model: run.carry?.model ?? null, resendNote: run.resendNote === true });
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
    noteEnded(run);
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
    if (run.status !== 'ending' && !run.released && !unlocked() && !run.lockedOut) {
      // The kill switch: give the conversation back the way the phone's Give back does (the runner ends its turn and
      // the tab resumes it), or end the run when the runner cannot be asked.
      run.lockedOut = true;
      const conn = conns.get(run.runId);
      const off = 'phone mode was turned off on this Mac';
      if (conn && ['idle', 'working', 'waiting'].includes(run.status)) {
        void command(run, conn, { t: 'give-back' }).then((r) => { if (!r?.ok && run.status !== 'ending') endRun(run, off); }, () => endRun(run, off));
      } else endRun(run, off);
    }
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
      // Without the shell's identity (no hello ever listed it) only "no such pid" proves it gone: the claim stays held
      // otherwise, and a pid that cannot be identified is never signalled (closing a phone tab SIGKILLs its PTY
      // through the PTY object, so a stopped shell still ends). No pid at all holds it too.
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

  const SEND_NOT_TAKEN = new Set(['not_live', 'busy', 'bad_request']);

  // Not gated on the setting: turning it off stops new moves (take), but a conversation already on the phone must
  // still take messages, answers, Stop and Give back, or the person is stuck with it there (Codex r26). The dark flag
  // is different: without it the run is being given back (settleOne), so nothing new is sent (Codex r38).
  function liveRun(tabId, runId) {
    const run = reg.runOfTab(tabId);
    if (!run || run.released || run.runId !== runId) return { error: fail('stale_run', 'that phone session is over') };
    if (!unlocked() || run.lockedOut) return { error: fail('off', 'phone mode was turned off on this Mac; the conversation is going back to the tab') };
    if (!['idle', 'working', 'waiting'].includes(run.status)) return { error: fail('not_live', run.status === 'ending' ? 'the phone session is ending' : 'the phone session is still starting') };
    const conn = conns.get(run.runId);
    if (!conn) return { error: fail('not_live', 'the phone session is not connected') };
    return { run, conn };
  }

  // `late`, when given, still receives the runner's answer after a timeout (for LATE_MS), so a send that timed out
  // learns whether it was taken after all. One entry per timed-out command, removed when it answers or expires.
  function command(run, conn, obj, { late, onReqId } = {}) {
    const reqId = `c${++reqSeq}`;
    onReqId?.(reqId);
    const ms = d.commandMs ?? COMMAND_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        replies.delete(reqId);
        if (late) {
          const t2 = setTimeout(() => replies.delete(reqId), LATE_MS);
          t2.unref?.();
          replies.set(reqId, { runId: run.runId, resolve: late, timer: t2 });
        }
        resolve({ ok: false, code: 'timeout', error: 'the phone session did not answer' });
      }, ms);
      replies.set(reqId, { runId: run.runId, resolve: (m) => resolve(m.ok ? { ok: true } : fail(m.code || 'failed', m.error || 'refused')), timer });
      if (!conn.send({ ...obj, reqId })) { replies.delete(reqId); clearTimeout(timer); resolve(fail('not_live', 'the phone session is not connected')); }
    });
  }

  // A send still waiting on the runner, by run and sendId: a retry of it (the phone reconnected and tapped Send again)
  // gets that send's outcome, never an early "duplicate" for a message the runner may still refuse (Codex r27). Each
  // entry lives at most COMMAND_MS.
  const sending = new Map();
  const NOT_KNOWN = 'it is not known yet whether that message arrived';

  // What a runner answer means for a send id: taken, refused (forgotten, so it may go again) or not known. A late
  // answer to a send that timed out lands here too (Codex r28).
  function settleSend(run, sendId, r) {
    // A reply and the runner's `delivered` can arrive in one read, the reply settling a microtask later: never undo it.
    if (reg.sendStateOf(run, sendId) === 'delivered') return;
    if (r?.ok) reg.setSendState(run, sendId, 'taken');
    else if (SEND_NOT_TAKEN.has(r?.code)) reg.forgetSend(run, sendId);
    else reg.setSendState(run, sendId, 'unknown');
  }

  async function send(tabId, runId, text, sendId) {
    const { run, conn, error } = liveRun(tabId, runId);
    if (error) return error;
    const key = `${run.runId}:${sendId}`;
    const state = reg.sendStateOf(run, sendId);
    if (state === 'taken' || state === 'delivered') return { ok: true, duplicate: true };
    // No answer yet for the first try: say so again, never "duplicate", until the runner's answer settles it.
    if (state === 'unknown') return fail('timeout', NOT_KNOWN);
    if (state === 'pending') {
      const first = sending.get(key);
      if (!first) return fail('timeout', NOT_KNOWN);
      const r = await first;
      if (r.ok) return { ok: true, duplicate: true };
      // Not taken: the id was forgotten, so this retry is the delivery. Anything else is not known, and says so.
      return SEND_NOT_TAKEN.has(r.code) ? send(tabId, runId, text, sendId) : r;
    }
    reg.firstSend(run, sendId);
    const p = command(run, conn, { t: 'send', text }, { late: (m) => settleSend(run, sendId, m), onReqId: (id) => noteSendReq(run, id, sendId) })
      .then((r) => { settleSend(run, sendId, r); return r; })
      .finally(() => { if (sending.get(key) === p) sending.delete(key); });
    sending.set(key, p);
    return p;
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
    init, take, send, answer, stopTurn, giveBack, tabClosed, quitSweep, heldSessions, heldUntilSwept, whenSwept, isPhoneTab,
    /** The session a tab's conversation on the phone runs (until released), so session tracking counts it running. */
    sessionOfTab: (tabId) => { const r = reg.runOfTab(tabId); return r && !r.released ? r.sessionId : null; },
    gen: (tabId) => reg.gen(tabId),
    stateOf,
    close: async () => { if (tickTimer) clearInterval(tickTimer); tickTimer = null; await server?.close(); ready = false; },
    // tests
    _registry: reg, _tick: tick, _runDir: () => runDir,
  };
}
