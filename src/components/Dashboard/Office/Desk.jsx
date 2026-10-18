// One desk + one character + label + state-specific overlays. The parent
// (OfficeView / Rooms) composes a grid of these per project.
//
// The desk is drawn in SVG right alongside the character so the whole scene
// scales as one. The verb bubble and the needs-attention red '!' are plain
// HTML absolute-positioned so they can carry text and scale with the user's
// browser font, independent of the pixel grid.
import Character from './Character.jsx';
import { memo } from 'react';

// 16-col SVG wide, same width as Character; stacked vertically with the desk
// on rows 14-20 (char rows 0-13 cover the person). kind/phase are reserved
// for future monitor theming (per-agent screen palette, animated terminal
// text crawl); unused here, prefixed to pass no-unused-vars.
function DeskScene({ state, kind: _kind, phase: _phase }) {
  // Monitor glow: a brighter screen for working, dim otherwise. Palette
  // intentionally not yellow (which collides with 'needs'); cool cyan reads
  // as 'thinking' at a glance and does not fight the red bubble.
  const glow = state === 'working' ? '#4ec9b0' : state === 'done' ? '#2a4a3a' : '#1b2229';
  const bezel = '#1a1a1a';
  const desk = '#8b6c4f';
  const deskShadow = '#5a4530';

  return (
    <svg viewBox="0 0 16 20" shapeRendering="crispEdges" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0 }}>
      {/* Desk surface + leg */}
      <rect x="0" y="14" width="16" height="1" fill={desk} />
      <rect x="0" y="15" width="16" height="1" fill={deskShadow} />
      {/* Monitor (sits on the desk, to the right of the person) */}
      <rect x="11" y="7" width="5" height="6" fill={bezel} />
      <rect x="12" y="8" width="3" height="4" fill={glow} />
      <rect x="12" y="13" width="3" height="1" fill={bezel} />
      {/* Keyboard (center) */}
      <rect x="4" y="13" width="8" height="1" fill="#333" />
    </svg>
  );
}

// Scrub a tab label for the recording view. Claude's auto-label is derived
// from its title and can include a file path, a filename with extension, or
// bare source identifiers; a reel of the Office must never expose those.
// Allowlist approach: drop any token containing a filesystem/code sigil
// (dot, slash, tilde, backslash, underscore, backtick). Codex r1 P1-1 r2:
// an earlier blocklist regex missed `.env`, `src/`, `/private`; this allowlist
// drops all three. 3 tokens max, cap 24 chars. Codex r1 P1-1.
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

function DeskImpl({ tab, phase, onClick, recording }) {
  const state = tab.status || 'idle';
  const kind = tab.kind || 'claude';
  const rawLabel = tab.label || 'tab';
  const label = recording ? safeRecordingLabel(rawLabel) : rawLabel;
  const project = tab.projectName || '';
  // The parent passes phase=0 for non-working desks, which is what lets the
  // memo comparator short-circuit this component on every animation tick.
  const effectivePhase = phase;
  const verb = state === 'working' ? tab.verb : '';

  const scale = recording ? 1.4 : 1;

  return (
    <button
      type="button"
      onClick={onClick}
      className="office-desk"
      data-state={state}
      data-kind={kind}
      aria-label={`Focus ${label} (${state})`}
      style={{
        position: 'relative',
        width: `${96 * scale}px`,
        height: `${132 * scale}px`,
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
      }}
    >
      <div style={{ position: 'relative', width: `${96 * scale}px`, height: `${120 * scale}px` }}>
        <DeskScene kind={kind} state={state} phase={effectivePhase} />
        <div style={{ position: 'absolute', inset: 0 }}>
          <Character kind={kind} state={state} phase={effectivePhase} />
        </div>
        {verb && (
          <div
            className="office-verb"
            style={{
              position: 'absolute',
              top: '-6px',
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(255,255,255,0.95)',
              color: '#111',
              fontSize: '10px',
              fontWeight: 500,
              padding: '2px 6px',
              borderRadius: '8px',
              whiteSpace: 'nowrap',
              maxWidth: '140px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              pointerEvents: 'none',
              boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
            }}
          >
            {verb}
          </div>
        )}
        {state === 'needs' && (
          <div
            className="office-needs-bubble"
            aria-label="needs attention"
            style={{
              position: 'absolute',
              top: '-10px',
              right: '-6px',
              width: '22px',
              height: '22px',
              borderRadius: '50%',
              background: '#e23b3b',
              color: '#fff',
              fontSize: '16px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 6px rgba(226,59,59,0.6)',
              pointerEvents: 'none',
            }}
          >
            !
          </div>
        )}
      </div>
      <div
        className="office-label"
        style={{
          fontSize: recording ? '13px' : '11px',
          color: 'var(--fg, #e8e8ea)',
          maxWidth: `${96 * scale}px`,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'center',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
        // No tooltip in recording mode: the raw label is what we are hiding.
        title={recording ? undefined : rawLabel}
      >
        {label}
      </div>
      {recording && project && (
        <div style={{ fontSize: '10px', color: 'var(--dim, #8a8a93)', textAlign: 'center' }}>{project}</div>
      )}
    </button>
  );
}

// Memo on (tab, phase, recording). onClick is a new function each render but
// we accept re-renders of the parent; wrapping the parent's handler in
// useCallback keeps this cheap when the roster is 40+ tabs.
export default memo(DeskImpl, (a, b) => (
  a.tab.id === b.tab.id
  && a.tab.status === b.tab.status
  && a.tab.verb === b.tab.verb
  && a.tab.label === b.tab.label
  && a.tab.kind === b.tab.kind
  && a.phase === b.phase
  && a.recording === b.recording
));
