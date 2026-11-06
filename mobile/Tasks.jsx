import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Today on the phone: what Claude picked from the Inbox board, with a reason under each, and
 * Done / Snooze right there. "See all" shows every open card. Nothing here is saved on the
 * phone: every card comes from the Mac when the screen asks (electron/mobile-today.js).
 */

let reqSeq = 0;
// One request, one reply matched by reqId. Resolves null when nothing came back in time.
function ask(connection, msg, replyType, ms = 15000) {
  const reqId = `t${Date.now().toString(36)}-${++reqSeq}`;
  // Not connected: say so now instead of waiting out the timer (writes are never queued).
  if (connection.status !== 'authed') return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(null); }, ms);
    const off = connection.onMessage((m) => {
      if (m.type !== replyType || m.reqId !== reqId) return;
      clearTimeout(timer);
      off();
      resolve(m);
    });
    connection.send({ ...msg, reqId });
  });
}

const BOARD_PROBLEM = {
  'not-installed': 'The Inbox board is not set up on this Mac.',
  'not-running': 'The Inbox board is not running on this Mac. Start it from Tasks on the Mac.',
};

function dueLabel(due, today) {
  if (!due) return '';
  if (due < today) return 'Overdue';
  if (due === today) return 'Due today';
  const d = new Date(`${due}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : `Due ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

const SOURCE = { email: 'Email', asana: 'Asana', meeting: 'Meeting', text: 'Text', imessage: 'Text', slack: 'Slack' };

function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function Card({ card, today, busy, onDone, onSnooze, showReason }) {
  // Both menus belong to the card version they were opened on: if a refresh brings a newer one,
  // they close and the person looks again (Codex).
  const [snoozeFor, setSnoozeFor] = useState(null);
  // An Asana card closes the task in Asana itself, so it asks first, as the Mac does.
  const [confirmFor, setConfirmFor] = useState(null);
  const version = `${card.rev}:${card.print}`;
  const snoozing = snoozeFor === version;
  const confirmAsana = confirmFor === version;
  const setSnoozing = (on) => setSnoozeFor(on ? version : null);
  const setConfirmAsana = (on) => setConfirmFor(on ? version : null);
  const title = card.subject || card.summary || '(no subject)';
  const due = dueLabel(card.due, today);
  const meta = [card.who, SOURCE[card.source] || null, due].filter(Boolean).join(' · ');
  return (
    <div className={`today-card${card.priority === 'high' ? ' high' : ''}`}>
      {card.url
        ? <a className="today-title" href={card.url} target="_blank" rel="noreferrer">{title}</a>
        : <span className="today-title">{title}</span>}
      {meta && <div className={`today-meta${due === 'Overdue' ? ' overdue' : ''}`}>{meta}</div>}
      {showReason && card.reason && <div className="today-reason">{card.reason}</div>}
      {!showReason && card.summary && card.subject && <div className="today-reason">{card.summary}</div>}
      <div className="today-actions">
        {confirmAsana ? <>
          <span className="today-ask">Close it in Asana?</span>
          <button className="today-done" disabled={busy} onClick={() => { setConfirmAsana(false); onDone(card, 'complete'); }}>Close it</button>
          <button className="quiet" onClick={() => setConfirmAsana(false)}>Cancel</button>
        </> : snoozing ? <>
          <button disabled={busy} onClick={() => { setSnoozing(false); onSnooze(card, 'tomorrow'); }}>Tomorrow</button>
          <button disabled={busy} onClick={() => { setSnoozing(false); onSnooze(card, 'week'); }}>Next week</button>
          <button className="quiet" onClick={() => setSnoozing(false)}>Cancel</button>
        </> : <>
          {card.rev !== null && card.rev !== undefined && (
            <button className="today-done" disabled={busy} onClick={() => (card.source === 'asana' ? setConfirmAsana(true) : onDone(card, 'done'))}>{busy ? '…' : 'Done'}</button>
          )}
          {card.print && <button disabled={busy} onClick={() => setSnoozing(true)}>Snooze</button>}
        </>}
      </div>
    </div>
  );
}

// null until this Mac has said what it can do (features arrive with 'authed').
export function useFeature(connection, name) {
  const read = () => (Array.isArray(connection.features) ? connection.features.includes(name) : null);
  const [has, setHas] = useState(read);
  useEffect(() => {
    setHas(read());
    return connection.onMessage((m) => { if (m.type === 'authed') setHas(read()); });
    // read() only looks at the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, name]);
  return has;
}

export default function Tasks({ connection, onBack }) {
  const supported = useFeature(connection, 'today');
  const [today, setToday] = useState(null);
  const [all, setAll] = useState(false);
  const [inbox, setInbox] = useState(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState({});
  const [note, setNote] = useState('');
  const [undo, setUndo] = useState(null);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const seq = useRef(0);
  const shown = useRef(0);
  const doneSeq = useRef(0);
  const inFlight = useRef(false);
  const allRef = useRef(false);
  allRef.current = all;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    inFlight.current = true;
    const [t, i] = await Promise.all([
      ask(connection, { type: 'todayRead' }, 'today', 90000),
      allRef.current ? ask(connection, { type: 'inboxRead' }, 'inbox', 30000) : Promise.resolve(undefined),
    ]);
    if (mine === seq.current) inFlight.current = false;
    // The newest read to FINISH wins, so slow replies never starve the screen (Codex).
    if (mine < shown.current) return;
    shown.current = mine;
    // A failed read keeps what is on screen; only a first read that fails shows the error.
    setToday((prev) => (t?.ok ? t.data : prev && !prev.error ? prev : { error: true }));
    if (i !== undefined) setInbox((prev) => (i?.ok ? i.data : prev || { ok: false }));
  }, [connection]);

  useEffect(() => {
    if (!supported) return undefined;
    load();
    const off = connection.onMessage((m) => {
      // A reconnect, or something changed on the Mac or another phone: read again.
      if (m.type === 'authed' || m.type === 'todayChanged') load();
    });
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { off(); document.removeEventListener('visibilitychange', onVisible); };
  }, [connection, load, supported]);

  // While Claude is still picking, look again every 10 seconds.
  const picking = !!today?.board?.picking;
  useEffect(() => {
    if (!picking) return undefined;
    const t = setInterval(() => { if (!inFlight.current) load(); }, 10000);
    return () => clearInterval(t);
  }, [picking, load]);

  useEffect(() => { if (all) load(); }, [all, load]);

  // New mail reaches the board on its own schedule and sends no event: look again every two
  // minutes while the screen is up (Codex).
  useEffect(() => {
    if (!supported) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible' && !inFlight.current) load(); }, 120000);
    return () => clearInterval(t);
  }, [supported, load]);

  useEffect(() => {
    // Not while its own Undo is on the way, or a slow failure would land on nothing (Codex).
    if (!undo || undo.problem || undo.pending) return undefined;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);

  const say = (text) => { setNote(text); setTimeout(() => setNote((n) => (n === text ? '' : n)), 5000); };
  const mark = (id, on) => setBusy((b) => { const n = { ...b }; if (on) n[id] = true; else delete n[id]; return n; });

  const done = async (card, kind) => {
    const mine = ++doneSeq.current;
    mark(card.id, true);
    // Closing in Asana can take a while: Asana answers before the board does. The print says
    // which version was on screen, so an edit that kept its rev is not closed blind.
    const r = await ask(connection, { type: 'inboxAct', kind, id: card.id, rev: card.rev, print: card.print }, 'todayResult', kind === 'complete' ? 45000 : 15000);
    mark(card.id, false);
    // Undo reopens the card on the board; a task closed in Asana stays closed there. Only the
    // newest Done offers Undo, so a slow reply never swaps the bar to another card (Codex).
    if (r?.ok) { if (kind === 'complete') say('Closed in Asana.'); else if (mine === doneSeq.current) setUndo({ card, key: mine }); }
    else if (!r && connection.status !== 'authed') say('Not connected to your Mac. Try again once it reconnects.');
    else if (r?.changed) say('Something new came in on that one. Have another look.');
    else say(r ? 'The board would not mark that done.' : 'No answer from your Mac. Try again in a moment.');
    load();
  };
  const undoDone = async () => {
    const card = undo?.card;
    const key = undo?.key;
    // One Undo at a time: a second tap could reopen a later Done of the same card (Codex).
    if (!card || undo.pending) return;
    setUndo((cur) => (cur?.key === key ? { ...cur, pending: true } : cur));
    const r = await ask(connection, { type: 'inboxAct', kind: 'undo', id: card.id, rev: card.rev }, 'todayResult');
    // Only if this card still owns the Undo bar: another card may have been marked done meanwhile.
    // Only the Undo bar this tap came from: a newer Done (even of the same card) has its own key.
    setUndo((cur) => (cur?.key !== key ? cur : r?.ok ? null : { card, key, problem: true }));
    load();
  };
  const snooze = async (card, choice) => {
    mark(card.id, true);
    const r = await ask(connection, { type: 'todaySnooze', id: card.id, choice, print: card.print }, 'todayResult');
    mark(card.id, false);
    if (r?.ok) say(choice === 'week' ? 'Snoozed until next week.' : 'Snoozed until tomorrow.');
    else if (r?.changed) say('That one changed since you looked. Have another look.');
    else say(r ? 'Could not snooze that one.' : 'No answer from your Mac.');
    load();
  };
  const bringBack = async (id, sid) => {
    mark(id, true);
    // With the snooze it saw, so a newer snooze of the card stays put.
    await ask(connection, { type: 'todayUnsnooze', id, sid }, 'todayResult');
    mark(id, false);
    load();
  };

  const header = (
    <header className="top-bar">
      <button className="icon-btn" onClick={onBack} aria-label="Back">‹</button>
      <span className="terminal-name today-head">{all ? 'All open' : 'Today'}</span>
      <button className="resume-btn" onClick={() => { setAll((v) => !v); setQuery(''); }}>{all ? 'Today' : 'See all'}</button>
    </header>
  );

  if (supported === null) return (
    <div className="screen history">{header}<main className="today-body"><p className="muted pad">Connecting to your Mac…</p></main></div>
  );
  if (!supported) return (
    <div className="screen history">{header}
      <main className="today-body"><p className="muted pad">This Mac needs a newer Dobius+ to show Today here. Update Dobius+ on the Mac.</p></main>
    </div>
  );

  const board = today?.board;
  const day = board?.today || '';
  let body;
  if (!today) body = <p className="muted pad">Loading…</p>;
  else if (today.error) body = <p className="muted pad">Could not read Today from your Mac. <button className="link-btn" onClick={load}>Try again</button></p>;
  else if (board?.state !== 'ok') body = <p className="muted pad">{BOARD_PROBLEM[board?.state] || 'Could not read the Inbox board on your Mac.'}</p>;
  else if (all) {
    const q = query.trim().toLowerCase();
    const cards = (inbox?.cards || []).filter((c) => !q || [c.subject, c.summary, c.who].some((v) => (v || '').toLowerCase().includes(q)));
    body = <>
      <input className="today-search" type="search" placeholder="Search every open card" value={query} onChange={(e) => setQuery(e.target.value)} />
      {!inbox && <p className="muted pad">Loading every card…</p>}
      {inbox && inbox.ok === false && <p className="muted pad">Could not read the Inbox board.</p>}
      {inbox?.cards && <p className="today-line">{q ? `${cards.length} of ${inbox.cards.length}` : `${inbox.cards.length} open`}</p>}
      {cards.map((c) => <Card key={c.id} card={c} today={inbox.today || day} busy={!!busy[c.id]} onDone={done} onSnooze={snooze} showReason={false} />)}
    </>;
  } else {
    const line = board.picking && board.mode !== 'claude' ? 'Claude is picking your list…'
      : board.mode === 'claude' ? `${board.suggested.length} picked by Claude${board.pickedAt ? ` at ${clock(board.pickedAt)}` : ''}${board.picking ? ', updating…' : ''}`
        : 'Sorted by due date and priority';
    const noticed = today.noticed?.state === 'ok' || today.noticed?.state === 'partial' ? today.noticed.items || [] : [];
    body = <>
      <p className="today-line">{line}</p>
      {board.failing?.length > 0 && <p className="today-warn">Can't read: {board.failing.join(', ')}. Cards from there may be missing.</p>}
      {board.suggested.length === 0 && <p className="muted pad">Nothing picked right now. See all shows every open card.</p>}
      {board.suggested.map((c) => <Card key={c.id} card={c} today={day} busy={!!busy[c.id]} onDone={done} onSnooze={snooze} showReason />)}
      {board.otherCount > 0 && <button className="today-more" onClick={() => setAll(true)}>{board.otherCount} more open cards</button>}
      {board.snoozed?.length > 0 && <>
        <button className="today-more" onClick={() => setShowSnoozed((v) => !v)}>{board.snoozed.length} snoozed {showSnoozed ? '▾' : '▸'}</button>
        {showSnoozed && board.snoozed.map((c) => (
          <div key={c.id} className="today-card snoozed">
            <span className="today-title">{c.subject || c.summary || '(no subject)'}</span>
            <div className="today-meta">{[c.who, c.until ? `back ${new Date(c.until).toLocaleDateString([], { weekday: 'short' })}` : null].filter(Boolean).join(' · ')}</div>
            <div className="today-actions"><button disabled={!!busy[c.id]} onClick={() => bringBack(c.id, c.sid)}>Bring back</button></div>
          </div>
        ))}
      </>}
      {noticed.length > 0 && <>
        <p className="today-line">SamKnows noticed (hints, not sorted)</p>
        {noticed.map((n) => (
          <div key={n.key} className="today-card noticed">
            <span className="today-title">{n.title}</span>
            {n.who && <div className="today-meta">{n.kind === 'promise' ? `You told ${n.who}` : n.who}</div>}
          </div>
        ))}
      </>}
    </>;
  }

  return (
    <div className="screen history">
      {header}
      <main className="today-body">{body}</main>
      {(undo || note) && (
        <div className="today-toast" role="status">
          {undo ? <>
            <span>{undo.problem ? 'Could not undo that.' : 'Marked done.'}</span>
            <button onClick={undoDone} disabled={!!undo.pending}>{undo.pending ? 'Undoing…' : undo.problem ? 'Try again' : 'Undo'}</button>
          </> : <span>{note}</span>}
        </div>
      )}
    </div>
  );
}
