/**
 * Team communicator service (docs/team-communicator.md): invites and the link prompt, joining, receiving, the
 * outbox with retries, and the delivery queue into the pinned orchestrator tab. No electron import: the store,
 * the network call, this install's endpoint, delivery deps and the UI hooks come in, so it runs under test with two
 * services talking to each other in memory.
 *
 * opts:
 *   store                 team-store.js
 *   request(opts)         team-net.js teamRequest (tests pass an in-memory router)
 *   endpoint() -> { host, port } | null   this install's MagicDNS name and phone-server port (null: not reachable)
 *   deliverDeps(tabId, authorized) -> deps for team-deliver.js, or null when the app cannot deliver
 *   notify(event, payload)                 UI: 'changed' | 'link-request' | 'message'
 *   now(), sleep(ms)
 */
import crypto from 'node:crypto';
import * as P from './team-protocol.js';
import { shortFp, fingerprint } from './team-crypto.js';
import { looksLikeFingerprint } from './team-store.js';
import { deliver, deliveryCard, handoffCard } from './team-deliver.js';

export const SEND_DEADLINE_MS = 24 * 3600 * 1000;
export const HANDOFF_TTL_MS = 24 * 3600 * 1000;
export const MAX_HANDOFFS = 20;
export const MAX_HANDOFFS_PER_TAB = 5;
// Shorter than an incoming message's 30 minutes: a busy orchestrator should not hold the queue for a local request.
export const HANDOFF_GIVE_UP_MS = 10 * 60 * 1000;
export const RETRY_WINDOW_MS = P.CUTOFF_MS - 10 * 60 * 1000; // a human Retry stays inside the receiver's cutoff
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
// Status reports back to a message's sender: retried until a SIGNED ack, at most 24 h after the event.
const REPORT_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000];
export const REPORT_TTL_MS = 24 * 3600 * 1000;
const TRACK_MS = 6 * 3600 * 1000; // how long a read message's working/done is followed
const TIMELINE_MAX = 30;
const FINAL = new Set(['done', 'failed', 'stopped']);
const REPORTS_PER_MIN = 10;
const REPORT_PAUSE_MS = 15 * 60 * 1000;
const LINK_POLL_MS = 2000;
const SIG_HEADER = 'x-dobius-team-sig';

