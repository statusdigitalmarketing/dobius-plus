import { useState, useEffect, useRef } from 'react';
import SwitchRunningSessions from './SwitchRunningSessions';
import AccountUsage from './AccountUsage';

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
          {login === 'in'
            ? 'signed in, address unreadable'
            : login === 'out'
              ? 'no login found'
              // 'unknown' means the probe failed. Saying "no login found"
              // there asserts an absence we did not observe (reviewer LOW).
              : 'could not check for a login'}
        </span>
      )}
      {login === 'out' && (
        <span style={badge('#f87171', 'rgba(248,113,113,0.15)')}>no credential</span>
      )}
      {login === 'unknown' && (
        <span style={badge('var(--dim)', 'rgba(148,163,184,0.15)')}>login unverified</span>
      )}
      {sameAs.length > 0 && (
        // "recorded email", not "login": this compares the address each profile
        // has on file. A profile whose credential is missing or unverifiable
        // can record the same address without being a usable, identical login,
        // so the badge must not imply a shared quota (reviewer MEDIUM).
        <span style={badge('#fbbf24', 'rgba(251,191,36,0.15)')}>
          same recorded email as {sameAs.join(', ')}
        </span>
      )}
    </div>
  );
}

/**
 * The exact, profile-bound commands to put a login on ONE account, and the
 * warnings that make it actually land on the account you meant.
 *
 * Why this is instructions and not a button that runs it for you: a login can
 * only be created by a process running with that profile's CLAUDE_CONFIG_DIR
 * (the credential is stored in the Keychain under a name derived from the
 * config dir), so it has to happen in a terminal running as this account.
 * Driving that automatically needs contracts this panel does not own yet, so
 * for now it hands you the correct commands instead of guessing.
 */
