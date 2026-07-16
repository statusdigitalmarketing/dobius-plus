import { useState, useEffect } from 'react';

export default function AccountsSection() {
  const [accounts, setAccounts] = useState([]);
  const [activeClaudeId, setActiveClaudeId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', type: 'claude', apiKey: '', cliPath: '' });
  const [feedback, setFeedback] = useState('');
  const [activating, setActivating] = useState(null);

  const reload = async () => {
    const [list, activeId] = await Promise.all([
      window.electronAPI.accountsList(),
      window.electronAPI.accountsGetActiveClaude(),
    ]);
    setAccounts(list || []);
    setActiveClaudeId(activeId);
  };

  useEffect(() => { reload(); }, []);

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
      flash(`Switched to "${acct.name}". Restart any open Claude terminals to pick up the new account.`);
    } else {
      flash(`Failed to switch: ${result.error}`, true);
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
      const homeDir = await window.electronAPI.getHomeDirPath();
      const destPath = `${homeDir}/.claude-profiles/${id}.json`;
      payload.id = id;
      payload.claudeJsonPath = destPath;
      const result = await window.electronAPI.accountsCaptureClaudeJson(destPath);
      if (!result.ok) {
        flash(`Could not capture ~/.claude.json: ${result.error}`, true);
        return;
      }
    }

    await window.electronAPI.accountsSave(payload);
    await reload();
    setShowForm(false);
    flash(editing ? 'Account updated.' : 'Account saved — snapshot of current ~/.claude.json stored.');
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

      {accounts.length === 0 && !showForm && (
        <p className="text-xs mb-3" style={{ color: 'var(--dim)' }}>
          No accounts saved yet. Use <strong>Add Account</strong> to snapshot your current Claude login, then log into a second account and snapshot that too.
        </p>
      )}

      <div className="space-y-2 mb-3">
        {accounts.map((acct) => {
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
                Make sure you're logged into the Claude account you want to save, then click Save. Dobius will snapshot the current <code style={{ fontFamily: 'monospace' }}>~/.claude.json</code>.
              </div>
            )}
            {form.type === 'claude' && (
              <div>
                <div className="text-xs mb-1" style={{ color: 'var(--dim)' }}>
                  CLI path <span style={{ opacity: 0.6 }}>(optional — leave blank to use the default <code style={{ fontFamily: 'monospace' }}>claude</code> on PATH)</span>
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
