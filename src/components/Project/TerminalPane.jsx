import { useState, useRef, useCallback, useEffect } from 'react';
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

  const { containerRef, searchAddonRef } = useTerminal({ id, cwd, theme, fontSize: termFontSize, maxScrollbackLines: scrollbackLines });
  const [input, setInput] = useState('');
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [dragOver, setDragOver] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef(null);
  const searchInputRef = useRef(null);

  // Auto-focus the command input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

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
    // Always send \r (Enter) to the terminal — even if input is empty,
    // so interactive prompts (Claude yes/no, etc.) get confirmed
    window.electronAPI.terminalWrite(id, (trimmed || '') + '\r');
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

  // Use capture-phase native listeners so drops register even when xterm canvas swallows the event
  const wrapperRef = useRef(null);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let dragCount = 0;

    const onDragEnter = (e) => {
      e.preventDefault();
      dragCount++;
      if (dragCount === 1) setDragOver(true);
    };
    const onDragOver = (e) => { e.preventDefault(); };
    const onDragLeave = (e) => {
      e.preventDefault();
      dragCount--;
      if (dragCount <= 0) { dragCount = 0; setDragOver(false); }
    };
    const onDrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCount = 0;
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
    };

    el.addEventListener('dragenter', onDragEnter, true);
    el.addEventListener('dragover', onDragOver, true);
    el.addEventListener('dragleave', onDragLeave, true);
    el.addEventListener('drop', onDrop, true);
    return () => {
      el.removeEventListener('dragenter', onDragEnter, true);
      el.removeEventListener('dragover', onDragOver, true);
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
    } else if (!window.getSelection()?.toString()) {
      // Single click (no text selected) → focus input bar
      inputRef.current?.focus();
    }
    lastClickTime.current = now;
  }, [containerRef]);

  // Auto-resize textarea to fit content
  const handleInputChange = useCallback((e) => {
    setInput(e.target.value);
    setHistoryIndex(-1);
    // Auto-resize
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  }, []);

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
          placeholder="Type command... (Enter to send, Esc to focus terminal)"
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
