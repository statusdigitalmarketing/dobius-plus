import { useState, useRef, useCallback } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import '@xterm/xterm/css/xterm.css';

/** Escape a file path for safe shell usage (wraps in single quotes). */
function shellEscape(filePath) {
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}

/**
 * TerminalPane — renders an xterm.js terminal with an editable command input bar.
 * @param {{ id: string, cwd: string, theme?: object, className?: string }} props
 */
export default function TerminalPane({ id, cwd, theme, className = '' }) {
  const { containerRef } = useTerminal({ id, cwd, theme });
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const sendCommand = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || !window.electronAPI) return;
    window.electronAPI.terminalWrite(id, trimmed + '\n');
    setHistory((prev) => {
      const next = prev.filter((cmd) => cmd !== trimmed);
      next.push(trimmed);
      return next.slice(-100);
    });
    setInput('');
    setHistoryIndex(-1);
  }, [id, input]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCommand();
    } else if (e.key === 'ArrowUp' && !e.shiftKey) {
      if (history.length === 0) return;
      e.preventDefault();
      const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInput(history[newIndex]);
    } else if (e.key === 'ArrowDown' && !e.shiftKey) {
      if (historyIndex === -1) return;
      e.preventDefault();
      const newIndex = historyIndex + 1;
      if (newIndex >= history.length) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        setHistoryIndex(newIndex);
        setInput(history[newIndex]);
      }
    } else if (e.key === 'Escape') {
      // Focus back to terminal
      containerRef.current?.querySelector('.xterm-helper-textarea')?.focus();
    }
  };

  const handlePaste = useCallback(async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) return;
        const arrayBuffer = await blob.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        const filePath = await window.electronAPI.saveClipboardImage(base64, item.type);
        if (filePath) {
          setInput((prev) => {
            const needsSpace = prev.length > 0 && !prev.endsWith(' ');
            return prev + (needsSpace ? ' ' : '') + shellEscape(filePath);
          });
          setHistoryIndex(-1);
        }
        return;
      }
    }
    // Text paste falls through to default behavior
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const paths = Array.from(files).map((f) => shellEscape(f.path)).join(' ');
    setInput((prev) => {
      const needsSpace = prev.length > 0 && !prev.endsWith(' ');
      return prev + (needsSpace ? ' ' : '') + paths;
    });
    setHistoryIndex(-1);
    inputRef.current?.focus();
  }, []);

  const bg = theme?.background || '#0D1117';
  const fg = theme?.foreground || '#E6EDF3';
  const border = theme?.brightBlack || '#484F58';

  return (
    <div
      className={`w-full h-full flex flex-col ${className}`}
      style={{ backgroundColor: bg, position: 'relative' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            border: `2px dashed ${fg}`,
            borderRadius: 8,
            pointerEvents: 'none',
          }}
        >
          <span style={{ color: fg, fontSize: 16, fontWeight: 600 }}>Drop files to insert path</span>
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 min-h-0"
        style={{ padding: '4px 0 0 4px' }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderTop: `1px solid ${border}`,
          backgroundColor: bg,
        }}
      >
        <span style={{ color: border, fontSize: 13, fontFamily: "'SF Mono', monospace", userSelect: 'none' }}>$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => { setInput(e.target.value); setHistoryIndex(-1); }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Type command... (Enter to send, Esc to focus terminal)"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          style={{
            flex: 1,
            backgroundColor: 'transparent',
            color: fg,
            border: 'none',
            outline: 'none',
            fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
            fontSize: 13,
            lineHeight: 1.4,
          }}
        />
        <button
          onClick={sendCommand}
          disabled={!input.trim()}
          style={{
            padding: '2px 10px',
            fontSize: 12,
            fontFamily: "'SF Mono', monospace",
            color: input.trim() ? bg : border,
            backgroundColor: input.trim() ? fg : 'transparent',
            border: `1px solid ${border}`,
            borderRadius: 4,
            cursor: input.trim() ? 'pointer' : 'default',
            opacity: input.trim() ? 1 : 0.4,
            transition: 'all 150ms',
          }}
        >
          Run
        </button>
      </div>
    </div>
  );
}
