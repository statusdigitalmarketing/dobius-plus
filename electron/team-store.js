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

// A full fingerprint or its short form (5-5): the shapes findPeer matches before any name.
export const looksLikeFingerprint = (v) => {
  const t = String(v || '').normalize('NFKC').trim();
  return /^[A-Za-z0-9_-]{5}-[A-Za-z0-9_-]{5}$/.test(t) || /^[A-Za-z0-9_+/=-]{32,}$/.test(t);
};
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
  // One line, no control, format (bidi, zero-width) or line/paragraph separator characters, single spaces, NFC.
  // Lone surrogate halves become U+FFFD first (removing a mark between two halves must never join them into a new,
  // invisible character), then NFKC (so width variants and composed forms are what is stored, checked and compared), invisible characters
  // dropped (zero-width, U+034F and the like: two names must never differ only by something no one can see), then
  // cut, then trim: the stored name is exactly what a later lookup normalizes to.
  const cleanName = (v) => String(v || '').toWellFormed().normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim();
  const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && cleanName(a).toLowerCase() === cleanName(b).toLowerCase();
  // The name to show for a message's teammate: their CURRENT name while linked (a rename since must not leave a
  // stale label that now means someone else), else the name the row was written with.
  const nameFor = (m) => { const p = m?.peer ? peers()[m.peer] : null; return p ? p.name : m?.peerName; };
  function savePeer(peer) {
    const all = peers();
    const old = all[peer.id];
    // Names are shown in terminals (dobius-team) and notifications: no control or invisible characters.
    // A Mac that calls itself something fingerprint-shaped is shown as "teammate" (sends match fingerprints first).
    const theirName = (() => { const n = cleanName(peer.name); return n && !looksLikeFingerprint(n) ? n : 'teammate'; })();
    all[peer.id] = {
      id: peer.id, name: theirName, host: peer.host, port: peer.port, ed: peer.ed, x: peer.x,
      linkedAt: old?.linkedAt || now(), autoRoute: old ? old.autoRoute : true, enabled: old ? old.enabled : true,
    };
    // A name given on this Mac survives a re-link; what their Mac now calls itself becomes the selfName.
    if (old?.renamed && old.name) { all[peer.id].name = old.name; all[peer.id].selfName = theirName; all[peer.id].renamed = true; }
    writeJson(file('peers.json'), all);
    return all[peer.id];
  }
  function updatePeer(id, patch) {
    const all = peers();
    if (!Object.hasOwn(all, id)) return null;
    const allowed = {};
    // A rename is this Mac's own label for them (two teammates on "MacBook-Air" become "Brett" and "Max"). What their
    // Mac calls itself is kept as selfName, so `dobius-team send <that name>` still finds them, and an empty name
    // goes back to it. Current names stay unique and can never look like a fingerprint (sends match those first).
    if (typeof patch.name === 'string') {
      const clean = cleanName(patch.name);
      const selfName = cleanName(all[id].renamed ? all[id].selfName : all[id].name) || 'teammate';
      const next = clean || selfName;
      if (looksLikeFingerprint(next)) throw new Error('a name cannot look like a fingerprint');
      const taken = Object.values(all).some((p) => p.id !== id && sameName(p.name, next));
      if (taken) throw new Error(`another teammate is already called ${next}${clean ? '' : '; rename that one first'}`);
      // `renamed` marks a name given on this Mac (so a re-link keeps it); selfName is what their Mac calls itself.
      if (next !== selfName) { allowed.name = next; allowed.selfName = selfName; allowed.renamed = true; } else { allowed.name = selfName; allowed.selfName = undefined; allowed.renamed = undefined; }
    }
    if (typeof patch.autoRoute === 'boolean') allowed.autoRoute = patch.autoRoute;
    if (typeof patch.enabled === 'boolean') allowed.enabled = patch.enabled;
    all[id] = { ...all[id], ...allowed };
    if (all[id].selfName === undefined) delete all[id].selfName;
    if (all[id].renamed === undefined) delete all[id].renamed;
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

  /** Per peer: at most 20 accepted messages a minute and 300 a day. A check only: counted by countAccepted, once the
   *  message is really stored (a refused attempt, e.g. a full inbox, must not use up the quota). */
  function allow(peerId) {
    const t = now();
    const times = (rate.get(peerId) || []).filter((x) => t - x < 864e5);
    rate.set(peerId, times);
    return times.length < PEER_PER_DAY && times.filter((x) => t - x < 60_000).length < PEER_PER_MIN;
  }
  function countAccepted(peerId) {
    const times = rate.get(peerId) || [];
    times.push(now());
    rate.set(peerId, times);
  }

  const messages = () => {
    const v = readJson(file('messages.json'), { list: [] });
    return Array.isArray(v.list) ? v.list : [];
  };
  // Never dropped by the cap: in flight. Kept for a week: waiting for a person (held, needs attention) or for a
  // Retry decision (unconfirmed, not delivered; the same-id retry window is 6 days). After that, or once a person
  // dismisses it, a row can go, so a pile of old rows can never block the inbox for good.
  const IN_FLIGHT = new Set(['queued', 'sending', 'waiting', 'routing']);
  const ATTENTION = new Set(['held', 'needs attention', 'unconfirmed', 'not delivered']);
  // Also kept while it still owes its sender a status report (lifecycle; dropped by the service after 24 h).
  const keep = (m) => IN_FLIGHT.has(m.state) || (ATTENTION.has(m.state) && now() - (m.at || 0) < RETAIN_MS)
    // and the one message whose working/done is being followed right now (the service says which). Pending status
    // reports do NOT protect a row: a teammate that never acks (an older Dobius) must not fill the inbox. At the cap,
    // the oldest such rows go, and their unsent reports with them (accepted).
    || keepAlso(m);
  let keepAlso = () => false;
  function setKeepAlso(fn) { keepAlso = typeof fn === 'function' ? fn : () => false; }
  // `protect`: the row being written now. If the cap cannot be met without dropping it or a KEEP row, this throws
  // ('inbox full') and nothing is written: a receiver must refuse such a message, never acknowledge and drop it.
  function saveMessages(list, protect = null) {
    let out = list;
    if (out.length > MAX_MESSAGES) {
      const extra = out.length - MAX_MESSAGES;
      let dropped = 0;
      out = out.filter((m) => (dropped < extra && !keep(m) && m !== protect ? (dropped += 1, false) : true));
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
    const was = list[i];
    // A row a person marked done that moves on (a new state, or a new report from the teammate's Mac) is not done any
    // more, even if it later lands back where it was marked (held, routing, held: Codex round 5).
    const moved = was.archived && !Object.hasOwn(patch, 'archived')
      && ((Object.hasOwn(patch, 'state') && patch.state !== was.state) || (Object.hasOwn(patch, 'stage') && (patch.stage ?? null) !== (was.stage ?? null)));
    list[i] = { ...was, ...patch, ...(moved ? { archived: false, archivedState: null, archivedStage: null } : {}) };
    saveMessages(list);
    return list[i];
  }
  /**
   * A message by its FULL id (what its card and `dobius-team inbox` show). Ids are only unique per sender, so with
   * `peer` the match is exact, and without one an id two senders used is refused rather than guessed. No prefixes:
   * after the cap drops a row a prefix could quietly start matching another teammate's message.
   */
  function findById(ref, dir = 'in', peer = null) {
    const s = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return null;
    const hits = messages().filter((m) => m.dir === dir && m.id === s && (peer === null || m.peer === peer));
    return hits.length === 1 ? hits[0] : null;
  }

  return {
    setKeepAlso,
    dir, loadIdentity, settings, setSettings, peers, savePeer, updatePeer, removePeer, nameFor,
    records: recordStore, allow, countAccepted, messages, putMessage, patchMessage, findById,
    // exposed for tests
    _retainMs: RETAIN_MS,
  };
}
