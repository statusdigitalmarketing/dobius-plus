// Teammates on two different Tailscale networks (docs/team-communicator.md, "Teammates on another Tailscale
// network"). The Zee case, 2026-11-19: Join answered "could not reach ... (ENOTFOUND)" and nothing said why.
// Run: npm run test:teamsvc
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTeamStore } from '../team-store.js';
import { createTeamService } from '../team-service.js';
import { withTailnetFallback } from '../team-net.js';
import { tailnetOf, crossTailnet, peerInStatus, isNameError, crossTailnetHelp, MACHINES_URL } from '../../shared/tailnet-share.js';
import { tmpDir } from './tmp.mjs';

const box = { available: () => true, encrypt: (s) => Buffer.from(`enc:${s}`), decrypt: (b) => b.toString().slice(4) };
let clock = 1_800_000_000_000;
const now = () => clock;
const EM_DASH = String.fromCharCode(0x2014);

// Hosts on an in-memory network. `blocked` holds caller>host pairs that answer ENOTFOUND (not shared with the
// caller), with the `reach` the real fallback wrapper would add.
function net() {
  const hosts = new Map();
  const blocked = new Map();
  const calls = [];
  const requestFrom = (from) => async ({ host, method, path: p, body, headers }) => {
    calls.push({ from, host, path: p.split('?')[0] });
    if (blocked.has(`${from}>${host}`)) return { error: 'ENOTFOUND', reached: false, reach: blocked.get(`${from}>${host}`) };
    const svc = hosts.get(host);
    if (!svc) return { error: 'ECONNREFUSED', reached: false };
    const sig = headers?.['x-dobius-team-sig'] || '';
    let r;
    if (method === 'GET' && p.startsWith('/team/hello?nonce=')) r = svc.hello(p.split('=')[1]);
    else if (p === '/team/link') r = svc.link(body, sig);
    else if (p === '/team/message') r = svc.receive(body, sig);
    else if (p === '/team/status') r = svc.receiveStatus(body, sig);
    else r = { status: 404, json: null };
    return { status: r.status, json: r.json === null ? null : JSON.parse(JSON.stringify(r.json)), reached: true };
  };
  return { hosts, blocked, calls, requestFrom };
}

function install(name, host, tn) {
  const store = createTeamStore({ dir: tmpDir('dobius-xtn-'), box, now });
  store.setSettings({ name });
  const hooks = {};
  const svc = createTeamService({
    store, request: tn.requestFrom(host), endpoint: () => ({ host, port: 8420 }), deliverDeps: () => null,
    now, sleep: async (ms) => { clock += ms; hooks.onSleep?.(); },
  });
  tn.hosts.set(host, svc);
  return { store, svc, host, hooks };
}

async function linkPair(a, b) {
  const inv = a.svc.createInvite();
  b.hooks.onSleep = () => { const p = a.svc.status().pendingLinks[0]; if (p) a.svc.decideLink(p.inviteId, true); };
  try { return await b.svc.join(inv.text); } finally { b.hooks.onSleep = null; }
}

const SAM = 'sams-macbook-pro.tail6addbf.ts.net';
const ZEE = 'zee-pc.tail578ae1.ts.net';

test('tailnetOf / crossTailnet: only full MagicDNS names, case and trailing dot ignored', () => {
  assert.equal(tailnetOf(SAM), 'tail6addbf.ts.net');
  assert.equal(tailnetOf('Zee-PC.TAIL578AE1.ts.net.'), 'tail578ae1.ts.net');
  assert.equal(tailnetOf('100.64.1.2'), null);
  assert.equal(tailnetOf('zee-pc'), null);
  assert.equal(tailnetOf('a.b.tail1.ts.net'), null, 'not a machine name');
  assert.equal(crossTailnet(SAM, ZEE), true);
  assert.equal(crossTailnet(SAM, 'brett.tail6addbf.ts.net'), false);
  assert.equal(crossTailnet(SAM, '100.64.1.2'), false, 'unknown is not cross');
});

test('peerInStatus: finds a shared-in machine by its full name, prefers IPv4, reports offline', () => {
  const status = { Peer: {
    k1: { DNSName: 'zee-pc.tail578ae1.ts.net.', TailscaleIPs: ['fd7a:115c:a1e0::1', '100.90.1.2'], Online: false },
    k2: { DNSName: '', ShareeNode: true, TailscaleIPs: ['fd7a::2'] },
  } };
  assert.deepEqual(peerInStatus(status, ZEE), { found: true, online: false, ip: '100.90.1.2' });
  assert.deepEqual(peerInStatus(status, 'zee-pc'), { found: false }, 'short names never match');
  assert.deepEqual(peerInStatus(null, ZEE), { found: false });
  assert.equal(isNameError('ENOTFOUND'), true);
  assert.equal(isNameError('ECONNREFUSED'), false);
});

