// A folder for display on the phone: only the Mac's own home folder becomes ~ (the Mac sends it), so /Users/Shared/x
// and another person's home stay in full and two folders never read the same (Codex phone tasks round 5). No home
// (an older Mac): the full path.
export function shortPath(p, home) {
  const s = String(p || '');
  const h = typeof home === 'string' ? home.replace(/[\\/]+$/, '') : '';
  if (!h) return s;
  if (s === h) return '~';
  return s.startsWith(h) && (s[h.length] === '/' || s[h.length] === '\\') ? `~${s.slice(h.length)}` : s;
}
