import { useState, useEffect, useRef } from 'react';

const badge = (color, bg) => ({
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 4,
  color,
  backgroundColor: bg,
  whiteSpace: 'nowrap',
});

/**
 * The login behind the name. This row exists because the list used to show
 * only a name someone typed, so two entries over ONE Claude account looked
 * like a Switch that did nothing, and an account with no credential looked
 * identical to a working one.
 */
function IdentityLine({ ident }) {
  if (!ident) return null;
  const { email, login, sameAs = [] } = ident;
  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-1">
      {email ? (
        <span className="text-xs" style={{ color: 'var(--fg)', fontFamily: 'monospace', opacity: 0.8 }}>
          {email}
        </span>
      ) : (
        // No readable address is not the same claim as no login. A profile
        // whose directory was deleted while its credential survives still has
        // a working login, and saying "never logged in here" there asserts a
        // history we do not know (Codex P2). Say only what was observed.
        <span className="text-xs" style={{ color: 'var(--dim)' }}>
          {login === 'in' ? 'signed in, address unreadable' : 'no login found'}
        </span>
      )}
      {login === 'out' && (
        <span style={badge('#f87171', 'rgba(248,113,113,0.15)')}>no credential</span>
      )}
      {login === 'unknown' && (
        <span style={badge('var(--dim)', 'rgba(148,163,184,0.15)')}>login unverified</span>
      )}
      {sameAs.length > 0 && (
        <span style={badge('#fbbf24', 'rgba(251,191,36,0.15)')}>
          same login as {sameAs.join(', ')}
        </span>
      )}
    </div>
  );
}

