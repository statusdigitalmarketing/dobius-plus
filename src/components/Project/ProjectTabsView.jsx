import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useStore } from '../../store/store';
import { STATUS_COLORS, STATUS_LABELS } from '../../lib/status-colors';
import { tabActivityLabel } from '../../lib/tab-activity';
import { orderSidebarTabs, normalizeSidebarOrder } from '../../lib/sidebar-order';
import { snoozePicks, snoozeTimeLabel } from '../../../shared/snooze-times.js';

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

const ACTIVITY_COLORS = {
  working: 'var(--fg)',
  input: 'var(--accent)',
  waiting: 'var(--dim)',
  done: 'var(--success)',
};

function ActivityIcon({ kind }) {
  const box = { width: 10, height: 10, flexShrink: 0 };
  if (kind === 'working') {
    return (
      <svg className="animate-spin" style={box} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="var(--warning)" strokeOpacity="0.3" strokeWidth="2.5" />
        <path d="M14 8a6 6 0 0 0-6-6" stroke="var(--warning)" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'input') {
    return (
      <svg style={box} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.75c-.5.2-.8.6-.8 1.1v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="8" cy="11.6" r="0.9" fill="currentColor" />
      </svg>
    );
  }
  if (kind === 'waiting') {
    return (
      <svg style={box} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" stroke="var(--warning)" strokeWidth="1.6" />
        <path d="M8 4.5V8l2.3 1.6" stroke="var(--warning)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg style={box} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MoonIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

const menuBtn = {
  display: 'flex', justifyContent: 'space-between', gap: 12, width: '100%', textAlign: 'left',
  padding: '5px 14px', fontSize: 11, fontFamily: "'SF Mono', monospace", color: 'var(--fg)',
  backgroundColor: 'transparent', border: 'none', cursor: 'pointer',
};
const hoverOn = (e) => { e.currentTarget.style.backgroundColor = 'var(--border)'; };
const hoverOff = (e) => { e.currentTarget.style.backgroundColor = 'transparent'; };

// Right-click on a snoozed row: bring it back, pick a new time, or close it for good. Escape or a press outside closes
// it; keys are held while it is open so none reach a terminal behind it.
function SnoozedMenu({ entry, x, y, onBringBack, onSetTime, onDiscard, onDismiss }) {
  const ref = useRef(null);
  const [picksOpen, setPicksOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => { e.preventDefault(); e.stopPropagation(); if (e.key === 'Escape') onDismiss(); };
    const onPress = (e) => { if (!ref.current?.contains(e.target)) onDismiss(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPress, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onPress, true); };
  }, [onDismiss]);
  const left = Math.max(8, Math.min(x, window.innerWidth - 268));
  const top = Math.max(8, Math.min(y, window.innerHeight - (picksOpen ? 330 : 130)));
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="snoozed-menu"
      style={{
        position: 'fixed', left, top, zIndex: 200, minWidth: 220, maxWidth: 260,
        backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
        padding: '4px 0', boxShadow: '0 4px 16px rgba(0,0,0,0.3)', WebkitAppRegion: 'no-drag',
      }}
    >
      <div className="truncate" style={{ padding: '3px 14px', fontSize: 10, color: 'var(--dim)', fontFamily: "'SF Mono', monospace" }}>{entry.label}</div>
      <button role="menuitem" style={menuBtn} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={onBringBack}>Bring back now</button>
      <button role="menuitem" aria-expanded={picksOpen} style={menuBtn} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={() => setPicksOpen((v) => !v)}>
        <span>Snooze until…</span><span style={{ color: 'var(--dim)', fontSize: 9 }}>{picksOpen ? '▾' : '▸'}</span>
      </button>
      {picksOpen && snoozePicks().map((p) => (
        <button key={p.id} role="menuitem" style={{ ...menuBtn, paddingLeft: 24 }} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={() => onSetTime(p.at)}>
          <span>{p.label}</span>{p.at !== null && <span style={{ color: 'var(--dim)' }}>{snoozeTimeLabel(p.at)}</span>}
        </button>
      ))}
      <div style={{ height: 1, backgroundColor: 'var(--border)', margin: '4px 0' }} />
      <button role="menuitem" style={menuBtn} onMouseEnter={hoverOn} onMouseLeave={hoverOff} onClick={onDiscard}>Close for good</button>
    </div>
  );
}

// How long after a tab leaves this window a list read must have started to be trusted about it (the window's tab list
// reaches main on a ~500ms debounced save).
const GONE_SETTLE_MS = 1500;

/**
 * "Tabs by project" sidebar view (Brett task 1217038024225884). Purely additive:
 * lists every project's tabs across ALL open Dobius windows, grouped by project,
 * each tab with its most recent message + time. Reads the read-only
 * data:getAllProjectTabs aggregate; never mutates history/restore/naming.
 *
 * Click behavior is deliberately safe across windows (no duplicate live
 * sessions):
 *   - a tab live in THIS window                   -> switch to it
 *   - a tab live in ANOTHER window (tear-off /     -> focus that owning window
 *     other same-project primary)                     (never resume: it's alive)
 *   - a tab in ANOTHER project (not live)          -> open/focus that project's window
 *   - a tab in THIS project, not live anywhere     -> resume its session here (if linked)
 */
// Per window (each window is its own renderer): project path -> true when opened, false when folded.
const windowFold = Object.create(null);

export default function ProjectTabsView({ search = '', onResumeSession }) {
  const [groups, setGroups] = useState(null); // null = loading
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const terminalTabs = useStore((s) => s.terminalTabs);
  const tabStatus = useStore((s) => s.tabStatus);
  const unreadTabs = useStore((s) => s.unreadTabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activeView = useStore((s) => s.activeView);
  // showTab, not setActiveTab: it leaves split or grid when needed, otherwise the
  // click is reverted or lands on a hidden tab (NOTES 2026-10-19).
  const showTab = useStore((s) => s.showTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const requestTabBar = useStore((s) => s.requestTabBar);
  // Only the project this window is on starts open; every other project is folded until you open it (Brett, Asana
  // 1220329713038492: "only the project that's open to be open and the other projects will be collapsed by default").
  // A choice lasts for this window (kept across the sidebar closing and opening), never shared with other windows.
  const [fold, setFold] = useState(() => ({ ...windowFold }));
  const toggleProject = useCallback((projectPath, isOpen) => {
    windowFold[projectPath] = !isOpen;
    setFold({ ...windowFold });
  }, []);
  // Snoozed shelves start folded and stay open once you open one (Brett: "auto-collapsed unless we uncollapse it"),
  // remembered per project in settings.sidebarSnoozeOpen (a list of project paths, at most 50).
  const [snoozeOpen, setSnoozeOpen] = useState(() => new Set());
  const snoozeTouched = useRef(false);
  useEffect(() => {
    window.electronAPI?.configGetSettings?.()
      .then((st) => {
        if (!snoozeTouched.current && Array.isArray(st?.sidebarSnoozeOpen)) {
          setSnoozeOpen(new Set(st.sidebarSnoozeOpen.filter((x) => typeof x === 'string')));
        }
      })
      .catch((err) => console.warn('[ProjectTabsView] snooze shelf setting read failed:', err?.message));
  }, []);
  const toggleSnoozeShelf = useCallback((projectPath) => {
    snoozeTouched.current = true;
    setSnoozeOpen((prev) => {
      const next = new Set(prev);
      if (next.has(projectPath)) next.delete(projectPath); else next.add(projectPath);
      window.electronAPI?.configUpdateSettings?.({ sidebarSnoozeOpen: [...next].slice(-50) })
        ?.catch?.((err) => console.warn('[ProjectTabsView] snooze shelf setting save failed:', err?.message));
      return next;
    });
  }, []);
  const [snoozedMenu, setSnoozedMenu] = useState(null); // { entry, path, x, y }
  const isTearOff = useStore((s) => !!s.tabIdSpace);
  // settings.sidebarTabOrder (src/lib/sidebar-order.js). Read on open and with every list refresh, so a change made in
  // another window arrives within the poll; Settings in this window announces its own change at once.
  const [order, setOrder] = useState('activity');
  const readOrder = useCallback(() => {
    window.electronAPI?.configGetSettings?.()
      .then((s) => setOrder(normalizeSidebarOrder(s?.sidebarTabOrder)))
      .catch((err) => console.warn('[ProjectTabsView] settings read failed:', err?.message));
  }, []);
  useEffect(() => {
    const onChange = (e) => setOrder(normalizeSidebarOrder(e.detail));
    window.addEventListener('dobius:sidebarTabOrder', onChange);
    return () => window.removeEventListener('dobius:sidebarTabOrder', onChange);
  }, []);

  // The aggregate reads session history and can be slow on a big history, so
  // a tick is skipped while one is still out (overlapping asks piled up).
  const groupsInFlight = useRef(false);
  // An ask made while one is out (a snooze just changed the list) runs once more when it lands, so the list never
  // keeps a reply that started before the change.
  const groupsAgain = useRef(false);
  const groupsReadAt = useRef(0); // when the list read that produced `groups` started
  // The tab and view before a double-click's first click switched to the row: closing the row puts you back there, not
  // on its neighbour (Max, 2026-11-09).
  const beforeClick = useRef(null);
  const refresh = useCallback(() => {
    if (!window.electronAPI?.dataGetAllProjectTabs) { setGroups([]); return; }
    if (groupsInFlight.current) { groupsAgain.current = true; return; }
    groupsInFlight.current = true;
    groupsAgain.current = false;
    const startedAt = Date.now();
    window.electronAPI.dataGetAllProjectTabs()
      .then((g) => { groupsReadAt.current = startedAt; setGroups(Array.isArray(g) ? g : []); })
      .catch(() => setGroups([]))
      .finally(() => {
        groupsInFlight.current = false;
        if (groupsAgain.current) refresh();
      });
  }, []);

  // Refresh on open, then poll: the aggregate spans other windows, so there's no
  // in-window event for their changes.
  useEffect(() => {
    refresh();
    readOrder();
    const i = setInterval(() => { refresh(); readOrder(); }, 5000);
    // A snooze added, due or taken anywhere shows at once rather than on the next tick.
    const off = window.electronAPI?.onSnoozeChanged?.(refresh);
    return () => { clearInterval(i); off?.(); };
  }, [refresh, readOrder]);
  // This window's own tabs changing (opened, closed, back from snooze) shows now too, not on the next tick. Tab
  // changes come at human speed and refresh is single-flight, so this adds a read per change, never a pile.
  const tabIdsKey = terminalTabs.map((t) => t.id).join('|');
  const seenTabIdsKey = useRef(tabIdsKey);
  useEffect(() => {
    if (seenTabIdsKey.current === tabIdsKey) return;
    seenTabIdsKey.current = tabIdsKey;
    const t = setTimeout(refresh, 300); // after ProjectView's save of the new list has reached main
    return () => clearTimeout(t);
  }, [tabIdsKey, refresh]);

  // Bring a snoozed tab back now. Its own project here: take it and open it as the active tab. Another project: mark
  // it ready and open that project's window, which takes it back (useSnoozeReturn).
  const bringBack = useCallback(async (entry) => {
    const api = window.electronAPI;
    try {
      if (entry.projectPath === currentProjectPath && !isTearOff && useStore.getState().tabsReady) {
        const got = await api.snoozeTake(entry.id);
        // Taken means it left main's list: it must open here. Tabs were ready above and never go back to not ready.
        if (got?.entry) useStore.getState().restoreSnoozedTab(got, { activate: true });
      } else if (entry.projectPath === currentProjectPath && !isTearOff) {
        // This window's tabs are not restored yet (it just opened): mark it ready and useSnoozeReturn takes it back
        // once they are. Taking it now would remove it with nowhere to open it.
        await api.snoozeSetTime(entry.id, Date.now());
      } else {
        await api.snoozeSetTime(entry.id, Date.now());
        api.windowOpenProject?.(entry.projectPath);
      }
    } catch (err) {
      console.warn('[snooze] bring back failed:', err?.message || err);
    }
  }, [currentProjectPath, isTearOff]);

  // Live row status (Working / Input / Waiting / Done) comes from main's cheap
  // tabs:activity, keyed by tab id. One ask at a time; an ask requested while
  // one is out runs once when it lands, so the newest state always arrives.
  const [activity, setActivity] = useState(() => new Map());
  const activityIdsRef = useRef([]);
  const activityState = useRef({ inFlight: false, again: false });
  const refreshActivity = useCallback(() => {
    if (!window.electronAPI?.tabsActivity) return;
    const st = activityState.current;
    if (st.inFlight) { st.again = true; return; }
    st.inFlight = true;
    st.again = false;
    window.electronAPI.tabsActivity(activityIdsRef.current)
      .then((list) => setActivity(new Map((Array.isArray(list) ? list : []).map((r) => [r.id, r]))))
      .catch((err) => console.warn('[ProjectTabsView] activity lookup failed:', err?.message))
      .finally(() => {
        st.inFlight = false;
        if (st.again) refreshActivity();
      });
  }, []);

  // Ask about every tab that may be live: this window's, and any the
  // aggregate says has a PTY in another window.
  const activityIdsKey = useMemo(() => {
    const ids = new Set(terminalTabs.map((t) => t.id));
    for (const g of groups || []) for (const t of g.tabs || []) if (t.live) ids.add(t.id);
    return [...ids].join('\n');
  }, [terminalTabs, groups]);
  // A status or unread change in THIS window re-asks at once, so a new turn's
  // start time (main records it) shows without waiting for the tick.
  const localKey = useMemo(
    () => terminalTabs.map((t) => `${t.id}:${tabStatus[t.id] || ''}:${unreadTabs[t.id] ? 1 : 0}`).join('|'),
    [terminalTabs, tabStatus, unreadTabs],
  );
  useEffect(() => {
    activityIdsRef.current = activityIdsKey ? activityIdsKey.split('\n') : [];
    refreshActivity();
  }, [activityIdsKey, localKey, refreshActivity]);
  // The tick also re-renders, which is what advances "Working 4m".
  useEffect(() => {
    const i = setInterval(refreshActivity, 3000);
    return () => clearInterval(i);
  }, [refreshActivity]);

  const liveHere = useCallback(
    (projectPath, tabId) => projectPath === currentProjectPath && terminalTabs.some((t) => t.id === tabId),
    [currentProjectPath, terminalTabs],
  );

  const handleClick = useCallback((projectPath, tab) => {
    if (liveHere(projectPath, tab.id)) {
      showTab(tab.id);
      setActiveView('terminal');
      return;
    }
    // Live in ANOTHER window (a tear-off, or another primary of this project):
    // the PTY is still running there, so resuming would spawn a duplicate
    // session. Reveal the owning window instead. H3.
    if (tab.live) {
      window.electronAPI?.windowFocusTabOwner?.(projectPath, tab.id);
      return;
    }
    if (projectPath !== currentProjectPath) {
      window.electronAPI?.windowOpenProject?.(projectPath);
      return;
    }
    // This project, tab not live anywhere: resume its linked session here.
    if (tab.sessionId) onResumeSession?.({ sessionId: tab.sessionId, project: projectPath });
  }, [liveHere, currentProjectPath, showTab, setActiveView, onResumeSession]);

  // A row's activity (Working / Input / Waiting / Done): what it shows, and what the status order sorts by.
  const labelFor = useCallback((projectPath, t, now) => {
    const live = liveHere(projectPath, t.id);
    const row = activity.get(t.id);
    const a = row?.activity;
    return tabActivityLabel({
      live: !!a,
      status: a?.status,
      hookOwned: !!a?.hookOwned,
      since: a?.since,
      lastWorkMs: a?.lastWorkMs,
      background: a?.background,
      waiting: a?.waiting,
      unread: live ? !!unreadTabs[t.id] : !!row?.unread,
      now,
    });
  }, [liveHere, activity, unreadTabs]);

  // Within each project, by settings.sidebarTabOrder: most recently active first (the default, attention-first like
  // the mobile board), the tab bar's order, or by status. Filtered by search across tab label + preview + project
  // name below, keeping a project only if it still has matching tabs.
  // A tab that left THIS window (closed, snoozed) still sits in main's aggregate until a read made after its window
  // saved the change, so a snoozed one showed twice, open and in Snoozed, for up to 5s. Its row is hidden from the
  // moment it leaves until a list read that STARTED at least GONE_SETTLE_MS later lands; after that the aggregate is
  // trusted again, so a tab torn off into another window (same id) shows from that read on. Bounded by the tabs this
  // window closes between two reads.
  const goneAt = useRef(new Map());
  const prevIds = useRef(null);
  const tabIdsNow = terminalTabs.map((t) => t.id);
  if (prevIds.current) {
    const nowIds = new Set(tabIdsNow);
    for (const id of prevIds.current) if (!nowIds.has(id)) goneAt.current.set(id, Date.now());
    for (const id of nowIds) goneAt.current.delete(id);
  }
  prevIds.current = tabIdsNow;
  const ordered = useMemo(() => {
    if (!groups) return null;
    const now = Date.now();
    const bar = new Map(terminalTabs.map((t, i) => [t.id, i]));
    for (const [id, at] of goneAt.current) if (groupsReadAt.current >= at + GONE_SETTLE_MS) goneAt.current.delete(id);
    return groups.map((g) => ({
      ...g,
      tabs: orderSidebarTabs(g.path === currentProjectPath ? g.tabs.filter((t) => !goneAt.current.has(t.id)) : g.tabs, order, {
        barIndex: (t) => (g.path === currentProjectPath && bar.has(t.id) ? bar.get(t.id) : -1),
        kind: (t) => labelFor(g.path, t, now)?.kind || null,
      }),
    }));
  }, [groups, order, terminalTabs, currentProjectPath, labelFor]);

  const filtered = useMemo(() => {
    if (!ordered) return null;
    const q = search.trim().toLowerCase();
    if (!q) return ordered;
    return ordered
      .map((g) => {
        const nameHit = (g.name || '').toLowerCase().includes(q);
        const hit = (t) => nameHit
          || (t.label || '').toLowerCase().includes(q)
          || (t.preview || '').toLowerCase().includes(q);
        return { ...g, tabs: g.tabs.filter(hit), snoozed: (g.snoozed || []).filter(hit) };
      })
      .filter((g) => g.tabs.length > 0 || g.snoozed.length > 0);
  }, [ordered, search]);

  if (filtered === null) {
    return (
      <div className="p-2 space-y-1">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="px-3 py-2 animate-pulse">
            <div className="h-3 w-2/3 rounded" style={{ backgroundColor: 'var(--border)' }} />
            <div className="h-2.5 w-1/2 mt-1.5 rounded" style={{ backgroundColor: 'var(--border)' }} />
          </div>
        ))}
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="p-3 text-xs" style={{ color: 'var(--dim)' }}>
        {search ? 'No matching tabs' : 'No open tabs yet'}
      </div>
    );
  }

  const now = Date.now(); // the activity tick re-renders, which advances "Working 4m"
  return (
    <div className="flex-1 overflow-y-auto">
      {filtered.map((g) => {
        const isCurrent = g.path === currentProjectPath;
        // A search shows every match, folded or not.
        const isOpen = search.trim() ? true : (typeof fold[g.path] === 'boolean' ? fold[g.path] : isCurrent);
        const isCollapsed = !isOpen;
        return (
          <div key={g.path} style={{ borderBottom: '1px solid var(--border)' }}>
            <button
              onClick={() => { if (!search.trim()) toggleProject(g.path, isOpen); }}
              aria-expanded={isOpen}
              className="w-full flex items-center justify-between px-3 py-1.5"
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: isCurrent ? 'var(--fg)' : 'var(--dim)',
                fontSize: 11, fontFamily: "'SF Mono', monospace",
                textTransform: 'uppercase', letterSpacing: '0.08em',
              }}
              title={g.path}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--surface-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <span className="truncate" style={{ fontWeight: isCurrent ? 700 : 500 }}>
                {g.name}{isCurrent ? ' • here' : ''}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ color: 'var(--dim)', fontSize: 9 }}>
                  {g.tabs.length}{g.snoozed?.length ? ` · ${g.snoozed.length} snoozed` : ''}
                </span>
                <span style={{ fontSize: 8 }}>{isCollapsed ? '▶' : '▼'}</span>
              </span>
            </button>
            {!isCollapsed && (
              <div className="pb-1">
                {g.tabs.map((t) => {
                  const live = liveHere(g.path, t.id);
                  // A PTY runs for the tab only if main says so (a tab still
                  // listed here can have an exited shell). Status and timing
                  // come from main, where the hook markers are recorded for
                  // every window (a tear-off, a respawn and auto-resume's
                  // status broadcasts all leave the store behind). Unread is
                  // this window's own for its tabs, main's mirror for others.
                  const a = activity.get(t.id)?.activity;
                  // Dot: this window's tabs keep the store (it also carries
                  // auto-resume's queued state); another window's live tab
                  // uses main's hook status rather than a transcript guess.
                  const status = (live ? tabStatus[t.id] : (a?.status || t.status)) || 'idle';
                  const dot = STATUS_COLORS[status] || 'var(--dim)';
                  const label = labelFor(g.path, t, now);
                  // The tab this window is showing (Brett: "so I know which tab I'm actually on").
                  // A tinted fill plus an accent bar, so it reads in light and dark themes alike.
                  // Only while the terminal view shows it: on the Dashboard no tab is on screen (Codex).
                  const selected = live && t.id === activeTabId && activeView === 'terminal';
                  const restBg = selected ? 'var(--accent-muted)' : 'transparent';
                  return (
                    <button
                      key={t.id}
                      onClick={() => handleClick(g.path, t)}
                      // A tab open in this window: right-click gives the tab bar's own menu, double-click closes it
                      // (Brett, task 1220331878170954; Cmd+Shift+T brings a closed tab back). The terminal view comes
                      // forward first so Rename and Split have somewhere to show.
                      onContextMenu={live ? (e) => {
                        e.preventDefault();
                        setActiveView('terminal');
                        requestTabBar({ kind: 'menu', tabId: t.id, x: e.clientX, y: e.clientY });
                      } : undefined}
                      onMouseDown={live ? (e) => {
                        if (e.button === 0 && e.detail === 1) {
                          const s = useStore.getState();
                          beforeClick.current = { row: t.id, tabId: s.activeTabId, view: s.activeView };
                        }
                      } : undefined}
                      onDoubleClick={live ? () => {
                        const b = beforeClick.current;
                        beforeClick.current = null;
                        // Back to where this double-click started, before the close (closing the tab on screen would
                        // pick its neighbour). The row's own tab, or one already gone: nothing to go back to.
                        if (b && b.row === t.id) {
                          if (b.tabId && b.tabId !== t.id && useStore.getState().terminalTabs.some((x) => x.id === b.tabId)) showTab(b.tabId);
                          // The view too, even when the row was the tab already shown (a pinned tab's cancelled close
                          // must not leave the Dashboard switched to the terminal).
                          if (b.view) setActiveView(b.view);
                        }
                        requestTabBar({ kind: 'close', tabId: t.id });
                      } : undefined}
                      className="w-full flex items-start gap-2 px-3 py-1.5 rounded"
                      data-testid="sidebar-tab-row"
                      aria-current={selected ? 'true' : undefined}
                      style={{
                        backgroundColor: restBg, border: 'none', cursor: 'pointer',
                        textAlign: 'left', color: 'var(--fg)',
                        boxShadow: selected ? 'inset 3px 0 0 var(--accent)' : 'none',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = selected ? 'var(--accent-muted)' : 'var(--surface-hover, var(--border))'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = restBg; }}
                      title={live
                        ? 'Switch to this tab. Right-click for options, double-click to close.'
                        : t.live
                          ? 'Focus the window running this tab'
                          : (g.path === currentProjectPath ? 'Resume this session' : 'Open this project window')}
                    >
                      <span
                        title={STATUS_LABELS[status] || status}
                        style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: dot, flexShrink: 0, marginTop: 5 }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                          <span className="truncate" style={{ fontSize: 12, fontWeight: 600 }}>
                            {t.label}{t.kind === 'browser' ? ' ○' : ''}
                          </span>
                          {/* No "live" badge: it only ever showed in the current
                              ("HERE") project group where every tab is already
                              open, so it was redundant and it contradicted the
                              gray idle dot on an open-but-idle tab (Sam). The
                              status dot conveys activity; HERE conveys the window. */}
                          {label ? (
                            <span
                              data-testid="tab-activity"
                              data-kind={label.kind}
                              title={label.title}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap',
                                fontSize: 10, fontWeight: 600, color: ACTIVITY_COLORS[label.kind],
                              }}
                            >
                              <ActivityIcon kind={label.kind} />
                              {label.text}
                            </span>
                          ) : (
                            <span style={{ fontSize: 9, color: 'var(--dim)', marginLeft: 'auto', flexShrink: 0 }}>
                              {timeAgo(t.lastActiveAt)}
                            </span>
                          )}
                        </span>
                        {t.preview && (
                          <span
                            className="truncate"
                            style={{ display: 'block', fontSize: 11, color: 'var(--dim)', marginTop: 1 }}
                          >
                            {t.preview}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {g.snoozed?.length > 0 && (
                  <div data-testid="snoozed-shelf" style={{ margin: '2px 8px 6px', border: '1px dashed var(--border)', borderRadius: 6 }}>
                    <button
                      onClick={() => toggleSnoozeShelf(g.path)}
                      aria-expanded={snoozeOpen.has(g.path) || !!search}
                      className="w-full flex items-center gap-1.5"
                      style={{
                        padding: '5px 8px', background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--dim)', fontSize: 10, fontFamily: "'SF Mono', monospace",
                        textTransform: 'uppercase', letterSpacing: '0.1em',
                      }}
                    >
                      <MoonIcon />
                      <span>Snoozed · {g.snoozed.length}</span>
                      <span style={{ marginLeft: 'auto', fontSize: 8 }}>{snoozeOpen.has(g.path) || search ? '▼' : '▶'}</span>
                    </button>
                    {(snoozeOpen.has(g.path) || !!search) && g.snoozed.map((e) => (
                      <button
                        key={e.id}
                        data-testid="snoozed-row"
                        onClick={() => bringBack(e)}
                        onContextMenu={(ev) => { ev.preventDefault(); setSnoozedMenu({ entry: e, x: ev.clientX, y: ev.clientY }); }}
                        className="w-full flex items-start gap-2 px-2 py-1.5 rounded"
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--fg)', opacity: 0.85 }}
                        onMouseEnter={(ev) => { ev.currentTarget.style.backgroundColor = 'var(--surface-hover, var(--border))'; }}
                        onMouseLeave={(ev) => { ev.currentTarget.style.backgroundColor = 'transparent'; }}
                        title="Click to bring it back now. Right-click for more."
                      >
                        <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: e.ready ? 'var(--success)' : 'var(--dim)', flexShrink: 0, marginTop: 5 }} />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                            <span className="truncate" style={{ fontSize: 12, fontWeight: 600 }}>{e.label}</span>
                            <span style={{ marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap', fontSize: 10, color: e.ready ? 'var(--success)' : 'var(--warning)' }}>
                              {e.ready ? 'ready' : e.until == null ? 'until you bring it back' : `back ${snoozeTimeLabel(e.until, now)}`}
                            </span>
                          </span>
                          {e.preview && (
                            <span className="truncate" style={{ display: 'block', fontSize: 11, color: 'var(--dim)', marginTop: 1 }}>{e.preview}</span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {snoozedMenu && (
        <SnoozedMenu
          entry={snoozedMenu.entry}
          x={snoozedMenu.x}
          y={snoozedMenu.y}
          onDismiss={() => setSnoozedMenu(null)}
          onBringBack={() => { const e = snoozedMenu.entry; setSnoozedMenu(null); bringBack(e); }}
          onSetTime={(at) => {
            const e = snoozedMenu.entry;
            setSnoozedMenu(null);
            window.electronAPI?.snoozeSetTime?.(e.id, at)?.catch?.((err) => console.warn('[snooze] reschedule failed:', err?.message));
          }}
          onDiscard={() => {
            const e = snoozedMenu.entry;
            setSnoozedMenu(null);
            if (window.confirm(`Close "${e.label}" for good? Its Claude conversation stays in History.`)) {
              window.electronAPI?.snoozeDiscard?.(e.id)?.catch?.((err) => console.warn('[snooze] discard failed:', err?.message));
            }
          }}
        />
      )}
    </div>
  );
}
