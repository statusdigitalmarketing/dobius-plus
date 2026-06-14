import { useEffect, useRef, useState, useCallback } from 'react';

const PHONE_W = 375;

/**
 * VisualView — full-window phone preview of a project's site.
 *
 * Renders in its own BrowserWindow (opened via visual:openWindow), so it never
 * covers the terminal. Phone is the only viewport. Three sources:
 *   • Local   — live-reload server over the project files (uncommitted changes)
 *   • Preview — a hosted preview deploy (pushed to the preview branch)
 *   • Live    — the deployed production URL (the public site)
 *
 * Deploy loop: edit -> see it on Local -> "Deploy to Preview" (commits + pushes
 * the preview branch) -> check the hosted Preview -> "Go Live" (pushes the prod
 * branch, host deploys to the public site). Both deploys confirm first.
 */
export default function VisualView({ projectPath }) {
  const webviewRef = useRef(null);

  const [source, setSource]           = useState('local'); // 'local' | 'preview' | 'live'
  const [port, setPort]               = useState(null);
  const [currentPage, setCurrentPage] = useState('/');
  const [pages, setPages]             = useState(['/']);
  const [loading, setLoading]         = useState(true);
  const [status, setStatus]           = useState('');

  // Production + preview URLs (persisted per project) and the branches to push.
  const [prodUrl, setProdUrl]         = useState('');
  const [previewUrl, setPreviewUrl]   = useState('');
  const [previewBranch, setPreviewBranch] = useState('visual-preview');
  const [prodBranch, setProdBranch]   = useState('main');

  const [editing, setEditing]         = useState(null); // null | 'prod' | 'preview'
  const [urlInput, setUrlInput]       = useState('');

  // Deploy dialog state.
  const [deployModal, setDeployModal] = useState(null);  // null | 'preview' | 'live'
  const [deployFiles, setDeployFiles] = useState([]);
  const [commitMsg, setCommitMsg]     = useState('');
  const [deployBusy, setDeployBusy]   = useState(false);
  const [deployResult, setDeployResult] = useState(null); // { ok, kind, message, log }

  const isLocal = source === 'local';

  // Load saved URLs/branches for this project.
  useEffect(() => {
    if (!projectPath) return;
    window.electronAPI?.configGetProject?.(projectPath).then((cfg) => {
      if (!cfg) return;
      if (cfg.visualProdUrl)     setProdUrl(cfg.visualProdUrl);
      if (cfg.visualPreviewUrl)  setPreviewUrl(cfg.visualPreviewUrl);
      if (cfg.visualPreviewBranch) setPreviewBranch(cfg.visualPreviewBranch);
      if (cfg.visualProdBranch)  setProdBranch(cfg.visualProdBranch);
    });
  }, [projectPath]);

  // Start the local preview server when the window opens; stop it on close.
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    setLoading(true);
    setStatus('Starting preview server…');

    window.electronAPI?.visualStart?.(projectPath).then(async (result) => {
      if (cancelled) return;
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

  const baseFor = useCallback((src) => {
    if (src === 'live')    return prodUrl;
    if (src === 'preview') return previewUrl;
    return port ? `http://127.0.0.1:${port}` : null;
  }, [prodUrl, previewUrl, port]);

  // Remote hosts use clean URLs; the local static server wants the raw path.
  const urlForSrc = useCallback((src, page) => {
    const base = baseFor(src);
    if (!base) return null;
    if (src === 'local') return base + page;
    const p = page === '/' ? '' : page.replace(/\.html$/, '').replace(/\/index$/, '/');
    return base + p;
  }, [baseFor]);

  const url = urlForSrc(source, currentPage);

  const navigate = useCallback((page) => {
    setCurrentPage(page);
    const u = urlForSrc(source, page);
    if (webviewRef.current && u) webviewRef.current.src = u;
  }, [urlForSrc, source]);

  const switchSource = useCallback((mode) => {
    // Switching to a remote source with no URL set yet: open its editor.
    if (mode === 'live' && !prodUrl)      { setSource('live');    setUrlInput(''); setEditing('prod');    return; }
    if (mode === 'preview' && !previewUrl){ setSource('preview'); setUrlInput(''); setEditing('preview'); return; }
    setSource(mode);
    const u = urlForSrc(mode, currentPage);
    if (webviewRef.current && u) webviewRef.current.src = u;
  }, [prodUrl, previewUrl, urlForSrc, currentPage]);

  const saveUrl = useCallback(async (which, raw) => {
    const clean = raw.trim().replace(/\/$/, '');
    setEditing(null);
    if (which === 'prod')    setProdUrl(clean);
    if (which === 'preview') setPreviewUrl(clean);
    if (clean) {
      const key = which === 'prod' ? 'visualProdUrl' : 'visualPreviewUrl';
      await window.electronAPI?.configSetProject?.(projectPath, { [key]: clean });
    }
    const activeWhich = source === 'live' ? 'prod' : source === 'preview' ? 'preview' : null;
    if (clean && activeWhich === which && webviewRef.current) {
      const p = currentPage === '/' ? '' : currentPage.replace(/\.html$/, '').replace(/\/index$/, '/');
      webviewRef.current.src = clean + p;
    }
  }, [projectPath, source, currentPage]);

  // Remote reloads bypass cache so we always pull the freshest deployed version.
  const reload = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    if (!isLocal && wv.reloadIgnoringCache) wv.reloadIgnoringCache();
    else wv.reload?.();
  }, [isLocal]);

  // ── Deploy ──
  const openPreviewDeploy = useCallback(async () => {
    setDeployResult(null);
    setDeployFiles([]);
    setCommitMsg('Update website');
    setDeployModal('preview');
    const s = await window.electronAPI?.visualDeployStatus?.(projectPath, { previewBranch, prodBranch });
    if (s?.ok) setDeployFiles(s.changedFiles || []);
    else setDeployResult({ ok: false, kind: 'preview', message: s?.error || 'Could not read git status' });
  }, [projectPath, previewBranch, prodBranch]);

  const runPreviewDeploy = useCallback(async () => {
    setDeployBusy(true);
    const r = await window.electronAPI?.visualDeployPreview?.(projectPath, { message: commitMsg, previewBranch, prodBranch });
    setDeployBusy(false);
    setDeployModal(null);
    if (r?.ok) {
      setDeployResult({ ok: true, kind: 'preview',
        message: `Pushed to ${r.previewBranch}${r.sha ? ` (${r.sha})` : ''}. Preview is building — give the host ~30s, then Reload.`,
        log: r.log });
      if (previewUrl) { setSource('preview'); const u = urlForSrc('preview', currentPage); if (webviewRef.current && u) webviewRef.current.src = u; }
      else { setSource('preview'); setUrlInput(''); setEditing('preview'); }
    } else {
      setDeployResult({ ok: false, kind: 'preview', message: r?.error || 'Preview deploy failed', detail: r?.detail, log: r?.log });
    }
  }, [projectPath, commitMsg, previewBranch, prodBranch, previewUrl, urlForSrc, currentPage]);

  const runPromote = useCallback(async () => {
    setDeployBusy(true);
    const r = await window.electronAPI?.visualPromote?.(projectPath, { prodBranch });
    setDeployBusy(false);
    setDeployModal(null);
    if (r?.ok) {
      setDeployResult({ ok: true, kind: 'live', message: `Pushed ${r.prodBranch} to GitHub. The live site is deploying — refreshing shortly.`, log: r.log });
      if (prodUrl) {
        setSource('live');
        const reloadLive = () => { const u = urlForSrc('live', currentPage); if (webviewRef.current && u) webviewRef.current.src = u; };
        reloadLive();
        setTimeout(reloadLive, 30000); // host needs ~30s to publish
      }
    } else {
      setDeployResult({ ok: false, kind: 'live', message: r?.error || 'Go Live failed', detail: r?.detail, log: r?.log });
    }
  }, [projectPath, prodBranch, prodUrl, urlForSrc, currentPage]);

  const showFrame = !!url && !status && !loading;
  const editingLabel = editing === 'prod' ? 'production' : 'preview';

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg)' }}>
      <div className="drag-region" style={{ height: 28, flexShrink: 0 }} />

      {/* ── Header ── */}
      <div className="no-drag" style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
        borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        {/* Source toggle */}
        <div style={{ display: 'flex', gap: 1, padding: 2, backgroundColor: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}>
          <SrcBtn active={source === 'local'}   onClick={() => switchSource('local')}   color="var(--accent)">⚡ Local</SrcBtn>
          <SrcBtn active={source === 'preview'} onClick={() => switchSource('preview')} color="#d29922">🔎 Preview</SrcBtn>
          <SrcBtn active={source === 'live'}    onClick={() => switchSource('live')}    color="#3fb950">🌐 Live</SrcBtn>
        </div>

        {pages.length > 1 && (
          <select value={currentPage} onChange={(e) => navigate(e.target.value)} style={{
            flex: 1, minWidth: 70, backgroundColor: 'var(--bg)', color: 'var(--fg)',
            border: '1px solid var(--border)', borderRadius: 5, padding: '3px 6px', fontSize: 10,
            fontFamily: "'SF Mono', monospace", outline: 'none',
          }}>
            {pages.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}

        <div style={{ flex: 1 }} />

        {/* Deploy actions */}
        {source !== 'live' && (
          <button onClick={openPreviewDeploy} title="Commit changes and push to the preview branch"
            style={deployBtnStyle('#d29922')}>Deploy → Preview</button>
        )}
        {source === 'preview' && (
          <button onClick={() => { setDeployResult(null); setDeployModal('live'); }} title="Push to the live site"
            style={deployBtnStyle('#3fb950')}>Go Live ↑</button>
        )}

        {/* URL editors (context-sensitive) */}
        {source === 'live' && (
          <button onClick={() => { setUrlInput(prodUrl); setEditing('prod'); }} title="Set production URL" style={iconBtnStyle}>
            {prodUrl ? '✏️' : '+ URL'}
          </button>
        )}
        {source === 'preview' && (
          <button onClick={() => { setUrlInput(previewUrl); setEditing('preview'); }} title="Set preview URL" style={iconBtnStyle}>
            {previewUrl ? '✏️' : '+ URL'}
          </button>
        )}

        <button onClick={reload} title="Reload" style={iconBtnStyle}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--dim)'; }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>

        <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, fontFamily: "'SF Mono', monospace", color: sourceColor(source) }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: sourceColor(source), boxShadow: `0 0 5px ${sourceColor(source)}` }} />
          {source.toUpperCase()}
        </span>
      </div>

      {/* URL input bar */}
      {editing && (
        <div className="no-drag" style={{ display: 'flex', gap: 6, padding: '6px 12px', borderBottom: '1px solid var(--border)', backgroundColor: 'var(--surface)', flexShrink: 0 }}>
          <input autoFocus value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveUrl(editing, urlInput); if (e.key === 'Escape') setEditing(null); }}
            placeholder={editing === 'prod' ? 'https://pocketcologne.com' : 'https://your-project-git-visual-preview-….vercel.app'}
            style={{ flex: 1, backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 5, padding: '4px 8px', fontSize: 11, fontFamily: "'SF Mono', monospace", outline: 'none' }} />
          <button onClick={() => saveUrl(editing, urlInput)} style={{ padding: '4px 10px', fontSize: 11, fontFamily: "'SF Mono', monospace", color: '#000', backgroundColor: '#3fb950', border: 'none', borderRadius: 5, cursor: 'pointer' }}>Save</button>
          <button onClick={() => setEditing(null)} style={{ padding: '4px 8px', fontSize: 11, fontFamily: "'SF Mono', monospace", color: 'var(--dim)', backgroundColor: 'transparent', border: '1px solid var(--border)', borderRadius: 5, cursor: 'pointer' }}>Cancel</button>
        </div>
      )}

      {/* ── Preview ── */}
      <div className="no-drag" style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 16, backgroundColor: '#111', position: 'relative' }}>
        {(loading || status) && (
          <div style={centeredMsg}>{loading ? 'Starting preview server…' : status}</div>
        )}

        {source !== 'local' && !baseFor(source) && !editing && !loading && (
          <div style={centeredMsg}>
            No {editingLabelFor(source)} URL set.{' '}
            <span style={{ color: '#3fb950', cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => { setUrlInput(''); setEditing(source === 'live' ? 'prod' : 'preview'); }}>Add one</span>
          </div>
        )}

        <div style={{
          width: PHONE_W, height: '100%', maxHeight: 760, borderRadius: 36, overflow: 'hidden',
          border: '8px solid #2a2a2a', boxShadow: '0 0 0 1px #333, 0 20px 60px rgba(0,0,0,0.6)',
          flexShrink: 0, position: 'relative', display: showFrame ? 'block' : 'none',
        }}>
          <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 100, height: 24, backgroundColor: '#2a2a2a', borderBottomLeftRadius: 14, borderBottomRightRadius: 14, zIndex: 2 }} />
          <webview ref={webviewRef} src={url || 'about:blank'} style={{ width: '100%', height: '100%', border: 'none' }} />
        </div>

        {/* Deploy confirm / result overlay */}
        {(deployModal || deployResult) && (
          <DeployOverlay
            modal={deployModal} result={deployResult} busy={deployBusy}
            files={deployFiles} commitMsg={commitMsg} setCommitMsg={setCommitMsg}
            prodUrl={prodUrl} previewBranch={previewBranch} prodBranch={prodBranch}
            onCancel={() => { setDeployModal(null); }}
            onConfirm={() => (deployModal === 'preview' ? runPreviewDeploy() : runPromote())}
            onCloseResult={() => setDeployResult(null)}
          />
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '4px 12px', borderTop: '1px solid var(--border)', backgroundColor: 'var(--surface)', fontSize: 9, fontFamily: "'SF Mono', monospace", color: 'var(--dim)', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {url || (source === 'local' ? '— waiting for server —' : `— set a ${editingLabelFor(source)} URL above —`)}
      </div>
    </div>
  );
}