test('help text: both shares, the right names, the real admin page, no em dashes', () => {
  const h = crossTailnetHelp({ me: { name: 'Sam', host: SAM }, them: { name: 'Zee', host: ZEE } });
  assert.equal(h.steps.length, 2);
  assert.match(h.steps[0].heading, /Zee shares zee-pc with you/);
  assert.match(h.steps[1].heading, /You share sams-macbook-pro with Zee/);
  assert.match(h.text, /tail6addbf/);
  assert.match(h.text, /tail578ae1/);
  assert.equal(h.text.includes(MACHINES_URL), true);
  assert.equal(JSON.stringify(h).includes(EM_DASH), false);
  assert.equal(crossTailnetHelp({ me: { host: SAM }, them: { name: 'Zee', host: ZEE }, missing: 'mine' }).steps.length, 1);
});

test('fallback: an unresolvable shared-in name is retried at its Tailscale IP with the same Host', async () => {
  const seen = [];
  const inner = async (o) => { seen.push(o); return o.address ? { status: 200, json: { ok: true }, reached: true } : { error: 'ENOTFOUND', reached: false }; };
  const status = { Peer: { k: { DNSName: `${ZEE}.`, TailscaleIPs: ['100.90.1.2'], Online: true } } };
  const req = withTailnetFallback(inner, async () => status, { tailnetOf, peerInStatus, isNameError });
  const r = await req({ host: ZEE, port: 8420, method: 'GET', path: '/team/hello?nonce=x' });
  assert.equal(r.status, 200);
  assert.equal(r.viaIp, true);
  assert.equal(seen[1].address, '100.90.1.2');
  assert.equal(seen[1].host, ZEE, 'Host header and TLS name stay the MagicDNS name');
});

test('fallback: a name missing from this netmap is "not-shared"; other errors and non-MagicDNS hosts pass through', async () => {
  let statusCalls = 0;
  const statusFn = async () => { statusCalls += 1; return { Peer: {} }; };
  const deps = { tailnetOf, peerInStatus, isNameError };
  const notFound = withTailnetFallback(async () => ({ error: 'ENOTFOUND', reached: false }), statusFn, deps);
  assert.equal((await notFound({ host: ZEE, port: 8420 })).reach, 'not-shared');
  const refused = withTailnetFallback(async () => ({ error: 'ECONNREFUSED', reached: false }), statusFn, deps);
  assert.equal((await refused({ host: ZEE, port: 8420 })).reach, undefined);
  assert.equal((await notFound({ host: '100.64.1.2', port: 8420 })).reach, undefined);
  assert.equal(statusCalls, 1, 'tailscale status asked only for a MagicDNS name that did not resolve');
  const unknown = withTailnetFallback(async () => ({ error: 'ENOTFOUND' }), async () => null, deps);
  assert.deepEqual(await unknown({ host: ZEE, port: 8420 }), { error: 'ENOTFOUND' }, 'no status: the original error');
});

test('join across tailnets without a share: stops before sending anything and returns the share steps', async () => {
  const tn = net();
  const sam = install('Sam', SAM, tn);
  const zee = install('Zee', ZEE, tn);
  tn.blocked.set(`${ZEE}>${SAM}`, 'not-shared');
  const inv = sam.svc.createInvite();
  const r = await zee.svc.join(inv.text);
  assert.equal(r.ok, false);
  assert.match(r.error, /another Tailscale network \(tail6addbf\.ts\.net\)/);
  assert.match(r.error, /not been shared with you/);
  assert.equal(r.help.steps.length, 2);
  assert.equal(tn.calls.filter((c) => c.path === '/team/link').length, 0, 'nothing but the hello was attempted');
});

