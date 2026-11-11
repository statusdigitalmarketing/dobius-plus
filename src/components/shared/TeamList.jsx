// Tasks > Team: teammates' messages in and out, with the actions a person takes on them (route a held message,
// retry or re-send an unconfirmed one, reply, send, mark done). docs/team-communicator.md.
// Shown as threads (a reply under the message it answers), by teammate and by state; handled rows are hidden until
// asked for (src/lib/team-threads.js has the rules).
import { useState, useEffect, useCallback } from 'react';
import { needsPerson, isArchived, visibleThreads, hiddenCount } from '../../lib/team-threads';

const MONO = "'SF Mono', Menlo, monospace";
const api = window.electronAPI;

// What each state means to a person (which ones need a person: team-threads.js).
const STATES = {
  queued: { label: 'sending', color: 'var(--dim)' },
  sending: { label: 'sending', color: 'var(--dim)' },
  delivered: { label: 'delivered', color: '#3FB950' },
  unconfirmed: { label: 'unconfirmed', color: 'var(--danger)' },
  'not delivered': { label: 'not delivered', color: 'var(--danger)' },
  conflict: { label: 'refused', color: 'var(--danger)' },
  waiting: { label: 'waiting for the tab', color: 'var(--dim)' },
  routing: { label: 'typing it in', color: 'var(--accent)' },
  routed: { label: 'sent to orchestrator', color: '#3FB950' },
  held: { label: 'waiting for you', color: '#F87300' },
  'needs attention': { label: 'check the tab', color: 'var(--danger)' },
  dismissed: { label: 'dismissed', color: 'var(--dim)' },
};
// What the teammate's Mac reported back about a message this Mac sent (docs/team-communicator.md, "Lifecycle").
const STAGES = {
  held: { label: 'held on their side', color: '#F87300' },
  'needs attention': { label: 'stuck in their tab', color: 'var(--danger)' },
  read: { label: 'read by their Claude', color: '#3FB950' },
  working: { label: 'they are working on it', color: 'var(--accent)' },
  replied: { label: 'replied', color: '#3FB950' },
  done: { label: 'done', color: '#3FB950' },
  failed: { label: 'failed', color: 'var(--danger)' },
  stopped: { label: 'stopped (tab closed)', color: '#F87300' },
};
// The label, colour and start time of where a message is now.
function stageOf(m) {
  if (m.dir === 'out' && m.stage && STAGES[m.stage]) return { ...STAGES[m.stage], since: m.stageAt || m.at, note: m.stageNote };
  const st = STATES[m.state] || { label: m.state, color: 'var(--dim)' };
  return { ...st, since: (m.dir === 'out' ? m.deliveredAt : m.routedAt) || m.at, note: m.note };
}
export { needsPerson };

