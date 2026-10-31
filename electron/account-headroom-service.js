// Main-process side of account headroom (pure rules: account-headroom.js).
//
// Three jobs:
//  1. Keep a small per-credential usage history from the statusLine records
//     and turn it into per-account usage, pace and forecast for the UI.
//  2. Answer "where can this tab move" for the Move to account dialog, with
//     the same-login / no-credential refusals filled in.
//  3. With auto-move switched on, notice a tab that hit a limit, ask its
//     window to move it (the renderer owns the respawn + resumeSession), then
//     send "continue" through the chat-service submit path once Claude is
//     back on its prompt.
//
// Everything that touches the system arrives through `d` (deps), so the
// timing and guard logic can be driven by a test or a harness.
//
// Credentials are never read: identity comes from account-identity's
// read-only metadata and attribute-only Keychain probes, and nothing here runs
// `claude auth status` (it writes into the config dir).

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  emptyHistory, sanitizeHistory, updateHistory, usageForKey, accountKeyRows, moveRefusal, autoRefusal,
  rankTargets, liveLimitLine, decideAutoMove, tabBusy, noteLogin, STALE_MS, LIMIT_LINE_RE, AUTO,
} from './account-headroom.js';

const SAVE_EVERY_MS = 30_000;
const CONTINUE_TIMEOUT_MS = 60_000;
const PENDING_MAX_MS = 3 * 60_000;
const POLL_MS = 500;
const MAX_NOTICED = 200;
const MAX_CANDIDATE_TABS = 64;
// A tab that looked limited is looked at closely (screen render, transcript)
// at most this often: a limited tab can sit for hours.
const RECHECK_MS = 60_000;
// Usage records are one file per session, forever, and every one is read on
// each sample. Older than the longest window they say nothing.
const RECORD_MAX_AGE_MS = 8 * 24 * 3600_000;
const PRUNE_EVERY_MS = 3600_000;
// Claude's own placeholder in an empty input box ("Try \"refactor ...\"").
const PLACEHOLDER_RE = /^Try "/;
export const isDraft = (box) => typeof box === 'string' && !!box.trim() && !PLACEHOLDER_RE.test(box.trim());
// Desktop tabs only: phone and bridge PTYs have no window to move them.
const DESKTOP_TAB_RE = /^term-\/.+-\d+$/;

