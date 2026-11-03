/**
 * Team communicator storage (docs/team-communicator.md). Everything lives under one directory
 * (`<userData>/team`), each file written atomically (temp + rename):
 *
 *   identity.json  the private keys, encrypted with `box` (Electron safeStorage in the app). Never plaintext:
 *                  without secure storage there is no identity and the feature stays off.
 *   settings.json  { name, accept, orchestratorTab }
 *   peers.json     fingerprint -> { id, name, host, port, ed, x, linkedAt, autoRoute, enabled }
 *   records.json   accepted-message records for dedupe, `${from}|${id}` -> { hash, firstAcceptedAt }, 7 days
 *   messages.json  the inbox and outbox log, newest last, capped
 *
 * Invites are memory only: a restart forgets every open invite, which only means a teammate asks for a new one.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateIdentity, fingerprint } from './team-crypto.js';
import { pruneRecords, RETAIN_MS } from './team-protocol.js';

export const MAX_MESSAGES = 500;
const PEER_PER_MIN = 20;
const PEER_PER_DAY = 300;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

// Missing file: the fallback. Unreadable or corrupt: throws, so a caller never overwrites what it could not read.
function readJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  const v = JSON.parse(text);
  if (!v || typeof v !== 'object') throw new Error(`${path.basename(file)} is not an object`);
  return v;
}

const defaultName = () => os.hostname().replace(/\.local$/i, '').slice(0, 80) || 'Dobius';

/**
 * @param {{ dir: string, box: { available: () => boolean, encrypt: (s: string) => Buffer, decrypt: (b: Buffer) => string },
 *           now?: () => number }} opts
 */
