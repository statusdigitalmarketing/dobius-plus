// The Fireflies API key, set in Settings > Integrations beside the Asana PAT.
// Every terminal Dobius opens gets it as FIREFLIES_API_KEY (createTerminal), so
// Claude and Codex sessions can read call transcripts (the fireflies-todo skill)
// on any account profile, without editing a shell or settings file.
//
// Stored ONLY encrypted, with Electron safeStorage (this app's own Keychain
// key), never in plain text, and never sent back to the renderer: the page
// learns only whether a key is set and its last four characters.
// By design anything running in a Dobius terminal can read it (that is what
// it is for), and so can a paired phone, which has full terminal access; a
// key printed in a terminal is kept in its saved scrollback like any other
// output. Both were accepted in review.

import { safeStorage } from 'electron';
import { loadConfig, saveConfig } from './config-manager.js';

let cache; // undefined: not read yet (or unreadable last time); null: none saved

export function firefliesKey() {
  if (cache !== undefined) return cache;
  const enc = loadConfig().secrets?.firefliesKey;
  if (typeof enc !== 'string' || !enc) { cache = null; return null; }
  try {
    cache = safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (err) {
    // Not cached, so the next terminal tries again (the Keychain may unlock).
    console.warn('[fireflies-key] the saved key could not be decrypted, set it again in Settings:', err?.message);
    return null;
  }
  return cache;
}

// { set, hint, unreadable }: unreadable means a key is saved but cannot be
// decrypted on this Mac now, so Settings offers Replace and Remove.
export function firefliesKeyStatus() {
  const k = firefliesKey();
  if (k) return { set: true, hint: k.slice(-4), unreadable: false };
  const saved = !!loadConfig().secrets?.firefliesKey;
  return { set: false, hint: null, unreadable: saved };
}

// An empty value removes the key. Returns { ok, set, hint } or { ok:false, error }.
export function setFirefliesKey(raw) {
  const key = typeof raw === 'string' ? raw.trim() : '';
  const config = loadConfig();
  if (!key) {
    if (config.secrets?.firefliesKey) {
      config.secrets = { ...config.secrets };
      delete config.secrets.firefliesKey;
      saveConfig(config);
    }
    cache = null;
    return { ok: true, ...firefliesKeyStatus() };
  }
  if (key.length < 16 || key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key)) {
    return { ok: false, error: 'That does not look like a Fireflies API key.' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'macOS encryption is not available right now, so the key was not saved.' };
  }
  let enc;
  try {
    enc = safeStorage.encryptString(key).toString('base64');
  } catch (err) {
    // No usable keychain (seen when HOME points somewhere without one).
    console.warn('[fireflies-key] encryption failed, key not saved:', err?.message);
    return { ok: false, error: 'macOS could not encrypt the key, so it was not saved.' };
  }
  config.secrets = { ...(config.secrets || {}), firefliesKey: enc };
  saveConfig(config);
  cache = key;
  return { ok: true, ...firefliesKeyStatus() };
}
