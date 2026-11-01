// Tab status dots for Codex tabs (red when Codex waits on an approval, yellow
// while it works, green when a turn ends), the Codex half of the Claude hooks
// in main.js addDobiusHooks.
//
// Codex cannot write a marker into the tab's terminal the way Claude's
// terminalSequence does: its hooks have no tty, and they run under a shared
// app-server daemon whose environment belongs to whichever tab started it, so
// DOBIUS_TAB_ID in a hook names the WRONG tab (measured 2026-11-01). Instead
// each hook hands its stdin to `dobius-codex-status <state>`, which posts it
// to the loopback bridge, and main finds the tab by the hook's SESSION.
//
// Measured on Codex 0.162 (CLI) / 0.166 (daemon): PreToolUse carries a
// tool_use_id and PermissionRequest follows it 0.02-0.04s later WITHOUT one;
// PostToolUse (same id) lands 0.08s after an approval; `codex exec` fires the
// hooks too; new or changed hooks run only once the user trusts them, and that
// trust is keyed by <file>:<event>:<group index>:<handler index>.
//
// Pure module (no electron import): electron/__tests__/codex-status.test.mjs.

import { createHash } from 'node:crypto';
import { shQuote } from '../shared/sh-quote.js';

export const CODEX_HOOK_MARKER = 'dobius-codex-status';
export const CODEX_HOOK_STATES = Object.freeze({
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PermissionRequest: 'needs',
  PostToolUse: 'working',
  Stop: 'done',
});
const STATES = new Set(['working', 'needs', 'done']);
export const HOOK_HEAD_BYTES = 65536;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// Stands in for a removed hook of ours wherever removing it would shift the
// position of a hook after it (Codex keys trust by position, so the user's
// own hook would silently stop running). Inert, and still ours by the marker.
export const CODEX_HOOK_OFF = `true # ${CODEX_HOOK_MARKER} off`;

/** The sh script installed as <userData>/bin/dobius-codex-status. */
export function buildCodexStatusScript({ port, tokenFile }) {
  return `#!/bin/sh
# dobius-codex-status <state>: a Codex hook (~/.codex/hooks.json, installed by
# Dobius+) reporting this session's state for its tab's status dot.
# Prints nothing and always exits 0, so it never changes what Codex decides.
# Reads all of stdin (Codex must never hit a closed pipe), keeps the head.
HEAD=$(head -c ${HOOK_HEAD_BYTES}); cat >/dev/null
TOKEN=$(cat ${shQuote(tokenFile)} 2>/dev/null)
[ -n "$TOKEN" ] || exit 0
# A headless \`codex exec\` (every code review) has no tab: skip it before any
# network, so a busy Dobius can never slow a review down.
# An interactive session always names its rollout; one with no transcript
# (\`codex exec --ephemeral\`) is never a tab's.
TP=$(printf '%s' "$HEAD" | sed 's/"hook_event_name".*//' | grep -o '"transcript_path":"[^"\\\\]*"' | head -n 1 | sed 's/^"transcript_path":"//; s/"$//')
[ -n "$TP" ] || exit 0
if [ -f "$TP" ] && head -c 8192 "$TP" | grep -q '"originator":"codex_exec"'; then exit 0; fi
case "$1" in working|needs|done) ;; *) exit 0 ;; esac
# -q: ignore ~/.curlrc. --noproxy: the token must never leave this machine.
# The token goes in as a header FILE on fd 3, never on the command line where
# any local process could read it.
printf '%s' "$HEAD" | /usr/bin/curl -q -s -o /dev/null --noproxy '*' --connect-timeout 0.3 --max-time 0.5 \\
  -X POST "http://127.0.0.1:${port}/codexStatus" \\
  -H "Host: 127.0.0.1:${port}" \\
  -H @/dev/fd/3 \\
  -H "Content-Type: application/json" \\
  -H "X-Dobius-Codex-State: $1" \\
  --data-binary @- 2>/dev/null 3<<DOBIUS_EOF
Authorization: Bearer $TOKEN
DOBIUS_EOF
exit 0
`;
}

