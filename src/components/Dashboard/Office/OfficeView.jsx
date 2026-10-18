// Office v2: canvas-rendered top-down pixel-art office.
//
// Read-only consumer of Dobius's own status (terminalTabs, tabStatus,
// runningAgents from the Zustand store). Never writes to a tab; the only
// action is focusing one. Recording mode hides parent chrome, offers 9:16
// vertical, and auto-pans the camera across the floor plan.
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useStore } from '../../../store/store';
import { buildScene, buildRoomStates } from './scene.js';
import { drawScene, hitTest } from './renderer.js';
import { makeCamera, fit, zoomTo, tick, startAutoPan, stopAutoPan } from './camera.js';
import './office.css';

const PHASE_MS = 420;
const TICKER_CAP = 12;

function deriveKind(tab, agentById, agentIdByTabId) {
  const agentId = agentIdByTabId.get(tab.id);
  const agent = agentId ? agentById.get(agentId) : null;
  const hay = `${agent?.name || ''} ${agent?.model || ''}`.toLowerCase();
  if (/codex/.test(hay)) return 'codex';
  if (/codex/i.test(tab.label || '')) return 'codex';
  return 'claude';
}

// Scrub a label for the lobby ticker (recording-safe even outside recording).
// The ticker shows across the room; same allowlist that Desk used in v1.
const UNSAFE_TOKEN_RE = /[./~\\_`<>]/;
function safeLabel(raw) {
  if (!raw) return 'tab';
  const words = String(raw).split(/\s+/).map((w) => w.trim())
    .filter((w) => w && !UNSAFE_TOKEN_RE.test(w) && !/\d{2,}/.test(w))
    .slice(0, 3);
  return (words.join(' ').slice(0, 24).trim()) || 'tab';
}

export default function OfficeView() {
  const terminalTabs = useStore((s) => s.terminalTabs);
  const tabStatus = useStore((s) => s.tabStatus);
  const runningAgents = useStore((s) => s.runningAgents);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveView = useStore((s) => s.setActiveView);
  const currentProjectPath = useStore((s) => s.currentProjectPath);

  const [agents, setAgents] = useState([]);
  const [recording, setRecording] = useState(false);
  const [vertical, setVertical] = useState(false);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const stateRef = useRef({
    phase: 0,
    now: Date.now(),
    statusByTab: {},
    verbByTab: {},
    kindByTab: {},
    ticker: [],
    reduceMotion: false,
    recording: false,
  });
  const cameraRef = useRef(makeCamera());
  const sceneRef = useRef(null);
  const viewportRef = useRef({ w: 0, h: 0 });
  // Track previous status per tab so we can emit ticker events on change.
  const prevStatusRef = useRef({});

  useEffect(() => {
    if (!window.electronAPI?.agentsList) return;
    window.electronAPI.agentsList().then((list) => setAgents(Array.isArray(list) ? list : []));
  }, []);

  const agentIdByTabId = useMemo(() => {
    const map = new Map();
    for (const [aid, tid] of Object.entries(runningAgents || {})) if (tid) map.set(tid, aid);
    return map;
  }, [runningAgents]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  // Rebuild Scene whenever the TAB LIST changes. tabStatus flipping on its
  // own does NOT change the room layout, so we exclude it from the scene
  // identity key and update statusByTab in a separate pass. Codex r1 P2-5:
  // a status push every second was rebuilding the scene and re-fitting the
  // camera, undoing the user's room-zoom instantly.
  const tabsKey = useMemo(() => terminalTabs.map((t) => `${t.id}:${t.projectPath}:${t.label}`).join('|'), [terminalTabs]);
  const scene = useMemo(() => {
    return buildScene({
      tabs: terminalTabs,
      tabStatus,
      projectName: (currentProjectPath || '').split('/').filter(Boolean).pop() || '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsKey]);

  const didFirstFitRef = useRef(false);
  useEffect(() => {
    sceneRef.current = scene;
    const cam = cameraRef.current;
    const vp = viewportRef.current;
    // Fit on the first POPULATED scene (any desks present), not merely on the
    // first scene (which may be an empty lobby before tabs arrive). Codex r2
    // P1-1. After that first fit the user owns the camera until they press
    // Fit floor.
    const populated = scene.desks && scene.desks.length > 0;
    if (vp.w > 0 && populated && !didFirstFitRef.current) {
      fit(cam, scene.bounds, vp, { padding: 24 });
      cam.x = cam.tx; cam.y = cam.ty; cam.zoom = cam.tzoom;
      didFirstFitRef.current = true;
    }
    if (cam.panMode === 'pan-lr') {
      cam.panBounds = scene.bounds;
      cam.viewportTilesW = vp.w / cam.zoom / 16;
    }
  }, [scene]);

  // Refresh room-states aggregates (counts + door light color) on tabStatus
  // changes WITHOUT rebuilding the layout. Codex r2 P2-2: without this, the
  // wall board and door lights froze at whatever values held when the tab list
  // last changed.
  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc) return;
    sc.roomStates = buildRoomStates(sc.rooms, tabStatus);
  }, [tabStatus]);

  // Push status + kind + verb into stateRef and derive ticker events on
  // transitions. Runs on every store change but is O(tabs) and cheap.
  useEffect(() => {
    const kindByTab = {};
    const statusByTab = {};
    const verbByTab = {};
    for (const t of terminalTabs) {
      kindByTab[t.id] = deriveKind(t, agentById, agentIdByTabId);
      statusByTab[t.id] = tabStatus[t.id] || 'idle';
      verbByTab[t.id] = ''; // desktop has no verb feed in v2; mobile has it via WS
    }
    // Ticker transitions.
    const prev = prevStatusRef.current;
    const now = Date.now();
    const additions = [];
    for (const t of terminalTabs) {
      const was = prev[t.id];
      const nowSt = statusByTab[t.id];
      if (was && was !== nowSt) {
        const label = safeLabel(t.label);
        if (nowSt === 'done')  additions.push(`${label} finished its turn`);
        if (nowSt === 'needs') additions.push(`${label} needs you`);
      }
      prev[t.id] = nowSt;
    }
    // Drop prev entries for tabs no longer present.
    for (const id of Object.keys(prev)) if (!statusByTab[id]) delete prev[id];
    const ticker = (stateRef.current.ticker || []).concat(additions).slice(-TICKER_CAP);
    stateRef.current = { ...stateRef.current, kindByTab, statusByTab, verbByTab, ticker, now };
  }, [terminalTabs, tabStatus, agentById, agentIdByTabId]);

  // Measure viewport + handle resize. ResizeObserver on the stage element so
  // state-driven CSS changes (switching 16:9 to 9:16 narrows the stage from
  // 1600 to 562 px wide) immediately reflow the canvas backing store. Codex
  // r1 P1-3: a window-only listener kept the canvas at the original width and
  // the office room ended up clipped out of frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const stage = canvas.parentElement;
    if (!stage) return undefined;
    const update = () => {
      const r = stage.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      viewportRef.current = { w: canvas.width, h: canvas.height };
      const cam = cameraRef.current;
      // Keep auto-pan's cached viewport width honest after a resize so the
      // drift bounds reflect the new canvas (Codex r3 P2-1).
      cam.viewportPx = canvas.width;
      if (sceneRef.current) {
        fit(cam, sceneRef.current.bounds, viewportRef.current, { padding: 24 * dpr });
        // Mark the first populated fit here too, otherwise a later tab-list
        // change can snap the camera back to the whole floor (Codex r3 P2-2).
        if ((sceneRef.current.desks?.length || 0) > 0) didFirstFitRef.current = true;
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, []);

  // Reduce-motion reactivity: respond to the OS flipping the preference while
  // the Office is open; without this a user turning reduce-motion ON mid-session
  // kept the auto-pan running (Codex r1 P2-8).
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const update = () => {
      stateRef.current.reduceMotion = mq.matches;
      if (mq.matches) stopAutoPan(cameraRef.current);
    };
    update();
    if (mq.addEventListener) mq.addEventListener('change', update);
    else if (mq.addListener) mq.addListener(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', update);
      else if (mq.removeListener) mq.removeListener(update);
    };
  }, []);

  // RAF loop. Advances camera + phase; redraws scene.
  useEffect(() => {
    let rafId = 0;
    let lastT = performance.now();
    const loop = (t) => {
      const dt = Math.min(0.1, (t - lastT) / 1000);
      lastT = t;
      stateRef.current.now = Date.now();
      if (!stateRef.current.reduceMotion) {
        stateRef.current.phase += dt * (1000 / PHASE_MS);
        stateRef.current.phase %= 256;
      }
      tick(cameraRef.current, dt);
      const canvas = canvasRef.current;
      const sc = sceneRef.current;
      if (canvas && sc) {
        const ctx = canvas.getContext('2d');
        stateRef.current.recording = recording;
        // Round phase for even/odd arm-pose compare in renderer.
        const stateForFrame = { ...stateRef.current, phase: Math.floor(stateRef.current.phase) };
        drawScene(ctx, sc, cameraRef.current, stateForFrame);
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [recording]);

  // Clicks: hit-test and route. Character => focus the tab. Room => zoom.
  // Lobby or background => auto-fit back to the whole floor.
  const onClick = useCallback((e) => {
    const canvas = canvasRef.current;
    const sc = sceneRef.current;
    if (!canvas || !sc) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const hit = hitTest(sc, cameraRef.current, viewportRef.current, px, py, stateRef.current.statusByTab);
    if (!hit) {
      fit(cameraRef.current, sc.bounds, viewportRef.current, { padding: 24 });
      return;
    }
    if (hit.type === 'char') {
      setActiveTab?.(hit.tabId);
      setActiveView?.('terminal');
      return;
    }
    if (hit.type === 'room') {
      const r = hit.room;
      // Zoom to the room's rect in sprite-pixel space (fit converts via tiles).
      zoomTo(cameraRef.current, { x: r.x, y: r.y, w: r.w, h: r.h }, viewportRef.current, { padding: 48 });
    }
  }, [setActiveTab, setActiveView]);

  // Recording: fixed overlay, focus trap, Escape handler, auto-pan toggle.
  useEffect(() => {
    const cam = cameraRef.current;
    if (recording) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!reduce && sceneRef.current) startAutoPan(cam, sceneRef.current.bounds, viewportRef.current.w / cam.zoom / 16, viewportRef.current.w);
    } else {
      stopAutoPan(cam);
    }
  }, [recording]);
  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setRecording(false); };
    window.addEventListener('keydown', onKey);
    const el = overlayRef.current;
    const focusables = () => Array.from(el?.querySelectorAll('button:not([disabled])') || [])
      .filter((n) => n.offsetParent !== null);
    const first = focusables()[0];
    if (first) first.focus();
    const trap = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const idx = items.indexOf(document.activeElement);
      if (e.shiftKey && idx <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && idx === items.length - 1) { e.preventDefault(); items[0].focus(); }
    };
    el?.addEventListener('keydown', trap);
    return () => {
      window.removeEventListener('keydown', onKey);
      el?.removeEventListener('keydown', trap);
    };
  }, [recording]);

  const containerStyle = recording ? {
    position: 'fixed', inset: 0, zIndex: 1000, background: '#07070a',
  } : undefined;

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
      <div className="office-toolbar">
        {!recording && (
          <>
            <button type="button" className="office-tool-btn" onClick={() => {
              if (sceneRef.current) fit(cameraRef.current, sceneRef.current.bounds, viewportRef.current, { padding: 24 });
            }}>Fit floor</button>
            <button type="button" className="office-tool-btn" onClick={() => setRecording(true)}>Record mode</button>
          </>
        )}
        {recording && (
          <>
            <button type="button" className="office-tool-btn" onClick={() => setVertical((v) => !v)}>{vertical ? '16:9' : '9:16'}</button>
            <span style={{ fontSize: 11, color: '#8a8a93' }}>Auto-pan on, Escape to exit</span>
            <button type="button" className="office-tool-btn" onClick={() => setRecording(false)}>Exit recording</button>
          </>
        )}
      </div>
      <div className={`office-stage ${vertical ? 'vertical' : ''}`}>
        <canvas ref={canvasRef} onClick={onClick} style={{ display: 'block' }} />
      </div>
      {/* Keyboard-accessible list of tabs. Visually-hidden by default so the
       * canvas owns the frame; moves ON screen when a button inside it is
       * focused so sighted keyboard users can see where they are. The list
       * is REMOVED from the DOM during recording so the recording focus trap
       * does not cycle through terminal buttons (Codex r2 P2-5). */}
      {!recording && (
        <ul aria-label="Tabs (keyboard list)" className="office-kbd-list">
          {terminalTabs.map((t) => {
            const st = (tabStatus && tabStatus[t.id]) || 'idle';
            // Include status in the accessible label so screen-reader users
            // can hear which tab needs attention (Codex r3 P2-3).
            const aria = `Open ${t.label || 'tab'}, ${st}${st === 'needs' ? ' attention' : ''}`;
            return (
              <li key={t.id}>
                <button type="button" aria-label={aria} onClick={() => { setActiveTab?.(t.id); setActiveView?.('terminal'); }}>
                  Open {t.label || 'tab'} <span style={{ opacity: 0.6 }}>({st})</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
