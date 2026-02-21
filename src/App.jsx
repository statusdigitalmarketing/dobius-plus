import TerminalPane from './components/Project/TerminalPane';

export default function App() {
  const cwd = new URLSearchParams(window.location.search).get('project') || undefined;

  return (
    <div className="h-full w-full" style={{ backgroundColor: 'var(--bg)' }}>
      <TerminalPane id="main" cwd={cwd} />
    </div>
  );
}