/** One hook command. A missing script (Dobius removed) is a silent no-op. */
export function codexHookCommand(scriptPath, state) {
  const q = shQuote(scriptPath);
  return `test -x ${q} && ${q} ${state} || true # ${CODEX_HOOK_MARKER}`;
}

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(CODEX_HOOK_MARKER);
const isActive = (h) => isOurs(h) && h.command !== CODEX_HOOK_OFF;
const isOurGroup = (g) => Array.isArray(g?.hooks) && g.hooks.length > 0 && g.hooks.every(isOurs);
const offHandler = () => ({ type: 'command', command: CODEX_HOOK_OFF });
const offGroup = () => ({ hooks: [offHandler()] });
const hooksOf = (doc) => (doc?.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks) ? doc.hooks : null);

// Turn our hooks in one event's list off WITHOUT moving anything of the
// user's: ours become placeholders in place, and only trailing ones (nothing
// after them to shift) are actually removed. `keep` = a group index to leave.
function switchOff(groups, keep = -1) {
  const out = groups.map((g, i) => {
    if (i === keep) return g;
    if (isOurGroup(g)) return offGroup();
    if (!Array.isArray(g?.hooks) || !g.hooks.some(isOurs)) return g;
    // A user group holding one of ours (merged by hand): same rule, inside.
    const hooks = g.hooks.map((h) => (isOurs(h) ? offHandler() : h));
    while (hooks.length && hooks[hooks.length - 1].command === CODEX_HOOK_OFF) hooks.pop();
    return { ...g, hooks };
  });
  while (out.length && out.length - 1 !== keep && isOurGroup(out[out.length - 1])
    && out[out.length - 1].hooks.every((h) => h.command === CODEX_HOOK_OFF)) out.pop();
  return out;
}

/** hooks.json with our hooks turned off; the user's keep their positions. */
export function stripCodexHooks(doc) {
  const out = { ...doc };
  const hooks = hooksOf(doc);
  if (!hooks) return out;
  const kept = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { kept[event] = groups; continue; }
    const rest = switchOff(groups);
    if (rest.length) kept[event] = rest;
  }
  if (Object.keys(kept).length) out.hooks = kept; else delete out.hooks;
  return out;
}

/** hooks.json with exactly our current block: an existing group of ours is
 * rewritten IN PLACE (so nothing after it moves), else ours is appended. */
export function withCodexHooks(doc, scriptPath) {
  const out = { ...(doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {}) };
  const hooks = { ...(hooksOf(out) || {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!(event in CODEX_HOOK_STATES) && Array.isArray(groups)) {
      const rest = switchOff(groups);
      if (rest.length) hooks[event] = rest; else delete hooks[event];
    }
  }
  for (const [event, state] of Object.entries(CODEX_HOOK_STATES)) {
    const ours = { hooks: [{ type: 'command', command: codexHookCommand(scriptPath, state) }] };
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const at = groups.findIndex(isOurGroup);
    if (at === -1) { hooks[event] = [...switchOff(groups), ours]; continue; }
    const next = switchOff(groups, at);
    next[at] = ours;
    hooks[event] = next;
  }
  out.hooks = hooks;
  return out;
}

/** Our live hooks present (installed, possibly an older shape). */
export function hasCodexHooks(doc) {
  const hooks = hooksOf(doc);
  if (!hooks) return false;
  return Object.values(hooks).some((groups) => Array.isArray(groups)
    && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isActive)));
}

/** The hook's own top-level fields from the first bytes of its stdin. They
 * are serialized before tool_input (where any quote is escaped anyway), so the
 * FIRST match of each key is the hook's own. */
