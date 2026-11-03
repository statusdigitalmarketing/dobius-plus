// Tasks > Team: teammates' messages in and out, with the actions a person takes on them (route a held message,
// retry or re-send an unconfirmed one, reply, send). docs/team-communicator.md.
import { useState, useEffect, useCallback } from 'react';

const MONO = "'SF Mono', Menlo, monospace";
const api = window.electronAPI;

// What each state means to a person, and whether it needs one.
const STATES = {
  queued: { label: 'sending', color: 'var(--dim)' },
  sending: { label: 'sending', color: 'var(--dim)' },
  delivered: { label: 'delivered', color: '#3FB950' },
  unconfirmed: { label: 'unconfirmed', color: 'var(--danger)', attention: true },
  'not delivered': { label: 'not delivered', color: 'var(--danger)', attention: true },
  conflict: { label: 'refused', color: 'var(--danger)', attention: true },
  waiting: { label: 'waiting for the tab', color: 'var(--dim)' },
  routing: { label: 'typing it in', color: 'var(--accent)' },
  routed: { label: 'sent to orchestrator', color: '#3FB950' },
  held: { label: 'waiting for you', color: '#F87300', attention: true },
  'needs attention': { label: 'check the tab', color: 'var(--danger)', attention: true },
};
export const needsPerson = (m) => !!STATES[m.state]?.attention;

const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

const small = (color = 'var(--accent)') => ({
  fontSize: 10, fontFamily: MONO, color, background: 'none', border: '1px solid var(--border)', borderRadius: 4,
  padding: '1px 6px', cursor: 'pointer',
});
const field = {
  boxSizing: 'border-box', backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
  borderRadius: 5, padding: '5px 8px', fontSize: 11, outline: 'none', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
};

export default function TeamList({ query }) {
  const [list, setList] = useState([]);
  const [peers, setPeers] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const [m, s] = await Promise.all([api.teamMessages(), api.teamStatus()]);
    if (m?.ok) setList(m.list.slice().reverse());
    if (s?.ok) {
      setPeers(s.peers);
      setTo((cur) => cur || s.peers.find((p) => p.enabled)?.id || '');
    }
  }, []);
  useEffect(() => {
    load();
    return api.onTeamChanged?.(load);
  }, [load]);

  const act = async (p) => {
    setError(null);
    const r = await p;
    if (!r?.ok) setError(r?.error || 'failed');
    load();
    return r;
  };
  const send = async () => {
    if (!to || !text.trim()) return;
    const r = await act(api.teamSend(to, text.trim()));
    if (r?.ok) setText('');
  };
  const sendReply = async (m) => {
    if (!replyText.trim()) return;
    const r = await act(api.teamReply(m.id, replyText.trim()));
    if (r?.ok) { setReplyTo(null); setReplyText(''); }
  };

  const q = String(query || '').toLowerCase();
  const shown = q ? list.filter((m) => `${m.peerName || ''} ${m.text}`.toLowerCase().includes(q)) : list;

  return (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 6px' }}>
        {shown.length === 0 && (
          <div style={{ padding: '20px 14px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, lineHeight: 1.5 }}>
            {q ? `Nothing matches "${query}".` : 'No team messages yet.'}
          </div>
        )}
        {shown.map((m) => {
          const st = STATES[m.state] || { label: m.state, color: 'var(--dim)' };
          const key = `${m.dir}|${m.peer}|${m.id}`;
          const open = expanded === key;
          return (
            <div key={key} style={{ padding: '7px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontFamily: MONO }}>
                <span style={{ color: 'var(--dim)' }}>{m.dir === 'in' ? '←' : '→'}</span>
                <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{m.peerName || m.peer.slice(0, 10)}</span>
                {m.kind === 'reply' && <span style={{ color: 'var(--dim)' }}>reply</span>}
                <span style={{ color: st.color }}>{st.label}</span>
                <span style={{ color: 'var(--dim)', marginLeft: 'auto' }}>{m.id.slice(0, 8)} {ago(m.at)}</span>
              </div>
              <button
                onClick={() => setExpanded(open ? null : key)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '3px 0 0', cursor: 'pointer',
                  color: 'var(--fg)', fontSize: 11, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  ...(open ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
                }}
              >
                {m.text}
              </button>
              {m.note && <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>{m.note}</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                {m.dir === 'in' && m.state === 'held' && <button style={small()} onClick={() => act(api.teamRouteNow(m.peer, m.id))}>Send to orchestrator</button>}
                {m.dir === 'in' && <button style={small('var(--dim)')} onClick={() => { setReplyTo(replyTo === key ? null : key); setReplyText(''); }}>Reply</button>}
                {m.dir === 'out' && (m.state === 'unconfirmed' || m.state === 'not delivered') && (
                  <button style={small()} title="Same message id: a copy that did arrive is not delivered twice" onClick={() => act(api.teamRetry(m.id))}>Retry</button>
                )}
                {m.dir === 'out' && ['unconfirmed', 'not delivered', 'conflict'].includes(m.state) && (
                  <button style={small('var(--dim)')} title="A new message: they may see it twice" onClick={() => act(api.teamSendAgain(m.id))}>Send again</button>
                )}
              </div>
              {replyTo === key && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} rows={2} placeholder={`Reply to ${m.peerName || 'them'}...`} style={{ ...field, flex: 1, resize: 'vertical' }} />
                  <button style={small()} onClick={() => sendReply(m)} disabled={!replyText.trim()}>Send</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <div style={{ padding: '4px 10px', fontSize: 10, color: 'var(--danger)' }}>{error}</div>}
      <div style={{ borderTop: '1px solid var(--border)', padding: '8px 10px', display: 'flex', gap: 6 }}>
        <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Send to" style={{ ...field, maxWidth: 110 }}>
          {peers.filter((p) => p.enabled).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Message their orchestrator..."
          style={{ ...field, flex: 1 }}
        />
        <button
          onClick={send}
          disabled={!to || !text.trim()}
          style={{
            padding: '5px 10px', fontSize: 11, fontFamily: MONO, border: 'none', borderRadius: 5, whiteSpace: 'nowrap',
            color: text.trim() ? 'var(--bg)' : 'var(--dim)', backgroundColor: text.trim() ? 'var(--accent)' : 'var(--border)',
            cursor: text.trim() ? 'pointer' : 'default',
          }}
        >
          Send
        </button>
      </div>
    </>
  );
}
