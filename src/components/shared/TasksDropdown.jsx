import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../store/store';
import { dueLabel, localDay, sortOpenTasks, matchesQuery } from '../../../shared/task-due.js';

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
  'not-running': "The Inbox board isn't running. Start it from its menu bar app, then retry.",
  denied: 'The Inbox board refused the request. Its token may have changed: retry.',
  'bad-response': "The Inbox board sent something Dobius couldn't read.",
};

const INBOX_RENDER_CAP = 120;

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
  const [tab, setTab] = useState(() => (readPref('dobius.tasks.tab', 'project') === 'inbox' ? 'inbox' : 'project'));
  const [query, setQuery] = useState('');
  const [tasks, setTasks] = useState([]);
  const [newTitle, setNewTitle] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [inbox, setInbox] = useState({ state: 'idle' });
  const [inboxSource, setInboxSource] = useState('all');
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);
  const inboxReq = useRef(0);

  const pendingCount = tasks.filter((t) => !t.done).length;
  const today = localDay();

  const load = useCallback(async () => {
    if (!currentProjectPath || !window.electronAPI?.tasksList) return;
    const list = await window.electronAPI.tasksList(currentProjectPath);
    setTasks(list || []);
  }, [currentProjectPath]);

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

  useEffect(() => {
    if (open && tab === 'inbox') loadInbox();
  }, [open, tab, loadInbox]);

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
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
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

  const handleSync = async () => {
    if (!window.electronAPI?.tasksSyncAsana) return;
    setSyncing(true);
    setSyncMsg('');
    const result = await window.electronAPI.tasksSyncAsana(currentProjectPath);
    if (result?.ok) {
      setSyncMsg(result.added ? `+${result.added} from Asana` : 'Up to date');
      await load();
    } else {
      setSyncMsg(result?.error || 'Sync failed');
    }
    setSyncing(false);
    setTimeout(() => setSyncMsg(''), 4000);
  };

  const openBoard = () => {
    const url = inbox.data?.url || inbox.url || 'http://127.0.0.1:8765/';
    if (!currentProjectPath) return;
    addBrowserTab(currentProjectPath, url);
    setActiveView('terminal');
    setOpen(false);
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
  const shownCards = cards.filter((c) => (inboxSource === 'all' || c.source === inboxSource)
    && matchesQuery(query, c.who, c.subject, c.summary, c.project, c.meeting));

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={`Tasks: this project's to-do list and the Inbox board${pendingCount > 0 ? ` (${pendingCount} open)` : ''}`}
        aria-label={`Tasks${pendingCount > 0 ? `, ${pendingCount} open` : ''}`}
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
              position: 'absolute', top: 'calc(100% + 6px)', right: 0,
              width: 400, maxWidth: 'calc(100vw - 24px)', maxHeight: 'min(620px, calc(100vh - 80px))',
              backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 9999,
            }}
          >
            {/* Header: segment switch + the segment's action */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 10px 8px', borderBottom: '1px solid var(--border)' }}>
              <div role="tablist" style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 7, backgroundColor: 'var(--bg)', border: '1px solid var(--border)' }}>
                <Segment active={tab === 'project'} onClick={() => switchTab('project')} label="Project" count={pendingCount} />
                <Segment
                  active={tab === 'inbox'}
                  onClick={() => switchTab('inbox')}
                  label="Inbox"
                  count={inbox.data ? inbox.data.total : null}
                  alert={inbox.data?.overdue > 0}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {tab === 'project' ? (
                  <>
                    {syncMsg && (
                      <span style={{ fontSize: 9, color: syncMsg.startsWith('+') || syncMsg === 'Up to date' ? '#3FB950' : 'var(--danger)', fontFamily: MONO }}>
                        {syncMsg}
                      </span>
                    )}
                    <HeaderButton onClick={handleSync} disabled={syncing} color="#F87300" title="Pull my Asana tasks and Sam's review lane into this list">
                      {syncing ? 'Syncing…' : '⟳ Asana'}
                    </HeaderButton>
                  </>
                ) : (
                  <>
                    <HeaderButton onClick={loadInbox} disabled={inbox.state === 'loading' || inbox.state === 'refreshing'} color="var(--dim)" title="Read the board again">
                      {inbox.state === 'refreshing' || inbox.state === 'loading' ? '…' : '⟳'}
                    </HeaderButton>
                    <HeaderButton onClick={openBoard} disabled={!currentProjectPath} color="#3FB950" title="Open the Inbox board in a Dobius browser tab">
                      Open board
                    </HeaderButton>
                  </>
                )}
              </div>
            </div>

            {/* Search */}
            <div style={{ padding: '8px 10px 4px' }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'project' ? 'Filter tasks…' : 'Search the inbox…'}
                aria-label="Filter"
                style={inputStyle}
              />
            </div>

            {tab === 'project' ? (
              <>
                <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 6px' }}>
                  {tasks.length === 0 && (
                    <Empty>No tasks yet. Add one below, sync from Asana, or add a card from the Inbox.</Empty>
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
            ) : (
              <InboxList
                inbox={inbox}
                cards={shownCards}
                total={cards.length}
                sourceCounts={sourceCounts}
                source={inboxSource}
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

function HeaderButton({ onClick, disabled, color, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        fontSize: 9, fontFamily: MONO, color: disabled ? 'var(--dim)' : color,
        backgroundColor: 'transparent', border: '1px solid var(--border)', borderRadius: 4,
        padding: '2px 7px', cursor: disabled ? 'default' : 'pointer', transition: 'all 150ms', whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
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

function InboxList({ inbox, cards, total, sourceCounts, source, onSource, query, today, expanded, onExpand, onList, canAdd, onAdd, onOpenLink, onOpenBoard, onRetry }) {
  if (inbox.state === 'idle' || (inbox.state === 'loading' && !inbox.data)) {
    return <div style={{ flex: 1 }}><Empty>Reading the Inbox board…</Empty></div>;
  }
  if (inbox.state === 'error' && !inbox.data) {
    return (
      <div style={{ flex: 1, padding: '16px 14px', textAlign: 'center' }}>
        <div style={{ fontSize: 11, color: 'var(--dim)', lineHeight: 1.5, marginBottom: 10 }}>
          {INBOX_ERRORS[inbox.reason] || INBOX_ERRORS['bad-response']}
        </div>
        {inbox.reason !== 'not-installed' && <LinkButton onClick={onRetry}>Retry</LinkButton>}
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
        <div style={{ margin: '0 10px 6px', fontSize: 10, color: 'var(--danger)' }}>
          Couldn't refresh: {INBOX_ERRORS[inbox.reason] || INBOX_ERRORS['bad-response']} Showing the last read.
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 6px', borderTop: '1px solid var(--border)' }}>
        {cards.length === 0 && (
          <Empty>{query || source !== 'all' ? 'Nothing matches.' : 'Inbox zero. Nothing open on the board.'}</Empty>
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

function InboxCard({ card, today, expanded, onExpand, added, canAdd, onAdd, onOpenLink, onOpenBoard }) {
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
      </div>
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