export function parseHookHead(text) {
  if (typeof text !== 'string') return null;
  const sid = new RegExp(`"session_id"\\s*:\\s*"(${UUID})"`, 'i').exec(text);
  if (!sid) return null;
  const str = (key) => {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
    if (!m) return null;
    try { return JSON.parse(`"${m[1]}"`); } catch { return null; }
  };
  const id = str('tool_use_id');
  // The top-level fields precede hook_event_name; a transcript_path after it
  // is inside tool_input (an ephemeral exec has none of its own).
  const cut = text.indexOf('"hook_event_name"');
  const prefix = cut === -1 ? text : text.slice(0, cut);
  const tp = /"transcript_path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(prefix);
  let transcriptPath = null;
  if (tp) { try { transcriptPath = JSON.parse(`"${tp[1]}"`); } catch { transcriptPath = null; } }
  const cmd = /"tool_input"\s*:\s*\{\s*"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
  return {
    sessionId: sid[1].toLowerCase(),
    transcriptPath,
    event: str('hook_event_name'),
    // Bounded: these are kept per session.
    toolUseId: id && id.length <= 128 ? id : null,
    // The whole command (as far as the head reaches), hashed: two commands
    // sharing a long prefix are still different tools.
    toolKey: createHash('sha1').update(`${str('tool_name') || ''}\u0000${cmd ? cmd[1] : ''}`).digest('hex'),
  };
}

/**
 * Routes hook events to tabs. deps:
 *   liveIds(): ids of live terminals
 *   codexInfo(id): getTerminalCodexInfo (the Codex TUI in that tab) or null
 *   sessionFor({cwd, startedAt}): findCodexSessionForProcess
 *   rolloutMeta(path, sessionId): { sessionId, cwd, isExec } for a rollout
 *     that is really that session's file under the sessions root, else null
 *   lastEnterAt(id), lastAnswerAt(id): ms of the last Enter / prompt answer
 *     typed into that tab (any surface), 0 if none
 *   apply(id, state): set the tab's status
 *   now(): ms; later(fn, ms): setTimeout
 */
export const CLAIM_WINDOW_MS = 15000;
const RETRY_DELAYS = [400, 1200, 3000];
const UNOWNED_RECHECK_MS = 5000; // how often an unowned session looks for a `codex resume`
const MAX_RUNNING = 512; // tool ids kept per session
const MAX_PENDING_TOTAL = 1000; // events waiting across all sessions
const RESUME_LAUNCH_MS = 1500; // the `codex resume` Enter lands within this of the process start
const PARALLEL_MS = 1000; // a tool started this soon after an approval request is a sibling, not a sign it was answered
const MAX_QUEUED = 64; // events waiting per session; more are dropped

export function createCodexStatusRouter(deps) {
  // sessionId -> { tabId, pid } | { exec: true } | { unowned: true, checkedAt }
  //   exec: a `codex exec` run, never a tab's.
  //   unowned: no tab ran it (a Codex outside Dobius, or its window quit and
  //   it carries on in the daemon). Only `codex resume <id>` in a tab claims it.
  const owners = new Map();
  // sessionId -> { seq, running: Map(id -> toolKey), lastPreId, pending, promptAt }
  const sessions = new Map();
  const queues = new Map(); // sessionId -> tail promise, so events apply in order
  const queuedBy = new Map(); // sessionId -> events waiting (survives session eviction)
  let pendingTotal = 0;
  // One counter for every session: a session evicted and recreated must not
  // restart at a number an old retry still carries.
  let nextSeq = 0;
  const MAX = 500;

  const bounded = (map, key, value) => {
    map.delete(key); map.set(key, value);
    while (map.size > MAX) map.delete(map.keys().next().value);
  };

  async function liveCandidates(cwd) {
    const out = [];
    for (const id of deps.liveIds()) {
      const info = await deps.codexInfo(id);
      if (info && (cwd === null || info.cwd === cwd)) out.push({ id, info });
    }
    return out;
  }

  // Who runs this session, as { tabId, pid }, null (nobody), or undefined
  // (cannot tell yet: retry). An owner holds only while the same Codex process
  // is in that tab. promptAt: when this session's latest prompt was submitted,
  // kept because Codex 0.166 may write the rollout only after that hook.
  async function owner(sessionId, transcriptPath, promptAt, urgent) {
    const known = owners.get(sessionId);
    if (known?.exec) return null;
    if (known?.tabId) {
      if (deps.liveIds().includes(known.tabId)) {
        const info = await deps.codexInfo(known.tabId);
        if (info && info.pid === known.pid) return { tabId: known.tabId, pid: known.pid };
      }
      // Its Codex is gone. Since 0.166 a session outlives the window that ran
      // it (it keeps working in the daemon).
      bounded(owners, sessionId, { unowned: true, checkedAt: 0 });
    }
    const unowned = owners.get(sessionId)?.unowned;
    if (unowned) {
      // Only an explicit `codex resume <id>` brings it back; looked for at
      // most every few seconds, since each look probes every tab.
      const o = owners.get(sessionId);
      // A red is never skipped by the cooldown: Codex now waits on a person.
      if (!urgent && deps.now() - o.checkedAt < UNOWNED_RECHECK_MS) return null;
      o.checkedAt = deps.now();
      const named = (await liveCandidates(null)).filter((c) => c.info.sessionId === sessionId);
      if (named.length !== 1) return null;
      bounded(owners, sessionId, { tabId: named[0].id, pid: named[0].info.pid });
      // The Enter that ran `codex resume` is no answer to its prompt; one typed
      // once that Codex was up is (resumedAt: its start, ps rounds it down).
      return { tabId: named[0].id, pid: named[0].info.pid, resumedAt: named[0].info.startedAt };
    }
    const meta = transcriptPath ? await deps.rolloutMeta(transcriptPath, sessionId) : null;
    if (meta?.isExec) { bounded(owners, sessionId, { exec: true }); return null; }
    if (!meta?.cwd) return undefined; // rollout not readable yet: retry
    const candidates = await liveCandidates(meta.cwd);
    const claim = (c) => { bounded(owners, sessionId, { tabId: c.id, pid: c.info.pid }); return { tabId: c.id, pid: c.info.pid }; };
    // 1. argv `codex resume <id>` names the session outright.
    const named = candidates.filter((c) => c.info.sessionId === sessionId);
    if (named.length === 1) return claim(named[0]);
    // For the rollout correlation below, a tab whose argv names a DIFFERENT
    // session is not this one's. The Enter evidence still counts for it:
    // `codex resume A` then /new starts session B in that same process.
    const open = candidates.filter((c) => !c.info.sessionId);
    if (promptAt) {
      // 2. A prompt was submitted: it came from the tab where Enter was just
      // pressed (or whose Codex had just started with a prompt in argv). A
      // Codex in some other terminal in the same folder matches neither.
      const near = (ms) => Number.isFinite(ms) && ms > 0 && Math.abs(promptAt - ms) <= CLAIM_WINDOW_MS;
      const fresh = candidates.filter((c) => near(deps.lastEnterAt(c.id)) || near(c.info.startedAt));
      if (fresh.length === 1) return claim(fresh[0]);
      if (fresh.length === 0) { bounded(owners, sessionId, { unowned: true, checkedAt: deps.now() }); return null; }
      return null; // two tabs in that folder just submitted: cannot tell
    }
    // 3. First seen mid-turn (Dobius restarted under a running session): the
    // tab whose Codex writes that rollout, only if exactly one does.
    // ponytail: a Codex outside Dobius in the same folder, first seen mid-turn,
    // can still be mistaken for the one Dobius tab there.
    const writers = [];
    for (const c of open) {
      if (!Number.isFinite(c.info.startedAt)) continue;
      if (await deps.sessionFor({ cwd: c.info.cwd, startedAt: c.info.startedAt }) === sessionId) writers.push(c);
    }
    return writers.length === 1 ? claim(writers[0]) : null;
  }

  // The state an event leaves the session in, or null to leave the dot alone.
  // A pending approval stays red until IT resolves: its own PostToolUse, a
  // later PreToolUse (Codex moved on, so it was answered or denied), a new
  // prompt, or the turn's end.
  function step(s, ev) {
    switch (ev.event) {
      case 'UserPromptSubmit': s.pending = null; s.running.clear(); s.promptAt = ev.at; return 'working';
      case 'Stop': s.pending = null; s.running.clear(); return 'done';
      case 'PreToolUse':
        if (ev.toolUseId) {
          s.running.delete(ev.toolUseId);
          s.running.set(ev.toolUseId, ev.toolKey);
          while (s.running.size > MAX_RUNNING) s.running.delete(s.running.keys().next().value);
          s.lastPreId = ev.toolUseId;
        }
        // A sibling started in the same burst as the approval request does not
        // answer it; one started later means Codex moved on (approved or denied).
        if (s.pending && ev.at - s.pending.at <= PARALLEL_MS) { if (ev.toolUseId) s.pending.before.add(ev.toolUseId); return null; }
        s.pending = null;
        return 'working';
      case 'PermissionRequest': {
        // PermissionRequest carries no tool id: it is the running tool with
        // the same name and command, newest first, else the latest one.
        let id = s.lastPreId;
        for (const [rid, key] of [...s.running].reverse()) { if (key === ev.toolKey) { id = rid; break; } }
        s.pending = { id, at: ev.at, before: new Set([...s.running.keys()].filter((r) => r !== id)) };
        return 'needs';
      }
      case 'PostToolUse':
        if (ev.toolUseId) s.running.delete(ev.toolUseId);
        // A tool that was already running when the approval was asked for
        // finishing does not answer it.
        if (s.pending && ev.toolUseId && ev.toolUseId !== s.pending.id && s.pending.before.has(ev.toolUseId)) return null;
        s.pending = null;
        return 'working';
      default: return ev.headerState; // a hook event this version does not know
    }
  }

  async function run(sessionId, ev, attempt) {
    const s = sessions.get(sessionId);
    if (!s || s.seq !== ev.seq) return { ok: true, tabId: null, superseded: true };
    const who = await owner(sessionId, ev.transcriptPath, s.promptAt, ev.state === 'needs');
    const o = owners.get(sessionId);
    // An unowned session's red is retried too: a `codex resume` may be starting.
    if (who === undefined || (who === null && ev.state === 'needs' && !o?.exec)) {
      // Not resolvable yet. The red is the one signal that may not be followed
      // by another (Codex now waits on the person), so it is retried.
      const delay = RETRY_DELAYS[attempt];
      if (delay !== undefined && deps.later) deps.later(() => { enqueue(sessionId, () => run(sessionId, ev, attempt + 1)); }, delay);
      return { ok: true, tabId: null, retrying: delay !== undefined };
    }
    if (!who) return { ok: true, tabId: null };
    // The lookup awaited; a newer event for this session, or a different Codex
    // now in that tab, makes this one stale.
    if (s.seq !== ev.seq) return { ok: true, tabId: null, superseded: true };
    const now = await deps.codexInfo(who.tabId);
    if (!now || now.pid !== who.pid || s.seq !== ev.seq) return { ok: true, tabId: null, superseded: true };
    // An answer typed after this event arrived means its prompt is gone.
    const answeredAfter = Number.isFinite(who.resumedAt) ? Math.max(ev.at, who.resumedAt + RESUME_LAUNCH_MS) : ev.at;
    if (ev.state === 'needs' && (deps.lastAnswerAt(who.tabId) || 0) > answeredAfter) { s.pending = null; return { ok: true, tabId: who.tabId, answered: true }; }
    deps.apply(who.tabId, ev.state);
    return { ok: true, tabId: who.tabId };
  }

  function enqueue(sessionId, fn) {
    const prev = queues.get(sessionId) || Promise.resolve();
    const p = prev.then(fn).catch((err) => ({ ok: false, error: err?.message || String(err) }));
    queues.set(sessionId, p);
    p.finally(() => { if (queues.get(sessionId) === p) queues.delete(sessionId); });
    return p;
  }

  /** One hook event. Resolves once it has been applied (or dropped). */
  function handle(headerState, head) {
    const parsed = parseHookHead(head);
    if (!parsed) return Promise.resolve({ ok: false, error: 'no session id' });
    if (!STATES.has(headerState)) return Promise.resolve({ ok: false, error: 'bad state' });
    const { sessionId } = parsed;
    // Backpressure: real Codex sends a few events per tool call, so a session
    // (or everything together) with this many still waiting is being flooded.
    const waiting = queuedBy.get(sessionId) || 0;
    if (waiting >= MAX_QUEUED || pendingTotal >= MAX_PENDING_TOTAL) return Promise.resolve({ ok: false, error: 'queue full' });
    queuedBy.set(sessionId, waiting + 1);
    pendingTotal += 1;
    const ev = { ...parsed, headerState, at: deps.now() };
    return enqueue(sessionId, () => {
      pendingTotal -= 1;
      const left = (queuedBy.get(sessionId) || 1) - 1;
      if (left > 0) queuedBy.set(sessionId, left); else queuedBy.delete(sessionId);
      let s = sessions.get(sessionId);
      if (!s) { s = { seq: 0, running: new Map(), lastPreId: null, pending: null, promptAt: 0 }; bounded(sessions, sessionId, s); }
      const state = step(s, ev);
      // Held events change nothing on screen, so they must not supersede a
      // red still being retried.
      if (!state) return { ok: true, tabId: null, held: true };
      nextSeq += 1;
      s.seq = nextSeq;
      return run(sessionId, { seq: s.seq, state, event: ev.event, transcriptPath: ev.transcriptPath, at: ev.at }, 0);
    });
  }

  return { handle, _owners: owners, _sessions: sessions };
}