export function createHeadroomService(d) {
  const histPath = path.join(d.userDataDir, 'usage-history.json');
  let hist = null;
  let dirty = false;
  let lastSave = 0;
  let saving = null;
  const tabStates = new Map(); // tabId -> { handled: Set<eventId>, lastMoveAt }
  const recentMoves = [];
  const pending = new Map(); // tabId -> { eventId, eventAt, sessionId, project, wcId, at, targetLabel, sourceLabel }
  const noticed = new Set();
  // Credential key -> until when it counts as limited: a tab just hit a
  // limit on it, and its last report may predate that.
  const limitedUntil = new Map();
  let ticking = false;
  let loading = null;
  let lastPrune = 0;

  async function history() {
    if (hist) return hist;
    loading ??= (async () => {
      try { hist = sanitizeHistory(JSON.parse(await fs.readFile(histPath, 'utf8'))); }
      catch { hist = emptyHistory(); }
      return hist;
    })();
    return loading;
  }

  async function save(force = false) {
    if (!dirty || saving) return;
    if (!force && d.now() - lastSave < SAVE_EVERY_MS) return;
    const tmp = `${histPath}.tmp.${process.pid}`;
    dirty = false;
    lastSave = d.now();
    saving = (async () => {
      try {
        await fs.writeFile(tmp, JSON.stringify(hist), { mode: 0o600 });
        await fs.rename(tmp, histPath);
      } catch (err) {
        dirty = true;
        console.warn('[headroom] could not save usage history:', err?.message || err);
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    })();
    try { await saving; } finally { saving = null; }
  }

  async function sample() {
    const h = await history();
    let records;
    if (d.now() - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = d.now();
      try { await d.pruneRecords(RECORD_MAX_AGE_MS); } catch { /* next hour */ }
    }
    try { records = await d.readRecords(); } catch { records = []; }
    if (updateHistory(h, records, d.now())) dirty = true;
    await save();
    return h;
  }

  // Default + every Claude account, with its login read-only. Ids that two
  // rows share cannot be pinned (spawn-account-env refuses them), so those
  // rows carry a refusal of their own.
  async function accountRows() {
    const accounts = d.getAccounts();
    const { default: def, accounts: rows } = accountKeyRows(accounts, { defaultDir: d.defaultDir() });
    const idCount = new Map();
    for (const a of accounts || []) if (a?.type === 'claude' && typeof a.id === 'string') idCount.set(a.id, (idCount.get(a.id) || 0) + 1);
    const all = [
      { ...def, isDefault: true, envUnset: d.defaultEnvUnset() },
      ...rows.filter(Boolean).map((r) => ({ ...r, isDefault: false, envUnset: false, duplicateId: (idCount.get(r.id) || 0) > 1 })),
    ];
    await Promise.all(all.map(async (r) => {
      try {
        const ident = await d.identity(r.dir, { envUnset: r.envUnset });
        r.email = ident?.email || null;
        r.login = ident?.login || 'unknown';
      } catch {
        r.email = null;
        r.login = 'unknown';
      }
    }));
    const byEmail = new Map();
    for (const r of all) {
      if (!r.email) continue;
      const k = r.email.toLowerCase();
      byEmail.set(k, [...(byEmail.get(k) || []), r.label]);
    }
    for (const r of all) r.sameAs = r.email ? byEmail.get(r.email.toLowerCase()).filter((l) => l !== r.label) : [];
    // A folder re-logged into another login: its old figures are not this one's.
    // Two rows on one credential can read two metadata files (Default with
    // the home-level file, an explicit ~/.claude with the inner one) and name
    // two logins: that credential's owner is undecidable, so it is left alone
    // rather than flipped back and forth.
    const h = await history();
    const loginOf = new Map();
    for (const r of all) {
      if (!r.key || !r.email) continue;
      const e = r.email.toLowerCase();
      loginOf.set(r.key, loginOf.has(r.key) && loginOf.get(r.key) !== e ? null : e);
    }
    for (const [key, email] of loginOf) if (email && noteLogin(h, key, email, d.now())) dirty = true;
    return all;
  }

  // Which credential a running claude actually uses, by process (a shell rc
  // can export its own CLAUDE_CONFIG_DIR over what the tab was spawned with).
  // null when the scan cannot say.
  async function processKey(pid) {
    if (!Number.isInteger(pid)) return null;
    let scan;
    try { scan = await d.scan(); } catch { return null; }
    const g = (scan?.groups || []).find((x) => x.pids.includes(pid));
    return g ? g.key : null;
  }

  // The credential a tab's shell was spawned with: its recorded binding, null
  // meaning CLAUDE_CONFIG_DIR unset (the CLI's ~/.claude, with the home-level
  // metadata file).
  async function sourceOf(tab, rows, pid = null) {
    const envUnset = tab.claudeConfigDir === null;
    const dir = envUnset ? d.cliDefaultDir() : tab.claudeConfigDir;
    const key = (pid !== null && (await processKey(pid))) || d.keyFor(dir);
    const row = rows.find((r) => r.key === key);
    if (row) return { key, email: row.email, label: row.label };
    let email;
    try { email = (await d.identity(dir, { envUnset }))?.email || null; } catch { email = null; }
    return { key, email, label: path.basename(dir) };
  }

  // One login under two folders is one limit: a folder with no live figure
  // shows (and ranks by) the freshest figure of a folder logged into the same
  // address, marked with where it came from.
  function usageForRow(r, rows, now) {
    const own = usageForKey(hist, r.key, now);
    if (own.known || !r.email) return own;
    const same = rows
      .filter((o) => o !== r && o.key !== r.key && o.email && o.email.toLowerCase() === r.email.toLowerCase())
      .map((o) => ({ o, u: usageForKey(hist, o.key, now) }))
      .filter((x) => x.u.known)
      .sort((x, y) => (y.u.lastReportedAt || 0) - (x.u.lastReportedAt || 0))[0];
    return same ? { ...same.u, via: same.o.label } : own;
  }

  // `reserved`: key -> percent already promised this pass to tabs moved there.
  function candidatesFor(source, rows, now, reserved = null) {
    return rankTargets(rows.map((r) => {
      const usage = usageForRow(r, rows, now);
      const hold = limitedUntil.get(r.key);
      if (hold && hold > now) { usage.limited = true; usage.headroom = 0; }
      const less = reserved?.get(r.key) || 0;
      if (less && usage.known) usage.headroom = Math.max(0, usage.headroom - less);
      return {
        id: r.id,
        key: r.key,
        isDefault: r.isDefault,
        label: r.label,
        email: r.email,
        login: r.login,
        sameAs: r.sameAs,
        usage,
        refusal: r.duplicateId ? 'two accounts share this id; fix that in Settings first' : moveRefusal(source, r),
        autoRefusal: autoRefusal(source, r),
      };
    }));
  }

  async function usage() {
    await sample();
    const now = d.now();
    const rows = await accountRows();
    let scan;
    try { scan = await d.scan(); } catch { scan = null; }
    const live = new Map((scan?.groups || []).map((g) => [g.key, g.pids.length]));
    // A process whose environment could not be read is unresolved, not
    // absent: never call a credential idle on that evidence.
    const coverageUnknown = !scan || !!scan.discoveryFailed || (scan.unresolved?.length || 0) > 0;
    return {
      ok: true,
      scanFailed: coverageUnknown,
      autoMove: !!d.autoMoveEnabled(),
      accounts: rows.map((r) => {
        const u = usageForRow(r, rows, now);
        const running = live.get(r.key) ?? 0;
        return {
          id: r.id, label: r.label, isDefault: r.isDefault, email: r.email, login: r.login, sameAs: r.sameAs,
          usage: u,
          sessionsRunning: coverageUnknown ? null : running,
          // Still a real figure, but nobody on this Mac is refreshing it, and
          // use elsewhere (claude.ai, another Mac) only ever adds to it.
          stale: u.known && ((u.ageMs ?? 0) > STALE_MS || (!coverageUnknown && running === 0)),
        };
      }),
    };
  }

  async function draftIn(tabId) {
    try {
      const sc = await d.screen(tabId);
      return sc ? isDraft(d.promptBox(sc.lines, sc.modes)) : false;
    } catch { return false; }
  }

  async function tabInfo(tabId) {
    let info;
    try { info = await d.claudeInfo(tabId); } catch { info = null; }
    let session = null;
    if (info) {
      try {
        const r = await d.resolveSession(tabId);
        if (r?.sessionId) session = { sessionId: r.sessionId, project: r.sessionProject || null };
      } catch { session = null; }
    }
    let running = 'claude';
    if (!info) {
      let proc;
      try { proc = await d.process(tabId); } catch { proc = 'unknown'; }
      running = proc ? 'other' : 'shell';
    }
    const act = d.activity(tabId);
    return {
      tabId, running, session, busy: tabBusy(act, d.now()), status: act?.status || null,
      // Unsent text in Claude's box: a respawn would throw it away.
      draft: info ? await draftIn(tabId) : false,
      pid: info?.pid ?? null,
    };
  }

  async function moveTargets(tabId) {
    const tab = d.tabs().find((t) => t.id === tabId);
    if (!tab) return { ok: false, error: 'that tab has no terminal running' };
    await sample();
    const rows = await accountRows();
    const info = await tabInfo(tabId);
    const source = await sourceOf(tab, rows, info.pid);
    const { pid: _pid, ...tabOut } = info;
    return { ok: true, source: { label: source.label, email: source.email }, targets: candidatesFor(source, rows, d.now()).map(({ key: _k, ...c }) => c), tab: tabOut };
  }

  // Move-all: every tab's state, and why it may not go to `targetId` (null =
  // Default). Each tab is judged from its own current account.
  async function moveCandidates(tabIds, targetId) {
    const ids = [...new Set((Array.isArray(tabIds) ? tabIds : []).filter((x) => typeof x === 'string'))].slice(0, MAX_CANDIDATE_TABS);
    const tabs = new Map(d.tabs().map((t) => [t.id, t]));
    const rows = await accountRows();
    const target = targetId === null ? rows.find((r) => r.isDefault) : rows.find((r) => !r.isDefault && r.id === targetId);
    const out = [];
    for (const id of ids) {
      const tab = tabs.get(id);
      if (!tab) continue;
      const info = await tabInfo(id);
      const source = await sourceOf(tab, rows, info.pid);
      const refusal = !target ? 'that account no longer exists'
        : target.duplicateId ? 'two accounts share this id; fix that in Settings first'
          : moveRefusal(source, target);
      const { pid: _pid, ...rest } = info;
      out.push({ ...rest, refusal });
    }
    return out;
  }

  const stateFor = (tabId) => {
    let st = tabStates.get(tabId);
    if (!st) { st = { handled: new Set(), lastMoveAt: 0 }; tabStates.set(tabId, st); }
    return st;
  };

  function notice(tabId, text) {
    d.send(tabId, 'accounts:autoMoveNotice', { text });
  }

  // One look at every desktop tab. Cheap first: only a tab whose credential
  // reads 100%, or whose recent output mentions a limit, is looked at closely.
  async function autoTick() {
    if (!d.autoMoveEnabled()) return;
    const now = d.now();
    for (const [tabId, p] of pending) {
      if (now - p.at > PENDING_MAX_MS) {
        pending.delete(tabId);
        d.log('accounts.auto-move', `tab=${tabId} event=${p.eventId} result=abandoned (the window never confirmed the move)`);
      }
    }
    const live = new Set(d.tabs().map((t) => t.id));
    for (const id of tabStates.keys()) if (!live.has(id)) tabStates.delete(id);
    let rows = null;
    // Headroom promised to tabs moved earlier in this same pass.
    const reserved = new Map();
    for (const tab of d.tabs()) {
      if (!DESKTOP_TAB_RE.test(tab.id) || pending.has(tab.id) || d.windowOf(tab.id) === null) continue;
      const st = stateFor(tab.id);
      if (st.nextLookAt && d.now() < st.nextLookAt) continue;
      const key = d.keyFor(tab.claudeConfigDir === null ? d.cliDefaultDir() : tab.claudeConfigDir);
      const u = usageForKey(hist, key, now);
      const textHit = LIMIT_LINE_RE.test(d.strippedTail(tab.id));
      if (!u.limited && !textHit) continue;
      st.nextLookAt = d.now() + RECHECK_MS;
      let info;
      try { info = await d.claudeInfo(tab.id); } catch { info = null; }
      if (!info) continue;
      let ses;
      try { ses = await d.resolveSession(tab.id); } catch { ses = null; }
      if (!ses?.sessionId) continue;
      const project = ses.sessionProject || tab.cwd;
      let rec;
      try { rec = await d.limitRecord(ses.sessionId, project); } catch { rec = null; }
      if (!rec?.found || !rec.limit) continue;
      if (Number.isFinite(info.startedAt) && rec.limit.at < info.startedAt) continue; // see decideAutoMove
      let sc;
      try { sc = await d.screen(tab.id); } catch { sc = null; }
      const screenHit = !!liveLimitLine(sc?.lines);
      const draft = sc ? isDraft(d.promptBox(sc.lines, sc.modes)) : false;
      rows ??= await accountRows();
      const source = await sourceOf(tab, rows, info.pid);
      const dec = decideAutoMove({
        enabled: true,
        now: d.now(),
        limit: rec.limit,
        processStartedAt: info.startedAt ?? null,
        corroboration: { statusLine: u.limited, screen: screenHit },
        draft,
        busy: tabBusy(d.activity(tab.id), d.now()),
        inputAgeMs: d.inputAgeMs(tab.id),
        tabState: st,
        recentMoves,
        ranked: candidatesFor(source, rows, d.now(), reserved),
      });
      // A real limit on this tab's account: it is limited for everyone else
      // in this pass and for a while after, whatever its last report said.
      if (dec.action === 'move' || dec.action === 'notice' || dec.action === 'wait') {
        if (source.key && !limitedUntil.has(source.key)) limitedUntil.set(source.key, d.now() + AUTO.LIMITED_HOLD_MS);
      }
      for (const [k, t] of limitedUntil) if (t <= d.now()) limitedUntil.delete(k);
      if (dec.action === 'wait') st.nextLookAt = d.now() + 5_000;
      if (dec.action === 'move') {
        st.handled.add(dec.eventId);
        st.lastMoveAt = d.now();
        recentMoves.push(st.lastMoveAt);
        while (recentMoves.length > 50) recentMoves.shift();
        reserved.set(dec.target.key, (reserved.get(dec.target.key) || 0) + AUTO.RESERVE_PER_TAB);
        const p = { eventId: dec.eventId, eventAt: rec.limit.at, sessionId: ses.sessionId, project, wcId: d.windowOf(tab.id), at: d.now(), targetLabel: dec.target.label, targetKey: dec.target.key, sourceLabel: source.label };
        pending.set(tab.id, p);
        d.log('accounts.auto-move', `tab=${tab.id} from=${source.label} to=${dec.target.label} event=${dec.eventId} result=moving`);
        const sent = d.send(tab.id, 'accounts:autoMove', {
          accountId: dec.target.id, sessionId: ses.sessionId, project, eventId: dec.eventId, targetLabel: dec.target.label,
        });
        if (sent !== 'sent') {
          pending.delete(tab.id);
          d.log('accounts.auto-move', `tab=${tab.id} event=${dec.eventId} result=not-moved (no window to move it)`);
        }
      } else if (dec.action === 'notice') {
        const k = `${tab.id}|${dec.eventId}`;
        if (noticed.has(k)) continue;
        noticed.add(k);
        if (noticed.size > MAX_NOTICED) noticed.delete(noticed.values().next().value);
        d.log('accounts.auto-move', `tab=${tab.id} from=${source.label} event=${dec.eventId} result=no-target (${dec.reason})`);
        notice(tab.id, 'This tab hit its limit, but every other account is limited, nearly limited, or has no usage reported yet, so it was not moved. Use Move to account on the tab to pick one yourself.');
      }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await sample();
      await autoTick();
    } catch (err) {
      console.warn('[headroom] tick failed:', err?.message || err);
    } finally {
      ticking = false;
    }
  }

  /**
   * The window moved the tab (respawned it on the target and typed the
   * resume) for a move main asked for, or says why it could not. Waits for
   * Claude to be back on its prompt in that session, then sends "continue".
   * Nothing is sent if anyone typed into the tab after the resume was typed,
   * or if the conversation moved on (its transcript no longer ends in the
   * limit this move was for).
   */
  async function continueAfterMove(tabId, eventId, senderId, failed) {
    const p = pending.get(tabId);
    if (!p || p.eventId !== eventId || p.wcId !== senderId) return { ok: false, error: 'no automatic move is waiting for that tab' };
    pending.delete(tabId);
    const done = (result, ok = false, text = null) => {
      d.log('accounts.auto-move', `tab=${tabId} from=${p.sourceLabel} to=${p.targetLabel} event=${eventId} result=${result}`);
      if (text) notice(tabId, text);
      return { ok, result };
    };
    if (typeof failed === 'string' && failed) return done(`not-moved (${failed.slice(0, 120)})`, false, `Could not move this tab to ${p.targetLabel}: ${failed.slice(0, 200)}`);
    const baseline = d.inputSeq(tabId);
    const pty = d.pty(tabId);
    if (!pty) return done('no-continue (the tab has no shell)');
    const end = d.now() + CONTINUE_TIMEOUT_MS;
    const stillHere = () => d.pty(tabId) === pty && !d.closing(tabId);
    // Claude running the session that was resumed.
    let started = null;
    while (d.now() < end && stillHere()) {
      let info;
      try { info = await d.claudeInfo(tabId); } catch { info = null; }
      if (info?.sessionId === p.sessionId) { started = info; break; }
      await d.sleep(POLL_MS);
    }
    if (!started) return done('no-continue (Claude did not resume in time)', false, `Moved this tab to ${p.targetLabel}, but Claude did not come back in time, so "continue" was not sent.`);
    // The resumed Claude must really be on the target's credential. A shell
    // rc that exports its own CLAUDE_CONFIG_DIR would otherwise land it back
    // on the limited account, and "continue" would spend that one.
    const onKey = await processKey(started.pid);
    if (onKey !== p.targetKey) {
      return done(`no-continue (Claude runs on ${onKey ? 'another credential' : 'a credential that could not be read'})`, false,
        `Moved this tab to ${p.targetLabel}, but the Claude it started is not using that account (a shell setting may override it), so "continue" was not sent.`);
    }
    // Its prompt, drawn and still, on two polls in a row.
    let hits = 0;
    while (d.now() < end && stillHere() && hits < 2) {
      const seq = d.outputSeq(tabId);
      let sc;
      try { sc = await d.screen(tabId); } catch { sc = null; }
      const ready = !!sc && d.promptReady(sc.lines, sc.modes);
      hits = ready && d.outputSeq(tabId) === seq ? hits + 1 : 0;
      if (hits < 2) await d.sleep(POLL_MS);
    }
    if (hits < 2 || !stillHere()) return done('no-continue (Claude\'s prompt did not appear)', false, `Moved this tab to ${p.targetLabel}, but its prompt did not appear in time, so "continue" was not sent.`);
    if (d.inputSeq(tabId) !== baseline) return done('no-continue (someone typed in the tab)', false, `Moved this tab to ${p.targetLabel}. Someone typed in it since, so "continue" was not sent.`);
    let rec;
    try { rec = await d.limitRecord(p.sessionId, p.project); } catch { rec = null; }
    if (!rec?.found || rec.limit?.at !== p.eventAt) return done('no-continue (the conversation moved on)', false, `Moved this tab to ${p.targetLabel}. The conversation had moved on, so "continue" was not sent.`);
    if (d.inputSeq(tabId) !== baseline || !stillHere()) return done('no-continue (someone typed in the tab)');
    const sent = await d.submit(tabId, 'continue', stillHere);
    return sent
      ? done('continued', true)
      : done('no-continue (the submit was interrupted)', false, `Moved this tab to ${p.targetLabel}, but "continue" did not go through. Check the tab.`);
  }

  return {
    tick,
    usage,
    moveTargets,
    moveCandidates,
    continueAfterMove,
    flush: () => save(true),
    _pending: pending,
    _tabStates: tabStates,
  };
}
