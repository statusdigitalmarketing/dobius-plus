import { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../../../store/store';
import { motion, AnimatePresence } from 'framer-motion';

function formatElapsed(startTime) {
  const secs = Math.max(0, Math.round((Date.now() - startTime) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

const STATUS_COLORS = {
  working: '#3FB950',
  idle: '#D29922',
  completed: 'var(--dim)',
};

const STATUS_LABELS = {
  working: 'Working',
  idle: 'Idle',
  completed: 'Completed',
};

export default function BoardView() {
  const runningAgents = useStore((s) => s.runningAgents);
  const agentActivity = useStore((s) => s.agentActivity);
  const activityTimeline = useStore((s) => s.activityTimeline);
  const setDashboardTab = useStore((s) => s.setDashboardTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const terminalTabs = useStore((s) => s.terminalTabs);
  const boardNotification = useStore((s) => s.boardNotification);
  const clearBoardNotification = useStore((s) => s.clearBoardNotification);

  const runningCount = Object.keys(runningAgents).length;

  // Clear notification badge when Board tab is active
  useEffect(() => {
    if (boardNotification) {
      // We're viewing the Board, so clear the badge
      clearBoardNotification();
    }
  }, []); // Run once on mount — user has navigated to Board

  // Auto-dismiss notification banner after 5s
  const [visibleNotification, setVisibleNotification] = useState(null);
  useEffect(() => {
    if (!boardNotification) return;
    setVisibleNotification(boardNotification);
    const timer = setTimeout(() => setVisibleNotification(null), 5000);
    return () => clearTimeout(timer);
  }, [boardNotification]);

  // Tick every second for elapsed time
  const [, setTick] = useState(0);
  useEffect(() => {
    if (runningCount === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [runningCount]);

  const handleView = useCallback((agentId) => {
    const tabId = runningAgents[agentId];
    if (!tabId) return;
    setActiveTab(tabId);
    setActiveView('terminal');
  }, [runningAgents, setActiveTab, setActiveView]);

  const handleStop = useCallback((agentId) => {
    const tabId = runningAgents[agentId];
    if (!tabId) return;
    if (window.electronAPI?.terminalKill) {
      window.electronAPI.terminalKill(tabId);
    }
  }, [runningAgents]);

  if (runningCount === 0) {
    return (
      <div className="p-5">
        <div className="mb-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--fg)', letterSpacing: '0.1em' }}>
            Board
          </h2>
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontSize: 10 }}>
            Live agent activity
          </div>
        </div>

        <div className="flex flex-col items-center justify-center py-16" style={{ color: 'var(--dim)' }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.4, marginBottom: 12 }}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
          </svg>
          <div className="text-xs mb-3" style={{ fontSize: 11 }}>No agents are currently running</div>
          <button
            onClick={() => setDashboardTab('agents')}
            style={{
              padding: '5px 14px',
              fontSize: 11,
              fontFamily: "'SF Mono', monospace",
              color: 'var(--bg)',
              backgroundColor: 'var(--accent)',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Go to Mission Control
          </button>
        </div>

        {/* Show timeline even when no agents running */}
        {activityTimeline.length > 0 && (
          <ActivityTimeline entries={activityTimeline} terminalTabs={terminalTabs} />
        )}
      </div>
    );
  }

  const agentEntries = Object.entries(runningAgents);

  return (
    <div className="p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--fg)', letterSpacing: '0.1em' }}>
            Board
          </h2>
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontSize: 10 }}>
            Live agent activity — {runningCount} agent{runningCount !== 1 ? 's' : ''} running
          </div>
        </div>
      </div>

      {/* Notification Banner */}
      <AnimatePresence>
        {visibleNotification && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="rounded-lg px-4 py-2 flex items-center justify-between"
            style={{
              backgroundColor: visibleNotification.exitCode === 0 ? 'rgba(63,185,80,0.1)' : 'rgba(248,81,73,0.1)',
              border: `1px solid ${visibleNotification.exitCode === 0 ? 'rgba(63,185,80,0.3)' : 'rgba(248,81,73,0.3)'}`,
            }}
          >
            <span style={{ fontSize: 11, fontFamily: "'SF Mono', monospace", color: visibleNotification.exitCode === 0 ? '#3FB950' : '#F85149' }}>
              {visibleNotification.agentName} completed (exit code {visibleNotification.exitCode ?? '?'})
            </span>
            <button
              onClick={() => setVisibleNotification(null)}
              style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 12, padding: '0 4px' }}
            >
              x
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Agent Cards Grid */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        <AnimatePresence mode="popLayout">
          {agentEntries.map(([agentId, tabId], i) => {
            const activity = agentActivity[agentId] || {};
            const tab = terminalTabs.find((t) => t.id === tabId);
            const agentName = tab?.label || agentId;
            const status = activity.status || 'working';
            const statusColor = STATUS_COLORS[status] || 'var(--dim)';

            return (
              <motion.div
                key={agentId}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ delay: i * 0.05, duration: 0.2 }}
                className="p-4 rounded-lg"
                style={{
                  backgroundColor: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                {/* Name + Status */}
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold" style={{ color: 'var(--fg)', fontSize: 13 }}>
                    {agentName}
                  </span>
                  <span className="inline-flex items-center gap-1" style={{ fontSize: 9, fontFamily: "'SF Mono', monospace" }}>
                    {status === 'working' && (
                      <motion.span
                        className="inline-block w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: statusColor }}
                        animate={{ opacity: [1, 0.4, 1] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                      />
                    )}
                    {status !== 'working' && (
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: statusColor }}
                      />
                    )}
                    <span style={{ color: statusColor }}>
                      {STATUS_LABELS[status] || status}
                    </span>
                  </span>
                </div>

                {/* Current Action */}
                <div
                  className="text-xs mb-2 truncate"
                  style={{
                    color: status === 'working' ? 'var(--fg)' : 'var(--dim)',
                    fontSize: 10,
                    fontFamily: "'SF Mono', monospace",
                    minHeight: 16,
                  }}
                >
                  {activity.currentAction || (status === 'idle' ? 'Waiting for output...' : 'Starting...')}
                </div>

                {/* Stats row */}
                <div className="flex items-center gap-4 mb-3" style={{ fontSize: 9, color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
                  <span>{activity.linesProcessed || 0} lines</span>
                  <span>{formatElapsed(activity.startTime || tab?.createdAt || Date.now())}</span>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <button
                    onClick={() => handleView(agentId)}
                    style={{
                      padding: '4px 12px',
                      fontSize: 10,
                      fontFamily: "'SF Mono', monospace",
                      color: 'var(--accent)',
                      backgroundColor: 'transparent',
                      border: '1px solid var(--accent)',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    View
                  </button>
                  <StopButton onStop={() => handleStop(agentId)} />
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Activity Timeline */}
      {activityTimeline.length > 0 && (
        <ActivityTimeline entries={activityTimeline} terminalTabs={terminalTabs} />
      )}
    </div>
  );
}

const TYPE_COLORS = {
  read: '#58A6FF',
  write: '#3FB950',
  bash: '#D29922',
  error: '#F85149',
  other: 'var(--dim)',
};

function ActivityTimeline({ entries, terminalTabs }) {
  const scrollRef = useRef(null);
  const prevLengthRef = useRef(entries.length);

  // Auto-scroll when new entries arrive
  useEffect(() => {
    if (entries.length > prevLengthRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLengthRef.current = entries.length;
  }, [entries.length]);

  // Show at most 50 entries
  const visible = entries.length > 50 ? entries.slice(-50) : entries;
  const hidden = entries.length > 50 ? entries.length - 50 : 0;

  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: 'var(--dim)', fontSize: 9, letterSpacing: '0.1em' }}>
        Activity Timeline ({entries.length})
      </div>
      <div
        ref={scrollRef}
        className="rounded-lg overflow-y-auto"
        style={{
          maxHeight: 300,
          backgroundColor: 'var(--surface)',
          border: '1px solid var(--border)',
        }}
      >
        {hidden > 0 && (
          <div className="px-3 py-1" style={{ fontSize: 9, color: 'var(--dim)', fontStyle: 'italic', borderBottom: '1px solid var(--border)' }}>
            {hidden} older entries hidden
          </div>
        )}
        {visible.map((entry, i) => {
          const time = new Date(entry.timestamp);
          const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;
          const tab = terminalTabs.find((t) => {
            // Find tab that matches agentId through runningAgents
            return t.label === entry.agentName;
          });
          const agentLabel = tab?.label || entry.agentName || entry.agentId;
          const color = TYPE_COLORS[entry.type] || TYPE_COLORS.other;

          return (
            <div
              key={`${entry.timestamp}-${i}`}
              className="flex items-center gap-2 px-3 py-1"
              style={{
                fontSize: 10,
                fontFamily: "'SF Mono', monospace",
                borderBottom: i < visible.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{ color: 'var(--dim)', flexShrink: 0 }}>{timeStr}</span>
              <span style={{ color: 'var(--accent)', flexShrink: 0 }}>{agentLabel}</span>
              <span style={{ color }}>—</span>
              <span
                style={{
                  color,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {entry.action}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StopButton({ onStop }) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  if (confirming) {
    return (
      <button
        onClick={onStop}
        style={{
          padding: '4px 12px',
          fontSize: 10,
          fontFamily: "'SF Mono', monospace",
          color: '#F85149',
          backgroundColor: 'rgba(248,81,73,0.1)',
          border: '1px solid #F85149',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Confirm Stop
      </button>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      style={{
        padding: '4px 12px',
        fontSize: 10,
        fontFamily: "'SF Mono', monospace",
        color: 'var(--dim)',
        backgroundColor: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 4,
        cursor: 'pointer',
      }}
    >
      Stop
    </button>
  );
}
