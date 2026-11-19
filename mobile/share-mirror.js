// The share sheet's copy of the paired Macs (docs/phone-share.md). The iOS Share Extension runs in its own sandbox and
// cannot read this app's storage, so every change to the pairing document is handed to the in-app DobiusShare plugin,
// which writes it to a Keychain item only Dobius+ and its extension can read. Native app only; a no-op in a browser.
import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from './native-push.js';

const DobiusShare = registerPlugin('DobiusShare');

/** Pure: what the extension gets. Only what it needs to reach each Mac; never drafts, pins or UI state. */
export function shareRecords(state) {
  const pairings = (state?.pairings || []).map((p) => ({ id: p.id, name: p.name, origin: p.origin, token: p.token }));
  return { pairings, activeId: pairings.some((p) => p.id === state?.activeId) ? state.activeId : null };
}

/** Pure: `next` minus anything it adds over `base`, so a removal can be mirrored before it is saved. */
export function withoutAdditions(base, next) {
  const keep = new Set((base?.pairings || []).map((p) => p.id));
  const pairings = (next?.pairings || []).filter((p) => keep.has(p.id) && (base.pairings.find((b) => b.id === p.id)?.token === p.token));
  return { ...next, pairings, activeId: pairings.some((p) => p.id === next?.activeId) ? next.activeId : null };
}

let last = null; // the JSON last written, so an unchanged document is not written again
let chain = Promise.resolve();

/** Writes the document for the extension. Resolves true when written (or unchanged), false when it could not be. */
export function mirrorPairings(state) {
  if (!isNativeApp()) return Promise.resolve(true);
  const rec = shareRecords(state);
  const sig = JSON.stringify(rec);
  const run = chain.then(async () => {
    if (sig === last) return true;
    try {
      await DobiusShare.setPairings(rec);
      last = sig;
      return true;
    } catch (err) {
      console.warn('[dobius] share sheet could not save the paired Macs:', err?.message || err);
      return false;
    }
  });
  chain = run.then(() => undefined);
  return run;
}
