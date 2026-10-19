// Mobile Office: shares the canvas renderer with the desktop Office v2 by
// importing ../src/components/Dashboard/Office/*. Vite's mobile config allows
// FS access up to the project root, so the import graph is one bundled copy.
// Consumes the existing WS `terminals` push stream (no new poller).
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { buildScene, buildRoomStates } from '../src/components/Dashboard/Office/scene.js';
import { drawScene, hitTest } from '../src/components/Dashboard/Office/renderer.js';
import { makeCamera, fit, zoomTo, tick, startAutoPan, stopAutoPan } from '../src/components/Dashboard/Office/camera.js';
import { loadAtlas } from '../src/components/Dashboard/Office/sprites.js';

const PHASE_MS = 420;
const TICKER_CAP = 12;

const UNSAFE_TOKEN_RE = /[./~\\_`<>]/;
function safeLabel(raw) {
  if (!raw) return 'tab';
  const words = String(raw).split(/\s+/).map((w) => w.trim())
    .filter((w) => w && !UNSAFE_TOKEN_RE.test(w) && !/\d{2,}/.test(w))
    .slice(0, 3);
  return (words.join(' ').slice(0, 24).trim()) || 'tab';
}

function kindOf(term) {
  const label = (term.label || '').toLowerCase();
  if (/codex/.test(label)) return 'codex';
  if (term.claudeLive === false && !term.model) return 'shell';
  return 'claude';
}

export default function Office({ connection, onBack, onOpen }) {
  const [terminals, setTerminals] = useState([]);
  const [recording, setRecording] = useState(false);
  const [vertical, setVertical] = useState(false);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const stateRef = useRef({
    phase: 0, now: Date.now(),
    statusByTab: {}, verbByTab: {}, kindByTab: {},
    ticker: [], reduceMotion: false, recording: false,
  });
  const cameraRef = useRef(makeCamera());
  const sceneRef = useRef(null);
  const viewportRef = useRef({ w: 0, h: 0 });
  const prevStatusRef = useRef({});

  useEffect(() => { loadAtlas().catch((e) => console.warn('[office] atlas load failed:', e)); }, []);

  // Shim: scene builder expects { id, projectPath, projectName, label }. The
  // WS payload gives us those plus status + verb + model. We split status/verb
  // out to stateRef and pass the rest to buildScene.
  const sceneTabs = useMemo(() => terminals.map((t) => ({
    id: t.id,
    projectPath: t.projectPath || t.projectName || 'other',
    projectName: t.projectName,
    label: t.label || 'tab',
  })), [terminals]);
  const tabStatus = useMemo(() => {
    const out = {};
    for (const t of terminals) out[t.id] = t.status || 'idle';
    return out;
  }, [terminals]);
  const scene = useMemo(() => buildScene({
    tabs: sceneTabs, tabStatus, projectName: '',
  }), [sceneTabs, tabStatus]);

  const didFirstFitRef = useRef(false);
  useEffect(() => {
    sceneRef.current = scene;
    const cam = cameraRef.current;
    const vp = viewportRef.current;
    const populated = scene.desks && scene.desks.length > 0;
    if (vp.w > 0 && populated && !didFirstFitRef.current) {
      fit(cam, scene.bounds, vp, { padding: 20 });
      cam.x = cam.tx; cam.y = cam.ty; cam.zoom = cam.tzoom;
      didFirstFitRef.current = true;
    }
    if (cam.panMode === 'pan-lr') {
      cam.panBounds = scene.bounds;
      cam.viewportTilesW = vp.w / cam.zoom / 16;
    }
  }, [scene]);

  // Status-only refresh of counts + door lights.
  useEffect(() => {
    const sc = sceneRef.current;
    if (!sc) return;
    sc.roomStates = buildRoomStates(sc.rooms, tabStatus);
  }, [tabStatus]);

  useEffect(() => {
    const kindByTab = {};
    const statusByTab = {};
    const verbByTab = {};
    for (const t of terminals) {
      kindByTab[t.id] = kindOf(t);
      statusByTab[t.id] = t.status || 'idle';
      verbByTab[t.id] = t.verb || '';
    }
    const prev = prevStatusRef.current;
    const now = Date.now();
    const additions = [];
    for (const t of terminals) {
      const was = prev[t.id];
      const cur = statusByTab[t.id];
      if (was && was !== cur) {
        const label = safeLabel(t.label);
        if (cur === 'done')  additions.push(`${label} finished its turn`);
        if (cur === 'needs') additions.push(`${label} needs you`);
      }
      prev[t.id] = cur;
    }
    for (const id of Object.keys(prev)) if (!statusByTab[id]) delete prev[id];
    const ticker = (stateRef.current.ticker || []).concat(additions).slice(-TICKER_CAP);
    stateRef.current = { ...stateRef.current, kindByTab, statusByTab, verbByTab, ticker, now };
  }, [terminals]);

  useEffect(() => {
    if (!connection?.onMessage) return undefined;
    const req = () => { try { connection.send?.({ type: 'listTerminals' }); } catch { /* best effort */ } };
    const off = connection.onMessage((msg) => {
      if (msg?.type === 'authed') { req(); return; }
      if (msg?.type === 'terminals' && Array.isArray(msg.list)) setTerminals(msg.list);
    });
    if (connection.status === 'authed') req();
    return off;
  }, [connection]);

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
      cameraRef.current.viewportPx = canvas.width;
      if (sceneRef.current) {
        fit(cameraRef.current, sceneRef.current.bounds, viewportRef.current, { padding: 20 * dpr });
        if ((sceneRef.current.desks?.length || 0) > 0) didFirstFitRef.current = true;
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, []);

  // Reduce-motion reactive media query listener.
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
        const stateForFrame = { ...stateRef.current, phase: Math.floor(stateRef.current.phase) };
        drawScene(ctx, sc, cameraRef.current, stateForFrame);
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [recording]);

  const onClick = useCallback((e) => {
    const canvas = canvasRef.current;
    const sc = sceneRef.current;
    if (!canvas || !sc) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const hit = hitTest(sc, cameraRef.current, viewportRef.current, px, py, stateRef.current.statusByTab);
    if (!hit) { fit(cameraRef.current, sc.bounds, viewportRef.current, { padding: 20 }); return; }
    if (hit.type === 'char') { onOpen?.(hit.tabId); return; }
    if (hit.type === 'room') {
      zoomTo(cameraRef.current, { x: hit.room.x, y: hit.room.y, w: hit.room.w, h: hit.room.h }, viewportRef.current, { padding: 36 });
    }
  }, [onOpen]);

  useEffect(() => {
    const cam = cameraRef.current;
    if (recording) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!reduce && sceneRef.current) startAutoPan(cam, sceneRef.current.bounds, viewportRef.current.w / cam.zoom / 16, viewportRef.current.w);
    } else {
      stopAutoPan(cam);
    }
  }, [recording]);

  // Focus trap: when recording is on, Tab cycles only through recording
  // controls inside this view. Mobile keyboard users (hardware kbd on iPad)
  // could otherwise tab out to hidden chrome. Codex r1 P2-10.
  useEffect(() => {
    if (!recording) return undefined;
    const el = overlayRef.current;
    const onKey = (e) => { if (e.key === 'Escape') setRecording(false); };
    window.addEventListener('keydown', onKey);
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

  return (
    <div
      ref={overlayRef}
      style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#07070a', color: '#e8e8ea' }}
      role={recording ? 'dialog' : undefined}
      aria-modal={recording ? 'true' : undefined}
    >
      {!recording && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #26262c' }}>
          <button type="button" onClick={onBack} style={{ fontSize: 13, background: 'transparent', border: 'none', color: '#8a8a93' }}>Back</button>
          <div style={{ fontSize: 13, color: '#e8e8ea', fontWeight: 500 }}>Office</div>
          <button type="button" onClick={() => setRecording(true)} style={{ fontSize: 12, padding: '4px 10px', background: '#141418', color: '#e8e8ea', border: '1px solid #26262c', borderRadius: 6 }}>Record</button>
        </div>
      )}
      {recording && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#0b0b0d' }}>
          <button type="button" onClick={() => setVertical((v) => !v)} style={{ fontSize: 12, padding: '4px 10px', background: '#141418', color: '#e8e8ea', border: '1px solid #26262c', borderRadius: 6 }}>{vertical ? '16:9' : '9:16'}</button>
          <button type="button" onClick={() => setRecording(false)} style={{ fontSize: 12, padding: '4px 10px', background: '#141418', color: '#e8e8ea', border: '1px solid #26262c', borderRadius: 6 }}>Exit</button>
        </div>
      )}
      <div style={{
        flex: 1,
        position: 'relative',
        overflow: 'hidden',
        maxWidth: vertical && recording ? 'calc(100vh * 9 / 16)' : '100%',
        margin: vertical && recording ? '0 auto' : 0,
      }}>
        <canvas ref={canvasRef} onClick={onClick} style={{ display: 'block', cursor: 'pointer' }} />
      </div>
      {/* Keyboard-only terminal list for mobile (hardware keyboard on iPad or
       * assistive tech). Hidden until focused; surfaces in the toolbar area.
       * Removed during recording so the focus trap cycles only recording
       * controls. Codex r2 P2-6. */}
      {!recording && (
        <ul aria-label="Tabs (keyboard list)" style={{
          position: 'absolute', left: 8, top: 48, zIndex: 2,
          listStyle: 'none', margin: 0, padding: 0,
          width: 0, height: 0, overflow: 'hidden',
        }}
          onFocus={(e) => {
            const u = e.currentTarget;
            u.style.width = 'auto'; u.style.height = 'auto'; u.style.overflow = 'visible';
            u.style.background = '#141418'; u.style.border = '1px solid #4ec9b0';
            u.style.borderRadius = '6px'; u.style.padding = '6px 8px';
          }}
          onBlur={(e) => {
            const u = e.currentTarget;
            if (!u.contains(document.activeElement)) {
              u.style.width = '0'; u.style.height = '0'; u.style.overflow = 'hidden';
              u.style.background = ''; u.style.border = ''; u.style.padding = '';
            }
          }}
        >
          {terminals.map((t) => {
            const st = t.status || 'idle';
            const aria = `Open ${t.label || 'tab'}, ${st}${st === 'needs' ? ' attention' : ''}`;
            return (
              <li key={t.id}>
                <button type="button" onClick={() => onOpen?.(t.id)} aria-label={aria} style={{
                  fontSize: 12, padding: '3px 8px', background: 'transparent', color: '#e8e8ea',
                  border: '1px solid transparent', borderRadius: 4, textAlign: 'left',
                  fontFamily: 'ui-monospace, Menlo, monospace', cursor: 'pointer',
                }}>Open {t.label || 'tab'} <span style={{ opacity: 0.6 }}>({st})</span></button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
