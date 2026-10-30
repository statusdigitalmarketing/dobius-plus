import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { projectMonogram } from '../../lib/project-color';
import {
  buildPickerProjects, countHiddenProjects, toggleHiddenProject, pickerShortcutIndex, normalizeNewTabTool,
} from '../../../shared/new-tab.js';
import Kbd from '../shared/Kbd';

const TOOL_LABEL = { claude: 'Claude Code', codex: 'Codex', shell: 'a plain shell' };

// The + button's New Tab picker: this project first (Enter opens a tab here),
// then the launcher's other projects, each opening a tab in its own window.
// Keyboard handling follows CommandPalette (NOTES 2026-10-19): every key stops
// at the dialog, clicks never blur the input, and a real blur dismisses it.
export default function NewTabPicker({ projectPath }) {
  const open = useStore((s) => s.newTabPickerOpen);
  const setOpen = useStore((s) => s.setNewTabPickerOpen);

  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [projects, setProjects] = useState([]);
  const [hidden, setHidden] = useState([]);
  const [showHidden, setShowHidden] = useState(false);
  const [tool, setTool] = useState('claude');
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const openSnapshotRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const s = useStore.getState();
    openSnapshotRef.current = { el: document.activeElement, tabId: s.activeTabId, view: s.activeView };
    setQuery('');
    setHighlight(0);
    setShowHidden(false);
    requestAnimationFrame(() => inputRef.current?.focus());
    const api = window.electronAPI;
    if (!api) return undefined;
    let cancelled = false;
    api.dataListProjects?.().then((list) => {
      if (!cancelled) setProjects((list || []).filter((p) => p?.decodedPath));
    }).catch((err) => console.warn('[NewTabPicker] projects load failed:', err?.message));
    api.configGetSettings?.().then((st) => {
      if (cancelled) return;
      setHidden(Array.isArray(st?.newTabHiddenProjects) ? st.newTabHiddenProjects : []);
      setTool(normalizeNewTabTool(st?.newTabTool));
    }).catch((err) => console.warn('[NewTabPicker] settings load failed:', err?.message));
    return () => { cancelled = true; };
  }, [open]);

  const rows = useMemo(
    () => buildPickerProjects({ currentPath: projectPath, projects, hidden, query, showHidden }),
    [projectPath, projects, hidden, query, showHidden],
  );
  const hiddenCount = useMemo(() => countHiddenProjects(projects, hidden, projectPath), [projects, hidden, projectPath]);
  const active = Math.min(highlight, Math.max(0, rows.length - 1));

  useEffect(() => { setHighlight(0); }, [query, showHidden]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, rows]);

  if (!open) return null;

  // Focus goes back to where it was only if the same tab and view are still in
  // front; a new tab focuses its own terminal.
  const close = () => {
    setOpen(false);
    const snap = openSnapshotRef.current;
    requestAnimationFrame(() => {
      const s = useStore.getState();
      if (!snap || s.activeTabId !== snap.tabId || s.activeView !== snap.view) return;
      const ae = document.activeElement;
      const prev = snap.el;
      if ((!ae || ae === document.body) && prev?.isConnected && prev.offsetParent !== null) prev.focus();
    });
  };

  const choose = (row) => {
    if (!row) return;
    close();
    if (row.path === projectPath) {
      const st = useStore.getState();
      st.openNewTab(projectPath);
      st.setActiveView('terminal');
      return;
    }
    Promise.resolve(window.electronAPI?.windowOpenProjectNewTab?.(row.path)).then((r) => {
      if (r && r.ok === false) console.warn('[NewTabPicker] could not open project:', r.error);
    }).catch((err) => console.warn('[NewTabPicker] open failed:', err?.message));
  };

  const toggleHidden = (row) => {
    if (!row || row.isCurrent) return;
    const next = toggleHiddenProject(hidden, row.path);
    setHidden(next);
    window.electronAPI?.configUpdateSettings?.({ newTabHiddenProjects: next });
  };

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const n = pickerShortcutIndex(e);
    if (n >= 0) {
      e.preventDefault();
      if (rows[n]) choose(rows[n]);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault(); inputRef.current?.focus(); return;
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault(); setHighlight(rows.length ? (active + 1) % rows.length : 0);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault(); setHighlight(rows.length ? (active - 1 + rows.length) % rows.length : 0);
    } else if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault(); choose(rows[active]);
    } else if (e.key === 'Backspace' && e.metaKey && rows[active] && !rows[active].isCurrent) {
      e.preventDefault(); toggleHidden(rows[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault(); close();
    }
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9990,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '14vh',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New tab"
        data-testid="new-tab-picker"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault(); }}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
        style={{
          width: 'min(560px, calc(100vw - 32px))', maxHeight: '60vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', color: 'var(--fg)',
          border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 24px 64px rgba(0,0,0,0.45)', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="New tab in..."
            spellCheck={false}
            aria-controls="new-tab-list"
            aria-activedescendant={rows[active] ? `nt-${active}` : undefined}
            className="w-full bg-transparent outline-none text-[13px]"
            style={{ color: 'var(--fg)', border: 'none', outline: 'none' }}
          />
        </div>

        <div ref={listRef} id="new-tab-list" role="listbox" className="overflow-y-auto" style={{ padding: '6px 0' }}>
          <div className="text-[10px] uppercase tracking-wider" style={{ padding: '8px 14px 4px', color: 'var(--dim)' }}>
            Projects
          </div>
          {rows.length === 0 && (
            <div className="text-[12px]" style={{ padding: '12px 14px', color: 'var(--dim)' }}>
              No projects match &ldquo;{query}&rdquo;
            </div>
          )}
          {rows.map((row, idx) => {
            const isActive = idx === active;
            const mono = projectMonogram(row.path);
            return (
              <div
                key={row.path}
                id={`nt-${idx}`}
                role="option"
                aria-selected={isActive}
                data-active={isActive}
                onMouseMove={() => { if (!isActive) setHighlight(idx); }}
                onClick={() => choose(row)}
                className="flex items-center gap-2.5 cursor-pointer"
                style={{
                  margin: '0 6px', padding: '6px 8px', borderRadius: 6,
                  background: isActive ? 'var(--surface-hover)' : 'transparent',
                  opacity: row.hidden ? 0.55 : 1,
                }}
              >
                <span
                  className="shrink-0 inline-flex items-center justify-center text-[10px] font-semibold"
                  style={{ width: 20, height: 20, borderRadius: 5, background: mono.background, color: '#fff' }}
                >
                  {mono.letter}
                </span>
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="truncate text-[13px]">{row.name}</span>
                  <span className="truncate text-[11px]" style={{ color: 'var(--dim)' }}>
                    {row.path.replace(/^\/Users\/[^/]+/, '~')}
                  </span>
                </span>
                {row.isCurrent && (
                  <span className="text-[10px] shrink-0" style={{ color: 'var(--accent)' }}>This window</span>
                )}
                {!row.isCurrent && isActive && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleHidden(row); }}
                    title={row.hidden ? 'Show in New Tab (Cmd+Backspace)' : 'Hide from New Tab (Cmd+Backspace)'}
                    className="text-[10px] shrink-0"
                    style={{ padding: '1px 6px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--dim)', cursor: 'pointer' }}
                  >
                    {row.hidden ? 'Show' : 'Hide'}
                  </button>
                )}
                {idx < 9 && <Kbd combo={`mod+${idx + 1}`} />}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3 text-[10px]" style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', color: 'var(--dim)' }}>
          <span className="inline-flex items-center gap-1">{'↑↓'} navigate</span>
          <span className="inline-flex items-center gap-1"><Kbd combo="enter" /> open</span>
          <span className="inline-flex items-center gap-1">esc close</span>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className="text-[10px]"
              style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}
            >
              {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
            </button>
          )}
          <span className="ml-auto">Starts {TOOL_LABEL[tool]}</span>
        </div>
      </div>
    </div>
  );
}
