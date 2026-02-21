import { useState, useRef, useEffect } from 'react';
import { THEMES } from '../../lib/themes';
import { AnimatePresence, motion } from 'framer-motion';

export default function ThemePicker({ currentIndex, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const current = THEMES[currentIndex];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="no-drag w-6 h-6 rounded-full border-2 transition-all duration-150 hover:scale-110"
        style={{
          backgroundColor: current.bg,
          borderColor: current.accent1,
        }}
        title={current.name}
      >
        <span
          className="block w-2.5 h-2.5 rounded-full mx-auto"
          style={{ backgroundColor: current.accent1 }}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full mt-2 p-2 rounded-lg z-50"
            style={{
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--border)',
              backdropFilter: 'blur(12px)',
              minWidth: '140px',
            }}
          >
            {THEMES.map((theme, i) => (
              <button
                key={theme.name}
                onClick={() => { onChange(i); setOpen(false); }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors duration-100"
                style={{
                  color: i === currentIndex ? 'var(--fg)' : 'var(--dim)',
                  backgroundColor: i === currentIndex ? 'var(--bg)' : 'transparent',
                }}
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: theme.accent1 }}
                />
                <span className="flex-1 text-left">{theme.name}</span>
                {i === currentIndex && (
                  <svg className="w-3 h-3 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
