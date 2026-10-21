// Pure logic for the command palette: matching, ranking, the submenu view
// stack, and shortcut formatting. No React here so it can be unit-tested
// under plain node (electron/__tests__/command-palette.test.mjs).

export function normalizeSearch(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Rank one field: 3 exact, 2 prefix, 1 substring, 0 when only the tokens are
// all present but scattered, -Infinity when a token is missing.
function rankField(field, query, tokens) {
  const f = normalizeSearch(field);
  if (!f || !tokens.every((t) => f.includes(t))) return -Infinity;
  if (f === query) return 3;
  if (f.startsWith(query)) return 2;
  if (f.includes(query)) return 1;
  return 0;
}

// searchTerms[0] is the title, later entries are synonyms. A hit on an earlier
// term outranks a hit on a later one, so "theme" ranks "Change theme" (title)
// above a tab whose path merely contains "theme".
export function rankItem(item, query, tokens) {
  const terms = (item.searchTerms || []).filter(Boolean);
  for (let i = 0; i < terms.length; i++) {
    const r = rankField(terms[i], query, tokens);
    if (r !== -Infinity) return 1000 - i * 100 + r;
  }
  return 0;
}

// groups: [{ id, label, items, searchOnly? }]. With an empty query, groups
// marked searchOnly are hidden so the root list stays short. A leading ">"
// restricts results to the "actions" group, like VS Code.
export function filterGroups(groups, rawQuery) {
  const actionsOnly = rawQuery.startsWith('>');
  const query = normalizeSearch(actionsOnly ? rawQuery.slice(1) : rawQuery);
  const base = groups.filter((g) => (actionsOnly ? g.id === 'actions' : true));
  if (!query) return base.filter((g) => !g.searchOnly && g.items.length > 0);
  const tokens = query.split(' ');
  const out = [];
  for (const g of base) {
    const scored = [];
    g.items.forEach((item, index) => {
      const hay = normalizeSearch((item.searchTerms || []).join(' '));
      if (!tokens.every((t) => hay.includes(t))) return;
      scored.push({ item, index, rank: rankItem(item, query, tokens) });
    });
    if (!scored.length) continue;
    scored.sort((a, b) => b.rank - a.rank || a.index - b.index);
    out.push({ ...g, items: scored.map((s) => s.item) });
  }
  return out;
}

// Selectable items in display order, for arrow-key navigation.
export function flattenItems(groups) {
  return groups.flatMap((g) => g.items.filter((i) => !i.disabled));
}

// Submenu drill-in. Pushing a view remembers the parent's query so Back
// restores exactly what the user had typed.
export function initialSearchState() {
  return { query: '', views: [] };
}

export function reduceSearchState(state, action) {
  switch (action.type) {
    case 'query':
      return { ...state, query: action.query };
    case 'push':
      return { query: '', views: [...state.views, { view: action.view, parentQuery: state.query }] };
    case 'back': {
      const top = state.views[state.views.length - 1];
      return top ? { query: top.parentQuery, views: state.views.slice(0, -1) } : state;
    }
    case 'reset':
      return initialSearchState();
    default:
      return state;
  }
}

const KEY_SYMBOLS = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '↵' };

// "mod+shift+t" -> ["⌘", "⇧", "T"]
export function formatShortcut(combo) {
  if (!combo) return [];
  return combo.split('+').map((k) => KEY_SYMBOLS[k] || (k.length === 1 ? k.toUpperCase() : k));
}

// Relative luminance check so themes get a "light"/"dark" synonym without
// adding a field to every theme definition.
export function isLightColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}