export default function AccountsSection() {
  const [accounts, setAccounts] = useState([]);
  const [activeClaudeId, setActiveClaudeId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', type: 'claude', apiKey: '', cliPath: '' });
  const [feedback, setFeedback] = useState('');
  const [activating, setActivating] = useState(null);
  const [identities, setIdentities] = useState(null);

  // A refresh that started BEFORE a Switch must never land after it. The
  // identity probes make a reload slow enough to lose that race, and the older
  // answer put the previous account's "active" badge back while new terminals
  // ran as the new one: the same "Switch did nothing" illusion this whole
  // panel exists to end (Codex P2). Newest read wins; older ones are dropped.
  const reqSeq = useRef(0);
  const mounted = useRef(true);

  const reload = async () => {
    const seq = ++reqSeq.current;
    const [list, activeId, idents] = await Promise.all([
      window.electronAPI.accountsList(),
      window.electronAPI.accountsGetActiveClaude(),
      // Optional-called so a renderer running against an older preload (app
      // updated but window not reloaded) still shows the list instead of
      // throwing on a bridge method that is not there yet.
      window.electronAPI.accountsIdentities?.() ?? Promise.resolve(null),
    ]);
    if (!mounted.current || seq !== reqSeq.current) return;
    setAccounts(list || []);
    setActiveClaudeId(activeId);
    setIdentities(idents || null);
  };

  useEffect(() => {
    reload();
    // Logging in happens in a TERMINAL, not in this panel, so the moment the
    // user does the thing the "no credential" badge told them to do, the badge
    // is wrong. Re-read whenever the window comes back to the front, otherwise
    // the warning outlives the problem it describes (Codex P2).
    const refresh = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  // identities.accounts is aligned 1:1 with `accounts`, so rows are read BY
  // POSITION. Account ids are user-supplied: a map keyed by them let an id of
  // __proto__ or __default__ corrupt the result, and a repeated id showed one
  // account's login against another. The id check is a belt-and-braces guard
  // in case the two lists were ever fetched a moment apart; on a mismatch the
  // row shows nothing rather than somebody else's address.
  const identAt = (index, acct) => {
    const row = identities?.accounts?.[index];
    if (!row) return null;
    return row.id === acct.id ? row : null;
  };

  const flash = (msg, isError = false) => {
    setFeedback({ msg, isError });
    setTimeout(() => setFeedback(''), 3000);
  };

  const handleActivate = async (acct) => {
    setActivating(acct.id);
    const result = await window.electronAPI.accountsActivateClaude(acct.id);
    setActivating(null);
    if (result.ok) {
      setActiveClaudeId(acct.id);
      reload();
      flash(`Switched. NEW terminals everywhere now run as "${acct.name}" (open tabs keep their old account). First time in this account: run claude auth login once in a new tab, it sticks.`);
    } else {
      flash(`Failed to switch: ${result.error}`, true);
    }
  };

  // Back to the Mac's default ~/.claude identity (full settings/skills/hooks).
  const handleUseDefault = async () => {
    setActivating('__default__');
    const result = await window.electronAPI.accountsActivateClaude(null);
    setActivating(null);
    if (result?.ok) {
      setActiveClaudeId(null);
      reload(); // invalidates any refresh started before this switch
      flash('Back to the default account. New terminals use this Mac\u2019s normal ~/.claude login and setup.');
    } else {
      flash(`Failed to switch: ${result?.error || 'unknown'}`, true);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) return flash('Name is required.', true);
    if (form.type === 'codex' && !form.apiKey.trim()) return flash('OpenAI API key is required.', true);

    const payload = {
      ...(editing ? { id: editing.id } : {}),
      name: form.name.trim(),
      type: form.type,
      ...(form.type === 'codex' ? { apiKey: form.apiKey.trim() } : {}),
      ...(form.type === 'claude' && editing?.claudeJsonPath ? { claudeJsonPath: editing.claudeJsonPath } : {}),
      ...(form.type === 'claude' && form.cliPath.trim() ? { cliPath: form.cliPath.trim() } : {}),
    };

    if (form.type === 'claude' && !editing) {
      const id = `acct-${Date.now()}`;
      payload.id = id;
      // v1.0.65: a NEW account gets an EMPTY config dir (its own identity,
      // bound by the first `claude auth login` run in it). The old flow
      // copied the CURRENT ~/.claude.json in, which seeded the new account
      // with the old identity (Codex High). Main constrains the destination
      // to ~/.claude-profiles/ and only honors the basename. PR#3 r3 P2.
      const result = await window.electronAPI.accountsInitProfileDir(`${id}.json`);
      if (!result.ok) {
        flash(`Could not create the account profile: ${result.error}`, true);
        return;
      }
      payload.claudeJsonPath = result.path;
    }

    await window.electronAPI.accountsSave(payload);
    await reload();
    setShowForm(false);
    flash(editing ? 'Account updated.' : 'Account saved. Switch to it, open a new terminal, and run claude auth login once there to bind its login.');
  };

  const handleDelete = async (id) => {
    await window.electronAPI.accountsDelete(id);
    await reload();
    flash('Account removed.');
  };

  const inp = {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    color: 'var(--fg)',
    borderRadius: '6px',
    padding: '6px 10px',
    fontSize: '13px',
    outline: 'none',
    width: '100%',
  };

  const btn = (variant = 'default', extra = {}) => ({
    padding: '5px 12px',
    borderRadius: '6px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    backgroundColor: variant === 'primary' ? 'var(--accent)' : 'var(--surface)',
    color: variant === 'primary' ? '#fff' : 'var(--fg)',
    border: variant === 'primary' ? '1px solid var(--accent)' : '1px solid var(--border)',
    ...extra,
  });

  return (
    <div>
      <div
        className="text-xs font-medium uppercase tracking-wider mb-3 pb-1"
        style={{ color: 'var(--dim)', borderBottom: '1px solid var(--border)', letterSpacing: '0.08em' }}
      >
        Accounts
      </div>

      {accounts.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2 rounded-lg mb-2" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="min-w-0">
            <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
              Default (this Mac&rsquo;s ~/.claude){activeClaudeId === null ? ' · active' : ''}
            </div>
            <IdentityLine ident={identities?.default} />
            <div className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
              Your main login with all your settings, skills, and hooks. Switching applies to NEW terminals in every project; a project with an assigned account keeps its assignment.
            </div>
          </div>
          {activeClaudeId !== null && (
            <button
              style={btn('primary', { padding: '4px 10px', fontSize: 11, flexShrink: 0, marginLeft: 10 })}
              disabled={activating === '__default__'}
              onClick={handleUseDefault}
            >
              {activating === '__default__' ? 'Switching…' : 'Switch'}
            </button>
          )}
        </div>
      )}

      {accounts.length === 0 && !showForm && (
        <p className="text-xs mb-3" style={{ color: 'var(--dim)' }}>
          No accounts saved yet. Add an account, switch to it, open a new terminal, and run <code style={{ fontFamily: 'monospace' }}>claude auth login</code> once there: each account keeps its own login from then on.
        </p>
      )}

      <div className="space-y-2 mb-3">
        {accounts.map((acct, index) => {
          const isActive = acct.type === 'claude' && acct.id === activeClaudeId;
          return (
            <div
              key={acct.id}
              className="flex items-center justify-between px-3 py-2.5 rounded-lg"
              style={{
                backgroundColor: 'var(--surface)',
                border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                {acct.type === 'claude' && (
                  <span style={{ fontSize: 10, color: isActive ? 'var(--accent)' : 'var(--dim)' }}>
                    {isActive ? '●' : '○'}
                  </span>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium" style={{ color: 'var(--fg)' }}>{acct.name}</span>
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: acct.type === 'claude' ? 'rgba(139,92,246,0.15)' : 'rgba(16,185,129,0.15)',
                        color: acct.type === 'claude' ? '#a78bfa' : '#34d399',
                      }}
                    >
                      {acct.type === 'claude' ? 'Claude' : 'Codex'}
                    </span>
                    {isActive && (
                      <span className="text-xs" style={{ color: 'var(--accent)' }}>active</span>
                    )}
                  </div>
                  {acct.type === 'claude' && <IdentityLine ident={identAt(index, acct)} />}
                  {acct.type === 'codex' && acct.apiKey && (
                    <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontFamily: 'monospace' }}>
                      {acct.apiKey.slice(0, 8)}…
                    </div>
                  )}
                  {acct.type === 'claude' && acct.cliPath && (
                    <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontFamily: 'monospace' }}>
                      {acct.cliPath.length > 40 ? `…${acct.cliPath.slice(-37)}` : acct.cliPath}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-1.5 shrink-0">
                {acct.type === 'claude' && !isActive && (
                  <button
                    style={btn('primary', { padding: '4px 10px', fontSize: 11 })}
                    disabled={activating === acct.id}
                    onClick={() => handleActivate(acct)}
                  >
                    {activating === acct.id ? 'Switching…' : 'Switch'}
                  </button>
                )}
                <button style={btn()} onClick={() => { setEditing(acct); setForm({ name: acct.name, type: acct.type, apiKey: acct.apiKey || '', cliPath: acct.cliPath || '' }); setShowForm(true); }}>
                  Edit
                </button>
                <button
                  style={btn('default', { color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' })}
                  onClick={() => handleDelete(acct.id)}
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {!showForm && (
        <button style={btn('primary')} onClick={() => { setEditing(null); setForm({ name: '', type: 'claude', apiKey: '', cliPath: '' }); setShowForm(true); }}>
          + Add Account
        </button>
      )}

      {showForm && (
        <div
          className="p-3 rounded-lg space-y-3 mt-2"
          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <div className="text-xs font-medium" style={{ color: 'var(--fg)' }}>
            {editing ? 'Edit Account' : 'Add Account'}
          </div>
          <div className="space-y-2">
            <input
              style={inp}
              placeholder="Account name (e.g. Personal Claude)"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <select
              style={{ ...inp, appearance: 'none' }}
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
              disabled={!!editing}
            >
              <option value="claude">Claude (Anthropic)</option>
              <option value="codex">Codex / OpenAI</option>
            </select>
            {form.type === 'codex' && (
              <input
                style={inp}
                type="password"
                placeholder="OpenAI API key (sk-…)"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              />
            )}
            {form.type === 'claude' && !editing && (
              <div className="text-xs p-2 rounded" style={{ backgroundColor: 'rgba(139,92,246,0.08)', color: 'var(--dim)', border: '1px solid rgba(139,92,246,0.2)' }}>
                Name the account and Save. It starts logged out with its own private config: switch to it, open a new terminal, run <code style={{ fontFamily: 'monospace' }}>claude auth login</code> once there, and the login sticks to this account.
              </div>
            )}
            {form.type === 'claude' && (
              <div>
                <div className="text-xs mb-1" style={{ color: 'var(--dim)' }}>
                  CLI path <span style={{ opacity: 0.6 }}>(optional : leave blank to use the default <code style={{ fontFamily: 'monospace' }}>claude</code> on PATH)</span>
                </div>
                <input
                  style={inp}
                  placeholder="e.g. /opt/homebrew/bin/claude or ~/.nvm/versions/.../claude"
                  value={form.cliPath}
                  onChange={(e) => setForm((f) => ({ ...f, cliPath: e.target.value }))}
                />
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button style={btn('primary')} onClick={handleSave}>Save</button>
            <button style={btn()} onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {feedback && (
        <p className="text-xs mt-2" style={{ color: feedback.isError ? '#f87171' : 'var(--dim)' }}>
          {feedback.msg}
        </p>
      )}

      <p className="text-xs mt-3" style={{ color: 'var(--dim)' }}>
        <strong>To add a second Claude account:</strong> run <code style={{ fontFamily: 'monospace' }}>claude auth logout</code> in a terminal, log into the other account, then come back and click Add Account.
      </p>
    </div>
  );
}
