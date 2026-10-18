// Office view: a pixel-art office of every agent tab, with roster + project
// header counts, recording mode, and click-to-focus. Read-only: never writes
// into a tab, never answers a prompt.
//
// Data sources (all Dobius's own status, never scrollback parsed by this view):
//   terminalTabs   : the window's tabs (id, projectPath, label, cwd)
//   tabStatus      : { tabId -> 'working' | 'done' | 'idle' | 'needs' }
//   runningAgents  : { agentId -> tabId } to tag Codex vs Claude characters
//   currentProjectPath : the window's project folder (= one room)
//
// Hard rule enforcement:
//  - Never shows file paths, prompt text, or scrollback. Only tab label,
//    project name, status chip, verb string.
//  - Recording mode hides chrome (toggle class on root).
//  - Click handler is the only action: it calls setActiveTabId + setDashboardTab
//    to focus the terminal view and that tab. No terminalWrite anywhere here.
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useStore } from '../../../store/store';
import Desk from './Desk.jsx';
import Roster from './Roster.jsx';
import './office.css';

const STATUS_FIELDS = ['working', 'done', 'idle', 'needs'];
const PHASE_MS = 420; // typing-animation phase flip; multiple of common 60/90fps intervals.

function deriveKind({ tab, agentById, agentIdByTabId }) {
  // Codex vs Claude vs Shell. Dobius does not yet carry a canonical "which CLI
  // is running in this PTY" flag for the renderer, so we read what IS known:
  //   1. an Orchestrator / Mission Control agent is registered for this tab,
  //      and its model/name mentions codex -> codex
  //   2. the user named the tab something containing 'codex' (case-insensitive)
  //      -> codex
  //   3. a bare shell tab (no label / 'Tab N' default) that is 'idle' AND has
  //      no registered agent -> shell
  //   4. everything else defaults to claude, which is the common case.
  const agentId = agentIdByTabId.get(tab.id);
  const agent = agentId ? agentById.get(agentId) : null;
  const agentHay = `${agent?.name || ''} ${agent?.model || ''}`.toLowerCase();
  if (/codex/.test(agentHay)) return 'codex';
  if (/codex/i.test(tab.label || '')) return 'codex';
  if (!agent && (tab.status === 'idle' || !tab.status) && /^(tab \d+|new)$/i.test(tab.label || '')) return 'shell';
  return 'claude';
}

