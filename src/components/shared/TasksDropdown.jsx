import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../store/store';
import { dueLabel, localDay, sortOpenTasks, matchesQuery, sameProject } from '../../../shared/task-due.js';
import TeamList, { needsPerson } from './TeamList';
import CommandsList, { useProjectCommands, waitingCount } from './CommandsList';

const MONO = "'SF Mono', monospace";

const SOURCE_COLORS = {
  asana:  { bg: 'rgba(248,115,0,0.12)',  text: '#F87300' },
  bot:    { bg: 'rgba(88,166,255,0.12)', text: 'var(--accent)' },
  inbox:  { bg: 'rgba(63,185,80,0.12)',  text: '#3FB950' },
  manual: { bg: 'rgba(139,148,158,0.12)', text: 'var(--dim)' },
};

// Lane = who the Asana task is assigned to. Build = mine (blue), review = Sam's (purple).
const LANE_COLORS = {
  build:  { stripe: '#58A6FF', bg: 'rgba(88,166,255,0.14)',  text: '#58A6FF', label: 'Mine' },
  review: { stripe: '#A371F7', bg: 'rgba(163,113,247,0.14)', text: '#A371F7', label: "Sam · review" },
};

// Inbox board card sources (the board's own names).
const INBOX_SOURCES = {
  email:    { label: 'Email',    color: '#58A6FF' },
  asana:    { label: 'Asana',    color: '#F87300' },
  meeting:  { label: 'Meetings', color: '#A371F7' },
  text:     { label: 'Texts',    color: '#3FB950' },
  whatsapp: { label: 'WhatsApp', color: '#25D366' },
  other:    { label: 'Other',    color: 'var(--dim)' },
};

const DUE_TONES = {
  overdue: { text: 'var(--danger)', bg: 'rgba(248,81,73,0.12)' },
  today:   { text: '#D29922', bg: 'rgba(210,153,34,0.14)' },
  soon:    { text: 'var(--fg)', bg: 'transparent' },
  later:   { text: 'var(--dim)', bg: 'transparent' },
};

// Pipeline stages worth a chip on a row; intake/queued/approval are the quiet default.
const STAGE_CHIPS = {
  building: { label: 'Building', color: '#58A6FF' },
  review:   { label: 'In review', color: '#A371F7' },
  shiptest: { label: 'Ship-test', color: '#D29922' },
  blocked:  { label: 'Blocked', color: 'var(--danger)' },
};

const INBOX_ERRORS = {
  'not-installed': "The Inbox board isn't set up on this Mac.",
  'not-running': "The Inbox board isn't running.",
  denied: 'The Inbox board refused the request. Its token may have changed: retry.',
  'bad-response': "The Inbox board sent something Dobius couldn't read.",
};

const INBOX_RENDER_CAP = 120;
const INBOX_REFRESH_MS = 60_000;

function readPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private window or blocked storage: the default is fine */ }
}

