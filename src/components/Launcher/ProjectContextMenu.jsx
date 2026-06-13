import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const ITEM_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '6px 12px',
  fontSize: 12,
  fontFamily: "'SF Mono', monospace",
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--fg)',
  borderRadius: 4,
  whiteSpace: 'nowrap',
};

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button
      style={{ ...ITEM_STYLE, color: danger ? '#f85149' : 'var(--fg)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.backgroundColor = danger ? 'rgba(248,81,73,0.12)' : 'var(--border)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = 'transparent';
      }}
      onClick={onClick}
    >
      <span style={{ width: 14, textAlign: 'center', opacity: 0.7 }}>{icon}</span>
      {label}
    </button>
  );
}

function Divider() {
  return <div style={{ height: 1, backgroundColor: 'var(--border)', margin: '3px 0' }} />;
}

export default function ProjectContextMenu({ x, y, project, isPinned, isOpen, onClose, onOpen, onRename, onTogglePin, onRemove }) {
  const ref = useRef(null);
  const [accounts, setAccounts] = useState([]);
  const [projectAccountId, setProjectAccountId] = useState(null);

  useEffect(() => {
    if (!project.decodedPath) return;
    window.electronAPI?.accountsList?.().then((list) => setAccounts(list || []));
    window.electronAPI?.accountsGetForProject?.(project.decodedPath).then((acct) => {
      setProjectAccountId(acct?.id || null);
    });
  }, [project.decodedPath]);

  // Adjust position to stay within viewport
  const MENU_W = 200;
  const MENU_H = 220 + accounts.length * 28;
  const left = x + MENU_W > window.innerWidth ? x - MENU_W : x;
  const top = y + MENU_H > window.innerHeight ? y - MENU_H : y;

  useEffect(() => {
    const handleDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const handleKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const act = (fn) => (e) => {
    e.stopPropagation();
    onClose();
    fn();
  };

  const hasPath = Boolean(project.decodedPath);

  const assignAccount = async (accountId) => {
    await window.electronAPI?.accountsSetForProject?.(project.decodedPath, accountId || null);
    setProjectAccountId(accountId || null);
  };

  const menu = (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 9999,
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '4px',
        minWidth: MENU_W,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItem icon="↗" label="Open" onClick={act(onOpen)} />
      {hasPath && (
        <MenuItem
          icon="⌘"
          label={isOpen ? 'Close Window' : 'Open in New Window'}
          onClick={act(onOpen)}
        />
      )}
      <Divider />
      <MenuItem icon="✏" label="Rename" onClick={act(onRename)} />
      <MenuItem
        icon={isPinned ? '★' : '��'}
        label={isPinned ? 'Unpin from Favorites' : 'Pin to Favorites'}
        onClick={act(onTogglePin)}
      />
      <Divider />
      {hasPath && (
        <MenuItem
          icon="📂"
          label="Open in Finder"
          onClick={act(() => window.electronAPI?.shellShowInFinder?.(project.decodedPath))}
        />
      )}
      {hasPath && (
        <MenuItem
          icon="⎘"
          label="Copy Path"
          onClick={act(() => navigator.clipboard.writeText(project.decodedPath))}
        />
      )}
      {hasPath && accounts.length > 0 && (
        <>
          <Divider />
          <div style={{ padding: '4px 12px 2px', fontSize: 10, color: 'var(--dim)', fontFamily: "'SF Mono', monospace", opacity: 0.7 }}>
            ACCOUNT
          </div>
          {accounts.map((acct) => (
            <MenuItem
              key={acct.id}
              icon={projectAccountId === acct.id ? '●' : '○'}
              label={acct.name}
              onClick={act(() => assignAccount(projectAccountId === acct.id ? null : acct.id))}
            />
          ))}
          {projectAccountId && (
            <MenuItem icon="⊘" label="Clear Account" onClick={act(() => assignAccount(null))} />
          )}
        </>
      )}
      <Divider />
      <MenuItem icon="✕" label="Remove from List" onClick={act(onRemove)} danger />
    </div>
  );

  return createPortal(menu, document.body);
}
