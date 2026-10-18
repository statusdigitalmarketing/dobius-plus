// Mobile Office page: same visual language as the desktop OfficeView.
// Consumes the existing WS `terminals` push stream (one message every ~1s
// or on relevant status change); no new poller. Smooth at 40+ tabs.
//
// Read-only: tapping a desk or roster row opens that tab in the chat view,
// matching the Board's onOpen contract. Never types into a tab.
//
// Character art is duplicated from src/components/Dashboard/Office/Character.jsx
// (not imported) because the mobile build is a separate Vite project rooted at
// mobile/ (vite.mobile.config.js). Keeping the two in sync is cheap: the
// palette and pose data are a dozen short constants.

import { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';

const PHASE_MS = 420;
const STATUS_FIELDS = ['working', 'done', 'idle', 'needs'];

const PALETTES = {
  claude: { H: '#2d1a0e', S: '#e8c9a8', T: '#c56a2e', P: '#5a3a28', Y: '#f0d8bc' },
  codex:  { H: '#111111', S: '#dcc3a0', T: '#3f6d8e', P: '#1a2d3d', Y: '#edd5b4' },
  shell:  { H: '#444444', S: '#d9c8ad', T: '#808080', P: '#404040', Y: '#e5d4b4' },
};

const BODY = [
  '................', '......HHHH......', '.....HHHHHH.....', '....HSSSSSSH....',
  '....HSSSSSSH....', '....HSS..SSH....', '....HSSSSSSH....', '....HSSSSSSH....',
  '.....SSSSSS.....', '....TTTTTTTT....', '....TTTTTTTT....', '....TTTTTTTT....',
  '....TTTTTTTT....', '....TTTTTTTT....', '....PPPPPPPP....', '....PPPPPPPP....',
  '................', '................', '................', '................',
];
const A_WORK_A = { 10: 'Y..........Y...', 11: '.Y........Y....', 12: '..Y......Y.....' };
const A_WORK_B = { 10: '..Y........Y..', 11: '...Y......Y...', 12: '....Y....Y.....' };
const A_IDLE   = { 10: 'Y..........Y...', 11: 'Y..........Y...', 12: 'Y..........Y...' };
const A_DONE   = { 10: 'Y.............Y', 11: '.Y............Y', 12: '..Y...........Y' };
const A_NEEDS  = { 10: 'Y..........Y...', 11: 'Y..........Y...', 12: 'Y..........Y...' };
const SLEEP_Z = ['.ZZZ', '...Z', '..Z.', '.Z..', 'ZZZZ'];
const COFFEE = ['MMMM.', 'MGGMMH', 'MGGM.H', 'MGGM.H', 'MMMM..'];

function overlay(rows, ov) {
  if (!ov) return rows;
  const out = rows.slice();
  for (const r in ov) {
    const chars = out[Number(r)].split('');
    const s = ov[r];
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i]; if (c === '-') chars[i] = '.'; else if (c !== '.') chars[i] = c;
    }
    out[Number(r)] = chars.join('');
  }
  return out;
}

function Character({ kind, state, phase }) {
  const pal = PALETTES[kind] || PALETTES.claude;
  let rows = BODY;
  if (state === 'working') rows = overlay(rows, phase % 2 === 0 ? A_WORK_A : A_WORK_B);
  else if (state === 'done') rows = overlay(rows, A_DONE);
  else if (state === 'needs') rows = overlay(rows, A_NEEDS);
  else rows = overlay(rows, A_IDLE);
  const cells = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const c = row[x];
      if (c === '.' || !c) continue;
      cells.push(<rect key={`b${x}-${y}`} x={x} y={y} width={1} height={1} fill={pal[c] || '#f0f'} />);
    }
  });
  if (state === 'done') {
    COFFEE.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        const c = row[x]; if (c === '.' || !c) continue;
        const f = c === 'M' ? '#8a6a4c' : c === 'G' ? '#5a3a28' : c === 'H' ? '#8a6a4c' : '#333';
        cells.push(<rect key={`c${x}-${y}`} x={x + 1} y={y + 10} width={1} height={1} fill={f} />);
      }
    });
  }
  if (state === 'idle') {
    SLEEP_Z.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) if (row[x] === 'Z')
        cells.push(<rect key={`z${x}-${y}`} x={x + 11} y={y} width={1} height={1} fill="#9db4c7" />);
    });
  }
  return (
    <svg viewBox="0 0 16 20" shapeRendering="crispEdges" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      {cells}
    </svg>
  );
}

