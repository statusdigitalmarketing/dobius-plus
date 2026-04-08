import { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';
import { markDoNotKill } from '../../hooks/useTerminal';

export default function TerminalTabBar() {
  const tabs = useStore((s) => s.terminalTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const removeTab = useStore((s) => s.removeTab);
  const renameTab = useStore((s) => s.renameTab);
  const addTab = useStore((s) => s.addTab);
  const reorderTabs = useStore((s) => s.reorderTabs);
  const closeOtherTabs = useStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useStore((s) => s.closeTabsToRight);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const pushClosedTab = useStore((s) => s.pushClosedTab);
  const togglePinTab = useStore((s) => s.togglePinTab);

  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [contextMenu, setContextMenu] = useState(null); // { x, y, tabId }
  const [dragTabId, setDragTabId] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);
  const editRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  // Check scroll overflow
  const checkOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeftArrow(el.scrollLeft > 0);
    setShowRightArrow(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    checkOverflow();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkOverflow);
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', checkOverflow);
      observer.disconnect();
    };
  }, [checkOverflow, tabs.length]);

  // Close context menu on click anywhere
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const handleDoubleClick = useCallback((tab) => {
    setEditingId(tab.id);
    setEditValue(tab.label);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId && editValue.trim()) {
      renameTab(editingId, editValue.trim());
    }
    setEditingId(null);
  }, [editingId, editValue, renameTab]);

  const handleEditKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      setEditingId(null);
    }
  }, [commitRename]);

  const autoCheckpoint = useCallback(async (tabId) => {
    if (!window.electronAPI?.checkpointSave || !currentProjectPath) return;
    // Trigger save, wait, read state, save checkpoint
    await window.electronAPI.terminalRequestSaveNow?.();
    await new Promise((r) => setTimeout(r, 200));
    const state = await window.electronAPI.terminalLoadState(tabId);
    if (state?.scrollback?.length > 0) {
      const tab = tabs.find((t) => t.id === tabId);
      await window.electronAPI.checkpointSave(currentProjectPath, {
        label: `Auto: ${tab?.label || 'closed tab'}`,
        terminalId: tabId,
        scrollback: state.scrollback,
        cols: state.cols || 80,
        rows: state.rows || 24,
      });
    }
  }, [currentProjectPath, tabs]);

  const handleCloseTab = useCallback(async (e, tabId) => {
    e.stopPropagation();
    const tab = tabs.find((t) => t.id === tabId);
    // Pinned tabs require confirmation
    if (tab?.pinned) {
      const confirmed = window.confirm(`"${tab.label}" is pinned. Close anyway?`);
      if (!confirmed) return;
    }
    // Save tab info + scrollback for Cmd+Shift+T reopen
    let scrollback = null;
    if (window.electronAPI?.terminalLoadState) {
      await window.electronAPI.terminalRequestSaveNow?.();
      await new Promise((r) => setTimeout(r, 200));
      const state = await window.electronAPI.terminalLoadState(tabId);
      scrollback = state?.scrollback || null;
    }
    if (tab) {
      pushClosedTab({ label: tab.label, projectPath: tab.projectPath, scrollback });
    }
    await autoCheckpoint(tabId);
    if (window.electronAPI) window.electronAPI.terminalKill(tabId);
    removeTab(tabId);
  }, [removeTab, autoCheckpoint, tabs, pushClosedTab]);

  // Middle-click to close (#24)
  const handleMouseDown = useCallback(async (e, tabId) => {
    if (e.button === 1 && tabs.length > 1) {
      e.preventDefault();
      const tab = tabs.find((t) => t.id === tabId);
      let scrollback = null;
      if (window.electronAPI?.terminalLoadState) {
        await window.electronAPI.terminalRequestSaveNow?.();
        await new Promise((r) => setTimeout(r, 200));
        const state = await window.electronAPI.terminalLoadState(tabId);
        scrollback = state?.scrollback || null;
      }
      if (tab) {
        pushClosedTab({ label: tab.label, projectPath: tab.projectPath, scrollback });
      }
      await autoCheckpoint(tabId);
      if (window.electronAPI) window.electronAPI.terminalKill(tabId);
      removeTab(tabId);
    }
  }, [removeTab, tabs, autoCheckpoint, pushClosedTab]);

  // Right-click context menu (#25)
  const handleContextMenu = useCallback((e, tabId) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  }, []);


  // Track whether the drag has left the window (for tear-off detection)
  const dragLeftWindow = useRef(false);

  // Drag-to-reorder (#26) + drag-out-of-window for tab tear-off
  const handleDragStart = useCallback((e, tabId) => {
    setDragTabId(tabId);
    dragLeftWindow.current = false;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
  }, []);

  // Detect when drag leaves the document (cursor exits the window)
  useEffect(() => {
    if (!dragTabId) return;
    const handleDocDragLeave = (e) => {
      // When the cursor truly leaves the window, e.relatedTarget is null
      // and clientX/clientY are at 0,0 or out of bounds
      if (!e.relatedTarget && (e.clientX <= 0 || e.clientY <= 0 ||
          e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)) {
        dragLeftWindow.current = true;
      }
    };
    const handleDocDragEnter = () => {
      dragLeftWindow.current = false;
    };
    document.addEventListener('dragleave', handleDocDragLeave);
    document.addEventListener('dragenter', handleDocDragEnter);
    return () => {
      document.removeEventListener('dragleave', handleDocDragLeave);
      document.removeEventListener('dragenter', handleDocDragEnter);
    };
  }, [dragTabId]);

  const handleDragOver = useCallback((e, idx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIdx(idx);
  }, []);

  const handleDrop = useCallback((e, toIdx) => {
    e.preventDefault();
    if (dragTabId == null) return;
    const fromIdx = tabs.findIndex((t) => t.id === dragTabId);
    if (fromIdx !== -1 && fromIdx !== toIdx) {
      reorderTabs(fromIdx, toIdx);
    }
    setDragTabId(null);
    setDragOverIdx(null);
  }, [dragTabId, tabs, reorderTabs]);

  const handleDragEnd = useCallback(async (e) => {
    const tabId = dragTabId;
    // Capture screen coordinates before any async work (event may be recycled)
    const sx = e.screenX;
    const sy = e.screenY;

    setDragTabId(null);
    setDragOverIdx(null);

    if (!tabId || !currentProjectPath) return;

    // Detect if the drag ended outside the window.
    // Rely on the dragleave tracker — Electron zeros clientX/clientY for
    // out-of-window drops which would cause false positives with coordinate checks.
    if (!dragLeftWindow.current) return;
    if (tabs.length <= 1) return; // Don't tear off the last tab

    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Mark this terminal as "do not kill" BEFORE removing the tab.
    // This prevents useTerminal's cleanup from killing the PTY when React
    // unmounts the TerminalPane in the old window.
    markDoNotKill(tabId);

    // Save terminal state so the new window can restore scrollback.
    // Await + small delay to ensure the IPC roundtrip completes (same pattern
    // as handleCloseTab's checkpoint save).
    await window.electronAPI?.terminalRequestSaveNow?.();
    await new Promise((r) => setTimeout(r, 200));

    // Re-check that the tab still exists after the async wait (it could have
    // been closed by Cmd+W or another action during the delay)
    if (!useStore.getState().terminalTabs.find((t) => t.id === tabId)) {
      return;
    }

    // Create new window for the torn-off tab.
    window.electronAPI?.windowTearOffTab(
      currentProjectPath,
      tabId,
      tab.label,
      sx,
      sy
    );

    // Remove tab from this window without killing the PTY
    removeTab(tabId);
  }, [dragTabId, tabs, currentProjectPath, removeTab]);

  // Poll active process for each tab (for status badges)
  const [tabProcesses, setTabProcesses] = useState({});
  useEffect(() => {
    if (!window.electronAPI?.terminalGetProcess || tabs.length === 0) return;
    const poll = async () => {
      const result = {};
      for (const tab of tabs) {
        try {
          const proc = await window.electronAPI.terminalGetProcess(tab.id);
          if (proc) result[tab.id] = proc;
        } catch { /* ignore */ }
      }
      setTabProcesses(result);
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [tabs]);

  // Scroll arrows (#27)
  const scrollBy = useCallback((dir) => {
    scrollRef.current?.scrollBy({ left: dir * 150, behavior: 'smooth' });
  }, []);

  if (tabs.length === 0) return null;

  return (
    <div
      className="flex items-center shrink-0"
      style={{
        height: 32,
        backgroundColor: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Left scroll arrow */}
      {showLeftArrow && (
        <button
          onClick={() => scrollBy(-1)}
          style={{
            width: 20, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--dim)', backgroundColor: 'var(--surface)', border: 'none', cursor: 'pointer',
            fontSize: 11, fontFamily: "'SF Mono', monospace", shrink: 0, zIndex: 2,
            borderRight: '1px solid var(--border)',
          }}
        >
          ‹
        </button>
      )}

      <div
        ref={scrollRef}
        className="flex items-center flex-1 min-w-0 overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
      >
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          const isDragging = tab.id === dragTabId;
          const isDragTarget = idx === dragOverIdx && dragTabId !== tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onDoubleClick={() => handleDoubleClick(tab)}
              onMouseDown={(e) => handleMouseDown(e, tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab.id)}
              draggable
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDrop={(e) => handleDrop(e, idx)}
              onDragEnd={handleDragEnd}
              className="group relative flex items-center gap-1 shrink-0"
              style={{
                height: 32,
                padding: '0 8px 0 12px',
                fontSize: 11,
                fontFamily: "'SF Mono', monospace",
                color: isActive ? 'var(--fg)' : 'var(--dim)',
                backgroundColor: isActive ? 'var(--bg)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                borderRight: '1px solid var(--border)',
                maxWidth: 180,
                minWidth: 60,
                opacity: isDragging ? 0.4 : 1,
                borderLeft: isDragTarget ? '2px solid var(--accent)' : 'none',
              }}
            >
              {/* Active indicator */}
              {isActive && (
                <span
                  className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full"
                  style={{ backgroundColor: 'var(--accent)' }}
                />
              )}

              {/* Process status badge */}
              {tabProcesses[tab.id] && (
                <span
                  title={tabProcesses[tab.id]}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: tabProcesses[tab.id].includes('claude') ? '#3FB950' : '#D29922',
                    flexShrink: 0,
                  }}
                />
              )}

              {/* Pin indicator */}
              {tab.pinned && (
                <span style={{ fontSize: 9, color: 'var(--dim)', flexShrink: 0, lineHeight: 1 }} title="Pinned">
                  {'//'}
                </span>
              )}

              {/* Label or edit input */}
              {editingId === tab.id ? (
                <input
                  ref={editRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={handleEditKeyDown}
                  spellCheck={false}
                  style={{
                    backgroundColor: 'transparent',
                    color: 'var(--fg)',
                    border: 'none',
                    outline: 'none',
                    fontFamily: "'SF Mono', monospace",
                    fontSize: 11,
                    width: '100%',
                    padding: 0,
                  }}
                />
              ) : (
                <span className="truncate">{tab.label}</span>
              )}

              {/* Close button — only visible on active tab to prevent accidental closes */}
              {tabs.length > 1 && isActive && (
                <span
                  onClick={(e) => handleCloseTab(e, tab.id)}
                  className="ml-1 shrink-0"
                  style={{
                    width: 16,
                    height: 16,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 3,
                    fontSize: 12,
                    lineHeight: 1,
                    color: 'var(--dim)',
                    cursor: 'pointer',
                    opacity: 0.6,
                    transition: 'opacity 100ms, background-color 100ms',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--border)'; e.currentTarget.style.opacity = '1'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.opacity = '0.6'; }}
                >
                  x
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Right scroll arrow */}
      {showRightArrow && (
        <button
          onClick={() => scrollBy(1)}
          style={{
            width: 20, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--dim)', backgroundColor: 'var(--surface)', border: 'none', cursor: 'pointer',
            fontSize: 11, fontFamily: "'SF Mono', monospace", shrink: 0, zIndex: 2,
            borderLeft: '1px solid var(--border)',
          }}
        >
          ›
        </button>
      )}

      {/* New tab button */}
      <button
        onClick={() => addTab(currentProjectPath)}
        title="New Tab (Cmd+T)"
        style={{
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 4,
          marginLeft: 2,
          borderRadius: 4,
          fontSize: 16,
          lineHeight: 1,
          color: 'var(--dim)',
          backgroundColor: 'transparent',
          border: 'none',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--border)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        +
      </button>

      {/* Context menu (#25) */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          tabId={contextMenu.tabId}
          tabCount={tabs.length}
          tabIndex={tabs.findIndex((t) => t.id === contextMenu.tabId)}
          isPinned={!!tabs.find((t) => t.id === contextMenu.tabId)?.pinned}
          onRename={() => {
            const tab = tabs.find((t) => t.id === contextMenu.tabId);
            if (tab) handleDoubleClick(tab);
            setContextMenu(null);
          }}
          onClose={async () => {
            if (tabs.length > 1) {
              await handleCloseTab({ stopPropagation: () => {} }, contextMenu.tabId);
            }
            setContextMenu(null);
          }}
          onCloseOthers={() => {
            closeOtherTabs(contextMenu.tabId);
            setContextMenu(null);
          }}
          onCloseToRight={() => {
            closeTabsToRight(contextMenu.tabId);
            setContextMenu(null);
          }}
          onPin={() => {
            togglePinTab(contextMenu.tabId);
            setContextMenu(null);
          }}
          onDismiss={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function ContextMenu({ x, y, tabCount, tabIndex, isPinned, onRename, onClose, onCloseOthers, onCloseToRight, onPin, onDismiss }) {
  const recentlyClosedTabs = useStore((s) => s.recentlyClosedTabs);
  const reopenClosedTab = useStore((s) => s.reopenClosedTab);

  const items = [
    { label: isPinned ? 'Unpin Tab' : 'Pin Tab', onClick: onPin },
    { label: 'Rename', onClick: onRename },
    { type: 'divider' },
    { label: 'Close', onClick: onClose, disabled: tabCount <= 1 },
    { label: 'Close Others', onClick: onCloseOthers, disabled: tabCount <= 1 },
    { label: 'Close to Right', onClick: onCloseToRight, disabled: tabIndex >= tabCount - 1 },
  ];

  const handleReopen = (idx) => {
    const result = reopenClosedTab(idx);
    if (result?.tab && result?.scrollback?.length > 0) {
      setTimeout(() => {
        window.electronAPI?.terminalSaveState?.(result.tab.id, {
          scrollback: result.scrollback,
          cols: 80, rows: 24, savedAt: Date.now(),
        });
      }, 100);
    }
    onDismiss();
  };

  return (
    <div
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 200,
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '4px 0',
        minWidth: 200,
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        item.type === 'divider' ? (
          <div key={`div-${i}`} style={{ height: 1, backgroundColor: 'var(--border)', margin: '4px 0' }} />
        ) : (
          <button
            key={item.label}
            onClick={item.disabled ? undefined : item.onClick}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '5px 14px',
              fontSize: 11,
              fontFamily: "'SF Mono', monospace",
              color: item.disabled ? 'var(--border)' : 'var(--fg)',
              backgroundColor: 'transparent',
              border: 'none',
              cursor: item.disabled ? 'default' : 'pointer',
            }}
            onMouseEnter={(e) => { if (!item.disabled) e.currentTarget.style.backgroundColor = 'var(--border)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            {item.label}
          </button>
        )
      )}

      {/* Reopen closed tabs section */}
      {recentlyClosedTabs.length > 0 && (
        <>
          <div style={{ height: 1, backgroundColor: 'var(--border)', margin: '4px 0' }} />
          <div style={{ padding: '3px 14px', fontSize: 10, color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>
            Reopen Closed Tab
          </div>
          {recentlyClosedTabs.slice(0, 8).map((closed, idx) => (
            <button
              key={`closed-${idx}`}
              onClick={() => handleReopen(idx)}
              style={{
                display: 'flex',
                width: '100%',
                textAlign: 'left',
                padding: '4px 14px',
                fontSize: 11,
                fontFamily: "'SF Mono', monospace",
                color: 'var(--fg)',
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
                gap: 8,
                alignItems: 'center',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--border)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <span className="truncate" style={{ flex: 1 }}>{closed.label || 'Tab'}</span>
              <span style={{ color: 'var(--dim)', fontSize: 10, flexShrink: 0 }}>{timeAgo(closed.closedAt)}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
