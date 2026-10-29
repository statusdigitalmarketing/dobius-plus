import { HOST_KEY, TOKEN_KEY, normaliseHost } from './host.js';

export const PAIRINGS_KEY = 'dobius-mobile-pairings-v1';
export const emptyPairings = () => ({ version: 1, pairings: [], activeId: null });
export const activePairing = (state) => state.pairings.find((p) => p.id === state.activeId) || null;
export const pairingKey = (pairing, key) => `${key}:${pairing.id}`;

/**
 * Add or update a Mac. `replaceId` names a record at ANOTHER address that was
 * proven to be this same Mac (App.jsx sameMac: it accepted this new token), so
 * that record moves to the new address and keeps its name and settings rather
 * than leaving two entries for one Mac.
 */
export function upsertPairing(state, { origin, token, name }, { id, now, replaceId = null }) {
  origin = normaliseHost(origin);
  if (!origin || typeof token !== 'string' || !token) throw new Error('Invalid pairing');
  const existing = state.pairings.find((p) => p.origin === origin)
    || (replaceId ? state.pairings.find((p) => p.id === replaceId) : null);
  const record = existing
    ? { ...existing, origin, token, lastUsedAt: now }
    : { id, origin, token, name: name?.trim() || new URL(origin).hostname, addedAt: now, lastUsedAt: now };
  if (!record.id) throw new Error('Missing pairing id');
  return {
    ...state,
    pairings: existing ? state.pairings.map((p) => p.id === existing.id ? record : p) : [...state.pairings, record],
    activeId: record.id,
  };
}

export function switchPairing(state, id, now) {
  if (!state.pairings.some((p) => p.id === id)) throw new Error('Unknown Mac');
  return { ...state, activeId: id, pairings: state.pairings.map((p) => p.id === id ? { ...p, lastUsedAt: now } : p) };
}

export function renamePairing(state, id, name) {
  name = name.trim().slice(0, 80);
  if (!name) throw new Error('Enter a name');
  return { ...state, pairings: state.pairings.map((p) => p.id === id ? { ...p, name } : p) };
}

export function removePairing(state, id) {
  const pairings = state.pairings.filter((p) => p.id !== id);
  const activeId = state.activeId === id
    ? [...pairings].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]?.id || null
    : state.activeId;
  return { ...state, pairings, activeId };
}

function parseState(raw) {
  const state = JSON.parse(raw);
  if (state?.version !== 1 || !Array.isArray(state.pairings)) throw new Error('Invalid pairings store');
  const ids = new Set();
  const origins = new Set();
  for (const p of state.pairings) {
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id)
        || typeof p.origin !== 'string' || normaliseHost(p.origin) !== p.origin || origins.has(p.origin)
        || typeof p.token !== 'string' || !p.token || typeof p.name !== 'string'
        || !Number.isFinite(p.addedAt) || !Number.isFinite(p.lastUsedAt)) throw new Error('Invalid pairing record');
    ids.add(p.id);
    origins.add(p.origin);
  }
  if (state.pairings.length ? !ids.has(state.activeId) : state.activeId !== null) throw new Error('Invalid active Mac');
  return state;
}

// Per-Mac UI state kept in window.localStorage before multi-Mac, unnamespaced.
// A migrated Mac (id 'legacy') takes them over, or an upgrade would drop the
// unsent draft, pins, collapsed groups and loose-end dismissals (Codex).
export const LEGACY_UI_KEYS = ['dobius-mobile-pins', 'dobius-mobile-expanded', 'dobius-mobile-collapsed',
  'dobius-mobile-loose-open', 'dobius-mobile-loose-dismissed', 'dobius-mobile-drafts'];
// A destination the user has written to since (a new draft while the copy
// was pending) is MERGED with the legacy value, never skipped: lists are
// unioned, maps combined with the newer value winning (Codex).
function mergeUiValue(legacy, current) {
  try {
    const a = JSON.parse(legacy);
    const b = JSON.parse(current);
    if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify([...new Set([...a, ...b])]);
    if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify({ ...a, ...b });
  } catch { /* not JSON: the newer value stands */ }
  return current;
}

