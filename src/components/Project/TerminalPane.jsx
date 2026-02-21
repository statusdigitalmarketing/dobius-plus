import { useTerminal } from '../../hooks/useTerminal';
import '@xterm/xterm/css/xterm.css';

/**
 * TerminalPane — renders an xterm.js terminal connected to node-pty.
 * @param {{ id: string, cwd: string, theme?: object, className?: string }} props
 */
export default function TerminalPane({ id, cwd, theme, className = '' }) {
  const { containerRef } = useTerminal({ id, cwd, theme });

  return (
    <div
      ref={containerRef}
      className={`w-full h-full ${className}`}
      style={{
        padding: '4px 0 0 4px',
        backgroundColor: theme?.background || '#0D1117',
      }}
    />
  );
}