function DeployOverlay({ modal, result, busy, files, commitMsg, setCommitMsg, prodUrl, previewBranch, prodBranch, onCancel, onConfirm, onCloseResult }) {
  // Result panel takes precedence once a deploy has finished.
  if (result && !modal) {
    return (
      <Overlay>
        <div style={{ color: result.ok ? '#3fb950' : '#f85149', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
          {result.ok ? '✓ ' : '✕ '}{result.kind === 'live' ? 'Go Live' : 'Deploy to Preview'}
        </div>
        <div style={{ color: 'var(--fg)', fontSize: 12, lineHeight: 1.5, marginBottom: result.detail || result.log ? 8 : 14 }}>{result.message}</div>
        {(result.detail || result.log) && (
          <pre style={logStyle}>{result.detail || (result.log || []).join('\n\n')}</pre>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onCloseResult} style={primaryBtn('var(--accent)')}>Close</button>
        </div>
      </Overlay>
    );
  }
  if (!modal) return null;

  if (modal === 'live') {
    return (
      <Overlay>
        <div style={{ color: '#3fb950', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Go Live</div>
        <div style={{ color: 'var(--fg)', fontSize: 12, lineHeight: 1.55, marginBottom: 14 }}>
          This pushes <b>{prodBranch}</b> to GitHub. The live site{prodUrl ? <> (<b>{prodUrl.replace(/^https?:\/\//, '')}</b>)</> : null} will update for everyone. This goes public.
        </div>
        <ConfirmRow busy={busy} cancelLabel="Cancel" confirmLabel="Go Live ↑" confirmColor="#3fb950" onCancel={onCancel} onConfirm={onConfirm} busyLabel="Pushing…" />
      </Overlay>
    );
  }

  // Preview confirm
  return (
    <Overlay>
      <div style={{ color: '#d29922', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Deploy to Preview</div>
      <div style={{ color: 'var(--dim)', fontSize: 11, lineHeight: 1.5, marginBottom: 10 }}>
        Commits your changes and pushes the <b>{previewBranch}</b> branch. The live site stays unchanged.
      </div>
      <div style={{ fontSize: 10, color: 'var(--dim)', marginBottom: 4, fontFamily: "'SF Mono', monospace" }}>
        {files.length ? `${files.length} file${files.length === 1 ? '' : 's'} will be included:` : 'No local changes — re-deploys the current committed version to preview.'}
      </div>
      {files.length > 0 && (
        <div style={{ maxHeight: 140, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 8px', marginBottom: 10, backgroundColor: 'var(--bg)' }}>
          {files.map((f, i) => (
            <div key={i} style={{ fontSize: 10, fontFamily: "'SF Mono', monospace", color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <span style={{ color: 'var(--accent)', display: 'inline-block', width: 22 }}>{f.status}</span>{f.file}
            </div>
          ))}
        </div>
      )}
      <input value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)} placeholder="Commit message"
        style={{ width: '100%', boxSizing: 'border-box', backgroundColor: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 5, padding: '5px 8px', fontSize: 11, fontFamily: "'SF Mono', monospace", outline: 'none', marginBottom: 12 }} />
      <ConfirmRow busy={busy} cancelLabel="Cancel" confirmLabel="Deploy to Preview" confirmColor="#d29922" onCancel={onCancel} onConfirm={onConfirm} busyLabel="Deploying…" />
    </Overlay>
  );
}

function Overlay({ children }) {
  return (
    <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
      <div style={{ width: 360, maxWidth: '90%', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
        {children}
      </div>
    </div>
  );
}

function ConfirmRow({ busy, cancelLabel, confirmLabel, confirmColor, onCancel, onConfirm, busyLabel }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button onClick={onCancel} disabled={busy} style={{ padding: '5px 12px', fontSize: 11, fontFamily: "'SF Mono', monospace", color: 'var(--dim)', backgroundColor: 'transparent', border: '1px solid var(--border)', borderRadius: 5, cursor: busy ? 'default' : 'pointer' }}>{cancelLabel}</button>
      <button onClick={onConfirm} disabled={busy} style={primaryBtn(confirmColor, busy)}>{busy ? busyLabel : confirmLabel}</button>
    </div>
  );
}

function SrcBtn({ active, onClick, color, children }) {
  return (
    <button onClick={onClick} style={{
      padding: '3px 8px', fontSize: 10, fontFamily: "'SF Mono', monospace", borderRadius: 4, border: 'none', cursor: 'pointer',
      backgroundColor: active ? color : 'transparent',
      color: active ? (color === 'var(--accent)' ? 'var(--bg)' : '#000') : 'var(--dim)',
      transition: 'all 120ms',
    }}>{children}</button>
  );
}

function sourceColor(src) { return src === 'live' ? '#3fb950' : src === 'preview' ? '#d29922' : 'var(--accent)'; }
function editingLabelFor(src) { return src === 'live' ? 'production' : 'preview'; }
function deployBtnStyle(color) {
  return { padding: '3px 9px', fontSize: 10, fontFamily: "'SF Mono', monospace", color: '#000', backgroundColor: color, border: 'none', borderRadius: 5, cursor: 'pointer', fontWeight: 600 };
}
function primaryBtn(color, busy) {
  return { padding: '5px 12px', fontSize: 11, fontFamily: "'SF Mono', monospace", color: color === 'var(--accent)' ? 'var(--bg)' : '#000', backgroundColor: color, border: 'none', borderRadius: 5, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1, fontWeight: 600 };
}
const iconBtnStyle = { background: 'none', border: 'none', color: 'var(--dim)', cursor: 'pointer', fontSize: 11, fontFamily: "'SF Mono', monospace", padding: '2px 4px' };
const centeredMsg = { alignSelf: 'center', color: 'var(--dim)', fontSize: 12, fontFamily: "'SF Mono', monospace", textAlign: 'center' };
const logStyle = { maxHeight: 160, overflow: 'auto', backgroundColor: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 5, padding: 8, fontSize: 10, fontFamily: "'SF Mono', monospace", color: 'var(--dim)', whiteSpace: 'pre-wrap', marginBottom: 12 };