export function createTeamStore({ dir, box, now = () => Date.now() }) {
  const file = (n) => path.join(dir, n);
  let identity = null;
  let records = null;
  const rate = new Map(); // peer id -> number[] (accept times, last day)

  function loadIdentity() {
    if (identity) return identity;
    if (!box.available()) throw new Error('secure storage is not available on this Mac');
    const stored = readJson(file('identity.json'), null);
    if (stored) {
      if (stored.v !== 1 || typeof stored.data !== 'string') throw new Error('identity.json has an unknown shape');
      const id = JSON.parse(box.decrypt(Buffer.from(stored.data, 'base64')));
      // The stored public keys must belong to the stored private keys' fingerprint we computed at creation.
      if (fingerprint(id.ed, id.x) !== stored.fp) throw new Error('identity.json does not match its fingerprint');
      identity = id;
      return identity;
    }
    const fresh = generateIdentity();
    writeJson(file('identity.json'), { v: 1, fp: fingerprint(fresh.ed, fresh.x), data: box.encrypt(JSON.stringify(fresh)).toString('base64') });
    identity = fresh;
    return identity;
  }

  const settings = () => ({ name: defaultName(), accept: true, orchestratorTab: null, ...readJson(file('settings.json'), {}) });
  function setSettings(patch) {
    const next = { ...settings(), ...patch };
    writeJson(file('settings.json'), next);
    return next;
  }

  const peers = () => readJson(file('peers.json'), {});
  function savePeer(peer) {
    const all = peers();
    const old = all[peer.id];
    all[peer.id] = {
      // Names are shown in terminals (dobius-team) and notifications: no control characters.
      id: peer.id, name: String(peer.name || '').replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, ' ').trim().slice(0, 80) || 'teammate', host: peer.host, port: peer.port, ed: peer.ed, x: peer.x,
      linkedAt: old?.linkedAt || now(), autoRoute: old ? old.autoRoute : true, enabled: old ? old.enabled : true,
    };
    writeJson(file('peers.json'), all);
    return all[peer.id];
  }
  function updatePeer(id, patch) {
    const all = peers();
    if (!Object.hasOwn(all, id)) return null;
    const allowed = {};
    if (typeof patch.name === 'string' && patch.name.trim()) allowed.name = patch.name.replace(/[\x00-\x1f\x7f\u0080-\u009f]/g, ' ').trim().slice(0, 80);
    if (typeof patch.autoRoute === 'boolean') allowed.autoRoute = patch.autoRoute;
    if (typeof patch.enabled === 'boolean') allowed.enabled = patch.enabled;
    all[id] = { ...all[id], ...allowed };
    writeJson(file('peers.json'), all);
    return all[id];
  }
  function removePeer(id) {
    const all = peers();
    if (!Object.hasOwn(all, id)) return false;
    delete all[id];
    writeJson(file('peers.json'), all);
    return true;
  }

  // Dedupe records: loaded once, pruned on load and on every save, written through.
  function recordMap() {
    if (!records) records = pruneRecords(readJson(file('records.json'), {}), now());
    return records;
  }
  const recordStore = {
    get: (k) => (Object.hasOwn(recordMap(), k) ? recordMap()[k] : undefined),
    // Written first, cached after: a failed write must not leave a record in memory that the disk does not have
    // (a retry would then be answered as a duplicate without the message ever being routed).
    set: (k, v) => {
      const next = pruneRecords({ ...recordMap(), [k]: v }, now());
      writeJson(file('records.json'), next);
      records = next;
    },
  };

  /** Per peer: at most 20 accepted messages a minute and 300 a day. Counts only when it allows. */
  function allow(peerId) {
    const t = now();
    const times = (rate.get(peerId) || []).filter((x) => t - x < 864e5);
    if (times.length >= PEER_PER_DAY || times.filter((x) => t - x < 60_000).length >= PEER_PER_MIN) {
      rate.set(peerId, times);
      return false;
    }
    times.push(t);
    rate.set(peerId, times);
    return true;
  }

  const messages = () => {
    const v = readJson(file('messages.json'), { list: [] });
    return Array.isArray(v.list) ? v.list : [];
  };
  // Never dropped by the cap: in flight, or waiting for a person to act.
  const KEEP = new Set(['queued', 'sending', 'waiting', 'routing', 'held', 'needs attention']);
  // `protect`: the row being written now. If the cap cannot be met without dropping it or a KEEP row, this throws
  // ('inbox full') and nothing is written: a receiver must refuse such a message, never acknowledge and drop it.
  function saveMessages(list, protect = null) {
    let out = list;
    if (out.length > MAX_MESSAGES) {
      const extra = out.length - MAX_MESSAGES;
      let dropped = 0;
      out = out.filter((m) => (dropped < extra && !KEEP.has(m.state) && m !== protect ? (dropped += 1, false) : true));
      if (out.length > MAX_MESSAGES) {
        const err = new Error('the team inbox is full of messages waiting for you');
        err.code = 'INBOX_FULL';
        throw err;
      }
    }
    writeJson(file('messages.json'), { list: out });
    return out;
  }
  // `key` = dir + peer + id: an inbound and outbound message may share an id (a reply quotes nothing), and two peers
  // may pick the same id.
  const keyOf = (m) => `${m.dir}|${m.peer}|${m.id}`;
  function putMessage(m) {
    const list = messages();
    const i = list.findIndex((x) => keyOf(x) === keyOf(m));
    if (i >= 0) list[i] = { ...list[i], ...m }; else list.push(m);
    const row = i >= 0 ? list[i] : m;
    saveMessages(list, row);
    return row;
  }
  function patchMessage(dir, peer, id, patch) {
    const list = messages();
    const i = list.findIndex((x) => x.dir === dir && x.peer === peer && x.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...patch };
    saveMessages(list);
    return list[i];
  }
  /**
   * A message by its full id (what the delivery card shows Claude) or, for a person typing, a prefix of at least 8
   * hex digits that matches exactly one. Ambiguous or unknown: null.
   */
  function findById(ref, dir = 'in') {
    const s = String(ref || '').trim().toLowerCase();
    const rows = messages().filter((m) => m.dir === dir);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return rows.find((m) => m.id === s) || null;
    const bare = s.replace(/-/g, '');
    if (!/^[0-9a-f]{8,31}$/.test(bare)) return null;
    const hits = rows.filter((m) => m.id.replace(/-/g, '').startsWith(bare));
    return hits.length === 1 ? hits[0] : null;
  }

  return {
    dir, loadIdentity, settings, setSettings, peers, savePeer, updatePeer, removePeer,
    records: recordStore, allow, messages, putMessage, patchMessage, findById,
    // exposed for tests
    _retainMs: RETAIN_MS,
  };
}
