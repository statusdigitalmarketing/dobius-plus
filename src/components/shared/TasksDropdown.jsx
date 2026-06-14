import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../store/store';

const SOURCE_COLORS = {
  asana:  { bg: 'rgba(248,115,0,0.12)',  text: '#F87300' },
  bot:    { bg: 'rgba(88,166,255,0.12)', text: 'var(--accent)' },
  manual: { bg: 'rgba(139,148,158,0.12)', text: 'var(--dim)' },
};

// Lane = who the Asana task is assigned to. Build = mine (blue), review = Sam's (purple).
const LANE_COLORS = {
  build:  { stripe: '#58A6FF', bg: 'rgba(88,166,255,0.14)',  text: '#58A6FF', label: 'Mine' },
  review: { stripe: '#A371F7', bg: 'rgba(163,113,247,0.14)', text: '#A371F7', label: "Sam · review" },
};

export default function TasksDropdown() {
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [newTitle, setNewTitle] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [adding, setAdding] = useState(false);
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);

  const pendingCount = tasks.filter((t) => !t.done).length;

  const load = useCallback(async () => {
    if (!currentProjectPath || !window.electronAPI?.tasksList) return;
    const list = await window.electronAPI.tasksList(currentProjectPath);
    setTasks(list || []);
  }, [currentProjectPath]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Live refresh when a task is completed from a terminal (dobius-task-done).
  // Reload whenever the event has no path or matches the current project, so
  // the badge count and checkboxes update without reopening the panel.
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
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleToggle = (taskId, done) => {
    if (!window.electronAPI?.tasksUpdate) return;
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, done } : t));
    window.electronAPI.tasksUpdate(currentProjectPath, taskId, { done });
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
      setSyncMsg(`+${result.added} from Asana`);
      await load();
    } else {
      setSyncMsg(result?.error || 'Sync failed');
    }
    setSyncing(false);
    setTimeout(() => setSyncMsg(''), 4000);
  };

  const done = tasks.filter((t) => t.done);
  const pending = tasks.filter((t) => !t.done);

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        title="Project Tasks"
        className="no-drag"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 8px',
          fontSize: 11,
          fontFamily: "'SF Mono', monospace",
          color: open ? 'var(--fg)' : 'var(--dim)',
          backgroundColor: open ? 'var(--surface)' : 'transparent',
          border: `1px solid ${open ? 'var(--border)' : 'transparent'}`,
          borderRadius: 5,
          cursor: 'pointer',
          transition: 'all 150ms',
        }}
      >
        {/* Checklist icon */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
        </svg>
        Tasks
        {pendingCount > 0 && (
          <span style={{
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 8,
            backgroundColor: 'var(--accent)',
            color: 'var(--bg)',
            fontSize: 9,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {pendingCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              right: 0,
              width: 320,
              maxHeight: 480,
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              zIndex: 9999,
            }}
          >
            {/* Header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 12px 8px',
              borderBottom: '1px solid var(--border)',
            }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Tasks
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {syncMsg && (
                  <span style={{ fontSize: 9, color: syncMsg.startsWith('+') ? '#3FB950' : 'var(--danger)', fontFamily: "'SF Mono', monospace" }}>
                    {syncMsg}
                  </span>
                )}
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  title="Sync from Asana"
                  style={{
                    fontSize: 9,
                    fontFamily: "'SF Mono', monospace",
                    color: syncing ? 'var(--dim)' : '#F87300',
                    backgroundColor: 'transparent',
                    border: '1px solid rgba(248,115,0,0.3)',
                    borderRadius: 4,
                    padding: '2px 7px',
                    cursor: syncing ? 'default' : 'pointer',
                    transition: 'all 150ms',
                  }}
                >
                  {syncing ? 'Syncing…' : '⟳ Asana'}
                </button>
              </div>
            </div>

            {/* Task list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
              {tasks.length === 0 && (
                <div style={{ padding: '20px 12px', textAlign: 'center', color: 'var(--dim)', fontSize: 11 }}>
                  No tasks yet. Add one below or sync from Asana.
                </div>
              )}

              {/* Pending */}
              {pending.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              ))}

              {/* Done section */}
              {done.length > 0 && (
                <>
                  <div style={{
                    padding: '6px 12px 3px',
                    fontSize: 9,
                    fontFamily: "'SF Mono', monospace",
                    color: 'var(--dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}>
                    Done ({done.length})
                  </div>
                  {done.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onToggle={handleToggle}
                      onDelete={handleDelete}
                    />
                  ))}
                </>
              )}
            </div>

            {/* Add task input */}
            <div style={{
              borderTop: '1px solid var(--border)',
              padding: '8px 10px',
              display: 'flex',
              gap: 6,
            }}>
              <input
                ref={inputRef}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
                placeholder="Add a task…"
                style={{
                  flex: 1,
                  backgroundColor: 'var(--bg)',
                  color: 'var(--fg)',
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  padding: '5px 8px',
                  fontSize: 11,
                  outline: 'none',
                  fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
                }}
              />
              <button
                onClick={handleAdd}
                disabled={!newTitle.trim() || adding}
                style={{
                  padding: '5px 10px',
                  fontSize: 11,
                  fontFamily: "'SF Mono', monospace",
                  color: newTitle.trim() ? 'var(--bg)' : 'var(--dim)',
                  backgroundColor: newTitle.trim() ? 'var(--accent)' : 'var(--border)',
                  border: 'none',
                  borderRadius: 5,
                  cursor: newTitle.trim() ? 'pointer' : 'default',
                  transition: 'all 150ms',
                  whiteSpace: 'nowrap',
                }}
              >
                Add
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TaskRow({ task, onToggle, onDelete }) {
  const [hovered, setHovered] = useState(false);
  const src = SOURCE_COLORS[task.source] || SOURCE_COLORS.manual;
  const lane = task.lane ? LANE_COLORS[task.lane] : null;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 12px',
        borderLeft: `3px solid ${lane ? lane.stripe : 'transparent'}`,
        backgroundColor: hovered ? 'var(--surface-hover)' : 'transparent',
        transition: 'background 100ms',
      }}
    >
      {/* Checkbox */}
      <button
        onClick={() => onToggle(task.id, !task.done)}
        style={{
          marginTop: 1,
          flexShrink: 0,
          width: 15,
          height: 15,
          borderRadius: 3,
          border: `1.5px solid ${task.done ? 'var(--accent)' : 'var(--dim)'}`,
          backgroundColor: task.done ? 'var(--accent)' : 'transparent',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 150ms',
        }}
      >
        {task.done && (
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
            <path d="M2 6l3 3 5-5" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          fontSize: 11,
          color: task.done ? 'var(--dim)' : 'var(--fg)',
          textDecoration: task.done ? 'line-through' : 'none',
          lineHeight: 1.4,
          wordBreak: 'break-word',
        }}>
          {task.title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
          {lane ? (
            <span style={{
              fontSize: 8,
              padding: '1px 5px',
              borderRadius: 3,
              backgroundColor: lane.bg,
              color: lane.text,
              fontFamily: "'SF Mono', monospace",
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
              {lane.label}
            </span>
          ) : task.source !== 'manual' && (
            <span style={{
              fontSize: 8,
              padding: '1px 5px',
              borderRadius: 3,
              backgroundColor: src.bg,
              color: src.text,
              fontFamily: "'SF Mono', monospace",
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
              {task.source}
            </span>
          )}
          {task.dueOn && (
            <span style={{ fontSize: 9, color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
              {task.dueOn}
            </span>
          )}
        </div>
      </div>

      {/* Delete */}
      {hovered && (
        <button
          onClick={() => onDelete(task.id)}
          style={{
            flexShrink: 0,
            background: 'none',
            border: 'none',
            color: 'var(--dim)',
            cursor: 'pointer',
            fontSize: 12,
            padding: '0 2px',
            opacity: 0.6,
            lineHeight: 1,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--danger)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.color = 'var(--dim)'; }}
        >
          ×
        </button>
      )}
    </div>
  );
}
