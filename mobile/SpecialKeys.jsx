/**
 * On-screen special keys. Phone soft keyboards can't send Esc / Ctrl / Tab /
 * arrows, which a terminal needs constantly. Each button sends the raw escape
 * sequence straight to the attached PTY.
 */
const KEYS = [
  { label: 'esc', seq: '\x1b' },
  { label: 'tab', seq: '\t' },
  { label: '^C', seq: '\x03' },
  { label: '^D', seq: '\x04' },
  { label: '^L', seq: '\x0c' },
  { label: '^R', seq: '\x12' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
];

export default function SpecialKeys({ onKey }) {
  return (
    <div className="special-keys">
      {KEYS.map((k) => (
        <button
          key={k.label}
          className="key"
          // Use onPointerDown so the key fires without stealing focus from
          // the terminal's input (avoids the soft keyboard dismissing).
          onPointerDown={(e) => { e.preventDefault(); onKey(k.seq); }}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