function SignInHelp({ acct, isActive, recordedEmail, loginState, intendedEmail, setIntendedEmail, onClose, onCopied }) {
  // Both of these end up in text the user PASTES INTO A SHELL, so quote them
  // POSIX-style and strip anything that could end the line and start a second
  // command. cliPath comes from the Edit form and the address is typed here.
  const shellQuote = (v) => `'${String(v).replace(/[\r\n]+/g, ' ').replace(/'/g, "'\\''")}'`;
  // A leading tilde must stay OUTSIDE the quotes or the shell will not expand
  // it and the command fails with "no such file or directory" on a path that
  // exists (reviewer MEDIUM). Covers ~/x and ~user/x. The unquoted prefix is
  // allowed only when it is a plain tilde plus a conservative username charset,
  // so nothing with shell meaning can escape the quoting; anything else is
  // quoted whole.
  const shellPath = (v) => {
    const s = String(v).replace(/[\r\n]+/g, ' ');
    const m = /^(~[A-Za-z0-9_.-]*)\/(.*)$/.exec(s);
    if (m) return `${m[1]}/${shellQuote(m[2])}`;
    return shellQuote(s);
  };
  const bin = acct.cliPath ? shellPath(acct.cliPath) : 'claude';
  const email = (intendedEmail || '').trim();
  // --email only pre-fills the login page. It is the defence against the
  // browser approving whatever Google session is already signed in, which is
  // how two entries end up on one account.
  const loginCmd = `${bin} auth login${email ? ` --email ${shellQuote(email)}` : ''}`;
  const commands = `${bin} auth logout\n${loginCmd}`;
  const changing = !!recordedEmail && !!email && email.toLowerCase() !== recordedEmail.toLowerCase();

  return (
    <div
      className="mt-2 pt-2 text-xs"
      style={{ borderTop: '1px solid var(--border)', color: 'var(--fg)' }}
    >
      {!isActive && (
        <div className="mb-1.5" style={{ color: '#fbbf24' }}>
          Switch to this account first. The terminal has to be running as it, or you will
          log in whichever account you are currently on instead.
        </div>
      )}
      {/* This caveat applies even when the row IS the active account: a project
          with its own assigned account keeps that assignment, so a terminal
          opened there would re-authenticate THAT profile instead (reviewer
          MEDIUM). Always shown. */}
      <div className="mb-1.5" style={{ color: '#fbbf24' }}>
        Check the terminal you use is actually running as this account. A project with its
        own assigned account keeps that assignment and would be signed in instead.
      </div>
      <div className="mb-1.5" style={{ color: 'var(--dim)' }}>
        {recordedEmail
          ? <>This profile currently records <span style={{ fontFamily: 'monospace' }}>{recordedEmail}</span>. Signing out first is what forces the login page to appear again.</>
          : loginState === 'in'
            ? <>This profile has a saved login, but its address could not be read. Signing out first forces the login page to appear again.</>
            : loginState === 'out'
              ? <>This profile has no saved login yet.</>
              // 'unknown' means the check itself failed. Do not claim there is no
              // login (unobserved), and do not promise signing out is harmless:
              // if a credential IS there, logout removes it, and offline you
              // could not sign back in (reviewer MEDIUM).
              : <>Could not check whether this profile has a login. Signing out will remove one if it is there, so only run it when you are ready to sign in again.</>}
      </div>

      <label className="block mb-1" style={{ color: 'var(--dim)' }}>
        Account you intend to end up as (pre-fills the login page)
      </label>
      <input
        value={intendedEmail}
        onChange={(e) => setIntendedEmail(e.target.value)}
        placeholder="you@example.com"
        spellCheck={false}
        style={{
          backgroundColor: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--fg)',
          borderRadius: 6, padding: '4px 8px', fontSize: 12, width: '100%', outline: 'none',
          fontFamily: 'monospace', marginBottom: 6,
        }}
      />
      {changing && (
        <div className="mb-1.5" style={{ color: '#fbbf24' }}>
          Your browser may already be signed in as {recordedEmail} and approve it without asking.
          If the page does not offer {email}, sign out of Google there, or use a private window.
        </div>
      )}

      <pre
        style={{
          backgroundColor: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '6px 8px', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap',
          wordBreak: 'break-all', margin: 0,
        }}
      >{commands}</pre>

      <div className="flex gap-1.5 mt-1.5">
        <button
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
            backgroundColor: 'var(--accent)', color: '#fff', border: 'none',
          }}
          onClick={() => {
            navigator.clipboard?.writeText(commands)
              .then(() => onCopied?.())
              .catch(() => { /* clipboard unavailable; the text is on screen */ });
          }}
        >
          Copy commands
        </button>
        <button
          style={{
            padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
            backgroundColor: 'transparent', color: 'var(--dim)', border: '1px solid var(--border)',
          }}
          onClick={onClose}
        >
          Done
        </button>
      </div>
      <div className="mt-1.5" style={{ color: 'var(--dim)' }}>
        Come back here afterwards and this row will show the address it actually ended up on.
      </div>
    </div>
  );
}

