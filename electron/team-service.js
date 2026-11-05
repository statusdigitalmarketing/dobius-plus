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
import { deliver, deliveryCard } from './team-deliver.js';

export const SEND_DEADLINE_MS = 24 * 3600 * 1000;
export const RETRY_WINDOW_MS = P.CUTOFF_MS - 10 * 60 * 1000; // a human Retry stays inside the receiver's cutoff
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
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
    enqueueDelivery(from.id, env.id);
    return { status: 200, json: { ok: true, receipt: r.receipt } };
  }

  // ---------- delivery queue (one at a time) ----------

  function enqueueDelivery(peer, id, manual = false) {
    if (!deliveryQueue.some((q) => q.peer === peer && q.id === id)) deliveryQueue.push({ peer, id, manual });
    runDeliveries().catch((err) => console.error('[team] delivery queue failed:', err.message));
  }

  async function runDeliveries() {
    if (delivering) return;
    delivering = true;
    try {
      while (deliveryQueue.length && !stopped) {
        const job = deliveryQueue.shift();
        try {
          await deliverJob(job);
        } catch (err) {
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
      if (!msg.hash) { store.patchMessage('in', peer, id, { state: 'held', note: 'no content hash recorded; check it before routing' }); changed(); return; }
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
    if (why) { store.patchMessage('in', peer, id, { state: 'held', note: why }); changed(); return; }
    const deps = deliverDeps(tabId, authorized);
    if (!deps) { store.patchMessage('in', peer, id, { state: 'held', note: 'delivery is not available' }); changed(); return; }
    const card = deliveryCard({ fromName: msg.peerName, fromFp: peer, at: msg.at, id, text: msg.text });
    if (card.error) { store.patchMessage('in', peer, id, { state: 'held', note: card.error }); changed(); return; }
    store.patchMessage('in', peer, id, { state: 'routing', note: null });
    changed();
    let result;
    current = `${peer}|${id}`;
    try { result = await deliver(deps, tabId, card.text); } catch (err) { result = { state: 'needs attention', note: `delivery failed: ${err.message}` }; } finally { current = null; }
    saveResult(peer, id, { state: result.state, note: result.note || null, routedAt: result.state === 'routed' ? now() : undefined });
  }

  /** A person routes a held message now (Auto-route off, or it gave up waiting). */
  function routeNow(peer, id) {
    const msg = store.messages().find((x) => x.dir === 'in' && x.peer === peer && x.id === id);
    if (!msg || (msg.state !== 'held' && msg.state !== 'waiting')) return { ok: false, error: 'that message is not waiting for you' };
    if (msg.state === 'waiting') { enqueueDelivery(peer, id); return { ok: true }; }
    enqueueDelivery(peer, id, true);
    return { ok: true };
  }

  // ---------- sending ----------

  function findPeer(ref) {
    const all = Object.values(store.peers());
    const r = String(ref || '').trim();
    if (!r) return { error: 'name a teammate' };
    const byId = all.filter((p) => p.id === r || shortFp(p.id) === r);
    const hits = byId.length ? byId : all.filter((p) => p.name.toLowerCase() === r.toLowerCase());
    if (hits.length === 1) return { peer: hits[0] };
    return { error: hits.length ? `more than one teammate is called ${r}; use their fingerprint` : `no linked teammate called ${r}` };
  }

  function send(ref, text, { kind = 'ask', replyTo = null } = {}) {
    const { peer, error } = findPeer(ref);
    if (error) return { ok: false, error };
    if (!peer.enabled) return { ok: false, error: `${peer.name} is disabled` };
    const t = String(text || '').trim();
    if (!t || t.length > P.MAX_TEXT) return { ok: false, error: `the message must be 1 to ${P.MAX_TEXT} characters` };
    const at = now();
    const msg = {
      dir: 'out', id: crypto.randomUUID(), peer: peer.id, peerName: peer.name, kind, replyTo, text: t,
      firstSentAt: at, deadline: at + SEND_DEADLINE_MS, at, state: 'queued', attempts: 0, reached: false, nextAt: at,
    };
    store.putMessage(msg);
    changed();
    schedulePump(0);
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
        next = store.messages().filter((x) => x.dir === 'out' && (x.state === 'queued' || x.state === 'sending'))
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
        if (m.dir === 'in' && m.state === 'routing' && current !== `${m.peer}|${m.id}` && !pendingResults.has(`${m.peer}|${m.id}`)) saveResult(m.peer, m.id, { state: 'needs attention', note: 'Dobius quit while this was being typed; check the orchestrator tab' });
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
    return all.filter((m) => recent.has(m) || act.has(m.state));
  }

  return {
    unlink, dismiss, messagesForUi,
    status, createInvite, hello, link, decideLink, join, receive, routeNow,
    findPeer, send, reply, retry, sendAgain, start, stop, settingsChanged, pump,
    SIG_HEADER,
  };
}
