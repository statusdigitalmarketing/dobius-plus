/**
 * Phone mode: main's registry of phone runs (docs/phone-mode-design.md, "Main: electron/phone-mode.js" and "End").
 *
 * Pure state: no processes, no timers, no files. Callers report facts (a hello arrived, a group is confirmed gone, the
 * tab's own Claude was seen running the session) and ask for decisions (is this session claimed, may this run be
 * forgotten). Everything that signals a process or touches disk lives in phone-mode.js, so every rule here is unit
 * tested on its own.
 *
 * A run's life: starting (gate hello pending, then runner hello pending) -> idle/working/waiting -> ending -> gone.
 * Two things keep a run in the registry after it ends, and they are independent (Codex P2, design round 5):
 *   - the phone CLAIM on its session, released only by the rules in `releaseReason`;
 *   - CLEANUP, done only when every process main knows of for the run is confirmed gone.
 * A run is forgotten only when both are over.
 */
import crypto from 'node:crypto';

export const MAX_RUNS = 4;
export const MAX_PENDING = 8;
export const MAX_SEND_IDS = 64;
export const MAX_GENS = 2000; // tab generations remembered; the oldest is forgotten first (it gets a NEW one on next use)

const LIVE = new Set(['idle', 'working', 'waiting']);
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

export function createPhoneRegistry({ maxRuns = MAX_RUNS, now = Date.now, isLive = () => true } = {}) {
  const runs = new Map(); // runId -> run
  const tokens = new Map(); // sha256(token) -> { runId, kind: 'gate' | 'runner' | 'done', used }
  const gens = new Map(); // tabId -> generation, only for tabs that moved to the phone at least once
  // A tab that never moved has the launch's BASE generation; only a move (and its end and release) gives a tab its
  // own. Asking about a tab never creates an entry, so lookups of other ids cannot evict a live tab's generation
  // (Codex P1, impl round 9). BASE is the clock at launch and every bump is above it and at least the clock, so a
  // restarted main is above every generation the previous one handed out. When the map is full the oldest entry of a
  // tab that is no longer live is dropped (its id falls back to BASE, harmless with no terminal behind it); only if
  // every entry is live, which needs 2000 tabs on the phone in one launch, is the oldest dropped anyway.
  const BASE = now();
  let genCounter = BASE;

  const bumpGen = (tabId) => {
    genCounter = Math.max(genCounter + 1, now());
    gens.delete(tabId);
    gens.set(tabId, genCounter);
    if (gens.size > MAX_GENS) {
      let victim = null;
      for (const id of gens.keys()) { if (id !== tabId && !isLive(id)) { victim = id; break; } }
      gens.delete(victim ?? gens.keys().next().value);
    }
    return genCounter;
  };
  const issue = (run, kind) => {
    const t = newToken();
    tokens.set(hash(t), { runId: run.runId, kind, used: false });
    return t;
  };
  const dropTokens = (runId) => { for (const [h, v] of tokens) if (v.runId === runId) tokens.delete(h); };
  const runOfTab = (tabId) => { for (const r of runs.values()) if (r.tabId === tabId) return r; return null; };

  function toEnding(run, reason) {
    if (run.status === 'ending') return false;
    run.status = 'ending';
    run.endReason = run.endReason || reason || 'ended';
    run.pending.clear();
    bumpGen(run.tabId);
    return true;
  }

  /** Every process main knows of for the run is confirmed gone (cleanup may end; the record may be deleted). */
  function cleanupDone(run) {
    if (run.runnerPgid != null && !run.groupGone) return false;
    if (run.claudePid != null && !run.claudeGone) return false;
    // An accepted gate may have spawned a runner it never reported. Only a tag sweep made after the gate itself is
    // confirmed gone proves there is none (Codex P2, impl round 1: a sweep cached from before the gate spawned missed it).
    if (run.gateAccepted && run.runnerPgid == null && !(run.gateGone && run.tagSweepClean)) return false;
    return true;
  }

  /** Why the phone claim may be released now, or null while it must stay held. */
  function releaseReason(run) {
    if (run.tuiSeen) return 'tui-running';
    if (run.status !== 'ending') return null;
    const procsGone = !run.helloAccepted || (run.groupGone && (run.claudePid == null || run.claudeGone));
    if (run.doneReceived && procsGone) return 'done';
    if (run.tabClosed && run.shellGone && procsGone) return 'tab-closed';
    return null;
  }

  const api = {
    /** The generation a phone write must carry for this tab (BASE until it first moves). Never creates an entry. */
    gen: (tabId) => gens.get(tabId) ?? BASE,

    /** The run currently on this tab (any status), or null. */
    runOfTab,
    get: (runId) => runs.get(runId) ?? null,
    list: () => [...runs.values()],

    /** The run holding a phone claim on this session, or null. */
    claimOf(sessionId) {
      for (const r of runs.values()) if (r.sessionId === sessionId && !r.released) return r;
      return null;
    },

    /**
     * Reserve a run for a move to the phone, before the TUI is stopped. Returns { ok, run, gateToken, doneToken } or
     * { ok: false, code }. The claim is held from here. The done token exists from the start, so `done` can end a
     * run whose gate never ran (its folder was gone): with no accepted hello no runner can start a Claude.
     */
    begin(tabId, sessionId) {
      if (runOfTab(tabId)) return { ok: false, code: 'busy' };
      if (api.claimOf(sessionId)) return { ok: false, code: 'claimed' };
      if (runs.size >= maxRuns) return { ok: false, code: 'too_many' };
      const run = {
        runId: crypto.randomBytes(16).toString('hex'), tabId, sessionId, status: 'starting', stage: 'gate',
        createdAt: Date.now(), gatePid: null, gateAccepted: false, runnerReported: false, runnerPid: null,
        runnerStart: null, runnerPgid: null, helloAccepted: false, claudePid: null, claudeStart: null,
        groupGone: false, claudeGone: false, gateGone: false, tagSweepClean: false, doneReceived: false, tabClosed: false,
        shellGone: false, tuiSeen: false, released: false, endReason: null, error: null,
        pending: new Map(), sendIds: [],
      };
      runs.set(run.runId, run);
      bumpGen(tabId);
      return { ok: true, run, gateToken: issue(run, 'gate'), doneToken: issue(run, 'done') };
    },

    /**
     * Drop a run nothing has used yet: the start failed before the tab was restarted, or the restart itself failed.
     * Refused once any of its tokens was redeemed (a gate exists, so the normal end and release rules apply).
     * Its tokens die with it, so a launch that did start anyway is refused at its hello and starts nothing.
     */
    cancel(run) {
      for (const v of tokens.values()) if (v.runId === run.runId && v.used) return false;
      if (run.gateAccepted || !runs.has(run.runId)) return false;
      runs.delete(run.runId);
      dropTokens(run.runId);
      bumpGen(run.tabId);
      return true;
    },

    /**
     * Redeem a one-time token. A token already used ends its run at once ("another program used its start ticket"),
     * so a hijack is never silent. Returns { ok, run, kind } or { ok: false, code, run? }.
     */
    redeem(token, kind) {
      const rec = typeof token === 'string' && token.length === 64 ? tokens.get(hash(token)) : null;
      if (!rec || rec.kind !== kind) return { ok: false, code: 'bad_token' };
      const run = runs.get(rec.runId);
      if (!run) return { ok: false, code: 'bad_token' };
      if (rec.used) {
        run.error = 'phone mode stopped: another program used its start ticket';
        toEnding(run, 'ticket-reused');
        return { ok: false, code: 'reused', run };
      }
      rec.used = true;
      return { ok: true, run, kind };
    },

    /** The gate's hello (after `redeem(token, 'gate')`). Returns { ok, runnerToken } or a refusal. */
    acceptGate(run, gatePid) {
      if (run.status !== 'starting' || run.stage !== 'gate' || run.tabClosed) return { ok: false, code: 'not_starting' };
      if (!Number.isSafeInteger(gatePid) || gatePid <= 1) return { ok: false, code: 'bad_pid' };
      run.gatePid = gatePid;
      run.gateAccepted = true;
      run.stage = 'runner';
      return { ok: true, runnerToken: issue(run, 'runner') };
    },

    /** The gate reports the runner it spawned (pid, start time; its group id is its pid). */
    noteRunnerSpawned(run, pid, start) {
      if (!run.gateAccepted || run.runnerReported) return false;
      if (!Number.isSafeInteger(pid) || pid <= 1 || typeof start !== 'string' || !start) return false;
      run.runnerReported = true;
      run.runnerPid = pid;
      run.runnerStart = start;
      run.runnerPgid = pid;
      return true;
    },

    /**
     * The runner's hello (after `redeem(token, 'runner')`), with the pid it says it has. The caller has already
     * confirmed with one `ps` that this pid is the reported one and descends from the tab's PTY (`verified`).
     */
    acceptRunner(run, pid, verified) {
      if (run.status !== 'starting' || run.stage !== 'runner' || run.tabClosed) return { ok: false, code: 'not_starting' };
      if (!verified || pid !== run.runnerPid) return { ok: false, code: 'not_verified' };
      run.helloAccepted = true;
      run.stage = 'live';
      run.status = 'idle';
      return { ok: true };
    },

    /** The runner reports the Claude it spawned, before the SDK sends it anything. */
    noteClaude(run, pid, start) {
      if (!run.helloAccepted || run.claudePid != null) return false;
      if (!Number.isSafeInteger(pid) || pid <= 1 || typeof start !== 'string' || !start) return false;
      run.claudePid = pid;
      run.claudeStart = start;
      return true;
    },

    /** Runner status. Only a live run moves between idle, working and waiting. */
    setStatus(run, status) {
      if (!LIVE.has(run.status) || !LIVE.has(status)) return false;
      run.status = status;
      return true;
    },

    /** The run is over from main's side: runner said ended, its socket closed, or no hello in time. */
    end(run, reason) { return toEnding(run, reason); },

    /**
     * `phone-runner.mjs done` for this run (after `redeem(token, 'done')`): the launch command is over.
     * `gateGone` is the caller's check, made when `done` arrived, that the accepted gate's pid has exited. The real
     * `done` runs only after the gate line finished, so a `done` while that gate still runs came from another
     * program: it ends the run loudly and is NOT counted, because the gate could still start its fallback
     * `claude --resume` after the claim was released. Returns { ok } or { ok: false, code: 'gate_alive' }.
     */
    noteDone(run, gateGone) {
      if (run.gateAccepted && gateGone !== true) {
        run.error = "phone mode stopped: another program reported the tab's launch as finished";
        toEnding(run, 'done-forged');
        return { ok: false, code: 'gate_alive' };
      }
      if (run.gateAccepted) run.gateGone = true;
      run.doneReceived = true;
      toEnding(run, run.endReason || 'done');
      return { ok: true };
    },

    tabClosed(tabId) {
      const run = runOfTab(tabId);
      if (!run) return null;
      run.tabClosed = true;
      toEnding(run, 'tab-closed');
      return run;
    },
    noteShellGone(run) { run.shellGone = true; },
    noteGroupGone(run) { run.groupGone = true; },
    noteClaudeGone(run) { run.claudeGone = true; },
    /** The gate's pid (start time matched) is confirmed gone, so it can spawn nothing more. */
    noteGateGone(run) { run.gateGone = true; },
    /**
     * One ps found no process tagged `phone-runner.mjs run <runId>`. Counts only when made after the gate is
     * confirmed gone; an earlier sweep is ignored (returns false), since the gate could still spawn one.
     */
    noteTagSweepClean(run) {
      if (!run.gateAccepted || !run.gateGone) return false;
      run.tagSweepClean = true;
      return true;
    },
    /** The tab's own Claude was seen running this run's session. */
    noteTuiRunning(tabId, sessionId) {
      const run = runOfTab(tabId);
      if (!run || run.sessionId !== sessionId || run.status !== 'ending') return null;
      run.tuiSeen = true;
      return run;
    },

    /** Add a card the runner is waiting on. False when the run is not live, the id is taken, or 8 are pending. */
    addPending(run, card) {
      if (!LIVE.has(run.status) || run.pending.has(card.requestId) || run.pending.size >= MAX_PENDING) return false;
      run.pending.set(card.requestId, card);
      return true;
    },
    /** Take the pending card an answer names (removed so it is answered once), or null. */
    takePending(run, requestId) {
      const card = run.pending.get(requestId);
      if (!card) return null;
      run.pending.delete(requestId);
      return card;
    },
    dropPending(run, requestId) { return run.pending.delete(requestId); },

    /** True the first time a send id is seen in this run (bounded memory, oldest forgotten first). */
    firstSend(run, sendId) {
      if (run.sendIds.includes(sendId)) return false;
      run.sendIds.push(sendId);
      if (run.sendIds.length > MAX_SEND_IDS) run.sendIds.shift();
      return true;
    },

    releaseReason,
    cleanupDone,

    /**
     * Apply the release rules: marks the claim released when allowed and forgets the run when its cleanup is also
     * done. Returns { released: reason|null, forgotten: boolean }.
     */
    settle(run) {
      let released = null;
      if (!run.released) {
        released = releaseReason(run);
        if (released) {
          run.released = true;
          // The Mac has the tab back: a phone view from the `ending` stretch must not reach the returned TUI
          // (Codex P1, impl round 1).
          bumpGen(run.tabId);
        }
      }
      if (run.released && run.status === 'ending' && cleanupDone(run)) {
        runs.delete(run.runId);
        dropTokens(run.runId);
        return { released, forgotten: true };
      }
      return { released, forgotten: false };
    },

    /** What the phone is shown. No tokens, no pids. */
    stateOf(tabId) {
      const run = runOfTab(tabId);
      const g = api.gen(tabId);
      if (!run || run.released) return { id: tabId, on: false, gen: g };
      return {
        id: tabId, on: true, gen: g, runId: run.runId, sessionId: run.sessionId, status: run.status,
        pending: [...run.pending.values()], ...(run.error ? { error: run.error } : {}),
      };
    },
  };
  return api;
}