// Same allowlist sanitization as the desktop (safeRecordingLabel in Desk.jsx):
// drop any token containing a filesystem/code sigil, keep 3 tokens, cap 24
// chars. Codex r1 P1-1 r2.
const UNSAFE_TOKEN_RE = /[./~\\_`<>]/;
function safeRecordingLabel(raw) {
  if (!raw) return 'tab';
  const words = String(raw)
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w && !UNSAFE_TOKEN_RE.test(w) && !/\d{2,}/.test(w))
    .slice(0, 3);
  const compact = words.join(' ').slice(0, 24).trim();
  return compact || 'working';
}

function Desk({ term, phase, onClick, recording }) {
  const state = term.status || 'idle';
  const rawLabel = term.label || 'tab';
  const label = recording ? safeRecordingLabel(rawLabel) : rawLabel;
  const verb = state === 'working' ? term.verb : '';
  // Infer kind on the phone from the same heuristics as desktop: label hint
  // and the model field exposed in the WS payload (shortModel yields 'opus',
  // 'sonnet', 'haiku' for Claude; empty for shells). An explicit codex label
  // wins.
  const labelLower = (rawLabel || '').toLowerCase();
  const kind = /codex/.test(labelLower) ? 'codex' : term.claudeLive === false && !term.model ? 'shell' : 'claude';
  // The parent (Office below) passes phase=0 for non-working desks, which is
  // what lets the memo comparator short-circuit on each animation tick.
  const effectivePhase = phase;
  const scale = recording ? 1.4 : 1;
  const w = 88 * scale;
  const h = 110 * scale;
  // Desk + monitor drawn as pure HTML pixels so the whole scene is one visual.
  const glow = state === 'working' ? '#4ec9b0' : state === 'done' ? '#2a4a3a' : '#1b2229';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Open ${label} (${state})`}
      style={{
        position: 'relative', width: w, height: h + 24, background: 'transparent',
        border: 'none', padding: 0, cursor: 'pointer', display: 'flex',
        flexDirection: 'column', alignItems: 'center', gap: 4,
      }}
    >
      <div style={{ position: 'relative', width: w, height: h }}>
        <svg viewBox="0 0 16 20" shapeRendering="crispEdges" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0 }}>
          <rect x="0" y="14" width="16" height="1" fill="#8b6c4f" />
          <rect x="0" y="15" width="16" height="1" fill="#5a4530" />
          <rect x="11" y="7" width="5" height="6" fill="#1a1a1a" />
          <rect x="12" y="8" width="3" height="4" fill={glow} />
          <rect x="12" y="13" width="3" height="1" fill="#1a1a1a" />
          <rect x="4" y="13" width="8" height="1" fill="#333" />
        </svg>
        <div style={{ position: 'absolute', inset: 0 }}>
          <Character kind={kind} state={state} phase={effectivePhase} />
        </div>
        {verb && (
          <div style={{
            position: 'absolute', top: -6, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(255,255,255,0.95)', color: '#111', fontSize: 10, fontWeight: 500,
            padding: '2px 6px', borderRadius: 8, whiteSpace: 'nowrap', maxWidth: 140,
            overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}>{verb}</div>
        )}
        {state === 'needs' && (
          <div className="office-needs-bubble" style={{
            position: 'absolute', top: -10, right: -6, width: 22, height: 22, borderRadius: '50%',
            background: '#e23b3b', color: '#fff', fontSize: 16, fontWeight: 700, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(226,59,59,0.6)', pointerEvents: 'none',
          }}>!</div>
        )}
      </div>
      <div style={{
        fontSize: recording ? 13 : 11, color: '#e8e8ea', maxWidth: w,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        textAlign: 'center', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }} title={recording ? undefined : rawLabel}>{label}</div>
    </button>
  );
}
const MemoDesk = memo(Desk, (a, b) => (
  a.term.id === b.term.id
  && a.term.status === b.term.status
  && a.term.verb === b.term.verb
  && a.term.label === b.term.label
  && a.term.model === b.term.model
  && a.phase === b.phase
  && a.recording === b.recording
));

