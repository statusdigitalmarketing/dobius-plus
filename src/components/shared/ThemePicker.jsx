import { THEMES } from '../../lib/themes';

/**
 * ThemePicker — dropdown with color preview swatches for each theme.
 * @param {{ currentIndex: number, onChange: (index: number) => void }} props
 */
export default function ThemePicker({ currentIndex, onChange }) {
  return (
    <div className="relative flex items-center gap-2">
      <span className="text-xs" style={{ color: 'var(--dim)' }}>Theme</span>
      <div className="flex gap-1">
        {THEMES.map((theme, i) => (
          <button
            key={theme.name}
            onClick={() => onChange(i)}
            title={theme.name}
            className="no-drag w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
            style={{
              backgroundColor: theme.bg,
              borderColor: i === currentIndex ? theme.accent1 : `${theme.fg}33`,
              boxShadow: i === currentIndex ? `0 0 6px ${theme.accent1}66` : 'none',
              transform: i === currentIndex ? 'scale(1.15)' : 'scale(1)',
            }}
          >
            <span
              className="block w-2 h-2 rounded-full mx-auto"
              style={{ backgroundColor: theme.accent1 }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
