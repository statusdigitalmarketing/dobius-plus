import { formatShortcut } from '../../lib/command-palette';

// Keyboard shortcut chips, e.g. <Kbd combo="mod+shift+t" /> renders three keys.
export default function Kbd({ combo }) {
  const keys = formatShortcut(combo);
  if (!keys.length) return null;
  return (
    <span className="inline-flex items-center gap-0.5 shrink-0" aria-label={combo}>
      {keys.map((k, i) => (
        <kbd
          key={i}
          style={{
            minWidth: 18, height: 18, padding: '0 4px',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, lineHeight: 1, fontFamily: "'SF Mono', ui-monospace, monospace",
            color: 'var(--dim)', background: 'var(--bg)',
            border: '1px solid var(--border)', borderRadius: 4,
          }}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
