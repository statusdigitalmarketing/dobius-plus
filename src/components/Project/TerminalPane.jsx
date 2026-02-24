import { useState, useRef, useCallback, useEffect } from 'react';
import { useStore } from '../../store/store';
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
  const [termFontSize, setTermFontSize] = useState(13);
  const [scrollbackLines, setScrollbackLines] = useState(1000);

  // Load terminal settings from config
  useEffect(() => {
    window.electronAPI?.configGetSettings?.().then((s) => {
      if (s?.terminalFontSize) setTermFontSize(s.terminalFontSize);
      if (s?.scrollbackLines) setScrollbackLines(s.scrollbackLines);
    });
  }, []);

  const { containerRef, termRef, searchAddonRef } = useTerminal({ id, cwd, theme, fontSize: termFontSize, maxScrollbackLines: scrollbackLines });
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [dragOver, setDragOver] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef(null);
  const searchInputRef = useRef(null);

  // Auto-focus the command input on mount and when this tab becomes active
  const activeTabId = useStore((s) => s.activeTabId);
  const activeView = useStore((s) => s.activeView);
  useEffect(() => {
    if (activeTabId === id && activeView === 'terminal') {
      // Use rAF to ensure DOM is ready after display:none→flex switch
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [activeTabId, activeView, id]);

  // Cmd+F to toggle search
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchVisible((v) => {
          if (!v) {
            setTimeout(() => searchInputRef.current?.focus(), 50);
          } else {
            searchAddonRef.current?.clearDecorations?.();
            inputRef.current?.focus();
          }
          return !v;
        });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchAddonRef]);

  const handleSearch = useCallback((query) => {
    setSearchQuery(query);
    if (!searchAddonRef.current) return;
    if (!query) {
      searchAddonRef.current.clearDecorations?.();
      return;
    }
    searchAddonRef.current.findNext(query, { regex: false, caseSensitive: false, incremental: true });
  }, [searchAddonRef]);

  const handleSearchKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        searchAddonRef.current?.findPrevious?.(searchQuery, { regex: false, caseSensitive: false });
      } else {
        searchAddonRef.current?.findNext?.(searchQuery, { regex: false, caseSensitive: false });
      }
    } else if (e.key === 'Escape') {
      setSearchVisible(false);
      searchAddonRef.current?.clearDecorations?.();
      inputRef.current?.focus();
    }
  }, [searchAddonRef, searchQuery]);

  const sendCommand = useCallback(() => {
    if (!window.electronAPI) return;
    const trimmed = input.trim();
    const text = trimmed || '';
    // Send each character individually then \r — Claude Code's TUI reads
    // in raw mode and may not process bulk writes the same as keystrokes.
    // Replace \n with \r so multiline input (via Shift+Enter) sends proper
    // carriage returns that the PTY interprets as Enter keypresses.
    const chars = text.replace(/\n/g, '\r').split('');
    chars.push('\r');
    let i = 0;
    const sendNext = () => {
      if (i < chars.length) {
        window.electronAPI.terminalWrite(id, chars[i]);
        i++;
        if (i < chars.length) {
          setTimeout(sendNext, 5);
        }
      }
    };
    sendNext();
    if (trimmed) {
      setHistory((prev) => {
        const next = prev.filter((cmd) => cmd !== trimmed);
        next.push(trimmed);
        return next.slice(-100);
      });
    }
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

  // Listen for file drops relayed by App.jsx via custom event
  useEffect(() => {
    const handler = (e) => {
      // Only the active tab handles the drop
      if (useStore.getState().activeTabId !== id) return;
      const paths = e.detail?.paths;
      if (!paths || paths.length === 0) return;
      const escaped = paths.map((p) => shellEscape(p)).join(' ');
      setInput((prev) => {
        const needsSpace = prev.length > 0 && !prev.endsWith(' ');
        return prev + (needsSpace ? ' ' : '') + escaped;
      });
      setHistoryIndex(-1);
      inputRef.current?.focus();
    };
    window.addEventListener('dobius:drop-files', handler);
    return () => window.removeEventListener('dobius:drop-files', handler);
  }, [id]);

  // Visual drag overlay via capture-phase listeners on the wrapper
  const wrapperRef = useRef(null);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let dragCount = 0;
    const onDragEnter = (e) => { e.preventDefault(); dragCount++; if (dragCount === 1) setDragOver(true); };
    const onDragLeave = (e) => { e.preventDefault(); dragCount--; if (dragCount <= 0) { dragCount = 0; setDragOver(false); } };
    const onDrop = () => { dragCount = 0; setDragOver(false); };
    el.addEventListener('dragenter', onDragEnter, true);
    el.addEventListener('dragleave', onDragLeave, true);
    el.addEventListener('drop', onDrop, true);
    return () => {
      el.removeEventListener('dragenter', onDragEnter, true);
      el.removeEventListener('dragleave', onDragLeave, true);
      el.removeEventListener('drop', onDrop, true);
    };
  }, []);

  // Single click → command input bar, double click → focus terminal (for interactive prompts)
  const lastClickTime = useRef(0);
  const handleTerminalClick = useCallback((e) => {
    const now = Date.now();
    if (now - lastClickTime.current < 300) {
      // Double click → focus terminal
      containerRef.current?.querySelector('.xterm-helper-textarea')?.focus();
    } else if (!window.getSelection()?.toString() && !termRef.current?.hasSelection()) {
      // Single click (no text selected in browser or xterm) → focus input bar
      inputRef.current?.focus();
    }
    lastClickTime.current = now;
  }, [containerRef, termRef]);

  // Auto-resize textarea to fit content
  const handleInputChange = useCallback((e) => {
    setInput(e.target.value);
    setHistoryIndex(-1);
  }, []);

  // Resize textarea whenever input changes (handles Shift+Enter newlines, paste, history nav)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [input]);

  const bg = theme?.background || '#0D1117';
  const fg = theme?.foreground || '#E6EDF3';
  const border = theme?.brightBlack || '#484F58';

  return (
    <div
      ref={wrapperRef}
      className={`w-full h-full flex flex-col ${className}`}
      style={{ backgroundColor: bg, position: 'relative' }}
    >
      {/* Search bar */}
      {searchVisible && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px',
            borderBottom: `1px solid ${border}`,
            backgroundColor: bg,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={border} strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search terminal... (Enter next, Shift+Enter prev, Esc close)"
            spellCheck={false}
            style={{
              flex: 1,
              backgroundColor: 'transparent',
              color: fg,
              border: 'none',
              outline: 'none',
              fontFamily: "'SF Mono', monospace",
              fontSize: 12,
            }}
          />
          <button
            onClick={() => { setSearchVisible(false); searchAddonRef.current?.clearDecorations?.(); inputRef.current?.focus(); }}
            style={{ color: border, fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
          >
            x
          </button>
        </div>
      )}
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
        onClick={handleTerminalClick}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          padding: '6px 8px',
          borderTop: `1px solid ${border}`,
          backgroundColor: bg,
        }}
      >
        <span style={{ color: border, fontSize: 13, fontFamily: "'SF Mono', monospace", userSelect: 'none', paddingBottom: 2 }}>$</span>
        <textarea
          ref={inputRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Type command... (Enter to send, Shift+Enter newline, Esc terminal)"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          rows={1}
          style={{
            flex: 1,
            backgroundColor: 'transparent',
            color: fg,
            border: 'none',
            outline: 'none',
            fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
            fontSize: 13,
            lineHeight: 1.4,
            resize: 'none',
            overflow: 'hidden',
            maxHeight: 120,
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
            marginBottom: 1,
          }}
        >
          Run
        </button>
      </div>
    </div>
  );
}
