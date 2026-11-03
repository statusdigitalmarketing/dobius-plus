// Settings > Team: this Mac's identity, invites and joining, linked teammates, the pinned orchestrator tab.
// docs/team-communicator.md. Section, SettingRow and Toggle come from Settings.jsx so the page stays one style.
import { useState, useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';

const api = window.electronAPI;
const box = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)' };
const btn = (primary, busy) => ({
  color: primary ? 'var(--bg)' : 'var(--fg)', backgroundColor: primary ? 'var(--accent)' : 'var(--surface)',
  border: primary ? 'none' : '1px solid var(--border)', cursor: busy ? 'wait' : 'pointer',
});

// term-<project path>-<n>: "<folder> tab <n>" for people.
export function tabName(tabId) {
  const m = /^term-(.*)-([^-]+)$/.exec(String(tabId || ''));
  if (!m) return String(tabId || '');
  return `${m[1].split('/').filter(Boolean).pop() || m[1]} tab ${m[2]}`;
}

export default function TeamSection({ Section, SettingRow, Toggle }) {
  const [st, setSt] = useState(null);
  const [invite, setInvite] = useState(null);
  const [joinText, setJoinText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [name, setName] = useState('');
  const [unlinking, setUnlinking] = useState(null);
  const [nowMs, setNowMs] = useState(Date.now());

  const load = useCallback(async () => {
    const s = await api.teamStatus();
    setSt(s);
    if (s?.ok) setName((n) => n || s.settings.name);
  }, []);
  useEffect(() => {
    load();
    const off = api.onTeamChanged?.(load);
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => { off?.(); clearInterval(t); };
  }, [load]);

  if (!st) return <Section id="team" title="Team"><div className="text-xs" style={{ color: 'var(--dim)' }}>Loading...</div></Section>;
  if (!st.ok) {
    return (
      <Section id="team" title="Team">
        <div className="text-xs px-3 py-2 rounded" style={{ ...box, color: 'var(--danger)' }}>Team messaging is unavailable: {st.error}</div>
      </Section>
    );
  }

  const saveSettings = async (patch) => { await api.teamSettings(patch); load(); };
  const makeInvite = async () => {
    setNote(null);
    const r = await api.teamInvite();
    if (r.ok) setInvite(r); else setNote({ error: r.error });
  };
  const join = async () => {
    setBusy(true);
    setNote({ info: 'Checking the invite and waiting for them to accept (up to 15 minutes)...' });
    const r = await api.teamJoin(joinText.trim());
    setBusy(false);
    setNote(r.ok ? { info: `Linked with ${r.peer.name} (${r.peer.short}).` } : { error: r.error });
    if (r.ok) setJoinText('');
    load();
  };
  const expiresIn = invite ? Math.max(0, Math.round((invite.expiresAt - nowMs) / 1000)) : 0;

  return (
    <Section id="team" title="Team">
      <div className="text-xs" style={{ color: 'var(--dim)', fontSize: 10 }}>
        Message teammates&apos; Dobius orchestrators over Tailscale. Every message is signed and encrypted end to end; only linked teammates can send.
      </div>

      <SettingRow label="This Mac" description={st.endpoint ? `Reachable at ${st.endpoint.host}:${st.endpoint.port}` : 'Not reachable yet: turn on Mobile Access above (Tailscale signed in)'}>
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name.trim() && name.trim() !== st.settings.name) saveSettings({ name: name.trim() }); }}
            className="text-xs px-2 py-1 rounded"
            style={{ ...box, color: 'var(--fg)', width: 140 }}
            aria-label="Name teammates see"
          />
          <code className="text-xs" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }} title={st.fp}>{st.short}</code>
        </div>
      </SettingRow>

      <SettingRow label="Accept team messages" description="Off: teammates' messages are refused and their Macs keep retrying for a day">
        <Toggle checked={!!st.settings.accept} onChange={(v) => saveSettings({ accept: v })} />
      </SettingRow>

      <SettingRow
        label="Orchestrator tab"
        description={st.settings.orchestratorTab
          ? 'Teammates\' messages are typed into this tab when its Claude is idle'
          : 'None: messages wait in the Tasks > Team list. Pin one from a tab\'s right-click menu: Use as team orchestrator'}
      >
        {st.settings.orchestratorTab ? (
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--fg)' }}>{tabName(st.settings.orchestratorTab)}</span>
            <button className="text-xs px-2 py-1 rounded" style={btn(false)} onClick={() => saveSettings({ orchestratorTab: null })}>Unpin</button>
          </div>
        ) : <span className="text-xs" style={{ color: 'var(--dim)' }}>not pinned</span>}
      </SettingRow>

      {st.pendingLinks.map((p) => (
        <div key={p.inviteId} className="flex items-center justify-between gap-3 text-xs px-3 py-2 rounded" style={{ ...box, borderColor: 'var(--accent)' }}>
          <span style={{ color: 'var(--fg)' }}>Link with <b>{p.name}</b> ({p.short}) at {p.host}?</span>
          <span className="flex gap-2 shrink-0">
            <button className="px-2 py-1 rounded" style={btn(true)} onClick={async () => { const r = await api.teamDecideLink(p.inviteId, true); if (!r?.ok) setNote({ error: r?.error || 'could not accept' }); load(); }}>Accept</button>
            <button className="px-2 py-1 rounded" style={btn(false)} onClick={async () => { await api.teamDecideLink(p.inviteId, false); load(); }}>Decline</button>
          </span>
        </div>
      ))}

      <SettingRow label="Invite a teammate" description="Send them the invite (iMessage is fine). It works once, for 15 minutes, and you confirm before anything is linked">
        <button className="text-xs px-3 py-1 rounded" style={btn(true)} onClick={makeInvite} disabled={!st.endpoint}>New invite</button>
      </SettingRow>
      {invite && expiresIn > 0 && (
        <div className="flex items-start gap-3 px-3 py-2 rounded" style={box}>
          <div className="p-1 rounded" style={{ backgroundColor: '#fff' }}><QRCodeSVG value={invite.text} size={96} /></div>
          <div className="min-w-0 flex-1">
            <code className="block text-xs break-all select-text" style={{ color: 'var(--fg)', fontFamily: "'SF Mono', monospace" }}>{invite.text}</code>
            <div className="flex items-center gap-2 mt-2">
              <button className="text-xs px-2 py-1 rounded" style={btn(false)} onClick={() => navigator.clipboard.writeText(invite.text)}>Copy</button>
              <span className="text-xs" style={{ color: 'var(--dim)' }}>expires in {Math.floor(expiresIn / 60)}:{String(expiresIn % 60).padStart(2, '0')}</span>
            </div>
          </div>
        </div>
      )}

      <SettingRow label="Join with an invite" description="Paste the invite a teammate sent you">
        <div className="flex items-center gap-2">
          <input
            value={joinText}
            onChange={(e) => setJoinText(e.target.value)}
            placeholder="dobius-team:1:..."
            className="text-xs px-2 py-1 rounded"
            style={{ ...box, color: 'var(--fg)', width: 200, fontFamily: "'SF Mono', monospace" }}
            aria-label="Team invite"
          />
          <button className="text-xs px-3 py-1 rounded" style={btn(true, busy)} disabled={busy || !joinText.trim() || !st.endpoint} onClick={join}>{busy ? 'Joining...' : 'Join'}</button>
        </div>
      </SettingRow>

      {note && (
        <div className="text-xs px-3 py-2 rounded" style={{ ...box, color: note.error ? 'var(--danger)' : 'var(--dim)', borderColor: note.error ? 'var(--danger)' : 'var(--border)' }}>
          {note.error || note.info}
        </div>
      )}

      {st.peers.length > 0 && (
        <div className="space-y-2">
          {st.peers.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded text-xs" style={box}>
              <div className="min-w-0">
                <div style={{ color: 'var(--fg)' }}>{p.name} <span style={{ color: 'var(--dim)' }}>{p.short}</span></div>
                <div className="truncate" style={{ color: 'var(--dim)', fontSize: 10 }}>{p.host}:{p.port}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <label className="flex items-center gap-1" style={{ color: 'var(--dim)' }} title="Type their messages into the orchestrator tab automatically">
                  Auto-route <Toggle checked={!!p.autoRoute} onChange={async (v) => { await api.teamUpdatePeer(p.id, { autoRoute: v }); load(); }} />
                </label>
                <label className="flex items-center gap-1" style={{ color: 'var(--dim)' }} title="Off: their messages are refused">
                  On <Toggle checked={!!p.enabled} onChange={async (v) => { await api.teamUpdatePeer(p.id, { enabled: v }); load(); }} />
                </label>
                {unlinking === p.id ? (
                  <button className="px-2 py-1 rounded" style={{ ...btn(false), color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={async () => { await api.teamUnlink(p.id); setUnlinking(null); load(); }}>Confirm unlink</button>
                ) : (
                  <button className="px-2 py-1 rounded" style={btn(false)} onClick={() => setUnlinking(p.id)}>Unlink</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
