// Terminal tab id construction, shared by the store and tests (v1.0.66).
// The FIRST window (windowKey null/'main') keeps the legacy `term-<path>-<n>`
// form byte-for-byte (zero migration). An EXTRA primary window inserts its
// windowKey as `term-<path>~<wk>-<n>` so ids stay globally unique across N
// windows of ONE project folder (Brett runs ~4). The `~` marker never appears
// in a project path, so mobile can split it back out; the id still matches
// TAB_ID_RE (`term-.+-\d+`) so session linking is unaffected.
export function makeTabId(projectPath, counter, windowKey) {
  if (!projectPath) return `term-main-${counter}`;
  if (windowKey && windowKey !== 'main') return `term-${projectPath}~${windowKey}-${counter}`;
  return `term-${projectPath}-${counter}`;
}
