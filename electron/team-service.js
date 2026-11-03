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

export function createTeamService({ store, request, endpoint, deliverDeps, notify = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const invites = new Map(); // inviteId -> { secret, expiresAt, joiner, decision, conf? }
  let pumpTimer = null;
  let pumping = false;
  const deliveryQueue = [];
  let delivering = false;
  let stopped = false;

  const identity = () => store.loadIdentity();
  const myFp = () => fpOf(identity());
  const fpOf = (id) => fingerprint(id.ed, id.x);
  const me = () => {
    const ep = endpoint();
    return ep ? { name: store.settings().name, host: ep.host, port: ep.port } : null;
  };
  const changed = () => notify('changed', {});

  // ---------- status ----------

  function status() {
    let id;
    try { id = identity(); } catch (err) { return { ok: false, error: err.message }; }
    const fp = fpOf(id);
    const ep = endpoint();
    const peers = Object.values(store.peers()).map(({ ed, x, ...p }) => ({ ...p, short: shortFp(p.id) }));
    return {
      ok: true, fp, short: shortFp(fp), endpoint: ep, settings: store.settings(), peers,
      pendingLinks: [...invites.entries()].filter(([, v]) => v.decision === 'pending' && v.expiresAt > now())
        .map(([inviteId, v]) => ({ inviteId, name: v.joiner.name, short: shortFp(v.joiner.id), host: v.joiner.host })),
    };
  }

  // ---------- linking: A's side ----------

  function createInvite() {
    const m = me();
    if (!m) return { ok: false, error: 'this Mac is not reachable yet: turn on the phone server (Settings > Mobile) with Tailscale signed in' };
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
    entry.decision = accept ? 'accepted' : 'declined';
    if (accept) store.savePeer(entry.joiner);
    changed();
    return { ok: true };
  }

  // ---------- linking: B's side ----------

  async function join(inviteText) {
    const inv = P.parseInvite(inviteText);
    if (!inv) return { ok: false, error: 'that is not a Dobius team invite' };
    const m = me();
    if (!m) return { ok: false, error: 'this Mac is not reachable yet: turn on the phone server (Settings > Mobile) with Tailscale signed in' };
    if (inv.fp === myFp()) return { ok: false, error: 'that invite is from this Mac' };
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
    if (r.status === 'duplicate') return { status: 200, json: { ok: true, receipt: r.receipt } };
    if (r.status === 'conflict') return { status: 409, json: { ok: false } };
    if (r.status === 'refused') return { status: r.reason === 'rate' ? 429 : 403, json: { ok: false } };
    // New. The message is stored BEFORE its dedupe record: a failure between the two leaves a stored message and
    // no record, so the sender's retry is accepted again and finds the message already here (not routed twice).
    const { env, from } = r;
    const existing = store.messages().find((x) => x.dir === 'in' && x.peer === from.id && x.id === env.id);
    if (!existing) {
      const s = store.settings();
      const routable = from.autoRoute && s.orchestratorTab;
      store.putMessage({
        dir: 'in', id: env.id, peer: from.id, peerName: from.name, kind: env.kind, replyTo: env.replyTo || null,
        text: env.text, firstSentAt: env.firstSentAt, at: now(),
        state: routable ? 'waiting' : 'held',
        note: routable ? null : (from.autoRoute ? 'no orchestrator tab is pinned' : `Auto-route is off for ${from.name}`),
      });
    }
    store.records.set(...staged);
    if (!existing) {
      notify('message', { name: from.name, text: env.text.slice(0, 200) });
      changed();
      enqueueDelivery(from.id, env.id);
    }
    return { status: 200, json: { ok: true, receipt: r.receipt } };
  }

  // ---------- delivery queue (one at a time) ----------

  function enqueueDelivery(peer, id, manual = false) {
    if (!deliveryQueue.some((q) => q.peer === peer && q.id === id)) deliveryQueue.push({ peer, id, manual });
    void runDeliveries();
  }

  async function runDeliveries() {
    if (delivering) return;
    delivering = true;
    try {
      while (deliveryQueue.length && !stopped) {
        const { peer, id, manual } = deliveryQueue.shift();
        const msg = store.messages().find((x) => x.dir === 'in' && x.peer === peer && x.id === id);
        if (!msg || (msg.state !== 'waiting' && !(manual && msg.state === 'held'))) continue;
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
        if (why) { store.patchMessage('in', peer, id, { state: 'held', note: why }); changed(); continue; }
        const deps = deliverDeps(tabId, authorized);
        if (!deps) { store.patchMessage('in', peer, id, { state: 'held', note: 'delivery is not available' }); changed(); continue; }
        const card = deliveryCard({ fromName: msg.peerName, fromFp: peer, at: msg.at, id, text: msg.text });
        if (card.error) { store.patchMessage('in', peer, id, { state: 'held', note: card.error }); changed(); continue; }
        store.patchMessage('in', peer, id, { state: 'routing', note: null });
        changed();
        let result;
        try { result = await deliver(deps, tabId, card.text); } catch (err) { result = { state: 'needs attention', note: `delivery failed: ${err.message}` }; }
        store.patchMessage('in', peer, id, { state: result.state, note: result.note || null, routedAt: result.state === 'routed' ? now() : undefined });
        changed();
      }
    } finally {
      delivering = false;
    }
  }

  /** A person routes a held message now (Auto-route off, or it gave up waiting). */
  function routeNow(peer, id) {
    const msg = store.messages().find((x) => x.dir === 'in' && x.peer === peer && x.id === id);
    if (!msg || msg.state !== 'held') return { ok: false, error: 'that message is not waiting for you' };
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

  function reply(shortId, text) {
    const orig = store.findByShortId(shortId, 'in');
    if (!orig) return { ok: false, error: `no single received message has the id ${shortId}` };
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
    try {
      const t = now();
      for (const msg of store.messages().filter((x) => x.dir === 'out' && (x.state === 'queued' || x.state === 'sending'))) {
        if (stopped) return;
        if (t >= msg.deadline) {
          store.patchMessage('out', msg.peer, msg.id, { state: msg.reached ? 'unconfirmed' : 'not delivered' });
          changed();
          continue;
        }
        if ((msg.nextAt || 0) > t) continue;
        await attemptSend(msg);
      }
    } finally {
      pumping = false;
      const next = store.messages().filter((x) => x.dir === 'out' && x.state === 'queued')
        .reduce((a, x) => Math.min(a, Math.min(x.nextAt || 0, x.deadline)), Infinity);
      if (next !== Infinity) schedulePump(next - now());
    }
  }

  async function attemptSend(msg) {
    const peer = store.peers()[msg.peer];
    const n = (msg.attempts || 0) + 1;
    const backoff = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)];
    if (!peer || !peer.enabled) {
      store.patchMessage('out', msg.peer, msg.id, { state: 'not delivered', note: 'no longer linked' });
      changed();
      return;
    }
    store.patchMessage('out', msg.peer, msg.id, { state: 'sending', attempts: n });
    const env = { id: msg.id, kind: msg.kind, replyTo: msg.replyTo, text: msg.text, firstSentAt: msg.firstSentAt, deadline: msg.deadline };
    const wire = P.buildMessage(identity(), myFp(), peer, env, now());
    const r = await request({ host: peer.host, port: peer.port, method: 'POST', path: '/team/message', body: wire.body, headers: { [SIG_HEADER]: wire.sig } });
    const reached = msg.reached || !!r.reached;
    if (r.status === 200 && P.checkReceipt(peer, myFp(), env, r.json?.receipt)) {
      store.patchMessage('out', msg.peer, msg.id, { state: 'delivered', reached: true, deliveredAt: now(), receipt: r.json.receipt, note: null });
    } else if (r.status === 409) {
      store.patchMessage('out', msg.peer, msg.id, { state: 'conflict', reached: true, note: 'they already have a different message under this id' });
    } else {
      const why = r.error || (r.status === 200 ? 'the receipt did not check out' : `answer ${r.status}`);
      store.patchMessage('out', msg.peer, msg.id, { state: 'queued', reached, nextAt: now() + backoff, note: why });
    }
    changed();
  }

  // ---------- lifecycle ----------

  function start() {
    stopped = false;
    // A delivery cut short by a quit may have pasted: never repeat it blindly.
    for (const m of store.messages()) {
      if (m.dir === 'in' && m.state === 'routing') store.patchMessage('in', m.peer, m.id, { state: 'needs attention', note: 'Dobius quit while this was being typed; check the orchestrator tab' });
      if (m.dir === 'in' && m.state === 'waiting') enqueueDelivery(m.peer, m.id);
      if (m.dir === 'out' && m.state === 'sending') store.patchMessage('out', m.peer, m.id, { state: 'queued', reached: true });
    }
    schedulePump(0);
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

  return {
    status, createInvite, hello, link, decideLink, join, receive, routeNow,
    findPeer, send, reply, retry, sendAgain, start, stop, settingsChanged, pump,
    SIG_HEADER,
  };
}
