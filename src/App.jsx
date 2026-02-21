import { useState, useEffect } from 'react';
import TerminalPane from './components/Project/TerminalPane';
import ThemePicker from './components/shared/ThemePicker';
import { THEMES, applyTheme } from './lib/themes';

export default function App() {
  const cwd = new URLSearchParams(window.location.search).get('project') || undefined;
  const [themeIndex, setThemeIndex] = useState(0);
  const theme = THEMES[themeIndex];

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="h-full w-full flex flex-col" style={{ backgroundColor: 'var(--bg)' }}>
      <div
        className="drag-region flex items-center justify-between px-20 py-2"
        style={{ backgroundColor: 'var(--surface)', borderBottom: '1px solid var(--border)' }}
      >
        <span className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>Dobius+</span>
        <ThemePicker currentIndex={themeIndex} onChange={setThemeIndex} />
      </div>
      <div className="flex-1 min-h-0">
        <TerminalPane id="main" cwd={cwd} theme={theme.xtermTheme} />
      </div>
    </div>
  );
}
