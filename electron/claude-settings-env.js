// Shared keys live in ONE place: the env block of Claude's ~/.claude/settings.json
// (every Dobius account profile links to that file). Claude sessions get them
// from there, SamKnows reads them from there (universal-search
// src/core/claude-settings-env.ts), Settings > Integrations edits them there,
// and every Dobius terminal gets them, so Codex and plain shells have them too.
//
// main.js owns the file (its reader knows the isolated-harness location) and
// registers it here at startup. While settings.json can be read, it alone
// decides; when it cannot (no reader yet, unreadable, not JSON) callers fall
// back to what they had before, so a bad read never strips a working key.

export const SHARED_KEYS = ['ASANA_PAT', 'FIREFLIES_API_KEY'];

let read = null; // () => settings object, {} when the file is absent, null when unparseable

export function setClaudeSettingsReader(fn) { read = typeof fn === 'function' ? fn : null; }

// The env block, or null when settings.json cannot be read right now.
function envBlock() {
  if (!read) return null;
  let settings;
  try { settings = read(); } catch (err) { console.warn('[claude-settings-env] read failed:', err?.message); return null; }
  if (!settings || typeof settings !== 'object') return null;
  return settings.env && typeof settings.env === 'object' ? settings.env : {};
}
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// One key, trimmed, or null (absent or unreadable).
export function claudeSettingsEnv(name) {
  if (!SHARED_KEYS.includes(name)) return null;
  return clean(envBlock()?.[name]);
}

// The shared keys for a new terminal: { NAME: value } for those set, or null
// when settings.json cannot be read (the caller then leaves inherited values).
export function sharedKeyEnv() {
  const env = envBlock();
  if (!env) return null;
  const out = {};
  for (const k of SHARED_KEYS) { const v = clean(env[k]); if (v) out[k] = v; }
  return out;
}

// The Asana token for Dobius's own Tasks sync: the shared spot decides while it
// is readable (an older Dobius-only PAT still counts until Settings saves or
// removes one, which clears it); otherwise the old order.
export function asanaToken(legacyPat) {
  const env = sharedKeyEnv();
  const legacy = clean(legacyPat);
  return env ? (env.ASANA_PAT || legacy || null) : (legacy || clean(process.env.ASANA_PAT) || null);
}

// What Settings may show: set or not, and the last four characters.
export function sharedKeyStatus(name) {
  const v = claudeSettingsEnv(name);
  return v ? { set: true, hint: v.slice(-4) } : { set: false, hint: null };
}

// A value Settings may save (empty means remove). Returns an error string or ''.
export function sharedKeyError(name, value) {
  if (!SHARED_KEYS.includes(name)) return 'Unknown key.';
  if (typeof value !== 'string') return 'Not a key.';
  const v = value.trim();
  if (!v) return '';
  if (v.length < 8 || v.length > 512 || /[\s\x00-\x1f\x7f"\\]/.test(v)) return 'That does not look like a valid key.';
  return '';
}