export default function AccountsSection() {
  const [accounts, setAccounts] = useState([]);
  const [activeClaudeId, setActiveClaudeId] = useState(null);
  const [activeCodexId, setActiveCodexId] = useState(null);
  const [codexIdents, setCodexIdents] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', type: 'claude', authMode: 'chatgpt', apiKey: '', cliPath: '' });
  const [feedback, setFeedback] = useState('');
  const [activating, setActivating] = useState(null);
  const [identities, setIdentities] = useState(null);
  // Which row has its sign-in instructions open, and the address the user
  // INTENDS to end up as (passed to the CLI as --email so the login page is
  // pre-filled with it instead of silently taking the signed-in Google session).
  // { index, id } for the row whose sign-in helper is open. The INDEX
  // disambiguates rows that somehow share an id; the ID invalidates the helper
  // if the list shifts under it (deleting an earlier row would otherwise leave
  // the panel open on a DIFFERENT account holding the previous intended
  // address). Both must match for the helper to render.
  const [signInFor, setSignInFor] = useState(null);
  const [intendedEmail, setIntendedEmail] = useState('');

  // A refresh that started BEFORE a Switch must never land after it. The
  // identity probes make a reload slow enough to lose that race, and the older
  // answer put the previous account's "active" badge back while new terminals
  // ran as the new one: the same "Switch did nothing" illusion this whole
  // panel exists to end (Codex P2). Newest read wins; older ones are dropped.
  const reqSeq = useRef(0);
  const mounted = useRef(true);

  const reload = async () => {
    const seq = ++reqSeq.current;
    const [list, activeId, idents, activeCodex, codexIds] = await Promise.all([
      window.electronAPI.accountsList(),
      window.electronAPI.accountsGetActiveClaude(),
      // Optional-called so a renderer running against an older preload (app
      // updated but window not reloaded) still shows the list instead of
      // throwing on a bridge method that is not there yet.
      window.electronAPI.accountsIdentities?.() ?? Promise.resolve(null),
      window.electronAPI.accountsGetActiveCodex?.() ?? Promise.resolve(null),
      window.electronAPI.accountsCodexIdentities?.() ?? Promise.resolve(null),
    ]);
    if (!mounted.current || seq !== reqSeq.current) return;
    setAccounts(list || []);
    setActiveClaudeId(activeId);
    setIdentities(idents || null);
    setActiveCodexId(activeCodex || null);
    setCodexIdents(codexIds || null);
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

  // Group rows (including the synthetic Default) by the address each one has on
  // file. Only groups of 2+ matter. Built from the SAME identities snapshot the
  // rows render from, and keyed by the email rather than by account id, since
  // ids are user-influenced.
  const duplicateGroups = (() => {
    const rows = identities?.accounts;
    if (!Array.isArray(rows)) return [];
    const byEmail = new Map();
    const add = (email, label) => {
      if (!email || !label) return;
      // Key case-insensitively: the identity service compares addresses that
      // way, so a case difference must not split a group and hide the banner
      // while the per-row badges still show (reviewer LOW).
      const key = String(email).toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, { display: email, labels: [] });
      byEmail.get(key).labels.push(label);
    };
    add(identities?.default?.email, 'Default');
    // Read BY POSITION against the same snapshot (reload fetches accounts and
    // identities together) with identAt's id equality guard. Rows are not
    // skipped for a repeated id: suppressing them would hide a genuine
    // duplicate group, which is exactly what this banner exists to show.
    accounts.forEach((acct, i) => {
      if (acct.type !== 'claude') return;
      const row = identAt(i, acct);
      add(row?.email, acct.name || row?.email || acct.id);
    });
    return [...byEmail.values()]
      .filter((g) => g.labels.length > 1)
      .map((g) => ({ email: g.display, labels: g.labels }));
  })();

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
      flash(`Switched. NEW terminals run as "${acct.name}", except in a project that has its own assigned account. Open tabs keep the account they started on. No login on this account yet? Use Sign in on its row.`);
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
      flash('Back to the default account. New terminals use this Mac\u2019s normal ~/.claude login and setup, except in a project that has its own assigned account.');
    } else {
      flash(`Failed to switch: ${result?.error || 'unknown'}`, true);
    }
  };

  // Back to the Mac's default ~/.codex Codex login. The Claude default reset
  // above did not touch Codex, so an active Codex account had no way back to
  // default (reviewer P2).
  const handleUseCodexDefault = async () => {
    setActivating('__codex_default__');
    const result = await window.electronAPI.accountsActivateCodex?.(null);
    setActivating(null);
    if (result?.ok) {
      setActiveCodexId(null);
      reload();
      flash('Back to the default Codex login. New terminals run codex as this Mac’s normal ~/.codex account, except in a project that has its own assigned account.');
    } else {
      flash(`Failed to switch Codex: ${result?.error || 'unknown'}`, true);
    }
  };

  const handleActivateCodex = async (acct) => {
    setActivating(acct.id);
    const result = await window.electronAPI.accountsActivateCodex?.(acct.id);
    setActivating(null);
    if (result?.ok) {
      setActiveCodexId(acct.id);
      reload();
      flash((acct.authMode || (acct.apiKey ? 'apikey' : 'chatgpt')) === 'apikey'
        ? `Switched Codex. NEW terminals run codex with "${acct.name}" API key, except in a project with its own assigned account.`
        : `Switched Codex. NEW terminals run codex as "${acct.name}", except in a project with its own assigned account. First time in this account: run codex login once in a new tab.`);
    } else {
      flash(`Failed to switch Codex: ${result?.error || 'unknown'}`, true);
    }
  };

  const handleSave = async () => {
    // Name stays REQUIRED. Making it optional left blank, indistinguishable
    // entries in the per-project ACCOUNT menu, which renders the name only
    // (reviewer MEDIUM). The fix for a name that drifts from the real login
    // is that the row shows the recorded address underneath it, not an empty
    // label.
    if (!form.name.trim()) return flash('Name is required.', true);
    const codexApiKey = form.type === 'codex' && form.authMode === 'apikey';
    if (codexApiKey && !form.apiKey.trim()) return flash('OpenAI API key is required.', true);

    const payload = {
      ...(editing ? { id: editing.id } : {}),
      name: form.name.trim(),
      type: form.type,
      ...(form.type === 'codex' ? { authMode: form.authMode } : {}),
      ...(codexApiKey ? { apiKey: form.apiKey.trim() } : {}),
      ...(form.type === 'codex' && form.authMode === 'chatgpt' && editing?.codexHome ? { codexHome: editing.codexHome } : {}),
      ...(form.type === 'claude' && editing?.claudeJsonPath ? { claudeJsonPath: editing.claudeJsonPath } : {}),
      ...(form.type === 'claude' && form.cliPath.trim() ? { cliPath: form.cliPath.trim() } : {}),
    };

    // A NEW Codex ChatGPT account gets its own empty CODEX_HOME, bound by the
    // first `codex login` run in it. Same posture as a new Claude profile.
    if (form.type === 'codex' && form.authMode === 'chatgpt' && !editing) {
      const id = `acct-${Date.now()}`;
      payload.id = id;
      const result = await window.electronAPI.accountsInitCodexProfileDir?.(id);
      if (!result?.ok) {
        flash(`Could not create the Codex profile: ${result?.error || 'unknown'}`, true);
        return;
      }
      payload.codexHome = result.path;
    }

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

    // saveAccount returns null when it refuses to write (e.g. more than one row
    // shares this id, where writing would overwrite the wrong account). Do not
    // report success for a save that did not happen.
    const saved = await window.electronAPI.accountsSave(payload);
    if (!saved) {
      await reload();
      flash('Could not save: this account id is duplicated in the config, so saving would overwrite the wrong entry.', true);
      return;
    }
    await reload();
    setShowForm(false);
    flash(editing
      ? 'Account updated.'
      : form.type === 'claude'
        ? 'Account saved. Switch to it, then use Sign in on its row to put a login on it.'
        : form.authMode === 'apikey'
          ? 'Account saved. Switch to it and new terminals will run codex with this API key.'
          : 'Account saved. Switch to it, open a new terminal, and run codex login once there.');
  };

  // Removing a row has side effects beyond the row, so say ALL of them before
  // asking, and say plainly what is NOT touched. Main refuses an ambiguous id
  // rather than deleting every match (reviewer HIGH).
  const handleDelete = async (id) => {
    const acct = accounts.find((a) => a.id === id);
    const label = acct?.name || id;
    const storesKeyInRowAfter = acct?.type === 'codex'
      && (acct.authMode || (acct.apiKey ? 'apikey' : 'chatgpt')) === 'apikey';
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const storesKeyInRow = acct?.type === 'codex'
        && (acct.authMode || (acct.apiKey ? 'apikey' : 'chatgpt')) === 'apikey';
      const lines = [
        `Remove "${label}" from this list?`,
        '',
        'This removes the list entry, clears any project assigned to it (those',
        'projects fall back to whichever account is active), and if it is the',
        'active account the active selection returns to Default.',
        '',
        storesKeyInRow
          // The key IS the entry for an API-key account, so removing the row
          // does remove that credential (reviewer MEDIUM).
          ? 'This account\u2019s API key is stored in this entry, so removing it deletes the key. Terminals already open keep the account they started on.'
          : 'It does NOT delete the profile folder, its transcripts, or its saved login. Terminals already open keep the account they started on.',
      ];
      if (!window.confirm(lines.join('\n'))) return;
    }
    const res = await window.electronAPI.accountsDelete(id);
    await reload();
    if (res && res.ok === false) {
      flash(`Could not remove: ${res.error}`, true);
      return;
    }
    const freed = res?.unassignedProjects?.length || 0;
    flash(
      `Removed "${label}".`
      + (freed ? ` ${freed} project${freed === 1 ? '' : 's'} unassigned.` : '')
      + (res?.wasActive ? ' Active account is back to Default.' : '')
      + (storesKeyInRowAfter ? ' Its API key was stored in that entry and is gone.' : ' The profile folder and its login were left alone.')
    );
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
          <div className="flex flex-col gap-1" style={{ flexShrink: 0, marginLeft: 10 }}>
            {activeClaudeId !== null && (
              <button
                style={btn('primary', { padding: '4px 10px', fontSize: 11 })}
                disabled={activating === '__default__'}
                onClick={handleUseDefault}
                title="Reset Claude to the default ~/.claude login"
              >
                {activating === '__default__' ? 'Switching…' : 'Use default (Claude)'}
              </button>
            )}
            {activeCodexId !== null && accounts.some((a) => a.type === 'codex') && (
              <button
                style={btn('primary', { padding: '4px 10px', fontSize: 11 })}
                disabled={activating === '__codex_default__'}
                onClick={handleUseCodexDefault}
                title="Reset Codex to the default ~/.codex login"
              >
                {activating === '__codex_default__' ? 'Switching…' : 'Use default (Codex)'}
              </button>
            )}
          </div>
        </div>
      )}

      <AccountUsage />
      <SwitchRunningSessions accounts={accounts} identities={identities} />

      {/* Entries recording the SAME address are the failure this panel kept
          hiding behind a small chip: the browser silently approves whichever
          Google account is already signed in, so "log out and log back in as
          the other one" quietly re-binds the same one and you get a second row
          that cannot change anything. Say it once, loudly, at the top. */}
      {duplicateGroups.length > 0 && (
        <div
          className="px-3 py-2 rounded-lg mb-2 text-xs"
          style={{ backgroundColor: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.35)', color: 'var(--fg)' }}
        >
          {duplicateGroups.map((g) => (
            <div key={g.email} className="mb-1">
              <strong>{g.labels.length} entries record the same email</strong>{' '}
              (<span style={{ fontFamily: 'monospace' }}>{g.email}</span>): {g.labels.join(', ')}.
            </div>
          ))}
          {/* Says "record the same account", not "share one quota": a recorded
              address with a missing or unverifiable credential does not prove
              two entries are the same usable login (reviewer MEDIUM). */}
          <div style={{ color: 'var(--dim)' }}>
            If these really are one account, they share one quota, so switching between
            them will not hand you a fresh rate limit. To make one of them a different
            account, use Sign in on that row and pick the other account in the browser.
            To drop a redundant entry, use Remove on it.
          </div>
        </div>
      )}

      {accounts.length === 0 && !showForm && (
        <p className="text-xs mb-3" style={{ color: 'var(--dim)' }}>
          No accounts saved yet. Add an account, then use <strong>Sign in</strong> on its row: each account keeps its own login from then on.
        </p>
      )}

      <div className="space-y-2 mb-3">
        {accounts.map((acct, index) => {
          const isActive = acct.type === 'claude' ? acct.id === activeClaudeId : acct.id === activeCodexId;
          const codexIdent = acct.type === 'codex' ? ((codexIdents?.accounts || []).find((r) => r.id === acct.id) || null) : null;
          return (
            <div
              key={acct.id}
              className="px-3 py-2.5 rounded-lg"
              style={{
                backgroundColor: 'var(--surface)',
                border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
             <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span style={{ fontSize: 10, color: isActive ? 'var(--accent)' : 'var(--dim)' }}>
                  {isActive ? '●' : '○'}
                </span>
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
                  {acct.type === 'codex' && (
                    <div className="flex items-center gap-1.5 flex-wrap mt-1">
                      {(acct.authMode || (acct.apiKey ? 'apikey' : 'chatgpt')) === 'apikey' ? (
                        <span className="text-xs" style={{ color: 'var(--dim)', fontFamily: 'monospace' }}>API key {acct.apiKey ? `${acct.apiKey.slice(0, 8)}…` : ''}</span>
                      ) : codexIdent?.email ? (
                        <span className="text-xs" style={{ color: 'var(--fg)', fontFamily: 'monospace', opacity: 0.8 }}>{codexIdent.email}{codexIdent.plan ? ` (${codexIdent.plan})` : ''}</span>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--dim)' }}>{codexIdent?.login === 'in' ? 'signed in' : 'run codex login in a new tab'}</span>
                      )}
                      {(acct.authMode || (acct.apiKey ? 'apikey' : 'chatgpt')) !== 'apikey' && codexIdent?.login === 'out' && (
                        <span style={badge('#f87171', 'rgba(248,113,113,0.15)')}>not logged in</span>
                      )}
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
                {!isActive && (
                  <button
                    style={btn('primary', { padding: '4px 10px', fontSize: 11 })}
                    disabled={activating === acct.id}
                    onClick={() => (acct.type === 'codex' ? handleActivateCodex(acct) : handleActivate(acct))}
                  >
                    {activating === acct.id ? 'Switching…' : 'Switch'}
                  </button>
                )}
                {acct.type === 'claude' && (
                  <button
                    style={btn('default', { padding: '4px 10px', fontSize: 11 })}
                    onClick={() => {
                      const open = signInFor?.index === index && signInFor?.id === acct.id
                        && signInFor?.path === (acct.claudeJsonPath || null);
                      const next = open ? null : { index, id: acct.id, path: acct.claudeJsonPath || null };
                      setSignInFor(next);
                      // Seed with the address this profile already records, so
                      // re-signing the SAME account is one click, and changing
                      // it is an obvious edit.
                      if (next) setIntendedEmail(identAt(index, acct)?.email || '');
                    }}
                  >
                    {signInFor?.index === index && signInFor?.id === acct.id && signInFor?.path === (acct.claudeJsonPath || null) ? 'Hide' : 'Sign in'}
                  </button>
                )}
                <button style={btn()} onClick={() => { setEditing(acct); setForm({ name: acct.name, type: acct.type, authMode: acct.authMode || (acct.apiKey ? 'apikey' : 'chatgpt'), apiKey: acct.apiKey || '', cliPath: acct.cliPath || '' }); setShowForm(true); }}>
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

              {acct.type === 'claude' && signInFor?.index === index && signInFor?.id === acct.id
                && signInFor?.path === (acct.claudeJsonPath || null) && (
                <SignInHelp
                  acct={acct}
                  isActive={isActive}
                  recordedEmail={identAt(index, acct)?.email || null}
                  loginState={identAt(index, acct)?.login || 'unknown'}
                  intendedEmail={intendedEmail}
                  setIntendedEmail={setIntendedEmail}
                  onClose={() => setSignInFor(null)}
                  onCopied={() => flash('Commands copied. Paste them into the new terminal.')}
                />
              )}
            </div>
          );
        })}
      </div>

      {!showForm && (
        <button style={btn('primary')} onClick={() => { setEditing(null); setForm({ name: '', type: 'claude', authMode: 'chatgpt', apiKey: '', cliPath: '' }); setShowForm(true); }}>
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
              <select
                style={{ ...inp, appearance: 'none' }}
                value={form.authMode}
                onChange={(e) => setForm((f) => ({ ...f, authMode: e.target.value }))}
                disabled={!!editing}
              >
                <option value="chatgpt">ChatGPT login (its own session)</option>
                <option value="apikey">OpenAI API key</option>
              </select>
            )}
            {form.type === 'codex' && form.authMode === 'apikey' && (
              <input
                style={inp}
                type="password"
                placeholder="OpenAI API key (sk-…)"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              />
            )}
            {form.type === 'codex' && form.authMode === 'chatgpt' && !editing && (
              <div className="text-xs p-2 rounded" style={{ backgroundColor: 'rgba(16,163,127,0.08)', color: 'var(--dim)' }}>
                Name the account and Save. It gets its own Codex home (history and settings shared): switch to it, open a new terminal, and run <code style={{ fontFamily: 'monospace' }}>codex login</code> once there to bind its login.
              </div>
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

      {/* The old text here said to log out and log in BEFORE clicking Add
          Account. That ordering is what produced several entries over one
          login: logging out and back in with an already-signed-in browser
          re-binds the same account, and Add Account then saved a second row
          for it. The real order is: create the row, switch to it, and only
          then sign in, so the login lands in THAT profile. */}
      <p className="text-xs mt-3" style={{ color: 'var(--dim)' }}>
        <strong>To add a second Claude account:</strong> click Add Account, then <strong>Switch</strong> to
        the new row, then use <strong>Sign in</strong> on it. Each account keeps its own login from then on.
        Signing in from the wrong row is a common way two entries end up on one account.
      </p>
    </div>
  );
}