export default function OfficeView() {
  const terminalTabs = useStore((s) => s.terminalTabs);
  const tabStatus = useStore((s) => s.tabStatus);
  const runningAgents = useStore((s) => s.runningAgents);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const currentProjectPath = useStore((s) => s.currentProjectPath);
  const [agents, setAgents] = useState([]);
  const [recording, setRecording] = useState(false);
  const [vertical, setVertical] = useState(false);
  const [phase, setPhase] = useState(0);

  // Phase ticker drives the typing-arm animation. One global interval; Desks
  // are memoized on phase so only working-state desks actually re-render.
  // Respect reduce-motion: hold phase 0 so the arms stay still.
  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return undefined;
    const h = setInterval(() => setPhase((n) => (n + 1) & 0xff), PHASE_MS);
    return () => clearInterval(h);
  }, []);

  // Esc exits recording mode. Without this a keyboard-only user could tab out
  // to the (visually hidden) dashboard chrome and reveal it (Codex r1 r2 P2-3).
  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setRecording(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recording]);

  // Agent registry (so we can tag Codex vs Claude tabs). Loaded once; the
  // list is tiny and rarely changes mid-session.
  useEffect(() => {
    if (!window.electronAPI?.agentsList) return;
    window.electronAPI.agentsList().then((list) => setAgents(Array.isArray(list) ? list : []));
  }, []);

  // Lookup maps built once per deps change.
  const { agentById, agentIdByTabId } = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const byTab = new Map();
    for (const [aid, tid] of Object.entries(runningAgents || {})) {
      if (tid) byTab.set(tid, aid);
    }
    return { agentById: byId, agentIdByTabId: byTab };
  }, [agents, runningAgents]);

  // Track when each tab entered its CURRENT status so the roster can show
  // "4m" / "12s". Kept in a ref so the Roster's 1Hz re-render is only for the
  // elapsed string, not for stateSince thrashing.
  const stateSinceRef = useRef(new Map());
  const stateSinceByTab = useMemo(() => {
    const now = Date.now();
    const map = stateSinceRef.current;
    const result = new Map();
    for (const t of terminalTabs) {
      const status = tabStatus[t.id] || 'idle';
      const prev = map.get(t.id);
      if (!prev || prev.status !== status) {
        map.set(t.id, { status, at: now });
      }
      result.set(t.id, map.get(t.id).at);
    }
    // Garbage-collect dropped tabs so the map does not grow unbounded.
    const liveIds = new Set(terminalTabs.map((t) => t.id));
    for (const id of map.keys()) if (!liveIds.has(id)) map.delete(id);
    return result;
  }, [terminalTabs, tabStatus]);

  // Per-tab view model fed to Desk + Roster.
  const tabsView = useMemo(() => {
    return terminalTabs.map((t) => {
      const status = tabStatus[t.id] || 'idle';
      const kind = deriveKind({ tab: { ...t, status }, agentById, agentIdByTabId });
      return {
        id: t.id,
        label: t.label || 'tab',
        projectName: (t.projectPath || currentProjectPath || '').split('/').filter(Boolean).pop() || 'project',
        projectPath: t.projectPath || currentProjectPath,
        status,
        kind,
        verb: '', // desktop has no verb feed in v1; mobile uses the WS payload directly
        stateSince: stateSinceByTab.get(t.id) || Date.now(),
      };
    });
  }, [terminalTabs, tabStatus, agentById, agentIdByTabId, stateSinceByTab, currentProjectPath]);

  // Group by project (one room per project in a window). In a single Dobius
  // window there is typically ONE project, but keeping the group abstraction
  // handles multi-project tabs gracefully should they appear.
  const rooms = useMemo(() => {
    const by = new Map();
    for (const t of tabsView) {
      const key = t.projectPath || 'unknown';
      if (!by.has(key)) by.set(key, { projectPath: key, projectName: t.projectName, tabs: [] });
      by.get(key).tabs.push(t);
    }
    return [...by.values()];
  }, [tabsView]);

  const onFocus = useCallback((tabId) => {
    // Switch to the terminal view and set this tab as active. Pure
    // read-focus: nothing is typed, no PTY is written to.
    if (setActiveTab) setActiveTab(tabId);
    if (setActiveView) setActiveView('terminal');
  }, [setActiveTab, setActiveView]);

  // When recording is on we render as a fixed overlay so the parent dashboard
  // tab bar and the ProjectView sidebar cannot leak into the frame (Codex r1
  // P1-2). z-index 1000 so a mid-recording UpdateBanner (z-50) cannot pop
  // into the frame (Codex r2 P2 r1).
  const overlayRef = useRef(null);
  const containerStyle = recording ? {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    background: 'var(--bg, #0b0b0d)',
  } : undefined;

  // Focus containment: when recording turns on, move keyboard focus into the
  // overlay and keep Tab cycling WITHIN it. Without this, Shift+Tab from the
  // ratio button would reach the hidden Settings tab (Codex r2 P2 r1).
  useEffect(() => {
    if (!recording) return undefined;
    const el = overlayRef.current;
    if (!el) return undefined;
    const focusables = () => Array.from(el.querySelectorAll(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )).filter((n) => n.offsetParent !== null);
    // Focus the first interactive element inside.
    const first = focusables()[0];
    if (first) first.focus();
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const active = document.activeElement;
      const idx = items.indexOf(active);
      // Shift+Tab from the first element -> go to last; Tab from last -> first.
      if (e.shiftKey && (idx <= 0)) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && idx === items.length - 1) { e.preventDefault(); items[0].focus(); }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [recording]);

  return (
    <div
      ref={overlayRef}
      className={`office-root ${recording ? 'office-recording-active' : ''}`}
      data-ratio={vertical ? 'vertical' : 'wide'}
      style={containerStyle}
      role={recording ? 'dialog' : undefined}
      aria-modal={recording ? 'true' : undefined}
      aria-label={recording ? 'Office recording mode. Press Escape to exit.' : undefined}
    >
      <main className="office-main">
        {!recording && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginBottom: '8px' }}>
            <button
              type="button"
              onClick={() => setRecording(true)}
              style={{ fontSize: '12px', padding: '4px 10px', background: 'var(--panel, #141418)', color: 'var(--fg, #e8e8ea)', border: '1px solid var(--border, #26262c)', borderRadius: '6px', cursor: 'pointer' }}
            >
              Record mode
            </button>
          </div>
        )}
        {recording && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => setVertical((v) => !v)}
                style={{ fontSize: '12px', padding: '4px 10px', background: 'var(--panel, #141418)', color: 'var(--fg, #e8e8ea)', border: '1px solid var(--border, #26262c)', borderRadius: '6px', cursor: 'pointer' }}
              >
                {vertical ? '16:9' : '9:16'}
              </button>
              <span style={{ fontSize: '11px', color: 'var(--dim, #8a8a93)' }}>Recording layout active</span>
            </div>
            <button
              type="button"
              onClick={() => setRecording(false)}
              style={{ fontSize: '12px', padding: '4px 10px', background: 'var(--panel, #141418)', color: 'var(--fg, #e8e8ea)', border: '1px solid var(--border, #26262c)', borderRadius: '6px', cursor: 'pointer' }}
            >
              Exit recording
            </button>
          </div>
        )}

        {rooms.map((room) => {
          const counts = STATUS_FIELDS.reduce((acc, s) => {
            acc[s] = room.tabs.filter((t) => t.status === s).length;
            return acc;
          }, { working: 0, done: 0, idle: 0, needs: 0 });
          return (
            <section key={room.projectPath} style={{ marginBottom: '24px' }}>
              <div className="office-header">
                <h2>{room.projectName}</h2>
                <div className="office-counts" aria-label="status counts">
                  <span className="cn"><span className="dot dot-working" />{counts.working}</span>
                  <span className="cn"><span className="dot dot-done" />{counts.done}</span>
                  <span className="cn"><span className="dot dot-idle" />{counts.idle}</span>
                  <span className="cn"><span className="dot dot-needs" />{counts.needs}</span>
                </div>
              </div>
              <div className={`office-floor ${recording ? 'recording' : ''} ${vertical ? 'vertical' : ''}`}>
                {room.tabs.map((tab) => (
                  <Desk
                    key={tab.id}
                    tab={tab}
                    // Narrow the memo re-render window to actually-working
                    // desks only. Idle/done/needs see phase=0 constant so the
                    // memo comparator sees no change on each 420ms tick.
                    // Computing this at the call site is what makes the memo
                    // effective; moving it inside the component after the
                    // compare, as in the first pass, still rendered all desks
                    // (Codex r1 r2 P2-4).
                    phase={tab.status === 'working' ? phase : 0}
                    recording={recording}
                    onClick={() => onFocus(tab.id)}
                  />
                ))}
                {room.tabs.length === 0 && (
                  <div style={{ gridColumn: '1 / -1', fontSize: '12px', color: 'var(--dim, #8a8a93)', padding: '12px' }}>
                    Open a terminal tab to see someone in this room.
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </main>

      <aside className="office-aside" aria-label="Roster">
        <div style={{ fontSize: '11px', color: 'var(--dim, #8a8a93)', margin: '0 4px 10px' }}>Roster</div>
        <Roster tabs={tabsView} activeTabId={activeTabId} onFocus={onFocus} />
      </aside>
    </div>
  );
}