export default function TasksDropdown() {
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const addBrowserTab = useStore((s) => s.addBrowserTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = dropdownRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(520, window.innerWidth - 24);
      const left = Math.max(12, Math.min(r.right - width, window.innerWidth - 12 - width));
      setPanelPos({ top: r.bottom + 6, left, width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);
  const [tab, setTab] = useState(() => {
    const t = readPref('dobius.tasks.tab', 'project');
    return t === 'inbox' || t === 'team' || t === 'today' ? t : 'project';
  });
  const [query, setQuery] = useState('');
  const [tasks, setTasks] = useState([]);
  const [newTitle, setNewTitle] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  // A failed sync stays on screen, in full, until it is dismissed or a sync works (Brett, 2026-11-07: the error was
  // squeezed into the header corner and vanished after 4 seconds). { error, unauthorized, refused, alternative, noKey }
  const [syncError, setSyncError] = useState(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const projectRef = useRef(currentProjectPath);
  projectRef.current = currentProjectPath;
  // A new problem is shown where it can be seen: the list scrolls back to its top.
  const listRef = useRef(null);
  useEffect(() => { if (syncError) listRef.current?.scrollTo?.({ top: 0 }); }, [syncError]);
  const openSettingsSection = useStore((s) => s.openSettingsSection);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [inbox, setInbox] = useState({ state: 'idle' });
  const [inboxSource, setInboxSource] = useState('all');
  const [undoCard, setUndoCard] = useState(null);
  const [fleet, setFleet] = useState(null);
  const [todayData, setTodayData] = useState(null);
  const todayReq = useRef(0);
  const todayShown = useRef(0);
  const todayBusy = useRef(false);
  const todayAgain = useRef(false);
  const loadTodayRef = useRef(null);
  // null until main answers; { installed, canStart }. No board here: no Inbox tab.
  const [board, setBoard] = useState(null);
  const [starting, setStarting] = useState(false);
  // Team communicator: the segment shows once a teammate is linked. { peers, attention } (docs/team-communicator.md)
  const [team, setTeam] = useState({ peers: 0, attention: 0, total: 0 });
  const dropdownRef = useRef(null);
  // { top, left, width } in window coordinates, from the button's place (see the panel's style).
  const [panelPos, setPanelPos] = useState(null);
  const inputRef = useRef(null);
  const inboxReq = useRef(0);

  const pendingCount = tasks.filter((t) => !t.done).length;
  // Commands this project's sessions handed back to run (Tasks > Commands).
  const commandEntries = useProjectCommands(currentProjectPath);
  const commandCount = waitingCount(commandEntries); // still to run (finished ones stay listed, not counted)
  const today = localDay();

  const load = useCallback(async () => {
    if (!currentProjectPath || !window.electronAPI?.tasksList) return;
    const list = await window.electronAPI.tasksList(currentProjectPath);
    setTasks(list || []);
  }, [currentProjectPath]);

  useEffect(() => {
    if (!open || !window.electronAPI?.fleetInfo) return;
    window.electronAPI.fleetInfo().then(setFleet).catch((err) => console.error('[TasksDropdown] fleet info failed:', err));
  }, [open]);

  useEffect(() => {
    // A failed Undo stays until it works or another card replaces it: the card is still closed.
    if (!undoCard || undoCard.undoProblem) return undefined;
    const t = setTimeout(() => setUndoCard(null), 8000);
    return () => clearTimeout(t);
  }, [undoCard]);

  const loadToday = useCallback(async () => {
    if (!window.electronAPI?.todayRead) return;
    // Reads run one at a time on main now, so one still running is not started again; and the
    // newest read to FINISH wins, so a slow reply never starves the panel (Codex).
    // One asked for meanwhile (after a snooze, say) runs once this one is back.
    if (todayBusy.current) { todayAgain.current = true; return; }
    todayBusy.current = true;
    const id = ++todayReq.current;
    let result;
    try {
      result = await window.electronAPI.todayRead();
    } catch (err) {
      console.error('[TasksDropdown] today read failed:', err?.name);
      result = { board: { state: 'bad-response' }, noticed: { state: 'unavailable' } };
    }
    todayBusy.current = false;
    if (id >= todayShown.current) { todayShown.current = id; setTodayData(result); }
    if (todayAgain.current) { todayAgain.current = false; loadTodayRef.current?.(); }
  }, []);
  loadTodayRef.current = loadToday;

  const loadInbox = useCallback(async () => {
    if (!window.electronAPI?.inboxRead) return;
    const id = ++inboxReq.current;
    setInbox((prev) => ({ ...prev, state: prev.data ? 'refreshing' : 'loading' }));
    let result;
    try {
      result = await window.electronAPI.inboxRead();
    } catch (err) {
      result = { ok: false, reason: 'bad-response' };
      console.error('[TasksDropdown] inbox read failed:', err);
    }
    if (id !== inboxReq.current) return; // a newer read owns the panel
    if (result?.ok) setInbox({ state: 'ok', data: result });
    else setInbox((prev) => ({ state: 'error', reason: result?.reason || 'bad-response', url: result?.url, data: prev.data }));
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // The phone or another window snoozed or closed a card: an open Today reads again.
  useEffect(() => {
    const a = window.electronAPI;
    if (!open || !a?.onTodayChanged) return undefined;
    return a.onTodayChanged(() => { loadToday(); if (inboxReq.current > 0) loadInbox(); });
  }, [open, loadToday, loadInbox]);

  // A Today notification was clicked.
  useEffect(() => {
    const a = window.electronAPI;
    if (!a?.onTasksOpenToday) return undefined;
    // switchTab only sets state and a saved preference, so the first one is as good as any.
    return a.onTasksOpenToday(() => { switchTab('today'); setOpen(true); });
  }, []);

  useEffect(() => {
    if (!open || !window.electronAPI?.inboxStatus) return;
    let live = true;
    window.electronAPI.inboxStatus()
      .then((s) => { if (live) setBoard(s || { installed: false, canStart: false }); })
      .catch((err) => {
        console.error('[TasksDropdown] inbox status failed:', err);
        if (live) setBoard({ installed: false, canStart: false });
      });
    return () => { live = false; };
  }, [open]);

  const inboxShown = !!board?.installed;
  // Also with no teammate left: messages from an unlinked one may still need a Dismiss.
  const teamShown = team.peers > 0 || team.total > 0;
  const view = tab === 'today' && inboxShown ? 'today' : tab === 'inbox' && inboxShown ? 'inbox' : tab === 'commands' ? 'commands' : (tab === 'team' && teamShown ? 'team' : 'project');

  useEffect(() => {
    const a = window.electronAPI;
    if (!a?.teamStatus) return undefined;
    let live = true;
    const loadTeam = async () => {
      try {
        const [st, msgs] = await Promise.all([a.teamStatus(), a.teamMessages()]);
        if (!live) return;
        const attention = msgs?.ok ? msgs.list.filter(needsPerson).length : 0;
        setTeam({ peers: st?.ok ? st.peers.length : 0, attention, total: msgs?.ok ? msgs.list.length : 0 });
      } catch (err) {
        console.error('[TasksDropdown] team status failed:', err);
      }
    };
    loadTeam();
    const off = a.onTeamChanged?.(loadTeam);
    return () => { live = false; off?.(); };
  }, []);

  // Read on open, then about once a minute while the Inbox tab stays open.
  useEffect(() => {
    if (!open || view !== 'today') return undefined;
    setTodayData(null); // an old answer on screen could read as a clear day while this one loads
    loadToday();
    const timer = setInterval(loadToday, INBOX_REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, view, loadToday]);

  // While Claude is picking, look again every 10 seconds instead of every refresh.
  const picking = !!todayData?.board?.picking;
  useEffect(() => {
    if (!open || view !== 'today' || !picking) return undefined;
    const t = setInterval(loadToday, 10_000);
    return () => clearInterval(t);
  }, [open, view, picking, loadToday]);

  const snoozeCard = async (card, choice) => {
    try { await window.electronAPI.todaySnooze(card.id, choice, card.print); } catch (err) { console.error('[TasksDropdown] snooze failed:', err?.name); }
    loadToday();
  };
  // With the snooze it showed, so a newer snooze (from the phone, say) stays put.
  const unsnoozeCard = async (id, sid) => {
    try { await window.electronAPI.todayUnsnooze(id, sid); } catch (err) { console.error('[TasksDropdown] unsnooze failed:', err?.name); }
    loadToday();
  };

  useEffect(() => {
    if (!open || view !== 'inbox') return;
    loadInbox();
    const timer = setInterval(loadInbox, INBOX_REFRESH_MS);
    return () => clearInterval(timer);
  }, [open, view, loadInbox]);

  // Prime the badge count on mount + when the project changes, so the
  // trigger never shows 0 while real tasks are waiting. PR#3 r1 LOW.
  useEffect(() => {
    load();
  }, [load]);

  // Live refresh when a task is completed from a terminal (dobius-task-done).
  useEffect(() => {
    if (!window.electronAPI?.onTasksUpdated) return;
    const unsubscribe = window.electronAPI.onTasksUpdated((projectPath) => {
      if (!projectPath || projectPath === currentProjectPath) load();
    });
    return unsubscribe;
  }, [currentProjectPath, load]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false);
    };
    // Escape from anywhere (the trigger keeps focus after a click); inside the
    // panel onPanelKeyDown runs first and stops it, so a query clears first.
    // Capture phase: xterm stops Escape from bubbling, so a bubbling listener
    // never hears it from the terminal. It still reaches the terminal; this
    // only closes the panel. Inside the panel onPanelKeyDown decides.
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.target?.closest?.('[role="dialog"][aria-label="Tasks"]')) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const switchTab = (next) => {
    setTab(next);
    setExpanded(null);
    writePref('dobius.tasks.tab', next);
  };

  const handleToggle = async (taskId, done) => {
    // Marking done must go THROUGH the pipeline (tasks:complete ->
    // completeTaskByRef -> pipeline.complete) so stage + done + the event log
    // stay consistent. Never patch `done` out of band.
    if (done) {
      if (!window.electronAPI?.tasksComplete) return;
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, done: true } : t));
      window.electronAPI.tasksComplete(currentProjectPath, taskId);
      return;
    }
    // Un-completing must reverse BOTH `done` and the pipeline `stage` through
    // tasksReopen, or Kanban keeps it in Done. Codex PR#3 r3 P2.
    const task = tasks.find((t) => t.id === taskId);
    if (task?.stage === 'done' && window.electronAPI?.tasksReopen) {
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, done: false, stage: 'approval' } : t));
      await window.electronAPI.tasksReopen(currentProjectPath, taskId, { note: 'unchecked from Tasks dropdown' });
      return;
    }
    if (!window.electronAPI?.tasksUpdate) return;
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, done: false } : t));
    window.electronAPI.tasksUpdate(currentProjectPath, taskId, { done: false });
  };

  const handleDelete = async (taskId) => {
    if (!window.electronAPI?.tasksDelete) return;
    await window.electronAPI.tasksDelete(currentProjectPath, taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  };

  const handleAdd = async () => {
    if (!newTitle.trim() || !window.electronAPI?.tasksAdd) return;
    setAdding(true);
    const result = await window.electronAPI.tasksAdd(currentProjectPath, { title: newTitle.trim() });
    if (result?.ok) {
      setTasks((prev) => [...prev, result.task]);
      setNewTitle('');
    }
    setAdding(false);
    inputRef.current?.focus();
  };

  const handleSync = async (opts) => {
    if (!window.electronAPI?.tasksSyncAsana) return;
    setSyncing(true);
    setSyncMsg('');
    const project = currentProjectPath;
    let result;
    try {
      result = await window.electronAPI.tasksSyncAsana(currentProjectPath, opts);
    } catch (err) {
      result = { ok: false, error: err?.message || 'Sync failed' };
    }
    setSyncing(false);
    // An answer for a project no longer shown is dropped (its list reloads when it is shown again).
    if (projectRef.current !== project) return;
    if (result?.ok) {
      setSyncError(null);
      setSyncMsg(result.added ? `+${result.added} from Asana` : 'Up to date');
      setTimeout(() => setSyncMsg(''), 4000);
      await load();
    } else {
      setSyncError({ ...(result || { error: 'Sync failed' }), project });
    }
  };

  // Another key on this Mac works: save it as Dobius's Asana key (main looks it up again; it never comes here), then
  // sync again so the person sees their tasks arrive.
  const useWorkingKey = async (alt) => {
    if (keyBusy || syncing) return;
    const startedOn = currentProjectPath;
    setKeyBusy(true);
    let switched = false;
    try {
      // Main saves it only if it is still the key shown here (same last four, same account).
      const r = await window.electronAPI?.tasksUseAsanaKey?.(alt.source, { hint: alt.hint, email: alt.email || '' });
      if (r?.ok) {
        setSyncError(null);
        switched = true;
      } else {
        // A key that changed or was refused is no longer offered; Asana being busy keeps the offer for a retry.
        setSyncError((e) => ({ ...(e || {}), error: r?.error || 'Could not switch keys.', alternative: r?.stale ? null : e?.alternative }));
      }
    } finally {
      setKeyBusy(false);
    }
    // Fresh: never join a sync that started with the old key. Only for the project it was asked on.
    if (switched && projectRef.current === startedOn) await handleSync({ fresh: true });
  };

  // Returns '' when closed, or what to show on the card. The board keeps its own rules:
  // it refuses when something new came in since the card was read.
  const markCardDone = async (card) => {
    const kind = card.source === 'asana' ? 'complete' : 'done';
    let result;
    try {
      result = await window.electronAPI.inboxAct({ kind, id: card.id, rev: card.rev, print: card.print });
    } catch (err) {
      console.error('[TasksDropdown] could not close inbox card:', err);
      result = { ok: false, reason: 'bad-response' };
    }
    if (!result?.ok) {
      loadInbox(); // a slow close can still have worked: show what the board says now
      loadToday();
      return result?.error || (result?.reason === 'not-running'
        ? 'The Inbox board is not running. Start it and try again.'
        : 'Could not reach the Inbox board. Nothing changed. Try again.');
    }
    inboxReq.current += 1; // a read already on its way would put the card back
    setInbox((prev) => (prev.data ? {
      ...prev,
      // Only the revision that was closed: a newer message on the card stays visible.
      data: { ...prev.data, cards: prev.data.cards.filter((c) => !(c.id === card.id && c.rev === card.rev)), total: Math.max(0, (prev.data.total || 0) - 1) },
    } : prev));
    setExpanded((v) => (v === card.id ? null : v));
    // Closing an Asana task reaches Asana, so only a board card can be undone from here.
    if (kind === 'done') setUndoCard(card);
    loadInbox();
    loadToday();
    return '';
  };

  const undoMarkDone = async () => {
    const card = undoCard;
    if (!card) return;
    let result;
    try {
      result = await window.electronAPI.inboxAct({ kind: 'undo', id: card.id, rev: card.rev });
    } catch (err) {
      console.error('[TasksDropdown] could not bring inbox card back:', err);
      result = { ok: false };
    }
    // Only this card's Undo: another card closed meanwhile keeps its own.
    setUndoCard((now) => {
      if (now?.id !== card.id) return now;
      if (result?.ok || result?.reason === 'changed') return null; // changed: a newer decision stands
      return { ...card, undoProblem: 'Could not reach the Inbox board. Try Undo again.' };
    });
    if (result?.ok) setTodayData(null); // the card is back: do not leave the list without it while this reads
    loadInbox();
    loadToday();
  };

  const openBoard = () => {
    const url = inbox.data?.url || inbox.url || 'http://127.0.0.1:8765/';
    if (!currentProjectPath) return;
    addBrowserTab(currentProjectPath, url);
    setActiveView('terminal');
    setOpen(false);
  };

  const startBoard = async () => {
    if (!window.electronAPI?.inboxStart || starting) return;
    setStarting(true);
    let result;
    try {
      result = await window.electronAPI.inboxStart();
    } catch (err) {
      console.error('[TasksDropdown] starting the board failed:', err);
      result = { ok: false };
    }
    setStarting(false);
    if (!result?.ok) console.error('[TasksDropdown] the board did not start:', result?.reason);
    loadInbox(); // either way: shows the cards, or the same error with Start again
  };

  const openLink = (url) => {
    if (url) window.electronAPI?.openExternal?.(url);
  };

  const addCardToTasks = async (card) => {
    if (!window.electronAPI?.tasksAdd || !currentProjectPath) return;
    const notes = [card.who && `From ${card.who}`, card.summary, card.why && `Why: ${card.why}`].filter(Boolean).join('\n\n');
    const result = await window.electronAPI.tasksAdd(currentProjectPath, {
      title: card.subject?.trim() || card.summary?.trim() || 'Inbox card',
      source: 'inbox',
      inboxId: card.id,
      dueOn: card.due,
      notes,
      url: card.url,
    });
    if (result?.ok) setTasks((prev) => [...prev, result.task]);
    else {
      console.error('[TasksDropdown] could not add inbox card:', result?.error);
      load(); // e.g. already added from another window: the reload shows the ✓
    }
  };

  const onPanelKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (query) setQuery('');
    else setOpen(false);
  };

  // Project list
  const matchTask = (t) => matchesQuery(query, t.title, t.notes, t.assignee);
  const pending = useMemo(() => sortOpenTasks(tasks.filter((t) => !t.done)), [tasks]);
  const shownPending = pending.filter(matchTask);
  const done = tasks.filter((t) => t.done);
  const shownDone = done.filter(matchTask);
  const projectOverdue = pending.filter((t) => dueLabel(t.dueOn, today)?.tone === 'overdue').length;
  const onList = useMemo(() => new Set(tasks.filter((t) => t.inboxId).map((t) => t.inboxId)), [tasks]);

  // Inbox list
  const cards = inbox.data?.cards || [];
  const sourceCounts = useMemo(() => {
    const counts = {};
    for (const c of cards) counts[c.source] = (counts[c.source] || 0) + 1;
    return counts;
  }, [cards]);
  const isHere = (c) => sameProject(c.project, currentProjectPath);
  const hereCount = cards.filter(isHere).length;
  // A filter whose pill has gone (its cards were closed on the board) falls back to All.
  const sourceNow = inboxSource === 'all' || (inboxSource === 'here' ? hereCount > 0 : sourceCounts[inboxSource] > 0) ? inboxSource : 'all';
  const shownCards = cards.filter((c) => (sourceNow === 'all' || (sourceNow === 'here' ? isHere(c) : c.source === sourceNow))
    && matchesQuery(query, c.who, c.subject, c.summary, c.project, c.meeting));

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Tasks: this project's to-do list and the Inbox board${pendingCount > 0 ? ` (${pendingCount} open)` : ''}${commandCount > 0 ? `. ${commandCount} command${commandCount === 1 ? '' : 's'} waiting for you to run` : ''}`}
        aria-label={`Tasks${pendingCount > 0 ? `, ${pendingCount} open` : ''}${commandCount > 0 ? `, ${commandCount} commands to run` : ''}`}
        aria-expanded={open}
        className="no-drag"
        style={{
          display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px', fontSize: 11, fontFamily: MONO,
          color: open ? 'var(--fg)' : 'var(--dim)',
          backgroundColor: open ? 'var(--surface)' : 'transparent',
          border: `1px solid ${open ? 'var(--border)' : 'transparent'}`,
          borderRadius: 5, cursor: 'pointer', transition: 'all 150ms',
        }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
        </svg>
        {pendingCount > 0 && (
          <span style={{
            minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
            backgroundColor: projectOverdue > 0 ? 'var(--danger)' : 'var(--accent)',
            color: 'var(--bg)', fontSize: 9, fontWeight: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {pendingCount}
          </span>
        )}
        {commandCount > 0 && (
          // A session is waiting on you to run something: its own badge, in the alert colour, with a prompt glyph.
          <span title="Commands waiting for you to run" style={{
            minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, backgroundColor: '#F87300',
            color: 'var(--bg)', fontSize: 9, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1,
          }}>
            {'$'}{commandCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Tasks"
            onKeyDown={onPanelKeyDown}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{
              // Placed against the window, not just the button: wherever the button sits, the popup stays inside the
              // window with a 12px margin (Sam, 2026-11-07: it ran off the right edge in a narrow window).
              ...(panelPos ? { position: 'fixed', top: panelPos.top, left: panelPos.left, width: panelPos.width } : { position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 'min(520px, calc(100vw - 24px))' }),
              maxHeight: 'min(680px, calc(100vh - 80px))',
              backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              // In a very small window the whole panel scrolls rather than squeezing the list to nothing.
              display: 'flex', flexDirection: 'column', overflowX: 'hidden', overflowY: 'auto', zIndex: 9999,
            }}
          >
            {/* Header: segment switch + the segment's action */}
            {/* Wraps instead of clipping: in a narrow window the actions move under the segments (Sam, 2026-11-07). */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, rowGap: 6, padding: '9px 10px 8px', borderBottom: '1px solid var(--border)' }}>
              <div role="tablist" style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 7, backgroundColor: 'var(--bg)', border: '1px solid var(--border)', minWidth: 0, maxWidth: '100%', overflowX: 'auto', scrollbarWidth: 'none' }}>
                <Segment active={view === 'project'} onClick={() => switchTab('project')} label="Project" count={pendingCount} />
                {inboxShown && (
                  <Segment active={view === 'today'} onClick={() => switchTab('today')} label="Today" count={todayData?.board?.suggested ? todayData.board.suggested.length : null} />
                )}
                {inboxShown && (
                  <Segment
                    active={view === 'inbox'}
                    onClick={() => switchTab('inbox')}
                    label="Inbox"
                    count={inbox.data ? inbox.data.total : null}
                    alert={inbox.data?.overdue > 0}
                  />
                )}
                {teamShown && (
                  <Segment active={view === 'team'} onClick={() => switchTab('team')} label="Team" count={team.attention || null} alert={team.attention > 0} />
                )}
                <Segment active={view === 'commands'} onClick={() => switchTab('commands')} label="Commands" count={commandCount || null} alert={commandCount > 0} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
                {fleet && (
                  <HeaderButton onClick={() => window.electronAPI?.openExternal?.(fleet.url)} color="var(--dim)" title="Open the Fleet board in your browser">
                    Fleet ↗
                  </HeaderButton>
                )}
                {view === 'project' ? (
                  <>
                    {syncMsg && (
                      <span style={{ fontSize: 9, color: '#3FB950', fontFamily: MONO }}>{syncMsg}</span>
                    )}
                    <HeaderButton onClick={() => handleSync()} disabled={syncing || keyBusy} color="#F87300" title="Pull my Asana tasks and Sam's review lane into this list">
                      {syncing ? 'Syncing…' : '⟳ Asana'}
                    </HeaderButton>
                  </>
                ) : view === 'team' || view === 'commands' ? null : view === 'today' ? (
                  <HeaderButton onClick={loadToday} color="var(--dim)" title="Read everything again">⟳</HeaderButton>
                ) : (
                  <>
                    <HeaderButton onClick={loadInbox} disabled={inbox.state === 'loading' || inbox.state === 'refreshing'} color="var(--dim)" title="Read the board again">
                      {inbox.state === 'refreshing' || inbox.state === 'loading' ? '…' : '⟳'}
                    </HeaderButton>
                    {(inbox.data || inbox.state !== 'error') && (
                      <HeaderButton onClick={openBoard} disabled={!currentProjectPath} color="#3FB950" title="Open the Inbox board in a Dobius browser tab">
                        Open board
                      </HeaderButton>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Search */}
            <div style={{ padding: '8px 10px 4px' }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={view === 'project' ? 'Filter tasks…' : view === 'today' ? 'Filter this list…' : view === 'team' ? 'Search team messages…' : view === 'commands' ? 'Filter commands…' : 'Search the inbox…'}
                aria-label="Filter"
                style={inputStyle}
              />
            </div>

            {view === 'project' ? (
              <>
                {/* The problem sits in the scrolling area, so in a short window its buttons can always be scrolled to. */}
                <div ref={listRef} style={{ flex: 1, minHeight: 110, overflowY: 'auto', padding: '4px 0 6px' }}>
                  {syncError && syncError.project === currentProjectPath && (
                    <SyncProblem
                      problem={syncError}
                      busy={keyBusy || syncing}
                      onUseKey={useWorkingKey}
                      onOpenSettings={() => { setOpen(false); openSettingsSection?.('integrations'); }}
                      onDismiss={() => setSyncError(null)}
                    />
                  )}
                  {tasks.length === 0 && (
                    <Empty>No tasks yet. Add one below{inboxShown ? ', sync from Asana, or add a card from the Inbox.' : ' or sync from Asana.'}</Empty>
                  )}
                  {tasks.length > 0 && shownPending.length === 0 && !query && (
                    <Empty>Everything here is done.</Empty>
                  )}
                  {query && shownPending.length === 0 && shownDone.length === 0 && tasks.length > 0 && (
                    <Empty>Nothing matches “{query}”.</Empty>
                  )}

                  {shownPending.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      today={today}
                      expanded={expanded === task.id}
                      onExpand={() => setExpanded((v) => (v === task.id ? null : task.id))}
                      onToggle={handleToggle}
                      onDelete={handleDelete}
                      onOpenLink={openLink}
                    />
                  ))}

                  {shownDone.length > 0 && (
                    <>
                      <button
                        onClick={() => setShowDone((v) => !v)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5, width: '100%', padding: '8px 12px 4px',
                          background: 'none', border: 'none', cursor: 'pointer',
                          fontSize: 9, fontFamily: MONO, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.08em',
                        }}
                      >
                        <Chevron open={showDone || !!query} />
                        Done ({shownDone.length})
                      </button>
                      {(showDone || query) && shownDone.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          today={today}
                          expanded={expanded === task.id}
                          onExpand={() => setExpanded((v) => (v === task.id ? null : task.id))}
                          onToggle={handleToggle}
                          onDelete={handleDelete}
                          onOpenLink={openLink}
                        />
                      ))}
                    </>
                  )}
                </div>

                <div style={{ borderTop: '1px solid var(--border)', padding: '8px 10px', display: 'flex', gap: 6 }}>
                  <input
                    ref={inputRef}
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
                    placeholder="Add a task…"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    onClick={handleAdd}
                    disabled={!newTitle.trim() || adding}
                    style={{
                      padding: '5px 10px', fontSize: 11, fontFamily: MONO,
                      color: newTitle.trim() ? 'var(--bg)' : 'var(--dim)',
                      backgroundColor: newTitle.trim() ? 'var(--accent)' : 'var(--border)',
                      border: 'none', borderRadius: 5, cursor: newTitle.trim() ? 'pointer' : 'default',
                      transition: 'all 150ms', whiteSpace: 'nowrap',
                    }}
                  >
                    Add
                  </button>
                </div>
              </>
            ) : view === 'team' ? (
              <TeamList query={query} />
            ) : view === 'commands' ? (
              <CommandsList query={query} />
            ) : view === 'today' ? (
              <TodayList
                data={todayData}
                query={query}
                today={today}
                expanded={expanded}
                onExpand={(id) => setExpanded((v) => (v === id ? null : id))}
                onList={onList}
                canAdd={!!currentProjectPath}
                onAdd={addCardToTasks}
                onOpenLink={openLink}
                onOpenBoard={openBoard}
                onDone={window.electronAPI?.inboxAct ? markCardDone : null}
                undoCard={undoCard}
                onUndo={undoMarkDone}
                onSeeAll={() => { setInboxSource('all'); setQuery(''); switchTab('inbox'); }}
                onSnooze={window.electronAPI?.todaySnooze ? snoozeCard : null}
                onUnsnooze={unsnoozeCard}
                onRetry={loadToday}
              />
            ) : (
              <InboxList
                inbox={inbox}
                cards={shownCards}
                total={cards.length}
                sourceCounts={sourceCounts}
                hereCount={hereCount}
                canStart={!!board?.canStart}
                starting={starting}
                onStart={startBoard}
                source={sourceNow}
                onSource={setInboxSource}
                query={query}
                today={today}
                expanded={expanded}
                onExpand={(id) => setExpanded((v) => (v === id ? null : id))}
                onList={onList}
                canAdd={!!currentProjectPath}
                onAdd={addCardToTasks}
                onOpenLink={openLink}
                onOpenBoard={openBoard}
                onRetry={loadInbox}
                onDone={window.electronAPI?.inboxAct ? markCardDone : null}
                undoCard={undoCard}
                onUndo={undoMarkDone}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const inputStyle = {
  width: '100%', boxSizing: 'border-box',
  backgroundColor: 'var(--bg)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 5,
  padding: '5px 8px', fontSize: 11, outline: 'none',
  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
};

// A failed Asana sync, in full: what went wrong, which key it was, and the one click that fixes it when there is one.
function SyncProblem({ problem, busy, onUseKey, onOpenSettings, onDismiss }) {
  const alt = problem.alternative;
  return (
    <div role="alert" style={{ margin: '6px 10px 2px', padding: '8px 10px', borderRadius: 7, border: '1px solid rgba(248,113,113,0.35)', backgroundColor: 'rgba(248,113,113,0.07)', fontSize: 11, lineHeight: 1.45, color: 'var(--fg)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          <strong style={{ color: 'var(--danger)' }}>{problem.unauthorized ? 'Asana did not accept the key. ' : problem.noKey ? 'No Asana key. ' : 'Asana sync failed. '}</strong>
          {problem.error}
        </span>
        <button onClick={onDismiss} aria-label="Dismiss" title="Dismiss" style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0, flexShrink: 0 }}>×</button>
      </div>
      {(alt || problem.unauthorized || problem.noKey) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
          {alt && (
            <HeaderButton wrap onClick={() => onUseKey(alt)} disabled={busy} color="#3FB950" title={`Save the key from ${alt.place} as Dobius's Asana key, then sync`}>
              {busy ? 'Switching…' : `Use the working key${alt.email ? ` (${alt.email})` : ''}`}
            </HeaderButton>
          )}
          {(problem.unauthorized || problem.noKey) && (
            <HeaderButton onClick={onOpenSettings} color="var(--dim)" title="Paste a new Asana personal access token">
              {problem.noKey ? 'Add a key in Settings' : 'Paste a new key in Settings'}
            </HeaderButton>
          )}
        </div>
      )}
    </div>
  );
}

function Segment({ active, onClick, label, count, alert }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 5, border: 'none', cursor: 'pointer',
        fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
        color: active ? 'var(--fg)' : 'var(--dim)',
        backgroundColor: active ? 'var(--surface)' : 'transparent',
        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.25)' : 'none',
        transition: 'all 120ms',
      }}
    >
      {label}
      {count != null && (
        <span style={{ fontSize: 9, fontFamily: MONO, color: alert ? 'var(--danger)' : 'var(--dim)' }}>{count}</span>
      )}
    </button>
  );
}

