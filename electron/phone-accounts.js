// The phone's Accounts list (Settings > Claude account), shaped from what main already computes: headroom.usage()
// (account-headroom-service.js, the Mac's Account usage panel) and the Codex identities (main codexAccountIdentities).
//
// ARRAYS only, every field copied one by one: account ids are user-influenced (an id of __proto__ must never become an
// object key, NOTES 2026-09-09) and window names come from Claude's statusLine records. Pure; tested in
// electron/__tests__/phone-accounts.test.mjs.

const short = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const LOGIN = new Set(['in', 'out', 'unknown']);
const loginOf = (v) => (LOGIN.has(v) ? v : 'unknown');
const num = (v) => (Number.isFinite(v) ? v : null);

export function usageForPhone(u) {
  if (!u || typeof u !== 'object') return { known: false, headroom: null, limited: false, ageMs: null, windows: [] };
  const src = u.windows && typeof u.windows === 'object' ? u.windows : {};
  const windows = Object.keys(src).filter((n) => /^[a-z_]{1,32}$/.test(n)).map((name) => {
    const w = src[name];
    return { name, used: num(w?.used), resetsAt: num(w?.resetsAt), ageMs: num(w?.ageMs) };
  });
  return { known: !!u.known, headroom: num(u.headroom), limited: !!u.limited, ageMs: num(u.ageMs), windows };
}

/**
 * usage: headroom.usage() result or null. accounts: config.accounts. activeClaude / activeCodex: the active ids (null:
 * the Mac's default login). codexIds: { default, accounts: [{ id, email, plan, login }] } aligned with the codex accounts.
 */
export function shapePhoneAccounts({ usage, accounts, activeClaude = null, activeCodex = null, codexIds = {} }) {
  const list = Array.isArray(accounts) ? accounts.filter((a) => a && typeof a === 'object') : [];
  const rows = usage?.ok && Array.isArray(usage.accounts)
    ? usage.accounts.filter((r) => r && typeof r === 'object')
    : [{ id: null, label: 'Default', isDefault: true }, ...list.filter((a) => a.type === 'claude').map((a) => ({ id: a.id, label: a.name || a.id, login: 'unknown' }))];
  const claude = rows.map((r) => ({
    id: r.isDefault ? null : short(r.id, 200),
    label: short(r.label, 60) || 'Account',
    email: short(r.email, 120),
    isDefault: !!r.isDefault,
    login: loginOf(r.login),
    active: r.isDefault ? activeClaude === null : typeof r.id === 'string' && r.id === activeClaude,
    usage: usageForPhone(r.usage),
    stale: !!r.stale,
    sessionsRunning: Number.isInteger(r.sessionsRunning) ? r.sessionsRunning : null,
  }));
  const codexAccounts = list.filter((a) => a.type === 'codex');
  const idRows = Array.isArray(codexIds?.accounts) ? codexIds.accounts : [];
  const codex = [
    { id: null, label: 'Default', isDefault: true, email: short(codexIds?.default?.email, 120), plan: short(codexIds?.default?.plan, 40), login: loginOf(codexIds?.default?.login), active: activeCodex === null },
    // Matched by position, then checked by id: the identities come back aligned with the codex accounts.
    ...idRows.map((row, i) => ({
      id: short(row?.id, 200),
      label: short(codexAccounts[i]?.id === row?.id ? codexAccounts[i].name : null, 60) || short(row?.id, 60) || 'Account',
      isDefault: false,
      email: short(row?.email, 120),
      plan: short(row?.plan, 40),
      login: loginOf(row?.login),
      active: typeof row?.id === 'string' && row.id === activeCodex,
    })),
  ];
  return { claude, codex, scanFailed: !!usage?.scanFailed };
}