const FILTER_LABELS = [['open', 'Open'], ['attention', 'Needs you'], ['all', 'All'], ['archived', 'Done']];

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
  const [filter, setFilter] = useState('open');
  const [peerFilter, setPeerFilter] = useState('');

  const load = useCallback(async () => {
    const [m, s] = await Promise.all([api.teamMessages(), api.teamStatus()]);
    if (m?.ok) setList(m.list.slice().reverse());
    if (s?.ok) {
      setPeers(s.peers);
      // Keep the choice only while that teammate can still be sent to; else the first one who can. What the picker
      // shows and what Send submits must be the same person.
      setTo((cur) => (s.peers.some((p) => p.enabled && p.id === cur) ? cur : s.peers.find((p) => p.enabled)?.id || ''));
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
    const r = await act(api.teamReply(m.peer, m.id, replyText.trim()));
    if (r?.ok) { setReplyTo(null); setReplyText(''); }
  };

  const q = String(query || '').toLowerCase();
  // Teammates to filter by: everyone linked, plus anyone a kept row came from.
  const peerOptions = [...new Map([...peers.map((p) => [p.id, p.name]), ...list.map((m) => [m.peer, m.peerName || m.peer.slice(0, 10)])]).entries()];
  const shownPeer = peerOptions.some(([id]) => id === peerFilter) ? peerFilter : '';
  const threads = visibleThreads(list, { filter, peer: shownPeer, query: q });
  const hidden = q ? 0 : hiddenCount(list, { filter, peer: shownPeer });

  const row = (m, isReply) => {
    const st = stageOf(m);
    const key = `${m.dir}|${m.peer}|${m.id}`;
    const open = expanded === key;
    return (
      <div key={key} style={{ padding: isReply ? '6px 12px 6px 26px' : '7px 12px', borderBottom: '1px solid var(--border)', opacity: isArchived(m) ? 0.6 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontFamily: MONO }}>
          <span style={{ color: 'var(--dim)' }}>{isReply ? '↳' : ''}{m.dir === 'in' ? '←' : '→'}</span>
          <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{m.peerName || m.peer.slice(0, 10)}</span>
          {m.kind === 'reply' && <span style={{ color: 'var(--dim)' }}>reply</span>}
          <span style={{ color: st.color }}>{st.label}</span>
          <span style={{ color: 'var(--dim)' }} title="How long it has been in this state">{ago(st.since)}</span>
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
        {st.note && <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>{st.note}</div>}
        {open && m.dir === 'out' && (
          <div style={{ marginTop: 4, fontSize: 10, fontFamily: MONO, color: 'var(--dim)', lineHeight: 1.6 }}>
            <div>queued {new Date(m.firstSentAt || m.at).toLocaleTimeString()}</div>
            {m.deliveredAt && <div>delivered {new Date(m.deliveredAt).toLocaleTimeString()}</div>}
            {(m.timeline || []).map((e, i) => (
              <div key={i}>
                <span style={{ color: STAGES[e.state]?.color || 'var(--dim)' }}>{STAGES[e.state]?.label || e.state}</span>
                {' '}{new Date(e.at).toLocaleTimeString()}{e.note ? `: ${e.note}` : ''}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          {m.dir === 'in' && (m.state === 'held' || m.state === 'waiting') && <button style={small()} onClick={() => act(api.teamRouteNow(m.peer, m.id))}>Send to orchestrator</button>}
          {m.dir === 'in' && <button style={small('var(--dim)')} onClick={() => { setReplyTo(replyTo === key ? null : key); setReplyText(''); }}>Reply</button>}
          {m.dir === 'out' && (m.state === 'unconfirmed' || m.state === 'not delivered') && (
            <button style={small()} title="Same message id: a copy that did arrive is not delivered twice" onClick={() => act(api.teamRetry(m.id))}>Retry</button>
          )}
          {m.dir === 'out' && ['unconfirmed', 'not delivered', 'conflict'].includes(m.state) && (
            <button style={small('var(--dim)')} title="A new message: they may see it twice" onClick={() => act(api.teamSendAgain(m.id))}>Send again</button>
          )}
          {['held', 'needs attention', 'unconfirmed', 'not delivered', 'routing'].includes(m.state) && (
            // Clears it for good (it can leave the list and frees its place in a full inbox); Done only hides it.
            <button style={small('var(--dim)')} title="Clear it for good: it stops counting, can leave the list and frees its place in a full inbox" onClick={() => act(api.teamDismiss(m.dir, m.peer, m.id))}>Dismiss</button>
          )}
          {isArchived(m) ? (
            <button style={small('var(--dim)')} title="Show it in Open and All again" onClick={() => act(api.teamArchive(m.dir, m.peer, m.id, false))}>Not done</button>
          ) : (
            <button
              style={small('var(--dim)')}
              title={needsPerson(m) || m.state === 'routing' ? 'Done with it: it stops counting and moves to Done' : 'Moves it to Done; nothing is sent or stopped'}
              onClick={() => act(api.teamArchive(m.dir, m.peer, m.id, true))}
            >
              Done
            </button>
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
  };

  const chip = (on) => ({
    fontSize: 10, fontFamily: MONO, padding: '2px 7px', borderRadius: 4, cursor: 'pointer',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, color: on ? 'var(--accent)' : 'var(--dim)', background: 'none',
  });

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <div role="group" aria-label="Show" style={{ display: 'flex', gap: 4 }}>
          {FILTER_LABELS.map(([id, label]) => (
            <button key={id} data-testid={`team-filter-${id}`} aria-pressed={filter === id} style={chip(filter === id)} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <select
          value={shownPeer}
          onChange={(e) => setPeerFilter(e.target.value)}
          aria-label="Teammate"
          data-testid="team-filter-peer"
          style={{ ...field, padding: '2px 6px', fontSize: 10, marginLeft: 'auto', maxWidth: 170 }}
        >
          <option value="">Every computer</option>
          {peerOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 6px' }}>
        {threads.length === 0 && (
          <div style={{ padding: '20px 14px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, lineHeight: 1.5 }}>
            {q ? `Nothing matches "${query}".`
              : list.length === 0 ? 'No team messages yet.'
                : filter === 'archived' ? 'Nothing marked done.'
                  : filter === 'attention' ? 'Nothing needs you.' : 'Nothing open.'}
          </div>
        )}
        {threads.map((t) => (
          <div key={t.key}>
            {row(t.root, false)}
            {t.replies.map((m) => row(m, true))}
          </div>
        ))}
        {hidden > 0 && filter !== 'all' && filter !== 'archived' && (
          <button
            onClick={() => setFilter('all')}
            style={{ display: 'block', margin: '8px auto 2px', background: 'none', border: 'none', color: 'var(--dim)', fontSize: 10, fontFamily: MONO, cursor: 'pointer' }}
          >
            {hidden} handled {hidden === 1 ? 'message is' : 'messages are'} hidden. Show all
          </button>
        )}
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
