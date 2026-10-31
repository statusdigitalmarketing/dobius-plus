import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { THEMES } from '../../lib/themes';
import { TABS as DASHBOARD_PAGES } from '../Dashboard/DashboardView';
import {
  filterGroups, flattenItems, reduceSearchState, initialSearchState, isLightColor,
} from '../../lib/command-palette';
import Kbd from './Kbd';

const RECENT_SESSION_LIMIT = 5;
const SEARCH_SESSION_LIMIT = 60;

// Cmd+P command palette for a project window. `commands` are the ProjectView
// callbacks that already back the keyboard shortcuts, so the palette and the
// shortcut always do the same thing.
export default function CommandPalette({ open, onClose, projectPath, commands }) {
  const tabs = useStore((s) => s.terminalTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeView = useStore((s) => s.activeView);
  const themeIndex = useStore((s) => s.themeIndex);
  const closedCount = useStore((s) => s.recentlyClosedTabs.length);

  const [search, dispatch] = useReducer(reduceSearchState, undefined, initialSearchState);
  const [highlight, setHighlight] = useState(0);
  const [sessions, setSessions] = useState([]);
  const [projects, setProjects] = useState([]);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const openSnapshotRef = useRef(null);

  // Fresh data each time the palette opens; no live subscription while closed.
  useEffect(() => {
    if (!open) return;
    const s = useStore.getState();
    openSnapshotRef.current = { el: document.activeElement, tabId: s.activeTabId, view: s.activeView };
    dispatch({ type: 'reset' });
    setSessions([]);
    setProjects([]);
    setHighlight(0);
    const api = window.electronAPI;
    if (!api) return;
    let cancelled = false;
    Promise.all([
      projectPath ? api.dataLoadAllSessions?.(projectPath) : [],
      api.configGetSessionTags?.(),
    ]).then(([raw, tags]) => {
      if (cancelled) return;
      const t = tags || {};
      setSessions((raw || []).filter((s) => s?.sessionId).map((s) => ({
        ...s, displayName: t[s.sessionId]?.label || s.preview || 'Untitled session',
      })));
    }).catch((err) => console.warn('[CommandPalette] sessions load failed:', err?.message));
    api.dataListProjects?.().then((list) => {
      if (!cancelled) setProjects((list || []).filter((p) => p?.decodedPath));
    }).catch((err) => console.warn('[CommandPalette] projects load failed:', err?.message));
    return () => { cancelled = true; };
  }, [open, projectPath]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, search.views.length]);

  // Give focus back to where it was (usually the xterm textarea), but only if
  // the chosen action left the same tab and view in front. Refocusing the old
  // tab's input after a tab switch would re-activate the old tab.
  const close = () => {
    onClose();
    const snap = openSnapshotRef.current;
    requestAnimationFrame(() => {
      const s = useStore.getState();
      if (!snap || s.activeTabId !== snap.tabId || s.activeView !== snap.view) return;
      const ae = document.activeElement;
      const prev = snap.el;
      if ((!ae || ae === document.body) && prev?.isConnected && prev.offsetParent !== null) prev.focus();
    });
  };

  const { rootGroups, submenus } = useMemo(() => {
    const st = () => useStore.getState();
    const inTerminal = activeView === 'terminal';
    const goTerminal = () => { if (st().activeView !== 'terminal') st().setActiveView('terminal'); };

    const sessionItem = (s) => ({
      id: `session:${s.sessionId}`,
      title: s.displayName,
      subtitle: s.age || '',
      icon: '↺',
      searchTerms: [s.displayName, s.preview || '', s.sessionId, 'session', 'resume', 'history', 'chat'],
      run: () => st().resumeSession({ sessionId: s.sessionId, project: s.projectPath || projectPath, sizeMB: s.sizeMB }),
    });

    const themeView = {
      id: 'themes', title: 'Theme', placeholder: 'Search themes...',
      groups: [{ id: 'themes', label: 'Themes', items: THEMES.map((t, i) => ({
        id: `theme:${i}`,
        title: t.name,
        swatch: [t.bg, t.accent1, t.accent2],
        trailing: i === themeIndex ? 'Current' : null,
        searchTerms: [t.name, isLightColor(t.bg) ? 'light' : 'dark'],
        run: () => st().setThemeIndex(i),
      })) }],
    };

    const projectView = {
      id: 'projects', title: 'Open project', placeholder: 'Search projects...',
      groups: [{ id: 'projects', label: 'Projects', items: projects.map((p) => ({
        id: `project:${p.decodedPath}`,
        title: p.displayName || p.decodedPath.split('/').filter(Boolean).pop(),
        subtitle: p.decodedPath.replace(/^\/Users\/[^/]+/, '~'),
        trailing: p.decodedPath === projectPath ? 'This window' : null,
        searchTerms: [p.displayName || '', p.decodedPath],
        run: () => window.electronAPI?.windowOpenProject?.(p.decodedPath),
      })) }],
    };

    const sessionView = {
      id: 'sessions', title: 'Resume session', placeholder: 'Search this project’s sessions...',
      groups: [{ id: 'sessions', label: 'Sessions', items: sessions.map(sessionItem) }],
    };

    const actions = [
      { id: 'new-tab', title: 'New terminal tab', shortcut: 'mod+t', searchTerms: ['New terminal tab', 'create tab', 'open tab', 'shell'], run: () => { goTerminal(); commands.newTab(); } },
      { id: 'new-window', title: 'New window on this project', shortcut: 'mod+shift+n', searchTerms: ['New window on this project', 'open window', 'duplicate window'], run: commands.newWindow, hidden: !projectPath },
      { id: 'reopen', title: 'Reopen closed tab', shortcut: 'mod+shift+t', searchTerms: ['Reopen closed tab', 'undo close', 'restore tab'], run: () => { goTerminal(); commands.reopenClosedTab(); }, hidden: closedCount === 0 },
      { id: 'close-tab', title: 'Close tab', shortcut: 'mod+w', searchTerms: ['Close tab', 'kill tab', 'remove tab'], run: commands.closeTab, hidden: !inTerminal || tabs.length <= 1 },
      { id: 'resume-latest', title: 'Resume last session', shortcut: 'mod+r', searchTerms: ['Resume last session', 'continue', 'claude --resume'], run: () => { goTerminal(); commands.resumeLatest(); }, hidden: !projectPath },
      { id: 'resume-pick', title: 'Resume session…', submenu: 'sessions', searchTerms: ['Resume session', 'history', 'past chats', 'conversations', 'sessions'], hidden: !projectPath },
      { id: 'clear', title: 'Clear terminal', shortcut: 'mod+k', searchTerms: ['Clear terminal', 'cls', 'reset screen'], run: commands.clearTerminal, hidden: !inTerminal },
      { id: 'view', title: inTerminal ? 'Show dashboard' : 'Show terminal', searchTerms: [inTerminal ? 'Show dashboard' : 'Show terminal', 'toggle view', 'switch view'], run: () => st().setActiveView(inTerminal ? 'dashboard' : 'terminal') },
      { id: 'sidebar', title: 'Toggle sidebar', shortcut: 'mod+b', searchTerms: ['Toggle sidebar', 'hide sidebar', 'show sidebar', 'side nav'], run: commands.toggleSidebar },
      { id: 'git', title: 'Toggle git panel', shortcut: 'mod+g', searchTerms: ['Toggle git panel', 'source control', 'changes', 'diff'], run: commands.toggleGitPanel, hidden: !inTerminal },
      { id: 'theme', title: 'Change theme…', submenu: 'themes', searchTerms: ['Change theme', 'color scheme', 'appearance', 'dark mode', 'light mode'] },
      { id: 'project', title: 'Open project…', submenu: 'projects', searchTerms: ['Open project', 'switch project', 'folder', 'workspace', 'repo'] },
    ].filter((a) => !a.hidden);

    const tabItems = tabs.map((t, i) => ({
      id: `tab:${t.id}`,
      title: t.label || `Tab ${i + 1}`,
      icon: t.kind === 'browser' ? '◎' : '❯',
      shortcut: i < 9 ? `mod+${i + 1}` : null,
      trailing: t.id === activeTabId && inTerminal ? 'Current' : null,
      searchTerms: [t.label || '', t.autoLabel || '', t.url || '', 'tab', 'switch tab'],
      run: () => { st().showTab(t.id); goTerminal(); },
    }));

    const pageItems = DASHBOARD_PAGES.map((p) => ({
      id: `page:${p.id}`,
      title: p.label,
      subtitle: 'Dashboard',
      searchTerms: [p.label, p.id, 'dashboard', 'open', 'page'],
      run: () => { st().setDashboardTab(p.id); st().setActiveView('dashboard'); },
    }));

    return {
      rootGroups: [
        { id: 'actions', label: 'Actions', items: actions },
        { id: 'tabs', label: 'Tabs', items: tabItems },
        { id: 'recent', label: 'Recent sessions', items: sessions.slice(0, RECENT_SESSION_LIMIT).map(sessionItem), rootOnly: true },
        { id: 'pages', label: 'Dashboard', items: pageItems, searchOnly: true },
        { id: 'sessions-search', label: 'Sessions', items: sessions.slice(0, SEARCH_SESSION_LIMIT).map(sessionItem), searchOnly: true },
      ],
      submenus: { themes: themeView, projects: projectView, sessions: sessionView },
    };
  }, [tabs, activeTabId, activeView, themeIndex, closedCount, sessions, projects, projectPath, commands]);

  // The view stack holds submenu ids, not snapshots, so a submenu entered
  // before its data loaded fills in when the data arrives.
  const topViewId = search.views[search.views.length - 1]?.view || null;
  const currentView = topViewId ? submenus[topViewId] || null : null;
  const groups = useMemo(() => {
    const base = currentView ? currentView.groups : rootGroups;
    // "Recent sessions" duplicates the full Sessions group while searching.
    const visible = search.query && !currentView ? base.filter((g) => !g.rootOnly) : base;
    return filterGroups(visible, search.query);
  }, [currentView, rootGroups, search.query]);
  const items = useMemo(() => flattenItems(groups), [groups]);
  const active = Math.min(highlight, Math.max(0, items.length - 1));

  useEffect(() => { setHighlight(0); }, [search.query, search.views.length]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, groups]);

  if (!open) return null;

  const choose = (item) => {
    if (!item) return;
    if (item.submenu) { dispatch({ type: 'push', view: item.submenu }); return; }
    close();
    try {
      const r = item.run?.();
      if (r && typeof r.catch === 'function') r.catch((err) => console.error('[CommandPalette] action failed:', err));
    } catch (err) {
      console.error('[CommandPalette] action failed:', err);
    }
  };

  // Handles every key that reaches the dialog and stops it there, so window
  // listeners behind the palette (Cmd+W, Cmd+F, Cmd+1-9, editor Escape) never
  // see keystrokes meant for it.
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.metaKey && !e.ctrlKey && e.key === 'p') {
      e.preventDefault(); close(); return;
    }
    if (e.key === 'Tab') {
      e.preventDefault(); inputRef.current?.focus(); return;
    }
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault(); setHighlight(items.length ? (active + 1) % items.length : 0);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault(); setHighlight(items.length ? (active - 1 + items.length) % items.length : 0);
    } else if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault(); choose(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (currentView) dispatch({ type: 'back' }); else close();
    } else if (e.key === 'Backspace' && !search.query && currentView && e.target === inputRef.current) {
      e.preventDefault(); dispatch({ type: 'back' });
    }
  };

  let flatIndex = -1;
  return (
    <div
      data-dialog-backdrop=""
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
        onKeyDown={onKeyDown}
        // Clicks on rows, headings or padding must not blur the input, or keys
        // would stop reaching onKeyDown. Row clicks still fire onClick.
        onMouseDown={(e) => { if (e.target !== inputRef.current) e.preventDefault(); }}
        // Focus left for real (a menu accelerator opened a tab, the sidebar
        // search took focus, the app lost focus): the palette no longer owns
        // the keyboard, so dismiss it without stealing focus back.
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) onClose(); }}
        aria-label="Command palette"
        data-testid="command-palette"
        style={{
          width: 'min(620px, calc(100vw - 32px))', maxHeight: '60vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', color: 'var(--fg)',
          border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 24px 64px rgba(0,0,0,0.45)', overflow: 'hidden',
        }}
      >
        <div className="flex items-center gap-2" style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
          {currentView && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'back' })}
              className="text-[11px] shrink-0"
              style={{ padding: '2px 8px', borderRadius: 5, background: 'var(--accent-muted)', color: 'var(--accent)', border: 'none', cursor: 'pointer' }}
              title="Back (Esc)"
            >
              {'‹'} {currentView.title}
            </button>
          )}
          <input
            ref={inputRef}
            value={search.query}
            onChange={(e) => dispatch({ type: 'query', query: e.target.value })}
            placeholder={currentView?.placeholder || 'Search commands, tabs, sessions, pages...  (> for actions only)'}
            spellCheck={false}
            aria-controls="command-palette-list"
            aria-activedescendant={items[active] ? `cp-${items[active].id}` : undefined}
            className="flex-1 bg-transparent outline-none text-[13px]"
            style={{ color: 'var(--fg)', border: 'none', outline: 'none' }}
          />
        </div>

        <div ref={listRef} id="command-palette-list" role="listbox" className="overflow-y-auto" style={{ padding: '6px 0' }}>
          {groups.length === 0 && (
            <div className="text-[12px]" style={{ padding: '18px 14px', color: 'var(--dim)' }}>
              No matches for &ldquo;{search.query}&rdquo;
            </div>
          )}
          {groups.map((g) => (
            <div key={g.id}>
              <div className="text-[10px] uppercase tracking-wider" style={{ padding: '8px 14px 4px', color: 'var(--dim)' }}>
                {g.label}
              </div>
              {g.items.map((item) => {
                flatIndex += 1;
                const idx = flatIndex;
                const isActive = idx === active;
                return (
                  <div
                    key={item.id}
                    id={`cp-${item.id}`}
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    onMouseMove={() => { if (!isActive) setHighlight(idx); }}
                    onClick={() => choose(item)}
                    className="flex items-center gap-2.5 cursor-pointer"
                    style={{
                      margin: '0 6px', padding: '6px 8px', borderRadius: 6,
                      background: isActive ? 'var(--surface-hover)' : 'transparent',
                    }}
                  >
                    {item.swatch ? (
                      <span className="inline-flex shrink-0" style={{ width: 16 }}>
                        {item.swatch.map((c, i) => (
                          <span key={i} style={{ width: 6, height: 14, background: c, borderRadius: i === 0 ? '3px 0 0 3px' : i === 2 ? '0 3px 3px 0' : 0 }} />
                        ))}
                      </span>
                    ) : (
                      <span className="shrink-0 text-center text-[12px]" style={{ width: 16, color: 'var(--dim)' }}>
                        {item.icon || '›'}
                      </span>
                    )}
                    <span className="flex-1 min-w-0 flex items-baseline gap-2">
                      <span className="truncate text-[13px]">{item.title}</span>
                      {item.subtitle && (
                        <span className="truncate shrink-0 text-[11px]" style={{ color: 'var(--dim)', maxWidth: '45%' }}>{item.subtitle}</span>
                      )}
                    </span>
                    {item.trailing && (
                      <span className="text-[10px] shrink-0" style={{ color: 'var(--accent)' }}>{item.trailing}</span>
                    )}
                    {item.submenu && <span className="text-[12px] shrink-0" style={{ color: 'var(--dim)' }}>{'›'}</span>}
                    {item.shortcut && <Kbd combo={item.shortcut} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 text-[10px]" style={{ padding: '6px 12px', borderTop: '1px solid var(--border)', color: 'var(--dim)' }}>
          <span className="inline-flex items-center gap-1"><Kbd combo="enter" /> select</span>
          <span className="inline-flex items-center gap-1">{'↑↓'} navigate</span>
          <span className="inline-flex items-center gap-1">esc {currentView ? 'back' : 'close'}</span>
        </div>
      </div>
    </div>
  );
}