export function createTeamService({ store, request, endpoint, endpointProblem = () => null, deliverDeps, notify = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const invites = new Map(); // inviteId -> { secret, expiresAt, joiner, decision, conf? }
  const unlinkedAt = new Map(); // peer id -> when this person unlinked it (a join in flight must not undo that)
  let pumpTimer = null;
  let pumping = false;
  const deliveryQueue = [];
  let delivering = false;
  let stopped = false;
  let current = null; // `${peer}|${id}` of the delivery typing right now
  // Sends another tab asked the orchestrator to approve (handoff / approveHandoff), by unguessable id.
  // ponytail: in memory only, so a restart drops the waiting ones; the asking tab can ask again.
  const handoffs = new Map();
  // The message most recently typed into the pinned tab, while its Claude works on it (lifecycle: working, done).
  // Incoming messages are typed only into an idle tab, one at a time, so hook states between this message's typing
  // and the next one's belong to it. { tabId, peer, id, at, typed, sawWorking, lastNote }
  let tracked = null;
  // Tabs where a turn ended with background work still running (Stop tagged background), until a plain Stop: Claude's
  // Stop hook reports a plain done only when no background task remains. Kept per TAB, not per message, so it
  // survives a message that was read-only because of it. A message pasted while it is set is not followed.
  const bgOpenTabs = new Set();
  // Only while it can still be reported on: an expired tracker must not keep its row (and so the inbox) pinned.
  store.setKeepAlso?.((m) => !!tracked && now() - tracked.at <= TRACK_MS && m.dir === 'in' && m.peer === tracked.peer && m.id === tracked.id);
  // Report pacing per teammate, so status traffic never crowds out messages on their side (their /team/* admission is
  // shared): at most REPORTS_PER_MIN a minute, and a pause after an answer that says they do not have the route.
  const reportTimes = new Map(); // peer -> recent request times
  const reportPause = new Map(); // peer -> until

  const identity = () => store.loadIdentity();
  const myFp = () => fpOf(identity());
  const fpOf = (id) => fingerprint(id.ed, id.x);
  const me = () => {
    const ep = endpoint();
    return ep ? { name: store.settings().name, host: ep.host, port: ep.port } : null;
  };
  const notReachable = () => endpointProblem() || 'This Mac is not reachable yet.';
  const changed = () => notify('changed', {});

  // ---------- status ----------

  function status() {
    let id;
    try { id = identity(); } catch (err) { return { ok: false, error: err.message }; }
    const fp = fpOf(id);
    const ep = endpoint();
    const peers = Object.values(store.peers()).map(({ ed, x, ...p }) => ({ ...p, short: shortFp(p.id) }));
    return {
      ok: true, fp, short: shortFp(fp), endpoint: ep, notReachable: ep ? null : notReachable(), settings: store.settings(), peers,
      pendingLinks: [...invites.entries()].filter(([, v]) => v.decision === 'pending' && v.expiresAt > now())
        .map(([inviteId, v]) => ({ inviteId, name: v.joiner.name, short: shortFp(v.joiner.id), host: v.joiner.host })),
    };
  }

  // ---------- linking: A's side ----------

  function createInvite() {
    const m = me();
    if (!m) return { ok: false, error: notReachable() };
    const inv = P.makeInvite(m, myFp(), now());
    const inviteId = crypto.randomUUID();
    invites.set(inviteId, { secret: inv.secret, expiresAt: inv.expiresAt, joiner: null, decision: null, nonces: new Set() });
    for (const [k, v] of invites) if (v.expiresAt < now() - 60_000) invites.delete(k);
    return { ok: true, text: inv.text, expiresAt: inv.expiresAt };
  }

  function hello(nonce) {
    if (!/^[0-9a-f]{32}$/.test(String(nonce || ''))) return { status: 400, json: { ok: false } };
    const m = me();
    if (!m) return { status: 503, json: { ok: false } };
    return { status: 200, json: P.makeHello(identity(), m, nonce) };
  }

  /** POST /team/link. 202 while the user decides, 200 + confirmation once accepted, 403 declined/refused. */
  function link(body, sig) {
    const m = me();
    if (!m) return { status: 503, json: { ok: false } };
    const req = P.openLinkRequest(identity(), myFp(), body, sig);
    if (!req) return { status: 403, json: { ok: false } };
    let entry = null;
    let inviteId = null;
    for (const [k, v] of invites) if (P.secretMatches(v.secret, req.secret)) { entry = v; inviteId = k; break; }
    if (!entry || entry.expiresAt <= now()) return { status: 403, json: { ok: false, state: 'expired' } };
    if (req.id === myFp()) return { status: 403, json: { ok: false } };
    if (entry.joiner && (entry.joiner.id !== req.id || entry.joiner.ed !== req.ed || entry.joiner.x !== req.x)) {
      return { status: 403, json: { ok: false } }; // a spent secret, different keys
    }
    if (!entry.joiner) {
      entry.joiner = { id: req.id, name: req.name, host: req.host, port: req.port, ed: req.ed, x: req.x };
      entry.decision = 'pending';
      notify('link-request', { inviteId, name: req.name, short: shortFp(req.id), host: req.host });
      changed();
    }
    if (entry.decision === 'pending') return { status: 202, json: { ok: true, state: 'pending' } };
    if (entry.decision === 'declined') return { status: 403, json: { ok: false, state: 'declined' } };
    // Accepted: a confirmation for THIS request's nonce (a lost answer is recoverable until the invite expires).
    return { status: 200, json: { ok: true, state: 'accepted', conf: P.linkConfirmation(identity(), m, req.secret, req.id, req.reqNonce) } };
  }

  function decideLink(inviteId, accept) {
    const entry = invites.get(inviteId);
    if (!entry || entry.decision !== 'pending' || entry.expiresAt <= now()) return { ok: false, error: 'that link request is no longer waiting' };
    // Saved BEFORE it counts as accepted: a failed save leaves the request pending (and the joiner polling), never a
    // confirmation for a teammate this Mac does not have.
    if (accept) {
      try { store.savePeer(entry.joiner); } catch (err) { return { ok: false, error: `could not save the teammate: ${err.message}` }; }
    }
    entry.decision = accept ? 'accepted' : 'declined';
    changed();
    return { ok: true };
  }

  // ---------- linking: B's side ----------

  async function join(inviteText) {
    const inv = P.parseInvite(inviteText);
    if (!inv) return { ok: false, error: 'that is not a Dobius team invite' };
    const m = me();
    if (!m) return { ok: false, error: notReachable() };
    if (inv.fp === myFp()) return { ok: false, error: 'that invite is from this Mac' };
    if (Object.hasOwn(store.peers(), inv.fp)) return { ok: false, error: 'you are already linked with that Mac' };
    const startedAt = now();
    const nonce = P.newNonce();
    const h = await request({ host: inv.host, port: inv.port, method: 'GET', path: `/team/hello?nonce=${nonce}` });
    const a = h.status === 200 ? P.checkHello(h.json, nonce, inv.fp) : null;
    // A wrong or hostile address learns nothing: we stop before sending anything (design step 2).
    if (!a) return { ok: false, error: h.error ? `could not reach ${inv.host} (${h.error})` : 'the Mac at that address is not the one that made the invite' };
    const reqNonce = P.newNonce();
    const lr = P.buildLinkRequest(identity(), m, { id: inv.fp, x: a.x }, inv.secret, reqNonce);
    const end = now() + P.INVITE_MS;
    while (now() < end && !stopped) {
      const r = await request({ host: inv.host, port: inv.port, method: 'POST', path: '/team/link', body: lr.body, headers: { [SIG_HEADER]: lr.sig } });
      if (r.status === 200) {
        const peer = P.checkLinkConfirmation(r.json?.conf, inv, myFp(), reqNonce);
        if (!peer) return { ok: false, error: 'the confirmation did not check out; nothing was saved' };
        // An Unlink of this Mac while the join waited wins: the join must not bring the teammate back.
        if ((unlinkedAt.get(peer.id) || 0) >= startedAt || Object.hasOwn(store.peers(), peer.id)) {
          return { ok: false, error: 'that Mac was unlinked or linked again while this join was waiting; nothing was saved' };
        }
        const saved = store.savePeer(peer);
        changed();
        return { ok: true, peer: { id: saved.id, name: saved.name, short: shortFp(saved.id) } };
      }
      if (r.status === 403) return { ok: false, error: r.json?.state === 'declined' ? 'they declined the link' : 'the invite was refused (expired, already used, or not for this Mac)' };
      if (r.status && r.status !== 202 && r.status !== 429 && r.status !== 503) return { ok: false, error: `unexpected answer ${r.status}` };
      await sleep(LINK_POLL_MS);
    }
    return { ok: false, error: 'they did not accept within 15 minutes' };
  }

  // ---------- receiving ----------

  function receive(body, sig) {
    if (!store.settings().accept) return { status: 503, json: { ok: false } };
    let staged = null;
    const records = { get: (k) => store.records.get(k), set: (k, v) => { staged = [k, v]; } };
    const r = P.receiveMessage({ identity: identity(), myFp: myFp(), peers: store.peers(), records, body, sig, now: now(), allow: store.allow });
    if (r.status === 'conflict') return { status: 409, json: { ok: false } };
    if (r.status === 'refused') return { status: r.reason === 'rate' ? 429 : 403, json: { ok: false } };
    const { env, from } = r;
    const hash = P.contentHash(env);
    const findRow = () => store.messages().find((x) => x.dir === 'in' && x.peer === from.id && x.id === env.id);
    if (r.status === 'duplicate') {
      // Already accepted. A row still 'waiting' whose delivery job was lost (a failed write after storing it) is
      // queued again; enqueueDelivery ignores one already queued.
      if (findRow()?.state === 'waiting') enqueueDelivery(from.id, env.id);
      return { status: 200, json: { ok: true, receipt: r.receipt } };
    }
    // New to the dedupe records. The stored ROW is the source of truth: it carries the content hash, and the receipt
    // is only ever returned once both the row and the record are on disk.
    const existing = findRow();
    if (existing) {
      // A crash between the row and the record left a row without one. Only the SAME content may be acknowledged.
      if (existing.hash !== hash) return { status: 409, json: { ok: false } };
      store.records.set(...staged);
      if (existing.state === 'waiting') enqueueDelivery(from.id, env.id);
      return { status: 200, json: { ok: true, receipt: r.receipt } };
    }
    const s = store.settings();
    const routable = from.autoRoute && s.orchestratorTab;
    try {
      store.putMessage({
        dir: 'in', id: env.id, peer: from.id, peerName: from.name, kind: env.kind, replyTo: env.replyTo || null,
        text: env.text, hash, firstSentAt: env.firstSentAt, at: now(),
        state: routable ? 'waiting' : 'held',
        note: routable ? null : (from.autoRoute ? 'no orchestrator tab is pinned' : `Auto-route is off for ${from.name}`),
      });
    } catch (err) {
      // Not stored, so not acknowledged: the sender keeps retrying (inbox full, disk full).
      console.error('[team] could not store an incoming message:', err.message);
      if (err.code === 'INBOX_FULL') notify('inbox-full', { name: from.name });
      return { status: 503, json: { ok: false } };
    }
    store.records.set(...staged); // throws on a failed write: 500, and the sender's retry lands in `existing` above
    store.countAccepted(from.id);
    notify('message', { name: from.name, text: env.text.slice(0, 200) });
    changed();
    if (!routable) report(from.id, env.id, 'held', from.autoRoute ? 'no orchestrator tab is pinned' : 'Auto-route is off for this sender');
    enqueueDelivery(from.id, env.id);
    return { status: 200, json: { ok: true, receipt: r.receipt } };
  }

  // ---------- delivery queue (one at a time) ----------

  function enqueueDelivery(peer, id, manual = false) {
    if (!deliveryQueue.some((q) => q.peer === peer && q.id === id)) {
      // A teammate's message goes ahead of local handoff requests, so a tab's requests can never hold one up.
      const firstLocal = deliveryQueue.findIndex((q) => q.local);
      deliveryQueue.splice(firstLocal < 0 ? deliveryQueue.length : firstLocal, 0, { peer, id, manual });
    }
    runDeliveries().catch((err) => console.error('[team] delivery queue failed:', err.message));
  }

  async function runDeliveries() {
    if (delivering) return;
    delivering = true;
    try {
      while (deliveryQueue.length && !stopped) {
        const job = deliveryQueue.shift();
        try {
          await (job.local ? deliverHandoff(job.local) : deliverJob(job));
        } catch (err) {
          if (job.local) { handoffFailed(handoffs.get(job.local), `delivery failed: ${err.message}`); continue; }
          // A failed write (disk full) must not strand an acknowledged message: it goes back on the queue.
          console.error('[team] delivery step failed, retrying in 30s:', err.message);
          setTimeout(() => enqueueDelivery(job.peer, job.id, job.manual), 30_000).unref?.();
        }
      }
    } finally {
      delivering = false;
    }
  }

  /** A person is done with a row that needed them: it stops counting and can leave the list. */
  function dismiss(dir, peer, id) {
    const msg = store.messages().find((x) => x.dir === dir && x.peer === peer && x.id === id);
    const stuck = msg?.state === 'routing' && current !== `${peer}|${id}`;
    if (!msg || (!stuck && !['held', 'needs attention', 'unconfirmed', 'not delivered'].includes(msg.state))) return { ok: false, error: 'nothing to dismiss' };
    store.patchMessage(dir, peer, id, { state: 'dismissed', note: null });
    changed();
    return { ok: true };
  }

  function unlink(id) {
    const ok = store.removePeer(id);
    if (ok) unlinkedAt.set(id, now());
    // An accepted invite would otherwise keep confirming the link to a joiner that is no longer a teammate.
    for (const v of invites.values()) if (v.joiner?.id === id) v.decision = 'declined';
    changed();
    return { ok };
  }

  // The outcome of a delivery is written until it lands: a requeued job would skip a row still saying 'routing'
  // (it may have typed), so a failed write here is retried on its own, never by delivering again.
  // Only over a row still 'routing': a person may have dismissed it while the retry waited.
  const pendingResults = new Set(); // `${peer}|${id}` whose result write is waiting for a retry
  function saveResult(peer, id, patch) {
    const key = `${peer}|${id}`;
    try {
      const row = store.messages().find((x) => x.dir === 'in' && x.peer === peer && x.id === id);
      if (row && row.state === 'routing') {
        store.patchMessage('in', peer, id, patch);
        changed();
      }
      pendingResults.delete(key);
    } catch (err) {
      console.error('[team] could not save a delivery result, retrying in 30s:', err.message);
      pendingResults.add(key);
      setTimeout(() => saveResult(peer, id, patch), 30_000).unref?.();
    }
  }

  async function deliverJob({ peer, id, manual }) {
    const msg = store.messages().find((x) => x.dir === 'in' && x.peer === peer && x.id === id);
    if (!msg || (msg.state !== 'waiting' && !(manual && msg.state === 'held'))) return;
    // Typed only once its dedupe record is on disk: without it, a retry of the same message after the row is
    // dropped would be accepted and typed again (Codex r2, three lenses).
    const rkey = `${peer}|${id}`;
    if (!store.records.get(rkey)) {
      if (!msg.hash) { holdIn(peer, id, 'no content hash recorded; check it before routing'); return; }
      store.records.set(rkey, { hash: msg.hash, firstAcceptedAt: msg.at }); // throws: requeued by the caller
    }
    const tabId = store.settings().orchestratorTab;
    const authorized = () => {
      const p = store.peers()[peer];
      const s = store.settings();
      if (!p || !p.enabled) return 'the sender is no longer linked';
      if (!manual && !p.autoRoute) return `Auto-route is off for ${p.name}`;
      if (!s.accept) return 'Accept team messages is off';
      if (!s.orchestratorTab) return 'no orchestrator tab is pinned';
      if (s.orchestratorTab !== tabId) return 'the orchestrator tab changed';
      return null;
    };
    const why = authorized();
    if (why) { holdIn(peer, id, why); return; }
    const deps = deliverDeps(tabId, authorized);
    if (!deps) { holdIn(peer, id, 'delivery is not available'); return; }
    const card = deliveryCard({ fromName: store.nameFor(msg), fromFp: peer, at: msg.at, id, text: msg.text });
    if (card.error) { holdIn(peer, id, card.error); return; }
    store.patchMessage('in', peer, id, { state: 'routing', note: null });
    changed();
    let result;
    current = `${peer}|${id}`;
    // Followed from the PASTE (not before the wait for an idle tab, when the previous message's turn may still be
    // running): Claude's 'working' for this prompt can land before the Enter is confirmed.
    const tracker = { tabId, peer, id, at: now(), typed: false, sawWorking: false, sawDone: false, turnOpen: false, lastNote: null, reliable: true, claudePid: null };

    // The Claude that will take it, read at each readiness check that finds Claude leading the tab, so the one recorded
    // is the one there right before the paste (not before a long wait, and not a fresh `claude` started after the
    // Enter). Unknown (two claudes in the shell, a failed look): the pid check is simply not used.
    let pastedYet = false;
    const followed = { ...deps, claudeRunning: async (t, x) => {
      const ok = await deps.claudeRunning(t, x);
      // Frozen at the paste: the checks before the Enter call this too, and must not swap in another process.
      if (pastedYet) return ok;
      tracker.claudePid = null;
      if (ok && deps.claudePid) {
        try {
          const pid = await deps.claudePid(t);
          if (Number.isInteger(pid) && pid > 0) tracker.claudePid = pid;
        } catch (err) {
          console.warn('[team] could not read the Claude pid:', err?.message || err);
        }
      }
      return ok;
    }, paste: (t, text) => {
      pastedYet = true;
      // Typed while background work from an earlier turn may still run in that tab: hooks that follow may be that
      // work's, so this one is reported read and not followed further.
      tracked = tracker;
      tracker.at = now();
      tracker.reliable = !deps.background?.(t) && !bgOpenTabs.has(t);
      return deps.paste(t, text);
    } };
    try { result = await deliver(followed, tabId, card.text); } catch (err) { result = { state: 'needs attention', note: `delivery failed: ${err.message}` }; } finally { current = null; }
    saveResult(peer, id, { state: result.state, note: result.note || null, routedAt: result.state === 'routed' ? now() : undefined });
    const t = tracked === tracker ? tracker : null;
    if (result.state === 'routed') {
      report(peer, id, 'read');
      if (t && !t.reliable) tracked = null;
      else if (t) {
        t.typed = true;
        if (t.sawWorking) report(peer, id, 'working', t.lastNote);
        if (t.sawDone) { if (t.claudePid) report(peer, id, 'done', 'the receiving Claude finished its turn'); tracked = null; }
      }
    } else {
      if (t) tracked = null;
      report(peer, id, result.state === 'needs attention' ? 'needs attention' : 'held',
        result.state === 'needs attention' ? `${result.note || 'typed in, not confirmed sent'}; someone has to check their orchestrator tab` : result.note);
    }
  }

  function holdIn(peer, id, note) {
    store.patchMessage('in', peer, id, { state: 'held', note });
    changed();
    report(peer, id, 'held', note);
  }

  // ---------- lifecycle reports (receiver side) ----------

  /** Queue a report about an incoming message for its sender. Never throws: a report is never worth a delivery. */
  function report(peer, id, state, note = null, replyId = null) {
    try {
      const row = store.messages().find((x) => x.dir === 'in' && x.peer === peer && x.id === id);
      if (!row) return;
      // An outcome stands (done, failed, stopped): a late read or working must not walk it back. A reply can still come.
      if (row.finalState && state !== 'replied') return;
      const seq = (row.nextSeq || 1);
      if (seq > P.MAX_SEQ) return;
      const n = note ? String(note).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').slice(0, 300) : null;
      const owed = Array.isArray(row.reports) ? row.reports : [];
      const reports = [...owed, { seq, state, at: now(), note: n, replyId }];
      // Joining a queue that is already backing off keeps its schedule: new events must not hammer a peer that is
      // not answering (an older Dobius, one that is offline).
      const patch = owed.length ? { reports, nextSeq: seq + 1 } : { reports, nextSeq: seq + 1, reportNextAt: now(), reportAttempts: 0 };
      if (FINAL.has(state)) patch.finalState = state;
      store.patchMessage('in', peer, id, patch);
      scheduleReports(0);
    } catch (err) {
      console.error('[team] could not queue a status report:', err.message);
    }
  }

  /**
   * A hook state from a terminal (terminal-status onHookState). Only the tab the tracked message was typed into, and
   * only for TRACK_MS after it was read.
   */
  function tabEvent(tabId, state, tag) {
    if (state === 'working' && tag === 'background') bgOpenTabs.add(tabId);
    else if ((state === 'done' && !tag) || state === 'exit') bgOpenTabs.delete(tabId);
    const t = tracked;
    if (!t || t.tabId !== tabId) return;
    if (now() - t.at > TRACK_MS) { tracked = null; return; }
    const say = (st, note) => {
      if (!t.typed) return; // reported once the Enter is confirmed (deliverJob)
      report(t.peer, t.id, st, note);
    };
    if (state === 'exit') {
      tracked = null;
      if (t.typed) report(t.peer, t.id, 'stopped', 'the orchestrator tab closed before Claude finished');
      return;
    }
    if (state === 'claude-gone') {
      // Claude is no longer running in that tab (it crashed or was quit) and someone is typing at the shell.
      tracked = null;
      if (t.typed) report(t.peer, t.id, 'stopped', 'Claude was closed in their orchestrator tab before it finished');
      return;
    }
    if (state === 'person-interrupt') {
      // Esc or Ctrl+C typed by a person: an interrupted turn sends no Stop, and a hook already in flight could reopen
      // it, so following ends here. The message stays at its last stage.
      if (t.typed) tracked = null;
      return;
    }
    if (state === 'person-submit') {
      // Someone typed a prompt of their own once Claude's turn on this message had ended (a handed-back command, an
      // interrupt): what follows is theirs, not the message's. Answering a permission prompt mid-turn does not count,
      // but only while we know which Claude took it: without its pid a crash and restart cannot be told apart, so any
      // person's Enter ends following (the safe direction).
      if (t.typed && (!t.turnOpen || !t.claudePid)) tracked = null;
      return;
    }
    if (state === 'working' || state === 'needs') {
      // A turn that handed a command back, or ended leaving background work running, is over: what the owner types
      // next is theirs.
      // Once over it stays over: a background subagent's later hooks must not reopen it (the owner's next prompt would
      // then be credited to this message).
      if ((state === 'needs' && tag === 'handoff') || (state === 'working' && tag === 'background')) t.turnClosed = true;
      t.turnOpen = !t.turnClosed;
      const note = state === 'needs' ? (tag === 'handoff' ? 'waiting on its owner (a command was handed back)' : 'waiting on a permission prompt')
        : (tag === 'background' ? 'background work still running' : null);
      if (!t.sawWorking || note !== t.lastNote) {
        t.sawWorking = true;
        t.lastNote = note;
        say('working', note);
      }
      return;
    }
    if (state === 'done' && tag !== 'idle' && t.sawWorking) {
      t.turnOpen = false;
      t.turnClosed = true;
      if (!t.typed) { t.sawDone = true; return; }
      tracked = null;
      // Without the Claude's pid, a chained second claude cannot be told from this one: no automatic done (the
      // message stays at working until `dobius-team done|failed`).
      if (!t.claudePid) return;
      report(t.peer, t.id, 'done', 'the receiving Claude finished its turn');
    }
  }

  /** Whether a message in `tabId` is being followed (team-main only checks for Claude then: a ps per Enter). */
  const following = (tabId) => !!tracked && tracked.tabId === tabId;
  /** The pid of the Claude that took the followed message in `tabId`, or null. */
  const followedPid = (tabId) => (following(tabId) && tracked.claudePid) || null;

  /** The orchestrator says it finished (or could not do) a teammate's message: `dobius-team done|failed <id@fp>`. */
  function markIncoming(ref, state, note) {
    const r = String(ref || '').trim();
    const at = r.indexOf('@');
    const msg = at > 0 ? store.findById(r.slice(0, at), 'in', r.slice(at + 1)) : null;
    if (!msg) return { ok: false, error: 'no single received message has that id@fingerprint' };
    if (tracked && tracked.peer === msg.peer && tracked.id === msg.id) tracked = null;
    report(msg.peer, msg.id, state, note || null);
    return { ok: true, short: msg.id.slice(0, 8), to: store.nameFor(msg) };
  }

  async function attemptReport(snap) {
    // Fresh, not the pump's snapshot: a report queued while an earlier request was in flight must not be wiped.
    const row = store.messages().find((x) => x.dir === 'in' && x.peer === snap.peer && x.id === snap.id);
    if (!row) return;
    const peer = store.peers()[row.peer];
    const reports = (row.reports || []).filter((x) => now() - x.at < REPORT_TTL_MS);
    if (!peer || !peer.enabled || !reports.length) {
      if ((row.reports || []).length) store.patchMessage('in', row.peer, row.id, { reports: [], reportNextAt: null });
      return false;
    }
    if ((row.reportNextAt || 0) > now()) return false;
    const rep = reports[0];
    const times = (reportTimes.get(row.peer) || []).filter((x) => now() - x < 60_000);
    if (times.length >= REPORTS_PER_MIN) { reportTimes.set(row.peer, times); return false; }
    times.push(now());
    reportTimes.set(row.peer, times);
    const wire = P.buildStatus(identity(), myFp(), peer, { id: row.id, ...rep }, now());
    const r = await request({ host: peer.host, port: peer.port, method: 'POST', path: '/team/status', body: wire.body, headers: { [SIG_HEADER]: wire.sig } });
    // Re-read: a newer report may have been queued while this one was in flight.
    // Pause on these whatever became of the row meanwhile (it may have been evicted during the request).
    if (r.status === 404) reportPause.set(row.peer, now() + REPORT_PAUSE_MS);
    else if (!r.status) reportPause.set(row.peer, now() + 60_000);
    const cur = store.messages().find((x) => x.dir === 'in' && x.peer === row.peer && x.id === row.id);
    if (!cur) return false;
    const pending = (cur.reports || []).filter((x) => now() - x.at < REPORT_TTL_MS);
    if (r.status === 200 && P.checkStatusAck(peer, myFp(), row.id, rep.seq, r.json?.ack)) {
      const left = pending.filter((x) => x.seq !== rep.seq);
      store.patchMessage('in', row.peer, row.id, { reports: left, reportNextAt: now(), reportAttempts: 0 });
      return left.length > 0;
    } else {
      // Only a SIGNED ack ends it: a status code from whatever answers at that address proves nothing. (A 404, likely
      // an older Dobius without the route, paused that teammate above; so did no answer at all.)
      const n = (cur.reportAttempts || 0) + 1;
      store.patchMessage('in', row.peer, row.id, { reports: pending, reportAttempts: n, reportNextAt: now() + REPORT_BACKOFF_MS[Math.min(n - 1, REPORT_BACKOFF_MS.length - 1)] });
      return false;
    }
  }

  // ---------- lifecycle reports (sender side) ----------

  /** POST /team/status: a teammate reports what happened to a message this Mac sent. */
  function receiveStatus(body, sig) {
    const r = P.receiveStatus({ identity: identity(), myFp: myFp(), peers: store.peers(), body, sig, now: now() });
    if (r.status !== 'ok') return { status: 403, json: { ok: false } };
    const { rep, from } = r;
    const row = store.messages().find((x) => x.dir === 'out' && x.peer === from.id && x.id === rep.id);
    // A row that is gone (or a report already applied) is still acked, so the reporter stops.
    if (row && rep.seq > (row.lastSeq || 0)) {
      const timeline = [...(Array.isArray(row.timeline) ? row.timeline : []), { state: rep.state, at: rep.at, note: rep.note, replyId: rep.replyId }].slice(-TIMELINE_MAX);
      store.patchMessage('out', from.id, rep.id, { timeline, stage: rep.state, stageAt: rep.at, stageNote: rep.note, lastSeq: rep.seq });
      changed();
    }
    return { status: 200, json: { ok: true, ack: r.ack } };
  }


  /** A person routes a held message now (Auto-route off, or it gave up waiting). */
  function routeNow(peer, id) {
    const msg = store.messages().find((x) => x.dir === 'in' && x.peer === peer && x.id === id);
    if (!msg || (msg.state !== 'held' && msg.state !== 'waiting')) return { ok: false, error: 'that message is not waiting for you' };
    if (msg.state === 'waiting') { enqueueDelivery(peer, id); return { ok: true }; }
    enqueueDelivery(peer, id, true);
    return { ok: true };
  }

  // ---------- handoff: a send asked for by a tab other than the pinned one ----------

  function pruneHandoffs() {
    // Never one being typed: its delivery still has to report a card left in the prompt.
    for (const [hid, h] of handoffs) if (h.state !== 'routing' && now() - h.at >= HANDOFF_TTL_MS) handoffs.delete(hid);
  }

  /**
   * Another tab ran `dobius-team send|reply`: check it now, then type it into the pinned orchestrator tab as a request
   * with an approve id. Nothing leaves the Mac until the orchestrator runs `dobius-team approve <hid>`.
   */
  function handoff({ cmd, arg, text, fromTab }) {
    pruneHandoffs();
    if (!store.settings().orchestratorTab) return { ok: false, error: 'no team orchestrator tab is pinned (tab menu > Use as team orchestrator)' };
    // Tabs as Claude's paste shows them (four spaces), so the card and the stored text match.
    const t = String(text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').trim();
    if (!t || t.length > P.MAX_TEXT) return { ok: false, error: `the message must be 1 to ${P.MAX_TEXT} characters` };
    // The card's sanitizer, the PTY or Claude's paste would hide or change these (control and invisible format
    // characters, broken UTF-16, Claude's own paste tags, which it escapes), and approve sends the stored text: what is
    // approved must be what is sent.
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(t) || /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cn}\p{Co}]/u.test(t) || !t.isWellFormed()
      || /<\/?pasted_content/i.test(t)) return { ok: false, error: 'the message contains control characters or broken text; send plain text' };
    let peer;
    let replyTo = null;
    if (cmd === 'reply') {
      const ref = String(arg || '').trim();
      const at = ref.indexOf('@');
      const orig = at > 0 ? store.findById(ref.slice(0, at), 'in', ref.slice(at + 1)) : null;
      if (!orig) return { ok: false, error: 'no single received message has that id@fingerprint' };
      peer = store.peers()[orig.peer];
      if (!peer) return { ok: false, error: 'that sender is no longer linked' };
      replyTo = orig.id;
    } else {
      const found = findPeer(arg);
      if (found.error) return { ok: false, error: found.error };
      peer = found.peer;
    }
    if (!peer.enabled) return { ok: false, error: `${peer.name} is disabled` };
    const open = [...handoffs.values()].filter((h) => h.state !== 'sent');
    const tab = String(fromTab || '');
    if (open.length >= MAX_HANDOFFS || open.filter((h) => h.fromTab === tab).length >= MAX_HANDOFFS_PER_TAB) {
      return { ok: false, error: 'too many requests already wait for the orchestrator; try again later' };
    }
    const hid = crypto.randomBytes(9).toString('base64url');
    handoffs.set(hid, { peer: peer.id, toName: peer.name, replyTo, text: t, fromTab: tab, at: now(), state: 'waiting', note: null });
    deliveryQueue.push({ local: hid });
    runDeliveries().catch((err) => console.error('[team] delivery queue failed:', err.message));
    return { ok: true, hid, to: peer.name };
  }

  async function deliverHandoff(hid) {
    const h = handoffs.get(hid);
    if (!h || h.state !== 'waiting') return;
    if (now() - h.at >= HANDOFF_TTL_MS) { handoffs.delete(hid); return; } // expired while queued: never typed
    const tabId = store.settings().orchestratorTab;
    h.state = 'routing';
    // Only the pin decides. An approve (or expiry) while the card is being typed must not veto its Enter: that would
    // leave a stale card in the prompt, and an incoming message needs that box empty.
    const authorized = () => {
      const s = store.settings();
      if (!s.orchestratorTab) return 'no orchestrator tab is pinned';
      if (s.orchestratorTab !== tabId) return 'the orchestrator tab changed';
      return null;
    };
    // Built at the paste: the name this Mac uses for that fingerprint THEN (a rename while the card waited must not
    // mislead the approver). The fingerprint is printed with it either way.
    let name = h.toName;
    const buildCard = () => {
      name = store.peers()[h.peer]?.name || h.toName;
      return handoffCard({ hid, fromTab: h.fromTab, toName: name, toFp: h.peer, replyTo: h.replyTo, text: h.text });
    };
    const card = buildCard();
    const deps0 = authorized() || card.error ? null : deliverDeps(tabId, authorized);
    // A teammate's message waiting behind this one goes first, as long as nothing of this card is typed yet.
    const deps = deps0 && { ...deps0, yieldTo: () => deliveryQueue.some((q) => !q.local),
      // This card starts a turn of its own in that tab: from its paste, what follows is not the last message's work.
      paste: (t, text) => { if (tracked && tracked.tabId === t) tracked = null; return deps0.paste(t, text); } };
    let result;
    if (!deps) result = { state: 'held', note: authorized() || card.error || 'delivery is not available' };
    else {
      current = `local|${hid}`;
      // Expired while it waited for the tab: built as nothing, so attempt() types nothing.
      const atPaste = () => (now() - h.at >= HANDOFF_TTL_MS ? null : buildCard().text);
      try { result = await deliver(deps, tabId, atPaste, { giveUpMs: HANDOFF_GIVE_UP_MS }); } catch (err) { result = { state: 'needs attention', note: `delivery failed: ${err.message}` }; } finally { current = null; }
    }
    if (result.state === 'yield' && h.state === 'routing') {
      h.state = 'waiting';
      // Back at the head of the local requests (behind the teammate's message), keeping its order among them.
      const firstLocal = deliveryQueue.findIndex((q) => q.local);
      deliveryQueue.splice(firstLocal < 0 ? deliveryQueue.length : firstLocal, 0, { local: hid });
      return;
    }
    if (h.state !== 'routing') {
      // Approved while it was being typed. A card left in the prompt still blocks incoming messages: say so.
      if (result.state === 'needs attention') notifyHeld(name, result.note);
      return;
    }
    if (result.state === 'routed') h.state = 'typed';
    else handoffFailed(h, result.note, result.state);
  }

  // Takes the request itself, not its id: one that expired meanwhile must still report.
  function handoffFailed(h, note, state = 'held') {
    if (!h || h.state === 'sent' || h.state === 'typed') return;
    h.state = state;
    h.note = note || null;
    notifyHeld(h.toName, h.note);
  }

  // Never throws: it runs inside the delivery queue, and a failing notification must not stop incoming deliveries.
  function notifyHeld(to, note) {
    try { notify('handoff-held', { to, note: note || null }); } catch (err) { console.error('[team] handoff notification failed:', err.message); }
  }

  /** The orchestrator approves a handed-off request: sent exactly as written, once. */
  function approveHandoff(hid) {
    pruneHandoffs();
    const h = handoffs.get(String(hid || '').trim());
    if (!h) return { ok: false, error: 'no waiting request has that id (it may have expired or Dobius+ restarted)' };
    if (h.state === 'sent') return { ok: false, error: 'that request was already sent' };
    // Its own age too: pruning spares one being typed, and that must not stretch the 24 hours.
    if (now() - h.at >= HANDOFF_TTL_MS) return { ok: false, error: 'that request expired; nothing was sent' };
    // Exactly the fingerprint it was made for: findPeer would fall back to a teammate NAMED like it once it is gone.
    if (!Object.hasOwn(store.peers(), h.peer)) return { ok: false, error: `${h.toName} is no longer linked; nothing was sent` };
    // Marked sent BEFORE queuing: if anything throws after the row is written, a retried approve must not queue it twice.
    const before = h.state;
    // The id is chosen here so a failure can be judged by THIS row's presence (a row count is fooled by eviction).
    const id = crypto.randomUUID();
    h.state = 'sent';
    let r;
    try {
      r = send(h.peer, h.text, { ...(h.replyTo ? { kind: 'reply', replyTo: h.replyTo } : {}), id });
    } catch (err) {
      // Nothing written (inbox full, disk full): it can be approved again. Written: it stays sent.
      let written = true;
      try { written = store.messages().some((m) => m.dir === 'out' && m.id === id); } catch { /* unreadable: keep it sent, never risk a second copy */ }
      if (!written) h.state = before;
      throw err;
    }
    if (!r.ok) h.state = before;
    return r;
  }

  // ---------- sending ----------

  function findPeer(ref) {
    const all = Object.values(store.peers());
    const r = String(ref || '').trim();
    if (!r) return { error: 'name a teammate' };
    const byId = all.filter((p) => p.id === r || shortFp(p.id) === r);
    // A fingerprint-shaped reference only ever means a fingerprint (a reply to an unlinked Mac must not fall through
    // to a teammate whose name happens to read the same). Otherwise your name for them first, then what their Mac
    // calls itself (a renamed teammate is still found by it); a name both ways is ambiguous.
    const fpShaped = looksLikeFingerprint(r);
    const same = (a) => typeof a === 'string' && a.normalize('NFKC').toLowerCase() === r.normalize('NFKC').toLowerCase();
    // A name that is one teammate's current name and ANOTHER's original name is ambiguous, not "the current one":
    // the person may still know the other one by it.
    const byNames = byId.length || fpShaped ? [] : all.filter((p) => same(p.name) || same(p.selfName));
    const hits = byId.length ? byId : byNames;
    if (hits.length === 1) return { peer: hits[0] };
    return { error: hits.length ? `more than one teammate is called ${r}; use the name you gave them (Settings > Team) or their fingerprint` : `no linked teammate called ${r}` };
  }

  function send(ref, text, { kind = 'ask', replyTo = null, id = null } = {}) {
    const { peer, error } = findPeer(ref);
    if (error) return { ok: false, error };
    if (!peer.enabled) return { ok: false, error: `${peer.name} is disabled` };
    const t = String(text || '').trim();
    if (!t || t.length > P.MAX_TEXT) return { ok: false, error: `the message must be 1 to ${P.MAX_TEXT} characters` };
    const at = now();
    const msg = {
      dir: 'out', id: id || crypto.randomUUID(), peer: peer.id, peerName: peer.name, kind, replyTo, text: t,
      firstSentAt: at, deadline: at + SEND_DEADLINE_MS, at, state: 'queued', attempts: 0, reached: false, nextAt: at,
    };
    store.putMessage(msg);
    schedulePump(0); // before the UI notice: a notice that throws must not leave the row unsent
    changed();
    return { ok: true, id: msg.id, short: msg.id.slice(0, 8), to: peer.name };
  }

  // `ref` is a full message id, or `<id>@<sender fingerprint>` as the card prints it (ids are unique only per sender).
  function reply(ref, text, peer = null) {
    let id = typeof ref === 'string' ? ref.trim() : '';
    let from = peer;
    const at = id.indexOf('@');
    if (at > 0) { from = id.slice(at + 1); id = id.slice(0, at); }
    const orig = store.findById(id, 'in', from);
    if (!orig) return { ok: false, error: `no single received message has the id ${ref}` };
    return send(orig.peer, text, { kind: 'reply', replyTo: orig.id });
  }

  /** Same id (a delivered copy is not routed twice), only while the receiver would still accept it. */
  function retry(id) {
    const msg = store.messages().find((x) => x.dir === 'out' && x.id === id);
    if (!msg || !['unconfirmed', 'not delivered'].includes(msg.state)) return { ok: false, error: 'that message is not waiting for a retry' };
    const limit = msg.firstSentAt + RETRY_WINDOW_MS;
    if (now() >= limit) return { ok: false, error: 'too old to retry under the same id; use Send again' };
    store.patchMessage('out', msg.peer, id, { state: 'queued', deadline: Math.min(now() + SEND_DEADLINE_MS, limit), nextAt: now(), attempts: 0 });
    changed();
    schedulePump(0);
    return { ok: true };
  }

  function sendAgain(id) {
    const msg = store.messages().find((x) => x.dir === 'out' && x.id === id);
    if (!msg) return { ok: false, error: 'no such message' };
    return send(msg.peer, msg.text, { kind: msg.kind, replyTo: msg.replyTo });
  }

  function schedulePump(ms) {
    if (stopped) return;
    if (pumpTimer) clearTimeout(pumpTimer);
    pumpTimer = setTimeout(() => { pumpTimer = null; void pump(); }, Math.max(0, ms));
    pumpTimer.unref?.();
  }

  async function pump() {
    if (pumping) { schedulePump(1000); return; }
    pumping = true;
    let retryLater = false;
    try {
      const t = now();
      for (const msg of store.messages().filter((x) => x.dir === 'out' && (x.state === 'queued' || x.state === 'sending'))) {
        if (stopped) return;
        try {
          if (t >= msg.deadline) {
            const maybe = msg.reached || msg.state === 'sending';
            store.patchMessage('out', msg.peer, msg.id, { state: maybe ? 'unconfirmed' : 'not delivered', reached: maybe });
            changed();
            continue;
          }
          if ((msg.nextAt || 0) > t) continue;
          await attemptSend(msg);
        } catch (err) {
          // A failed write (disk full) at any step: the row may still say 'sending' or be past its deadline; the
          // pump comes back for it after the back-off, and the other rows are still processed.
          console.error('[team] outbox step failed:', err.message);
          retryLater = true;
        }
      }

    } finally {
      pumping = false;
      let next = Infinity;
      try {
        const all = store.messages();
        next = all.filter((x) => x.dir === 'out' && (x.state === 'queued' || x.state === 'sending'))
          .reduce((a, x) => Math.min(a, Math.min(x.nextAt || 0, x.deadline)), Infinity);

      } catch (err) {
        console.error('[team] outbox unreadable:', err.message);
        retryLater = true;
      }
      // Writes failing: back off 30 s, never the past nextAt of the row that failed (a tight loop of failed writes).
      if (retryLater) next = now() + 30_000;
      if (next !== Infinity) schedulePump(next - now());
    }
  }

  // Status reports have their own loop: a slow or unanswered report must never hold up a message's delivery.
  let reportTimer = null;
  let reporting = false;
  function scheduleReports(ms) {
    if (stopped) return;
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = setTimeout(() => { reportTimer = null; void pumpReports(); }, Math.max(0, ms));
    reportTimer.unref?.();
  }

  async function pumpReports() {
    if (reporting) { scheduleReports(1000); return; }
    reporting = true;
    let retryLater = false;
    try {
      for (const row of store.messages().filter((x) => x.dir === 'in' && Array.isArray(x.reports) && x.reports.length)) {
        if (stopped) return;
        if ((row.reportNextAt || 0) > now()) continue;
        if ((reportPause.get(row.peer) || 0) > now()) continue;
        // One message's reports go one after another while each is acked, in order.
        try { for (let i = 0; i < P.MAX_SEQ && !stopped && (await attemptReport(row)); i += 1) { /* next report */ } } catch (err) {
          console.error('[team] status report step failed:', err.message);
          retryLater = true;
        }
      }
    } catch (err) {
      console.error('[team] status reports unreadable:', err.message);
      retryLater = true;
    } finally {
      reporting = false;
      let next = Infinity;
      try {
        for (const x of store.messages()) if (x.dir === 'in' && Array.isArray(x.reports) && x.reports.length) next = Math.min(next, x.reportNextAt || 0);
      } catch { retryLater = true; }
      if (retryLater) next = now() + 30_000;
      // Paced or paused teammates: look again in a while rather than spin.
      if (next !== Infinity) scheduleReports(Math.max(next - now(), next <= now() ? 6000 : 0));
    }
  }

  async function attemptSend(msg) {
    const peer = store.peers()[msg.peer];
    const n = (msg.attempts || 0) + 1;
    const backoff = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)];
    if (!peer || !peer.enabled) {
      // An earlier attempt may have arrived (its receipt lost): that stays "unconfirmed", never "not delivered".
      const maybe = msg.reached || msg.state === 'sending';
      store.patchMessage('out', msg.peer, msg.id, { state: maybe ? 'unconfirmed' : 'not delivered', reached: maybe, note: peer ? 'teammate disabled' : 'no longer linked' });
      changed();
      return;
    }
    store.patchMessage('out', msg.peer, msg.id, { state: 'sending', attempts: n });
    const env = { id: msg.id, kind: msg.kind, replyTo: msg.replyTo, text: msg.text, firstSentAt: msg.firstSentAt, deadline: msg.deadline };
    const wire = P.buildMessage(identity(), myFp(), peer, env, now());
    const r = await request({ host: peer.host, port: peer.port, method: 'POST', path: '/team/message', body: wire.body, headers: { [SIG_HEADER]: wire.sig } });
    // A row found still 'sending' was cut off mid-attempt (a failed write, a quit): that attempt may have arrived.
    const reached = msg.reached || msg.state === 'sending' || !!r.reached;
    if (r.status === 200 && P.checkReceipt(peer, myFp(), env, r.json?.receipt)) {
      store.patchMessage('out', msg.peer, msg.id, { state: 'delivered', reached: true, deliveredAt: now(), receipt: r.json.receipt, note: null });
      // The reply really arrived: tell the original sender its message was answered.
      if (msg.kind === 'reply' && msg.replyTo) report(msg.peer, msg.replyTo, 'replied', null, msg.id);
    } else {
      // Anything but a VERIFIED receipt is retried until the deadline, a 409 included: a status code is not signed,
      // so whatever answers at that address (a reassigned name) cannot end the retries.
      const why = r.error || (r.status === 200 ? 'the receipt did not check out' : `answer ${r.status}`);
      store.patchMessage('out', msg.peer, msg.id, { state: 'queued', reached, nextAt: now() + backoff, note: why });
    }
    changed();
  }

  // ---------- lifecycle ----------

  function start() {
    stopped = false;
    // A failed read here (the message file momentarily unreadable) is retried, so acknowledged messages waiting for
    // the tab are never left out of the delivery queue until the next restart.
    const attempt = () => {
      try { recover(); } catch (err) {
        console.error('[team] start-up recovery failed, retrying in 30s:', err.message);
        if (!stopped) setTimeout(attempt, 30_000).unref?.();
      }
    };
    attempt();
    schedulePump(0);
    scheduleReports(0);
  }

  function recover() {
    // Every stored incoming message keeps its dedupe record: a crash between writing the row and the record must not
    // let a retry of it be accepted (and routed) again once the row is gone, or acknowledge different content.
    for (const m of store.messages()) {
      if (m.dir !== 'in' || !m.hash || now() - m.at > P.RETAIN_MS) continue;
      const key = `${m.peer}|${m.id}`;
      // Per row: a failed read or write here must not stop the recovery below (deliverJob writes a missing record
      // itself before typing anything).
      try {
        if (!store.records.get(key)) store.records.set(key, { hash: m.hash, firstAcceptedAt: m.at });
      } catch (err) {
        console.error('[team] could not restore a dedupe record:', err.message);
      }
    }
    // A delivery cut short by a quit may have pasted: never repeat it blindly. Each row on its own: a failed write
    // here must never stop the app from starting (the pump treats a leftover 'sending' row as maybe-arrived anyway).
    for (const m of store.messages()) {
      try {
        // Not the delivery typing right now (a retried recovery runs while the app is live).
        // Nor one whose real result is still waiting to be written (it would be overwritten with a false "quit").
        if (m.dir === 'in' && m.state === 'routing' && current !== `${m.peer}|${m.id}` && !pendingResults.has(`${m.peer}|${m.id}`)) {
          saveResult(m.peer, m.id, { state: 'needs attention', note: 'Dobius quit while this was being typed; check the orchestrator tab' });
          report(m.peer, m.id, 'needs attention', 'their Dobius quit while it was being typed; someone has to check their orchestrator tab');
        }
        if (m.dir === 'in' && m.state === 'waiting') enqueueDelivery(m.peer, m.id);
        if (m.dir === 'out' && m.state === 'sending') store.patchMessage('out', m.peer, m.id, { state: 'queued', reached: true });
      } catch (err) {
        console.error('[team] start-up recovery step failed:', err.message);
      }
    }
  }

  function stop() {
    stopped = true;
    if (pumpTimer) clearTimeout(pumpTimer);
    pumpTimer = null;
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = null;
  }

  /** The orchestrator was (re)pinned: messages waiting only for a tab can go now. */
  function settingsChanged() {
    const s = store.settings();
    if (!s.orchestratorTab || !s.accept) return;
    const peers = store.peers();
    for (const m of store.messages()) {
      if (m.dir === 'in' && m.state === 'held' && m.note === 'no orchestrator tab is pinned' && peers[m.peer]?.autoRoute) {
        store.patchMessage('in', m.peer, m.id, { state: 'waiting', note: null });
        enqueueDelivery(m.peer, m.id);
      }
    }
  }

  /** What the UI lists: everything a person has to act on, plus the newest 200 (actionable ones never fall off). */
  function messagesForUi() {
    const all = store.messages();
    const act = new Set(['held', 'needs attention', 'unconfirmed', 'not delivered', 'waiting', 'routing', 'queued', 'sending']);
    const recent = new Set(all.slice(-200));
    // Rows show the teammate's CURRENT name (a rename after the row was written must not leave a stale label).
    const current = store.peers(); // read once for the whole list
    return all.filter((m) => recent.has(m) || act.has(m.state))
      .map((m) => { const n = m.peer && Object.hasOwn(current, m.peer) ? current[m.peer].name : m.peerName; return n !== m.peerName ? { ...m, peerName: n } : m; });
  }

  return {
    unlink, dismiss, messagesForUi,
    status, createInvite, hello, link, decideLink, join, receive, routeNow,
    findPeer, send, reply, retry, sendAgain, start, stop, settingsChanged, pump,
    handoff, approveHandoff, receiveStatus, tabEvent, markIncoming, pumpReports, following, followedPid,
    SIG_HEADER,
  };
}