const CHIP = {
  working: { bg: '#3b2f12', fg: '#e4b43a', text: 'WORK' },
  done:    { bg: '#13311f', fg: '#37c871', text: 'DONE' },
  idle:    { bg: '#1f1f22', fg: '#8a8a93', text: 'IDLE' },
  needs:   { bg: '#3b1414', fg: '#ff8a8a', text: 'NEEDS' },
};

function elapsed(fromMs) {
  if (!fromMs) return '';
  const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export default function Office({ connection, onBack, onOpen }) {
  const [terminals, setTerminals] = useState([]);
  const [recording, setRecording] = useState(false);
  const [vertical, setVertical] = useState(false);
  const [phase, setPhase] = useState(0);
  const stateSinceRef = useRef(new Map());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return undefined;
    const h = setInterval(() => setPhase((n) => (n + 1) & 0xff), PHASE_MS);
    return () => clearInterval(h);
  }, []);

  // Elapsed labels tick at 1 Hz regardless of connection activity.
  useEffect(() => {
    const h = setInterval(() => setTick((n) => (n + 1) & 0xffff), 1000);
    return () => clearInterval(h);
  }, []);

  // Consume the existing WS push stream. One listener; no new poller.
  // Also re-request the snapshot on every (re)auth, because the server
  // suppresses unchanged broadcasts: without this, entering Office during
  // reconnection while no status moved would show "No tabs yet" until the
  // next change. Mirrors Board's own authed handling. Codex r1 P2-3.
  useEffect(() => {
    if (!connection?.onMessage) return undefined;
    const requestSnapshot = () => { try { connection.send?.({ type: 'listTerminals' }); } catch { /* best effort */ } };
    const off = connection.onMessage((msg) => {
      if (msg?.type === 'authed') { requestSnapshot(); return; }
      if (msg?.type === 'terminals' && Array.isArray(msg.list)) {
        setTerminals(msg.list);
        // Update stateSince for each tab on status change.
        const now = Date.now();
        const map = stateSinceRef.current;
        const live = new Set();
        for (const t of msg.list) {
          live.add(t.id);
          const prev = map.get(t.id);
          if (!prev || prev.status !== t.status) map.set(t.id, { status: t.status, at: now });
        }
        for (const id of map.keys()) if (!live.has(id)) map.delete(id);
      }
    });
    // If already authed at mount (common path when the user navigates in from
    // Board), request immediately; otherwise the authed handler above fires.
    if (connection.status === 'authed') requestSnapshot();
    return off;
  }, [connection]);

  const rooms = useMemo(() => {
    const by = new Map();
    for (const t of terminals) {
      const key = t.projectPath || t.projectName || 'other';
      if (!by.has(key)) by.set(key, { projectPath: key, projectName: t.projectName || 'project', tabs: [] });
      by.get(key).tabs.push(t);
    }
    return [...by.values()];
  }, [terminals]);

  const handleOpen = useCallback((id) => { if (onOpen) onOpen(id); }, [onOpen]);

  return (
    <div className={`screen office-screen ${recording ? 'rec' : ''}`} style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {!recording && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid #26262c' }}>
          <button type="button" onClick={onBack} style={{ fontSize: 13, background: 'transparent', border: 'none', color: '#8a8a93' }}>Back</button>
          <div style={{ fontSize: 13, color: '#e8e8ea', fontWeight: 500 }}>Office</div>
          <button type="button" onClick={() => setRecording(true)} style={{ fontSize: 12, padding: '4px 10px', background: '#141418', color: '#e8e8ea', border: '1px solid #26262c', borderRadius: 6 }}>Record</button>
        </div>
      )}
      {recording && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#0b0b0d' }}>
          <button type="button" onClick={() => setVertical((v) => !v)} style={{ fontSize: 12, padding: '4px 10px', background: '#141418', color: '#e8e8ea', border: '1px solid #26262c', borderRadius: 6 }}>{vertical ? '16:9' : '9:16'}</button>
          <button type="button" onClick={() => setRecording(false)} style={{ fontSize: 12, padding: '4px 10px', background: '#141418', color: '#e8e8ea', border: '1px solid #26262c', borderRadius: 6 }}>Exit</button>
        </div>
      )}

      <div style={{
        flex: 1, overflowY: 'auto', padding: '16px', background: '#0b0b0d',
        maxWidth: vertical && recording ? 'calc(100vh * 9 / 16)' : '100%',
        margin: vertical && recording ? '0 auto' : 0,
      }}>
        {rooms.map((room) => {
          const counts = STATUS_FIELDS.reduce((a, s) => ({ ...a, [s]: room.tabs.filter((t) => t.status === s).length }), {});
          return (
            <section key={room.projectPath} style={{ marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <h2 style={{ margin: 0, fontSize: 15, color: '#e8e8ea', fontWeight: 500 }}>{room.projectName}</h2>
                <div style={{ display: 'inline-flex', gap: 8, fontSize: 11, color: '#8a8a93', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                  <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#e4b43a', marginRight: 4 }} />{counts.working}</span>
                  <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#37c871', marginRight: 4 }} />{counts.done}</span>
                  <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#6b6b73', marginRight: 4 }} />{counts.idle}</span>
                  <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#e23b3b', marginRight: 4 }} />{counts.needs}</span>
                </div>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: recording ? 'repeat(auto-fill, minmax(140px, 1fr))' : 'repeat(auto-fill, minmax(100px, 1fr))',
                gap: recording ? '28px 14px' : '18px 10px',
                padding: '14px 6px',
                background: '#141418',
                border: '1px solid #26262c',
                borderRadius: 10,
              }}>
                {room.tabs.map((t) => (
                  <MemoDesk
                    key={t.id}
                    term={t}
                    // Narrow memo re-render to working desks only.
                    phase={t.status === 'working' ? phase : 0}
                    recording={recording}
                    onClick={() => handleOpen(t.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}

        {!recording && terminals.length > 0 && (
          <section style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: '#8a8a93', margin: '0 4px 8px' }}>Roster</div>
            {terminals.map((t) => {
              const chip = CHIP[t.status] || CHIP.idle;
              const since = stateSinceRef.current.get(t.id)?.at;
              const key = tick; /* eslint-disable-line no-unused-vars */
              return (
                <button
                  type="button"
                  key={t.id}
                  onClick={() => handleOpen(t.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px',
                    borderRadius: 6, cursor: 'pointer', width: '100%', background: 'transparent',
                    border: '1px solid transparent', color: '#e8e8ea', textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.03em', fontWeight: 500, background: chip.bg, color: chip.fg }}>{chip.text}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, Menlo, monospace' }}>{t.label}</span>
                  <span style={{ fontSize: 10, color: '#8a8a93', fontVariantNumeric: 'tabular-nums' }}>{elapsed(since)}</span>
                </button>
              );
            })}
          </section>
        )}

        {terminals.length === 0 && (
          <div style={{ fontSize: 13, color: '#8a8a93', textAlign: 'center', padding: '40px 20px' }}>No tabs yet.</div>
        )}
      </div>

      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .office-needs-bubble { animation: office-pulse 900ms ease-in-out infinite; }
        }
        @keyframes office-pulse {
          0%,100% { transform: scale(1); box-shadow: 0 2px 6px rgba(226,59,59,0.45); }
          50% { transform: scale(1.14); box-shadow: 0 2px 14px rgba(226,59,59,0.85); }
        }
      `}</style>
    </div>
  );
}