test('join across tailnets with only Sam shared: links, tells Zee to share back, Sam sees "not shared" right away', async () => {
  const tn = net();
  const sam = install('Sam', SAM, tn);
  const zee = install('Zee', ZEE, tn);
  tn.blocked.set(`${SAM}>${ZEE}`, 'not-shared'); // Zee has not shared his PC with Sam yet
  const r = await linkPair(sam, zee);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.help.steps.length, 1);
  assert.match(r.help.steps[0].heading, /You share zee-pc with/);
  await new Promise((res) => setImmediate(res)); // the reach check runs after Accept
  const peer = sam.svc.status().peers[0];
  assert.equal(peer.cross, true);
  assert.equal(peer.reach, 'not-shared');
  assert.match(peer.help.steps[0].heading, /shares zee-pc with you/);

  // A message from Sam waits with the reason in words, not "ENOTFOUND".
  sam.svc.send(peer.id, 'hello from Sam');
  await sam.svc.pump();
  const out = sam.store.messages().find((m) => m.dir === 'out');
  assert.equal(out.state, 'queued');
  assert.match(out.note, /not shared with you/);

  // Zee shares: Check connection clears it, and the queued message goes through.
  tn.blocked.delete(`${SAM}>${ZEE}`);
  const c = await sam.svc.checkPeer(peer.id);
  assert.equal(c.reachable, true);
  assert.equal(sam.svc.status().peers[0].reach, null);
  clock += 10 * 60_000;
  await sam.svc.pump();
  assert.equal(sam.store.messages().find((m) => m.dir === 'out').state, 'delivered');
});

test('same tailnet: no cross-tailnet help anywhere', async () => {
  const tn = net();
  const a = install('Sam', SAM, tn);
  const b = install('Brett', 'brett-air.tail6addbf.ts.net', tn);
  const r = await linkPair(a, b);
  assert.equal(r.ok, true);
  assert.equal(r.help, null);
  assert.equal(a.svc.status().peers[0].cross, false);
  assert.equal(a.svc.status().peers[0].help, null);
});

test('a teammate answering with other keys stays "different-install" until a signed answer (Codex r1)', async () => {
  const tn = net();
  const sam = install('Sam', SAM, tn);
  const zee = install('Zee', ZEE, tn);
  assert.equal((await linkPair(sam, zee)).ok, true);
  await new Promise((res) => setImmediate(res));
  const id = sam.svc.status().peers[0].id;
  // Zee reinstalls: a fresh install answers at the same name with new keys.
  install('Zee', ZEE, tn);
  const c = await sam.svc.checkPeer(id);
  assert.equal(c.reachable, false);
  assert.equal(c.problem, 'different-install');
  assert.match(c.error, /Unlink and link again/);
  sam.svc.send(id, 'are you there');
  await sam.svc.pump();
  assert.equal(sam.svc.status().peers[0].reach, 'different-install', 'their 403 does not clear it');
  tn.hosts.set(ZEE, zee.svc); // the original install is back
  assert.equal((await sam.svc.checkPeer(id)).reachable, true);
  assert.equal(sam.svc.status().peers[0].reach, null);
});

test('fallback: a missing name on OUR tailnet is "not-in-tailnet", not a sharing problem (Codex r1)', async () => {
  const deps = { tailnetOf, peerInStatus, isNameError };
  const req = withTailnetFallback(async () => ({ error: 'ENOTFOUND' }), async () => ({ MagicDNSSuffix: 'tail6addbf.ts.net', Peer: {} }), deps);
  assert.equal((await req({ host: 'brett-old.tail6addbf.ts.net', port: 8420 })).reach, 'not-in-tailnet');
  assert.equal((await req({ host: ZEE, port: 8420 })).reach, 'not-shared');
});

test('fallback: this computer logged out of Tailscale is "tailscale-off", never blamed on sharing (Codex r2)', async () => {
  const req = withTailnetFallback(async () => ({ error: 'ENOTFOUND' }), async () => ({ BackendState: 'NeedsLogin', Peer: {} }), { tailnetOf, peerInStatus, isNameError });
  assert.equal((await req({ host: ZEE, port: 8420 })).reach, 'tailscale-off');
});

test('different-install survives a timeout then a bare 403; only a signed answer clears it (Codex r2)', async () => {
  const tn = net();
  const sam = install('Sam', SAM, tn);
  const zee = install('Zee', ZEE, tn);
  assert.equal((await linkPair(sam, zee)).ok, true);
  await new Promise((res) => setImmediate(res));
  const id = sam.svc.status().peers[0].id;
  install('Zee', ZEE, tn); // reinstalled: new keys at the same name
  assert.equal((await sam.svc.checkPeer(id)).problem, 'different-install');
  tn.blocked.set(`${SAM}>${ZEE}`, undefined); // a plain network failure (no reach)
  sam.svc.send(id, 'one');
  await sam.svc.pump();
  assert.equal(sam.svc.status().peers[0].reach, 'different-install');
  tn.blocked.delete(`${SAM}>${ZEE}`);
  clock += 10 * 60_000;
  await sam.svc.pump(); // the new install answers 403
  assert.equal(sam.svc.status().peers[0].reach, 'different-install');
});
