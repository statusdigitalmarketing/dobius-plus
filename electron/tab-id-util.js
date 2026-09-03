// Single source of truth for parsing a terminal tab id (v1.0.66). Multiple
// main-process modules recover a project path from a tab id; before this each
// had its own regex and they drifted when extra-window ids arrived.
//
// Ids: first window `term-<path>-<n>`; extra primary window
// `term-<path>~w-<8alnum>-<n>` (the windowKey is EXACTLY `w-` + 8 [a-z0-9]).
// We right-anchor on that fixed marker so a `~` inside a real folder name is
// never mistaken for it. Phone-spawned ids are `term-mobile-<ts>`.
//
// Returns { projectPath, windowKey, counter } or null. windowKey is null for a
// first-window (or phone) id.
export function parseTabId(id) {
  if (typeof id !== 'string') return null;
  const extra = id.match(/^term-(.+)~(w-[a-z0-9]{8})-(\d+)$/);
  if (extra) return { projectPath: extra[1], windowKey: extra[2], counter: extra[3] };
  const m = id.match(/^term-(.+)-(\d+)$/);
  if (m) return { projectPath: m[1], windowKey: null, counter: m[2] };
  return null;
}

/** Just the real project path from a tab id (drops any extra-window marker). */
export function projectPathFromTabId(id) {
  const p = parseTabId(id);
  return p ? p.projectPath : null;
}
