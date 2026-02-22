import { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';

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
    await autoCheckpoint(tabId);
    if (window.electronAPI) window.electronAPI.terminalKill(tabId);
    removeTab(tabId);
  }, [removeTab, autoCheckpoint]);

  // Middle-click to close (#24)
  const handleMouseDown = useCallback(async (e, tabId) => {
    if (e.button === 1 && tabs.length > 1) {
      e.preventDefault();
      await autoCheckpoint(tabId);
      if (window.electronAPI) window.electronAPI.terminalKill(tabId);
      removeTab(tabId);
    }
  }, [removeTab, tabs.length, autoCheckpoint]);

  // Right-click context menu (#25)
  const handleContextMenu = useCallback((e, tabId) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabId });
  }, []);

  // Drag-to-reorder (#26)
  const handleDragStart = useCallback((e, tabId) => {
    setDragTabId(tabId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tabId);
  }, []);

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

  const handleDragEnd = useCallback(() => {
    setDragTabId(null);
    setDragOverIdx(null);
  }, []);

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

              {/* Close button */}
              {tabs.length > 1 && (
                <span
                  onClick={(e) => handleCloseTab(e, tab.id)}
                  className="opacity-0 group-hover:opacity-100 ml-1 shrink-0"
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
                    transition: 'opacity 100ms',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--border)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
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
          onRename={() => {
            const tab = tabs.find((t) => t.id === contextMenu.tabId);
            if (tab) handleDoubleClick(tab);
            setContextMenu(null);
          }}
          onClose={() => {
            if (tabs.length > 1) {
              if (window.electronAPI) window.electronAPI.terminalKill(contextMenu.tabId);
              removeTab(contextMenu.tabId);
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
        />
      )}
    </div>
  );
}

function ContextMenu({ x, y, tabCount, tabIndex, onRename, onClose, onCloseOthers, onCloseToRight }) {
  const items = [
    { label: 'Rename', onClick: onRename },
    { label: 'Close', onClick: onClose, disabled: tabCount <= 1 },
    { label: 'Close Others', onClick: onCloseOthers, disabled: tabCount <= 1 },
    { label: 'Close to Right', onClick: onCloseToRight, disabled: tabIndex >= tabCount - 1 },
  ];

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
        minWidth: 160,
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
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
      ))}
    </div>
  );
}
