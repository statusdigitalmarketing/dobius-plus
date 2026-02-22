import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';

export default function Checkpoints() {
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const addTab = useStore((s) => s.addTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const activeTabId = useStore((s) => s.activeTabId);

  const [checkpoints, setCheckpoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');

  const loadCheckpoints = useCallback(async () => {
    if (!window.electronAPI?.checkpointList || !currentProjectPath) return;
    const list = await window.electronAPI.checkpointList(currentProjectPath);
    setCheckpoints(list || []);
    setLoading(false);
  }, [currentProjectPath]);

  useEffect(() => {
    loadCheckpoints();
  }, [loadCheckpoints]);

  const handleSave = useCallback(async () => {
    if (!window.electronAPI?.checkpointSave || !currentProjectPath || !activeTabId) return;
    setSaving(true);
    // Trigger terminal to flush its scrollback to disk, then read it back
    window.electronAPI.terminalRequestSaveNow?.();
    // Wait for save to flush (useTerminal saves synchronously on requestSave event)
    await new Promise((r) => setTimeout(r, 300));
    const state = await window.electronAPI.terminalLoadState(activeTabId);
    const checkpoint = {
      label: `Checkpoint ${checkpoints.length + 1}`,
      terminalId: activeTabId,
      scrollback: state?.scrollback || [],
      cols: state?.cols || 80,
      rows: state?.rows || 24,
    };
    await window.electronAPI.checkpointSave(currentProjectPath, checkpoint);
    await loadCheckpoints();
    setSaving(false);
  }, [currentProjectPath, activeTabId, checkpoints.length, loadCheckpoints]);

  const handleDelete = useCallback(async (cpId) => {
    if (!window.electronAPI?.checkpointDelete || !currentProjectPath) return;
    await window.electronAPI.checkpointDelete(currentProjectPath, cpId);
    await loadCheckpoints();
  }, [currentProjectPath, loadCheckpoints]);

  const handleRename = useCallback(async (cpId) => {
    if (!editValue.trim() || !window.electronAPI?.checkpointRename || !currentProjectPath) {
      setEditingId(null);
      return;
    }
    await window.electronAPI.checkpointRename(currentProjectPath, cpId, editValue.trim());
    await loadCheckpoints();
    setEditingId(null);
  }, [editValue, currentProjectPath, loadCheckpoints]);

  const handleRestore = useCallback((cp) => {
    if (!window.electronAPI || !activeTabId) return;
    // Write checkpoint scrollback as dimmed text to active terminal
    if (cp.scrollback?.length > 0) {
      for (const line of cp.scrollback) {
        window.electronAPI.terminalWrite(activeTabId, `\x1b[2m${line}\x1b[0m\r\n`);
      }
      window.electronAPI.terminalWrite(activeTabId, '\x1b[2m\x1b[38;5;240m── restored checkpoint ──\x1b[0m\r\n\r\n');
    }
    setActiveView('terminal');
  }, [activeTabId, setActiveView]);

  const handleFork = useCallback((cp) => {
    if (!currentProjectPath || !window.electronAPI) return;
    // Create new tab, then write checkpoint data to its terminal after a delay
    const tab = addTab(currentProjectPath);
    setActiveView('terminal');
    // Save checkpoint scrollback as the new tab's state so useTerminal restores it
    if (cp.scrollback?.length > 0) {
      window.electronAPI.terminalSaveState(tab.id, {
        scrollback: cp.scrollback,
        cols: cp.cols,
        rows: cp.rows,
        savedAt: Date.now(),
      });
    }
  }, [currentProjectPath, addTab, setActiveView]);

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded animate-pulse" style={{ backgroundColor: 'var(--surface)' }} />
        ))}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--fg)', letterSpacing: '0.1em' }}>
          Checkpoints
        </h2>
        <button
          onClick={handleSave}
          disabled={saving || !activeTabId}
          style={{
            padding: '5px 14px',
            fontSize: 11,
            fontFamily: "'SF Mono', monospace",
            color: saving ? 'var(--dim)' : 'var(--bg)',
            backgroundColor: saving ? 'var(--surface)' : 'var(--accent)',
            border: 'none',
            borderRadius: 6,
            cursor: saving ? 'default' : 'pointer',
            opacity: !activeTabId ? 0.4 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save Checkpoint'}
        </button>
      </div>

      {checkpoints.length === 0 ? (
        <div className="text-center py-12" style={{ color: 'var(--dim)' }}>
          <div className="text-2xl mb-2" style={{ opacity: 0.3 }}>&#x23F0;</div>
          <div className="text-xs">No checkpoints yet</div>
          <div className="text-xs mt-1" style={{ fontSize: 10 }}>
            Save a checkpoint to capture your terminal state
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {[...checkpoints].reverse().map((cp, i) => {
            const date = new Date(cp.timestamp);
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
            const lines = cp.scrollback?.length || 0;

            return (
              <div
                key={cp.id}
                className="flex items-center gap-3 p-3 rounded"
                style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                {/* Timeline dot */}
                <div className="flex flex-col items-center shrink-0" style={{ width: 32 }}>
                  <div
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: i === 0 ? 'var(--accent)' : 'var(--dim)' }}
                  />
                  {i < checkpoints.length - 1 && (
                    <div className="w-px flex-1 mt-1" style={{ backgroundColor: 'var(--border)', minHeight: 12 }} />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  {editingId === cp.id ? (
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={() => handleRename(cp.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(cp.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      spellCheck={false}
                      style={{
                        backgroundColor: 'var(--bg)',
                        color: 'var(--fg)',
                        border: '1px solid var(--accent)',
                        borderRadius: 4,
                        padding: '2px 6px',
                        fontSize: 12,
                        fontFamily: "'SF Mono', monospace",
                        outline: 'none',
                        width: '100%',
                      }}
                    />
                  ) : (
                    <div
                      className="text-xs font-medium truncate cursor-pointer"
                      style={{ color: 'var(--fg)' }}
                      onDoubleClick={() => { setEditingId(cp.id); setEditValue(cp.label); }}
                    >
                      {cp.label}
                    </div>
                  )}
                  <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', fontSize: 10 }}>
                    {dateStr} {timeStr} &middot; {lines} lines
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <ActionBtn label="Restore" onClick={() => handleRestore(cp)} />
                  <ActionBtn label="Fork" onClick={() => handleFork(cp)} />
                  <ActionBtn label="Delete" onClick={() => handleDelete(cp.id)} danger />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '3px 8px',
        fontSize: 10,
        fontFamily: "'SF Mono', monospace",
        color: danger ? '#F85149' : 'var(--dim)',
        backgroundColor: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 4,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = 'var(--border)';
        if (!danger) e.currentTarget.style.color = 'var(--fg)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
        e.currentTarget.style.color = danger ? '#F85149' : 'var(--dim)';
      }}
    >
      {label}
    </button>
  );
}
