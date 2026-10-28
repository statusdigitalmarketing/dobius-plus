// Claude's live spinner, as both chat views show it: the glyph cycle, the
// gerund ("Whirlpooling"), and the meter after it (1m 12s · ↓ 2.3k tokens).
//
// RENDERER-ONLY, like the rest of shared/: both vite builds inline it.
// Main reads the line off the terminal (selector-parser spinnerStatus) and
// sends { verb, seconds, tokens, dir }; everything here is display.

// The CLI's own animation: out through the glyphs and back.
export const SPIN_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
export const SPIN_MS = 120;

/** "8s", "1m 12s", "1h 2m": Claude's own spinner format. */
export function fmtElapsed(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "95", "2.3k", "1.2M". */
export function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * The activity object main sent, checked field by field (a newer or older
 * Mac may send something else): null when it is not usable at all.
 */
export function normalizeActivity(a) {
  if (!a || typeof a !== 'object') return null;
  const verb = typeof a.verb === 'string' ? a.verb.slice(0, 48) : '';
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    verb,
    seconds: num(a.seconds),
    tokens: num(a.tokens),
    dir: a.dir === 'up' || a.dir === 'down' ? a.dir : null,
  };
}

/**
 * Elapsed seconds right now: the last value the screen showed plus the time
 * since it arrived, so the clock ticks between polls instead of jumping.
 * Without a value from the screen, count from when the turn was first seen.
 */
export function liveSeconds(anchor, now) {
  if (!anchor) return null;
  const base = anchor.seconds ?? 0;
  return base + Math.max(0, Math.floor((now - anchor.at) / 1000));
}

/** "1m 12s · ↓ 2.3k tokens" (either half may be missing). */
export function activityMeta(seconds, activity) {
  const parts = [];
  const t = fmtElapsed(seconds);
  if (t) parts.push(t);
  if (activity?.tokens != null) parts.push(`${activity.dir === 'up' ? '↑' : '↓'} ${fmtTokens(activity.tokens)} tokens`);
  return parts.join(' · ');
}
