import { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from '../../store/store';

export default function TerminalTabBar() {
  const tabs = useStore((s) => s.terminalTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const removeTab = useStore((s) => s.removeTab);
  const renameTab = useStore((s) => s.renameTab);
  const addTab = useStore((s) => s.addTab);
  const currentProjectPath = useStore((s) => s.currentProjectPath);

  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const editRef = useRef(null);

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

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

  const handleCloseTab = useCallback((e, tabId) => {
    e.stopPropagation();
    // Kill the terminal PTY before removing the tab
    if (window.electronAPI) {
      window.electronAPI.terminalKill(tabId);
    }
    removeTab(tabId);
  }, [removeTab]);

  if (tabs.length === 0) return null;

  return (
    <div
      className="flex items-center shrink-0"
      style={{
        height: 32,
        backgroundColor: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      <div className="flex items-center flex-1 min-w-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onDoubleClick={() => handleDoubleClick(tab)}
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
          shrink: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--border)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        +
      </button>
    </div>
  );
}
