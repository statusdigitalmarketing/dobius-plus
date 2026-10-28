import { HOST_KEY, TOKEN_KEY, normaliseHost } from './host.js';

export const PAIRINGS_KEY = 'dobius-mobile-pairings-v1';
export const emptyPairings = () => ({ version: 1, pairings: [], activeId: null });
export const activePairing = (state) => state.pairings.find((p) => p.id === state.activeId) || null;
export const pairingKey = (pairing, key) => `${key}:${pairing.id}`;

export function upsertPairing(state, { origin, token, name }, { id, now }) {
  origin = normaliseHost(origin);
  if (!origin || typeof token !== 'string' || !token) throw new Error('Invalid pairing');
  const existing = state.pairings.find((p) => p.origin === origin);
  const record = existing
    ? { ...existing, token, lastUsedAt: now }
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

// One document is the commit point. Legacy keys remain intact for interrupted
// migration; an existing document (even an empty list) always wins.
export async function loadPairings(storage, pageOrigin, now = Date.now()) {
  const raw = await storage.get(PAIRINGS_KEY);
  if (raw !== null) return parseState(raw);
  const [host, token] = await Promise.all([storage.get(HOST_KEY), storage.get(TOKEN_KEY)]);
  const origin = normaliseHost(host || (/^https?:\/\//.test(pageOrigin) ? pageOrigin : ''));
  let state = emptyPairings();
  if (origin && token) state = upsertPairing(state, { origin, token }, { id: 'legacy', now });
  await savePairings(storage, state);
  return state;
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