// The keys still to carry over: each key is copied (or merged) ONCE, and a
// key already done is never touched again, so a draft the user sent or
// cleared after its copy cannot be resurrected by a later retry (Codex).
function migrateUiKeys(local, id, todo = LEGACY_UI_KEYS) {
  if (!local) return [];
  const left = [];
  for (const key of todo) {
    try {
      const v = local.getItem(key);
      if (v === null) continue;
      const cur = local.getItem(`${key}:${id}`);
      const next = cur === null ? v : mergeUiValue(v, cur);
      if (next !== cur) local.setItem(`${key}:${id}`, next);
      // Copied: the legacy key goes, so a retry (its pending marker failed to
      // clear) finds nothing to merge back over a sent or cleared draft (Codex).
      local.removeItem?.(key);
    } catch { left.push(key); /* full or private storage: retried on the next launch */ }
  }
  return left;
}

// One document is the commit point; an existing document (even an empty list)
// always wins. The legacy single-Mac keys are removed only AFTER the document
// is written and read back: an interruption before that retries the
// migration, and leaving them behind would let an OLDER build (a downgrade)
// act on a stale token while ignoring which Mac a notification came from
// (Codex High).
export async function loadPairings(storage, pageOrigin, now = Date.now(), local = typeof window !== 'undefined' ? window.localStorage : null) {
  const raw = await storage.get(PAIRINGS_KEY);
  if (raw !== null) {
    let state = parseState(raw);
    // A UI-state copy that failed at migration (storage full) is retried on
    // every launch until it succeeds, or the drafts would stay invisible (Codex).
    if (Array.isArray(state.uiMigrationPending)) {
      const left = migrateUiKeys(local, 'legacy', state.uiMigrationPending.filter((k) => LEGACY_UI_KEYS.includes(k)));
      if (left.length !== state.uiMigrationPending.length) {
        const { uiMigrationPending, ...rest } = state;
        void uiMigrationPending;
        state = left.length ? { ...rest, uiMigrationPending: left } : rest;
        await savePairings(storage, state).catch(() => { /* retried next launch */ });
      }
    }
    // A migration interrupted after its commit point left the legacy keys:
    // finish it. Once the document holds any Mac (or a host is still stored,
    // so there was a Mac to carry over), a leftover token is only something an
    // older build could act on. A native token with no host and nothing paired
    // yet stays for the pairing prompt.
    if (state.legacyMigrated || state.pairings.length || await storage.get(HOST_KEY) !== null) {
      await Promise.all([storage.remove(HOST_KEY), storage.remove(TOKEN_KEY)]).catch(() => { /* next launch tries again */ });
    }
    return state;
  }
  const [host, token] = await Promise.all([storage.get(HOST_KEY), storage.get(TOKEN_KEY)]);
  const origin = normaliseHost(host || (/^https?:\/\//.test(pageOrigin) ? pageOrigin : ''));
  let state = emptyPairings();
  if (origin && token) state = upsertPairing(state, { origin, token }, { id: 'legacy', now });
  // The pairing document is committed FIRST, with every UI key still to copy:
  // copying drafts first could use up the storage the document needs, and a
  // document that never saves locks the user out of a Mac they had paired
  // (Codex). The copies then run, and the list shrinks as they succeed.
  if (state.pairings.length) state = { ...state, legacyMigrated: true, uiMigrationPending: [...LEGACY_UI_KEYS] };
  await savePairings(storage, state);
  if (state.pairings.length) {
    const left = migrateUiKeys(local, 'legacy');
    const { uiMigrationPending, ...rest } = state;
    void uiMigrationPending;
    state = left.length ? { ...rest, uiMigrationPending: left } : rest;
    await savePairings(storage, state).catch(() => { /* the pending list retries next launch */ });
  }
  // A token with no host (a native install cannot guess its Mac) migrates to
  // nothing: keep it, the user is asked to pair.
  if (state.pairings.length) {
    await Promise.all([storage.remove(HOST_KEY), storage.remove(TOKEN_KEY)]).catch(() => { /* the document wins either way */ });
  }
  return state;
}

/** The saved document, or null when none exists yet. Throws when unreadable. */
export async function readPairings(storage) {
  const raw = await storage.get(PAIRINGS_KEY);
  return raw === null ? null : parseState(raw);
}

export async function savePairings(storage, state) {
  const raw = JSON.stringify(state);
  await storage.set(PAIRINGS_KEY, raw);
  if (await storage.get(PAIRINGS_KEY) !== raw) throw new Error('Could not save paired Macs');
}

// Capture both credentials before asynchronous work, never read active storage
// halfway through a request. Reject redirects so a token cannot follow a host.
export function pairingRequest(pairing, path, options = {}) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Expected a local request path');
  const url = new URL(path, pairing.origin);
  if (url.origin !== pairing.origin) throw new Error('Request changed origin');
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${pairing.token}`);
  return { url: url.href, options: { ...options, headers, credentials: 'omit', redirect: 'error' } };
}
