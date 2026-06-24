import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../store/store';

/**
 * BrowserPane — embedded Chromium frame for previewing the project's
 * dev server (or any URL) inside Dobius+ split/grid layout.
 *
 * Uses Electron's <webview> tag. It's a real-DOM element, so it slots into
 * the existing pane system the same way <TerminalPane> does — same lifecycle
 * (mount once, position via CSS), same split/grid compatibility, never
 * unmounts on layout change so the page state survives.
 *
 * Why <webview> over BrowserView/WebContentsView: <webview> is a DOM node,
 * matching Carson's pane architecture exactly. BrowserView is a native
 * overlay that has to be positioned via coordinates and re-attached on
 * window resize — way more plumbing for no visible benefit at this scale.
 *
 * Per-pane URL persists via the tab metadata (saved/restored alongside the
 * terminal tabs).
 */

const DEFAULT_URL = 'http://localhost:5173';
const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export default function BrowserPane({ id, url: initialUrl, theme }) {
  const updateTabUrl = useStore((s) => s.updateTabUrl);

  const webviewRef = useRef(null);
  const [url, setUrl] = useState(initialUrl || DEFAULT_URL);
  const [inputUrl, setInputUrl] = useState(initialUrl || DEFAULT_URL);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');

  // Lifecycle: webview emits load + error events; mirror them into local state
  // for the URL bar / spinner / error overlay.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    const onStart = () => { setLoading(true); setError(''); };
    const onStop = () => setLoading(false);
    const onFail = (e) => {
      setLoading(false);
      // ERR_CONNECTION_REFUSED on localhost is the most common — show a
      // helpful hint instead of the raw chromium error.
      if (e.errorCode === -102 || /CONNECTION_REFUSED/i.test(e.errorDescription || '')) {
        setError(`Can't connect to ${url} — is the dev server running?`);
      } else if (e.errorCode !== -3) { // -3 = ABORTED (user navigated away mid-load), ignore
        setError(`${e.errorDescription || 'Load failed'} (${e.errorCode})`);
      }
    };
    const onNav = (e) => {
      // Reflect actual navigated URL (after redirects) in the address bar.
      if (e.url) { setInputUrl(e.url); }
    };
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    return () => {
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-navigate-in-page', onNav);
    };
  }, [url]);

  const navigate = useCallback((next) => {
    let target = (next || '').trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = `http://${target}`;
    setUrl(target);
    setInputUrl(target);
    updateTabUrl?.(id, target);
    // Use .src assignment (not loadURL) — webview re-renders cleanly even if
    // navigating to the same URL string, which we treat as a reload-like UX.
    if (webviewRef.current) webviewRef.current.src = target;
  }, [id, updateTabUrl]);

  const reload = useCallback(() => {
    setError('');
    webviewRef.current?.reload();
  }, []);

  const openExternal = useCallback(() => {
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }, [url]);

  const toggleDevTools = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (wv.isDevToolsOpened?.()) wv.closeDevTools();
    else wv.openDevTools();
  }, []);

  const changeZoom = useCallback((delta) => {
    const idx = ZOOM_LEVELS.indexOf(zoom);
    const nextIdx = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, (idx === -1 ? 4 : idx) + delta));
    const nextZoom = ZOOM_LEVELS[nextIdx];
    setZoom(nextZoom);
    webviewRef.current?.setZoomFactor?.(nextZoom);
  }, [zoom]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); navigate(inputUrl); }
  };
  const onContext = (e) => {
    // Right-click toggles DevTools — keeps the URL bar UI clean for the common case
    e.preventDefault();
    toggleDevTools();
  };

  const bg = theme?.background || '#0D1117';
  const fg = theme?.foreground || '#E6EDF3';
  const border = theme?.brightBlack || '#484F58';

  return (
    <div className="w-full h-full flex flex-col" style={{ backgroundColor: bg }}>
      {/* URL bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 6px',
          borderBottom: `1px solid ${border}`,
          backgroundColor: bg,
        }}
        onContextMenu={onContext}
      >
        <BarButton title="Reload" onClick={reload}>{loading ? '◐' : '↻'}</BarButton>
        <BarButton title="Zoom out" onClick={() => changeZoom(-1)}>−</BarButton>
        <span style={{ color: border, fontSize: 10, fontFamily: "'SF Mono', monospace", minWidth: 32, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <BarButton title="Zoom in" onClick={() => changeZoom(1)}>+</BarButton>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => { if (inputUrl !== url) navigate(inputUrl); }}
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1, minWidth: 0,
            backgroundColor: 'transparent',
            color: fg,
            border: `1px solid ${border}`,
            borderRadius: 3,
            padding: '2px 6px',
            fontFamily: "'SF Mono', monospace",
            fontSize: 11,
            outline: 'none',
          }}
        />
        <BarButton title="Open in default browser" onClick={openExternal}>↗</BarButton>
      </div>

      {/* Live region */}
      <div className="flex-1 min-h-0 relative" style={{ backgroundColor: '#fff' }}>
        {/* eslint-disable-next-line react/no-unknown-property -- <webview> is Electron-specific */}
        <webview
          ref={webviewRef}
          src={url}
          partition="persist:dobius-browser-pane"
          allowpopups="true"
          style={{ width: '100%', height: '100%', display: 'flex' }}
        />
        {error && (
          <div
            style={{
              position: 'absolute', inset: 0,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: bg, color: fg,
              padding: 20, gap: 8, fontFamily: 'system-ui',
            }}
          >
            <div style={{ fontSize: 13 }}>{error}</div>
            <button
              onClick={reload}
              style={{
                padding: '6px 14px', borderRadius: 4, fontSize: 11,
                border: `1px solid ${border}`, backgroundColor: 'transparent',
                color: fg, cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function BarButton({ title, onClick, children }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 22, height: 22,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'transparent',
        color: 'var(--dim)',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        borderRadius: 3,
        flexShrink: 0,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; }}
    >
      {children}
    </button>
  );
}
