import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../store/store';
import { motion, AnimatePresence } from 'framer-motion';

const TYPE_META = {
  add:       { label: 'ADD',   color: '#3FB950' },
  change:    { label: 'MOD',   color: '#58A6FF' },
  unlink:    { label: 'DEL',   color: '#f85149' },
  addDir:    { label: 'DIR+',  color: '#BC8CFF' },
  unlinkDir: { label: 'DIR-',  color: '#f0883e' },
};

function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ext(p) {
  const m = p.match(/\.([^./]+)$/);
  return m ? m[1].toLowerCase() : '';
}

export default function ChangeFeed() {
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const [events, setEvents] = useState([]);
  const [watching, setWatching] = useState(false);
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // 'all' | 'add' | 'change' | 'unlink'
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const bottomRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  pausedRef.current = paused;

  const startWatching = useCallback(async () => {
    if (!currentProjectPath || !window.electronAPI?.filewatcherWatch) return;
    await window.electronAPI.filewatcherWatch(currentProjectPath);
    // Load any events that already happened since watcher started
    const existing = await window.electronAPI.filewatcherGetEvents?.(currentProjectPath) || [];
    setEvents(existing);
    setWatching(true);
  }, [currentProjectPath]);

  const stopWatching = useCallback(async () => {
    if (!currentProjectPath || !window.electronAPI?.filewatcherUnwatch) return;
    await window.electronAPI.filewatcherUnwatch(currentProjectPath);
    setWatching(false);
  }, [currentProjectPath]);

  // Subscribe to live events
  useEffect(() => {
    if (!window.electronAPI?.onFilewatcherChange) return;
    const unsub = window.electronAPI.onFilewatcherChange((projectPath, entry) => {
      if (projectPath !== currentProjectPath || pausedRef.current) return;
      setEvents((prev) => {
        const next = [...prev, entry];
        return next.length > 500 ? next.slice(-500) : next;
      });
    });
    return unsub;
  }, [currentProjectPath]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events, autoScroll]);

  // Stop watcher when the project changes or the component unmounts — otherwise
  // the chokidar watcher in the main process leaks every time the user switches
  // dashboard tabs or projects.
  useEffect(() => {
    setEvents([]);
    setWatching(false);
    return () => {
      if (currentProjectPath && window.electronAPI?.filewatcherUnwatch) {
        window.electronAPI.filewatcherUnwatch(currentProjectPath);
      }
    };
  }, [currentProjectPath]);

  const filteredEvents = events.filter((e) => {
    if (typeFilter !== 'all' && e.type !== typeFilter) return false;
    if (filter && !e.path.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  if (!currentProjectPath) {
    return (
      <div className="p-4 flex items-center justify-center h-40">
        <span className="text-xs" style={{ color: 'var(--dim)' }}>Open a project to watch its file changes.</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {/* Controls */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        {!watching ? (
          <button
            onClick={startWatching}
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{ backgroundColor: 'var(--accent)', color: '#000' }}
          >
            Start Watching
          </button>
        ) : (
          <>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: '#3FB950' }} />
              <span className="text-xs" style={{ color: '#3FB950' }}>Watching</span>
            </div>
            <button
              onClick={() => setPaused((p) => !p)}
              className="px-3 py-1.5 rounded text-xs"
              style={{ color: 'var(--dim)', border: '1px solid var(--border)' }}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              onClick={stopWatching}
              className="px-3 py-1.5 rounded text-xs"
              style={{ color: '#f85149', border: '1px solid var(--border)' }}
            >
              Stop
            </button>
          </>
        )}

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by path…"
          className="flex-1 px-3 py-1.5 rounded text-xs outline-none min-w-0"
          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg)' }}
        />

        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-2 py-1.5 rounded text-xs outline-none"
          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--dim)' }}
        >
          <option value="all">All types</option>
          <option value="add">Added</option>
          <option value="change">Modified</option>
          <option value="unlink">Deleted</option>
        </select>

        {events.length > 0 && (
          <button
            onClick={() => setEvents([])}
            className="px-2 py-1.5 rounded text-xs"
            style={{ color: 'var(--dim)', border: '1px solid var(--border)' }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Project path */}
      <div className="text-xs truncate shrink-0" style={{ color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
        {currentProjectPath}
        {paused && <span className="ml-2" style={{ color: '#f0883e' }}>[paused]</span>}
      </div>

      {/* Event list */}
      <div
        className="flex-1 overflow-y-auto rounded-lg"
        style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
          setAutoScroll(near);
        }}
      >
        {filteredEvents.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <span className="text-xs" style={{ color: 'var(--dim)' }}>
              {watching ? 'Watching… no changes yet.' : 'Not watching.'}
            </span>
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            <AnimatePresence initial={false}>
              {filteredEvents.map((ev, i) => {
                const meta = TYPE_META[ev.type] || { label: ev.type.toUpperCase(), color: 'var(--dim)' };
                return (
                  <motion.div
                    key={`${ev.timestamp}-${i}`}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.1 }}
                    className="flex items-center gap-2 px-2 py-1 rounded"
                    style={{ fontFamily: "'SF Mono', monospace" }}
                  >
                    <span
                      className="text-xs font-bold w-10 shrink-0 text-center rounded"
                      style={{ color: meta.color, fontSize: 9 }}
                    >
                      {meta.label}
                    </span>
                    <span className="text-xs flex-1 truncate" style={{ color: 'var(--fg)' }}>
                      {ev.path}
                    </span>
                    <span className="text-xs shrink-0" style={{ color: 'var(--dim)', fontSize: 9 }}>
                      {timeStr(ev.timestamp)}
                    </span>
                  </motion.div>
                );
              })}
            </AnimatePresence>
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Footer stats */}
      {events.length > 0 && (
        <div className="flex items-center gap-3 shrink-0 text-xs" style={{ color: 'var(--dim)' }}>
          <span>{filteredEvents.length} event{filteredEvents.length !== 1 ? 's' : ''}</span>
          {Object.entries(
            filteredEvents.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {})
          ).map(([type, count]) => {
            const meta = TYPE_META[type];
            return meta ? (
              <span key={type} style={{ color: meta.color, fontSize: 9 }}>
                {meta.label} {count}
              </span>
            ) : null;
          })}
          <button
            className="ml-auto text-xs"
            style={{ color: autoScroll ? 'var(--accent)' : 'var(--dim)' }}
            onClick={() => setAutoScroll((v) => !v)}
          >
            Auto-scroll {autoScroll ? 'on' : 'off'}
          </button>
        </div>
      )}
    </div>
  );
}