function HeaderButton({ onClick, disabled, color, title, children, wrap = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        fontSize: 9, fontFamily: MONO, color: disabled ? 'var(--dim)' : color,
        backgroundColor: 'transparent', border: '1px solid var(--border)', borderRadius: 4,
        padding: '2px 7px', cursor: disabled ? 'default' : 'pointer', transition: 'all 150ms', whiteSpace: wrap ? 'normal' : 'nowrap',
        textAlign: 'left', maxWidth: '100%', overflowWrap: 'anywhere',
      }}
    >
      {children}
    </button>
  );
}

const TODAY_NOTE = { fontSize: 10, color: 'var(--dim)', lineHeight: 1.45 };
const BOARD_DOWN = {
  'not-installed': 'No Inbox board on this Mac.',
  'not-running': 'The Inbox board is not running, so this list is not complete. Start it from the Inbox tab.',
};

// A short list to finish, and an honest count of everything it left out. It says what the board
// holds and never that nothing needs attention: it cannot know that about mail it could not read.
function TodayList({ data, query, today, expanded, onExpand, onList, canAdd, onAdd, onOpenLink, onOpenBoard, onDone, undoCard, onUndo, onSeeAll, onRetry, onSnooze, onUnsnooze }) {
  const [showSnoozed, setShowSnoozed] = useState(false);
  if (!data) return <Empty>Reading…</Empty>;
  const { board, noticed } = data;
  const q = query.trim().toLowerCase();
  const matches = (...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));
  const cards = (board.suggested || []).filter((c) => matches(c.subject, c.summary, c.who, c.project));
  const notes = (noticed.items || []).filter((n) => matches(n.title, n.who));
  const checkedAgo = board.checkedAt ? Date.now() - Date.parse(board.checkedAt) : NaN;
  const stale = Number.isFinite(checkedAgo) && checkedAgo > 60 * 60 * 1000;
  const failing = board.failing || [];
  return (
    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)' }}>
        {board.state === 'ok' ? (
          <div style={TODAY_NOTE}>
            {board.mode === 'claude'
              ? `${board.suggested.length} picked by Claude${board.pickedAt ? ` at ${new Date(board.pickedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}${board.picking ? ', picking again' : ''}. ${board.total} open in all.`
              : `${board.picking ? 'Claude is picking your list. Until then, ' : ''}${board.suggested.length} of ${board.withinReach} sorted by due date and priority. ${board.total} open in all.`}{' '}
            <LinkButton onClick={onSeeAll} color="var(--accent)">See all</LinkButton>
            {board.snoozed?.length > 0 && <>{' '}<LinkButton onClick={() => setShowSnoozed((v) => !v)} color="var(--dim)">{showSnoozed ? 'Hide' : `${board.snoozed.length} snoozed`}</LinkButton></>}
          </div>
        ) : (
          <div role="alert" style={{ ...TODAY_NOTE, color: 'var(--danger)' }}>
            {BOARD_DOWN[board.state] || 'Could not read the Inbox board, so this list is not complete.'}{' '}
            <LinkButton onClick={onRetry} color="var(--accent)">Try again</LinkButton>
          </div>
        )}
        {stale && <div role="alert" style={{ ...TODAY_NOTE, color: 'var(--danger)', marginTop: 2 }}>The board last checked for new messages {Math.round(checkedAgo / 3600000)}h ago, so this may be missing things.</div>}
        {failing.length > 0 && <div role="alert" style={{ ...TODAY_NOTE, color: 'var(--danger)', marginTop: 2 }}>Can't read {failing.join(', ')} right now, so new messages there are missing. See Connections on the board.</div>}
        {board.held > 0 && <div style={{ ...TODAY_NOTE, marginTop: 2 }}>{board.held} text{board.held === 1 ? '' : 's'} still being read, not listed yet.</div>}
      </div>
      {undoCard && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 11, color: 'var(--fg)', backgroundColor: 'rgba(63,185,80,0.12)', borderBottom: '1px solid var(--border)' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: undoCard.undoProblem ? 'var(--danger)' : undefined }}>{undoCard.undoProblem || `Marked done: ${undoCard.subject || undoCard.summary || '(no subject)'}`}</span>
          <button onClick={onUndo} style={{ flexShrink: 0, fontSize: 11, color: '#3FB950', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Undo</button>
        </div>
      )}
      {board.state === 'ok' && cards.length === 0 && <Empty>{q ? 'Nothing matches.' : board.total ? 'Nothing here looks pressing, but cards are still open.' : 'No open cards on the board.'}</Empty>}
      {showSnoozed && (board.snoozed || []).map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--dim)' }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.subject || s.summary || '(no subject)'}</span>
          <span style={{ flexShrink: 0, fontSize: 10 }}>until {new Date(s.until).toLocaleDateString([], { weekday: 'short' })}</span>
          <LinkButton onClick={() => onUnsnooze(s.id, s.sid)} color="var(--accent)">Bring back</LinkButton>
        </div>
      ))}
      {cards.map((card) => (
        <div key={card.id}>
          <InboxCard
            card={card}
            today={today}
            expanded={expanded === card.id}
            onExpand={() => onExpand(card.id)}
            added={onList.has(card.id)}
            canAdd={canAdd}
            onAdd={() => onAdd(card)}
            onOpenLink={onOpenLink}
            onOpenBoard={onOpenBoard}
            onDone={onDone}
          />
          {(card.reason || onSnooze) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 6px 13px', marginTop: -2, borderBottom: '1px solid var(--border)', fontSize: 10, color: 'var(--dim)' }}>
              {card.reason && <span style={{ flex: 1, minWidth: 0, color: 'var(--fg)', opacity: 0.85 }}>{card.reason}</span>}
              {onSnooze && (
                <span style={{ flexShrink: 0, marginLeft: 'auto' }}>
                  Snooze <LinkButton onClick={() => onSnooze(card, 'tomorrow')} color="var(--accent)">tomorrow</LinkButton> · <LinkButton onClick={() => onSnooze(card, 'week')} color="var(--accent)">next week</LinkButton>
                </span>
              )}
            </div>
          )}
        </div>
      ))}
      <div style={{ padding: '8px 12px 4px' }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--fg)' }}>SamKnows noticed</div>
        <div style={TODAY_NOTE}>
          {noticed.state === 'unavailable'
            ? 'SamKnows did not answer, so nothing from it is here.'
            : `Not sorted or checked, so treat these as hints. Showing ${notes.length} of ${noticed.found}${noticed.state === 'partial' ? '+' : ''}.`}
        </div>
      </div>
      {notes.map((n) => (
        <div key={n.key} style={{ padding: '4px 12px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--fg)', lineHeight: 1.4 }}>
          <span style={{ color: 'var(--dim)', fontSize: 9, fontFamily: MONO, textTransform: 'uppercase', marginRight: 6 }}>{n.kind}</span>
          {n.title}
          {n.who && <span style={{ color: 'var(--dim)' }}> · {n.who}</span>}
        </div>
      ))}
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ padding: '20px 14px', textAlign: 'center', color: 'var(--dim)', fontSize: 11, lineHeight: 1.5 }}>{children}</div>;
}

function Chevron({ open }) {
  return (
    <svg width="8" height="8" viewBox="0 0 10 10" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms', flexShrink: 0 }}>
      <path d="M3 1.5L7 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Chip({ color, bg = 'transparent', children, title }) {
  return (
    <span title={title} style={{
      fontSize: 8, padding: '1px 5px', borderRadius: 3, backgroundColor: bg, color,
      border: bg === 'transparent' ? '1px solid var(--border)' : 'none',
      fontFamily: MONO, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function DueChip({ due, today }) {
  const label = dueLabel(due, today);
  if (!label) return null;
  const tone = DUE_TONES[label.tone];
  return (
    <span title={`Due ${due}`} style={{ fontSize: 9, fontFamily: MONO, color: tone.text, backgroundColor: tone.bg, padding: tone.bg === 'transparent' ? 0 : '0 4px', borderRadius: 3, whiteSpace: 'nowrap' }}>
      {label.text}
    </span>
  );
}

function LinkButton({ onClick, children, color = 'var(--accent)' }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        fontSize: 10, color, background: 'none', border: '1px solid var(--border)', borderRadius: 4,
        padding: '2px 7px', cursor: 'pointer', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      {children}
    </button>
  );
}

function TaskRow({ task, today, expanded, onExpand, onToggle, onDelete, onOpenLink }) {
  const [hovered, setHovered] = useState(false);
  const src = SOURCE_COLORS[task.source] || SOURCE_COLORS.manual;
  const lane = task.lane ? LANE_COLORS[task.lane] : null;
  const stage = !task.done ? STAGE_CHIPS[task.stage] : null;
  const hasDetail = !!(task.notes || task.url);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 12px',
        borderLeft: `3px solid ${lane ? lane.stripe : 'transparent'}`,
        backgroundColor: hovered || expanded ? 'var(--surface-hover)' : 'transparent',
        transition: 'background 100ms',
      }}
    >
      <button
        onClick={() => onToggle(task.id, !task.done)}
        aria-label={task.done ? 'Mark not done' : 'Mark done'}
        style={{
          marginTop: 1, flexShrink: 0, width: 15, height: 15, borderRadius: 3,
          border: `1.5px solid ${task.done ? 'var(--accent)' : 'var(--dim)'}`,
          backgroundColor: task.done ? 'var(--accent)' : 'transparent',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms',
        }}
      >
        {task.done && (
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      <div
        style={{ flex: 1, minWidth: 0, cursor: hasDetail ? 'pointer' : 'default' }}
        onClick={hasDetail ? onExpand : undefined}
      >
        <span style={{
          fontSize: 11, color: task.done ? 'var(--dim)' : 'var(--fg)',
          textDecoration: task.done ? 'line-through' : 'none', lineHeight: 1.4, wordBreak: 'break-word',
        }}>
          {task.title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, flexWrap: 'wrap' }}>
          {lane ? (
            <Chip color={lane.text} bg={lane.bg}>{lane.label}</Chip>
          ) : task.source !== 'manual' && (
            <Chip color={src.text} bg={src.bg}>{task.source}</Chip>
          )}
          {stage && <Chip color={stage.color}>{stage.label}</Chip>}
          {!task.done && <DueChip due={task.dueOn} today={today} />}
          {hasDetail && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: 'var(--dim)', fontFamily: MONO }}>
              <Chevron open={expanded} />{expanded ? 'less' : 'details'}
            </span>
          )}
        </div>
        {expanded && (
          <div style={{ marginTop: 6 }}>
            {task.notes && (
              <div style={{
                fontSize: 11, color: 'var(--dim)', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                maxHeight: 180, overflowY: 'auto', padding: '6px 8px', borderRadius: 5, backgroundColor: 'var(--bg)', border: '1px solid var(--border)',
              }}>
                {task.notes}
              </div>
            )}
            {task.url && (
              <div style={{ marginTop: 6 }}>
                <LinkButton onClick={() => onOpenLink(task.url)}>
                  {task.source === 'asana' ? 'Open in Asana ↗' : 'Open original ↗'}
                </LinkButton>
              </div>
            )}
          </div>
        )}
      </div>

      {hovered && (
        <button
          onClick={() => onDelete(task.id)}
          aria-label="Delete task"
          style={{ flexShrink: 0, background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 12, padding: '0 2px', opacity: 0.6, lineHeight: 1 }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--danger)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.color = 'var(--dim)'; }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function InboxList({ inbox, cards, total, sourceCounts, hereCount, canStart, starting, onStart, source, onSource, query, today, expanded, onExpand, onList, canAdd, onAdd, onOpenLink, onOpenBoard, onRetry, onDone, undoCard, onUndo }) {
  if (inbox.state === 'idle' || (inbox.state === 'loading' && !inbox.data)) {
    return <div style={{ flex: 1 }}><Empty>Reading the Inbox board…</Empty></div>;
  }
  if (inbox.state === 'error' && !inbox.data) {
    return (
      <div style={{ flex: 1, padding: '16px 14px', textAlign: 'center' }}>
        <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.5, marginBottom: 10 }}>
          {INBOX_ERRORS[inbox.reason] || INBOX_ERRORS['bad-response']}
        </div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
          {inbox.reason === 'not-running' && canStart && (
            <LinkButton onClick={onStart} color="#3FB950">{starting ? 'Starting…' : 'Start board'}</LinkButton>
          )}
          {inbox.reason !== 'not-installed' && !starting && <LinkButton onClick={onRetry}>Retry</LinkButton>}
        </div>
      </div>
    );
  }
  const stats = inbox.data || {};
  const sources = Object.keys(INBOX_SOURCES).filter((k) => sourceCounts[k]);
  const rendered = cards.slice(0, INBOX_RENDER_CAP);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px 6px', flexWrap: 'wrap' }}>
        <FilterPill active={source === 'all'} onClick={() => onSource('all')} label="All" count={total} />
        {hereCount > 0 && (
          <FilterPill active={source === 'here'} onClick={() => onSource('here')} label="This project" count={hereCount} dot="var(--accent)" />
        )}
        {sources.map((k) => (
          <FilterPill key={k} active={source === k} onClick={() => onSource(k)} label={INBOX_SOURCES[k].label} count={sourceCounts[k]} dot={INBOX_SOURCES[k].color} />
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 9, fontFamily: MONO, color: 'var(--dim)' }}>
          {stats.overdue > 0 && <span style={{ color: 'var(--danger)' }}>{stats.overdue} overdue</span>}
          {stats.overdue > 0 && stats.dueToday > 0 && ' · '}
          {stats.dueToday > 0 && <span style={{ color: '#D29922' }}>{stats.dueToday} today</span>}
        </span>
      </div>
      {inbox.state === 'error' && (
        <div style={{ margin: '0 10px 6px', fontSize: 10, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>Couldn't refresh: {INBOX_ERRORS[inbox.reason] || INBOX_ERRORS['bad-response']} Showing the last read.</span>
          {inbox.reason === 'not-running' && canStart && (
            <LinkButton onClick={onStart} color="#3FB950">{starting ? 'Starting…' : 'Start board'}</LinkButton>
          )}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 6px', borderTop: '1px solid var(--border)' }}>
        {cards.length === 0 && (
          <Empty>{query || source !== 'all' ? 'Nothing matches.' : 'Inbox zero. Nothing open on the board.'}</Empty>
        )}
        {undoCard && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 11, color: 'var(--fg)', backgroundColor: 'rgba(63,185,80,0.12)', borderBottom: '1px solid var(--border)' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: undoCard.undoProblem ? 'var(--danger)' : undefined }}>{undoCard.undoProblem || `Marked done: ${undoCard.subject || undoCard.summary || '(no subject)'}`}</span>
            <button onClick={onUndo} style={{ flexShrink: 0, fontSize: 11, color: '#3FB950', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Undo</button>
          </div>
        )}
        {rendered.map((card) => (
          <InboxCard
            key={card.id}
            card={card}
            today={today}
            expanded={expanded === card.id}
            onExpand={() => onExpand(card.id)}
            added={onList.has(card.id)}
            canAdd={canAdd}
            onAdd={() => onAdd(card)}
            onOpenLink={onOpenLink}
            onOpenBoard={onOpenBoard}
            onDone={onDone}
          />
        ))}
        {cards.length > rendered.length && (
          <div style={{ padding: '8px 12px', textAlign: 'center' }}>
            <LinkButton onClick={onOpenBoard}>{cards.length - rendered.length} more on the board</LinkButton>
          </div>
        )}
      </div>
    </>
  );
}

function FilterPill({ active, onClick, label, count, dot }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 10, cursor: 'pointer',
        fontSize: 10, border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        color: active ? 'var(--fg)' : 'var(--dim)', backgroundColor: active ? 'rgba(88,166,255,0.10)' : 'transparent',
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />}
      {label}
      <span style={{ fontFamily: MONO, fontSize: 9, opacity: 0.8 }}>{count}</span>
    </button>
  );
}

function InboxCard({ card, today, expanded, onExpand, added, canAdd, onAdd, onOpenLink, onOpenBoard, onDone }) {
  const [closing, setClosing] = useState(false);
  const [confirmAsana, setConfirmAsana] = useState(false);
  const [problem, setProblem] = useState('');
  // A confirm answers the card as it stood, so anything new, or a few seconds, asks again.
  useEffect(() => {
    if (!confirmAsana) return undefined;
    const t = setTimeout(() => setConfirmAsana(false), 5000);
    return () => clearTimeout(t);
  }, [confirmAsana]);
  useEffect(() => { setConfirmAsana(false); }, [card.rev]);
  const isAsana = card.source === 'asana';
  const close = async (e) => {
    e.stopPropagation();
    if (closing) return;
    // Closing an Asana task changes Asana for everyone on it and has no undo here.
    if (isAsana && !confirmAsana) { setConfirmAsana(true); return; }
    setClosing(true);
    setProblem('');
    const why = await onDone(card);
    setClosing(false);
    setConfirmAsana(false);
    if (why) setProblem(why);
  };
  const src = INBOX_SOURCES[card.source] || INBOX_SOURCES.other;
  const title = card.subject || card.summary || '(no subject)';
  const linkLabel = { email: 'Open in Gmail ↗', asana: 'Open in Asana ↗' }[card.source] || 'Open original ↗';

  return (
    <div
      onClick={onExpand}
      style={{
        padding: '7px 12px 7px 10px', cursor: 'pointer',
        borderLeft: `3px solid ${src.color}`,
        backgroundColor: expanded ? 'var(--surface-hover)' : 'transparent',
        borderBottom: '1px solid var(--border)',
      }}
      onMouseEnter={(e) => { if (!expanded) e.currentTarget.style.backgroundColor = 'var(--surface-hover)'; }}
      onMouseLeave={(e) => { if (!expanded) e.currentTarget.style.backgroundColor = 'transparent'; }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        {card.priority === 'high' && <span title="High priority" style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: 'var(--danger)', flexShrink: 0, alignSelf: 'center' }} />}
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: expanded ? 'normal' : 'nowrap', wordBreak: 'break-word', flex: 1 }}>
          {title}
        </span>
        <DueChip due={card.due} today={today} />
        {onDone && (
          <button
            onClick={close}
            disabled={closing}
            title={isAsana ? 'Mark this task done in Asana' : 'Mark done'}
            aria-label={isAsana ? `Mark ${title} done in Asana` : `Mark ${title} done`}
            style={{
              flexShrink: 0, alignSelf: 'center', height: 20, minWidth: 20, padding: confirmAsana ? '0 6px' : 0,
              fontSize: 10, lineHeight: '18px', borderRadius: 4, cursor: closing ? 'wait' : 'pointer',
              color: confirmAsana ? 'var(--bg)' : '#3FB950',
              backgroundColor: confirmAsana ? '#3FB950' : 'transparent',
              border: '1px solid rgba(63,185,80,0.5)', opacity: closing ? 0.5 : 1,
            }}
          >
            {closing ? '…' : confirmAsana ? 'Close in Asana?' : '✓'}
          </button>
        )}
      </div>
      {problem && <div role="alert" style={{ marginTop: 3, fontSize: 10, color: 'var(--danger)', lineHeight: 1.4 }}>{problem}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2, fontSize: 10, color: 'var(--dim)', minWidth: 0 }}>
        <span style={{ color: src.color, fontFamily: MONO, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>{src.label.replace(/s$/, '')}</span>
        {card.who && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{card.who}</span>}
        {card.project && <Chip color="var(--dim)">{card.project}</Chip>}
      </div>
      {card.summary && card.summary !== title && (
        <div style={{
          marginTop: 3, fontSize: 11, color: 'var(--dim)', lineHeight: 1.45, wordBreak: 'break-word',
          ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
        }}>
          {card.summary}
        </div>
      )}
      {expanded && (
        <div style={{ marginTop: 6 }}>
          {card.meeting && <div style={{ fontSize: 10, color: 'var(--dim)', marginBottom: 4 }}>From the meeting: {card.meeting}</div>}
          {card.why && <div style={{ fontSize: 10, color: 'var(--dim)', lineHeight: 1.45, marginBottom: 6 }}>Why it's here: {card.why}</div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <LinkButton onClick={onOpenBoard} color="#3FB950">Reply on the board</LinkButton>
            {card.url && <LinkButton onClick={() => onOpenLink(card.url)}>{linkLabel}</LinkButton>}
            {canAdd && (added
              ? <span style={{ fontSize: 10, color: '#3FB950', alignSelf: 'center' }}>✓ On this project's list</span>
              : <LinkButton onClick={onAdd} color="var(--fg)">Add to project tasks</LinkButton>)}
          </div>
        </div>
      )}
    </div>
  );
}
