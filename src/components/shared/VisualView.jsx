import { useEffect, useRef, useState, useCallback } from 'react';

const PHONE_W = 375;

/**
 * VisualView — full-window phone preview of a project's site.
 *
 * Renders in its own BrowserWindow (opened via visual:openWindow), so it never
 * covers the terminal. Phone is the only viewport. Two sources:
 *   • Local — live-reload server over the project files (uncommitted changes)
 *   • Live  — the deployed production URL (always the freshest deployed version)
 */
export default function VisualView({ projectPath }) {
  const webviewRef = useRef(null);

  const [source, setSource]           = useState('local'); // 'local' | 'live'
  const [port, setPort]               = useState(null);
  const [prodUrl, setProdUrl]         = useState('');
  const [editingProd, setEditingProd] = useState(false);
  const [prodInput, setProdInput]     = useState('');
  const [currentPage, setCurrentPage] = useState('/');
  const [pages, setPages]             = useState(['/']);
  const [loading, setLoading]         = useState(true);
  const [status, setStatus]           = useState('');

  const isLive = source === 'live';

  // Load saved production URL for this project
  useEffect(() => {
    if (!projectPath) return;
    window.electronAPI?.configGetProject?.(projectPath).then((cfg) => {
      if (cfg?.visualProdUrl) setProdUrl(cfg.visualProdUrl);
    });
  }, [projectPath]);

  // Start the local preview server when the window opens; stop it on close
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    setLoading(true);
    setStatus('Starting preview server…');

    window.electronAPI?.visualStart?.(projectPath).then(async (result) => {
      if (cancelled) return; // effect was torn down before the server came up
      if (result?.ok) {
        setPort(result.port);
        setStatus('');
        const found = await window.electronAPI.visualListPages?.() || ['/'];
        if (!cancelled) setPages(found.length ? found : ['/']);
      } else {
        setStatus(`Error: ${result?.error || 'Failed to start server'}`);
      }
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; window.electronAPI?.visualStop?.(); };
  }, [projectPath]);

  // Map a page path to the URL for the active source
  const urlFor = useCallback((page) => {
    if (isLive) {
      if (!prodUrl) return null;
      const path = page === '/' ? '' : page.replace(/\.html$/, '').replace(/\/index$/, '/');
      return prodUrl + path;
    }
    return port ? `http://127.0.0.1:${port}${page}` : null;
  }, [isLive, prodUrl, port]);

  const navigate = useCallback((page) => {
    setCurrentPage(page);
    const url = urlFor(page);
    if (webviewRef.current && url) webviewRef.current.src = url;
  }, [urlFor]);

  const switchSource = useCallback((mode) => {
    if (mode === 'live' && !prodUrl) { setSource('live'); setEditingProd(true); return; }
    setSource(mode);
    const live = mode === 'live';
    const wv = webviewRef.current;
    if (!wv) return;
    const path = currentPage === '/' ? '' : currentPage.replace(/\.html$/, '').replace(/\/index$/, '/');
    if (live) wv.src = prodUrl + path;
    else if (port) wv.src = `http://127.0.0.1:${port}${currentPage}`;
  }, [prodUrl, port, currentPage]);

  const saveProdUrl = useCallback(async (raw) => {
    const clean = raw.trim().replace(/\/$/, '');
    setProdUrl(clean);
    setEditingProd(false);
    if (clean) await window.electronAPI?.configSetProject?.(projectPath, { visualProdUrl: clean });
    if (isLive && clean && webviewRef.current) {
      const path = currentPage === '/' ? '' : currentPage.replace(/\.html$/, '').replace(/\/index$/, '/');
      webviewRef.current.src = clean + path;
    }
  }, [projectPath, isLive, currentPage]);

  // Live mode bypasses cache so reload always pulls the freshest deployed version
  const reload = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (isLive && wv.reloadIgnoringCache) wv.reloadIgnoringCache();
    else wv.reload?.();
  }, [isLive]);

  const url = urlFor(currentPage);
  const showFrame = !!url && !status && !loading;

  return (
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex', flexDirection: 'column',
      backgroundColor: 'var(--bg)',
    }}>
      {/* Drag region for the frameless title bar */}
      <div className="drag-region" style={{ height: 28, flexShrink: 0 }} />

      {/* ── Header ── */}
      <div className="no-drag" style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 12px',
        borderBottom: '1px solid var(--border)',
        backgroundColor: 'var(--surface)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        {/* Source toggle */}
        <div style={{ display: 'flex', gap: 1, padding: 2, backgroundColor: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}>
          <SrcBtn active={!isLive} onClick={() => switchSource('local')} color="var(--accent)">⚡ Local</SrcBtn>
          <SrcBtn active={isLive} onClick={() => switchSource('live')} color="#3fb950">🌐 Live</SrcBtn>
        </div>

        {pages.length > 1 && (
          <select
            value={currentPage}
            onChange={(e) => navigate(e.target.value)}
            style={{
              flex: 1, minWidth: 80,
              backgroundColor: 'var(--bg)', color: 'var(--fg)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '3px 6px', fontSize: 10,
              fontFamily: "'SF Mono', monospace", outline: 'none',
            }}
          >
            {pages.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}

        <div style={{ flex: 1 }} />

        {isLive && (
          <button onClick={() => { setProdInput(prodUrl); setEditingProd(true); }}
            title="Set production URL"
            style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 11, fontFamily: "'SF Mono', monospace", padding: '2px 4px' }}>
            {prodUrl ? '✏️' : '+ URL'}
          </button>
        )}

        <button onClick={reload} title="Reload"
          style={{ background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', padding: '2px 4px' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>

        <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, fontFamily: "'SF Mono', monospace",
          color: isLive ? '#3fb950' : 'var(--accent)' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%',
            backgroundColor: isLive ? '#3fb950' : 'var(--accent)',
            boxShadow: isLive ? '0 0 5px #3fb950' : '0 0 5px var(--accent)' }} />
          {isLive ? 'PROD' : 'LOCAL'}
        </span>
      </div>

      {/* Prod URL input bar */}
      {editingProd && (
        <div className="no-drag" style={{
          display: 'flex', gap: 6, padding: '6px 12px',
          borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface)', flexShrink: 0,
        }}>
          <input
            autoFocus
            value={prodInput}
            onChange={(e) => setProdInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveProdUrl(prodInput);
              if (e.key === 'Escape') setEditingProd(false);
            }}
            placeholder="https://pocketcologne.com"
            style={{
              flex: 1, backgroundColor: 'var(--bg)', color: 'var(--fg)',
              border: '1px solid var(--border)', borderRadius: 5,
              padding: '4px 8px', fontSize: 11, fontFamily: "'SF Mono', monospace", outline: 'none',
            }}
          />
          <button onClick={() => saveProdUrl(prodInput)}
            style={{ padding: '4px 10px', fontSize: 11, fontFamily: "'SF Mono', monospace",
              color: '#000', backgroundColor: '#3fb950', border: 'none', borderRadius: 5, cursor: 'pointer' }}>Save</button>
          <button onClick={() => setEditingProd(false)}
            style={{ padding: '4px 8px', fontSize: 11, fontFamily: "'SF Mono', monospace",
              color: 'var(--dim)', backgroundColor: 'transparent', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {/* ── Preview ── */}
      <div className="no-drag" style={{
        flex: 1, overflow: 'auto',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 16, backgroundColor: '#111',
      }}>
        {(loading || status) && (
          <div style={{ alignSelf: 'center', color: 'var(--dim)', fontSize: 12, fontFamily: "'SF Mono', monospace", textAlign: 'center' }}>
            {loading ? 'Starting preview server…' : status}
          </div>
        )}

        {isLive && !prodUrl && !editingProd && !loading && (
          <div style={{ alignSelf: 'center', color: 'var(--dim)', fontSize: 12, fontFamily: "'SF Mono', monospace", textAlign: 'center' }}>
            No production URL set.{' '}
            <span style={{ color: '#3fb950', cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => { setProdInput(''); setEditingProd(true); }}>Add one</span>
          </div>
        )}

        {/* Phone frame — webview stays mounted, only its src changes */}
        <div style={{
          width: PHONE_W, height: '100%', maxHeight: 760,
          borderRadius: 36, overflow: 'hidden',
          border: '8px solid #2a2a2a',
          boxShadow: '0 0 0 1px #333, 0 20px 60px rgba(0,0,0,0.6)',
          flexShrink: 0, position: 'relative',
          display: showFrame ? 'block' : 'none',
        }}>
          <div style={{
            position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
            width: 100, height: 24, backgroundColor: '#2a2a2a',
            borderBottomLeftRadius: 14, borderBottomRightRadius: 14, zIndex: 2,
          }} />
          <webview ref={webviewRef} src={url || 'about:blank'} style={{ width: '100%', height: '100%', border: 'none' }} />
        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: '4px 12px', borderTop: '1px solid var(--border)',
        backgroundColor: 'var(--surface)', fontSize: 9,
        fontFamily: "'SF Mono', monospace", color: 'var(--dim)', flexShrink: 0,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {url || (isLive ? '— set a production URL above —' : '— waiting for server —')}
      </div>
    </div>
  );
}

function SrcBtn({ active, onClick, color, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '3px 8px', fontSize: 10, fontFamily: "'SF Mono', monospace",
      borderRadius: 4, border: 'none', cursor: 'pointer',
      backgroundColor: active ? color : 'transparent',
      color: active ? (color === 'var(--accent)' ? 'var(--bg)' : '#000') : 'var(--dim)',
      transition: 'all 120ms',
    }}>{children}</button>
  );
}
