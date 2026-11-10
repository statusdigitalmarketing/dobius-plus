import { useEffect, useState, useCallback, useRef } from 'react';

export default function Updates() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [status, setStatus] = useState({ state: 'idle' });
  const [latestRelease, setLatestRelease] = useState(null);
  const [releaseError, setReleaseError] = useState('');
  const [pending, setPending] = useState(null);

  // Asked of the MAIN process, not fetched here. index.html's CSP allows
  // connect-src 'self' only, so a fetch to api.github.com from the renderer is
  // blocked and always failed with "Failed to fetch", which the panel showed as
  // "Couldn't reach GitHub" even while the updater was downloading releases
  // perfectly well from the main process.
  // Newest lookup wins. Clicking "Check for updates" while the mount lookup is
  // still pending gave two overlapping requests, and the older one landing last
  // reverted the panel to the release it had already replaced (Codex P2).
  const releaseSeq = useRef(0);

  const refreshRelease = useCallback(async ({ force = false } = {}) => {
    const seq = ++releaseSeq.current;
    setReleaseError('');
    try {
      const res = await window.electronAPI?.updaterGetLatestRelease?.(force);
      if (seq !== releaseSeq.current) return;
      if (!res) throw new Error('updater bridge unavailable');
      if (!res.ok) throw new Error(res.error || 'unknown error');
      setLatestRelease(res.release);
    } catch (err) {
      if (seq !== releaseSeq.current) return;
      setReleaseError(String(err?.message || err));
    }
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.updaterGetCurrentVersion?.().then(setCurrentVersion).catch(() => {});
    window.electronAPI.updaterGetStatus?.().then((s) => s && setStatus(s)).catch(() => {});
    window.electronAPI.updaterGetPending?.().then(setPending).catch(() => {});
    const off = window.electronAPI.onUpdaterStatus?.((s) => {
      setStatus(s);
      if (s?.state === 'ready') {
        window.electronAPI.updaterGetPending?.().then(setPending).catch(() => {});
      }
    });
    refreshRelease();
    return () => off?.();
  }, [refreshRelease]);

  const handleCheck = () => {
    setStatus({ state: 'checking' });
    window.electronAPI?.updaterCheck?.().catch(() => {});
    refreshRelease({ force: true });
  };

  const handleInstall = () => {
    window.electronAPI?.updaterInstall?.();
  };

  const isUpToDate = currentVersion && latestRelease?.tag_name &&
    latestRelease.tag_name.replace(/^v/, '') === currentVersion;

  const ready = status.state === 'ready';

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-medium" style={{ color: 'var(--fg)' }}>Updates</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--dim)' }}>
            Auto-checks every 4 hours. You can also trigger a check manually.
          </p>
        </div>
        <button
          onClick={handleCheck}
          disabled={status.state === 'checking' || status.state === 'downloading' || status.state === 'installing'}
          className="px-4 py-2 text-sm rounded-md font-medium transition-colors"
          style={{
            backgroundColor: 'var(--accent)',
            color: 'white',
            opacity: (status.state === 'checking' || status.state === 'downloading') ? 0.5 : 1,
            cursor: (status.state === 'checking' || status.state === 'downloading') ? 'wait' : 'pointer',
          }}
        >
          {status.state === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      {/* Current vs latest */}
      <div
        className="grid grid-cols-2 gap-3 mb-4"
      >
        <Card label="You're running" value={currentVersion ? `v${currentVersion}` : '…'} />
        <Card
          label="Latest release"
          value={latestRelease?.tag_name || (releaseError ? 'unknown' : '…')}
          accent={!isUpToDate && latestRelease ? 'var(--accent)' : undefined}
        />
      </div>

      {/* Status banner */}
      <StatusBanner status={status} ready={ready} pending={pending} onInstall={handleInstall} isUpToDate={isUpToDate} />

      <RestartCard updateReady={ready && !!pending} installing={status.state === 'installing'} />

      {/* Release notes */}
      {latestRelease && (
        <div
          className="mt-6 p-4 rounded-md"
          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
              {latestRelease.name || latestRelease.tag_name}
            </h3>
            <a
              href={latestRelease.html_url}
              onClick={(e) => {
                e.preventDefault();
                window.electronAPI?.openExternal?.(latestRelease.html_url);
              }}
              className="text-xs hover:underline"
              style={{ color: 'var(--dim)' }}
            >
              View on GitHub →
            </a>
          </div>
          <pre
            className="text-xs whitespace-pre-wrap font-sans"
            style={{ color: 'var(--dim)', lineHeight: 1.5 }}
          >
            {latestRelease.body || '(no release notes)'}
          </pre>
        </div>
      )}

      {releaseError && (
        <p className="text-xs mt-4" style={{ color: 'var(--danger)' }}>
          Couldn't reach GitHub: {releaseError}
        </p>
      )}
    </div>
  );
}

// Restart without updating: each Claude tab gets a fresh `claude` (Claude in Chrome reconnects, new hooks and MCP
// servers load) and auto-resume picks the conversation back up. Asks once inline, since it ends every running turn.
// The confirm is armed after ARM_MS and Cancel takes the spot under the cursor, so a double-click or a held Enter on
// the first button cannot skip it.
const ARM_MS = 400;
const STALL_MS = 20000;
function RestartCard({ updateReady, installing }) {
  const [confirming, setConfirming] = useState(false);
  const [armed, setArmed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');
  const [autoResume, setAutoResume] = useState(true);
  useEffect(() => {
    window.electronAPI?.appRestartInfo?.().then((r) => { if (r) setAutoResume(r.autoResume !== false); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!confirming) { setArmed(false); return undefined; }
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, [confirming]);
  // ok only means the quit started. If this window is still here well after, say so instead of spinning forever.
  useEffect(() => {
    if (!restarting) return undefined;
    const t = setTimeout(() => setError('Dobius+ is still closing. If it does not reopen, quit it and open it again.'), STALL_MS);
    return () => clearTimeout(t);
  }, [restarting]);
  const restart = async () => {
    if (!armed || restarting || installing) return;
    setRestarting(true);
    setError('');
    try {
      const res = await window.electronAPI?.appRestart?.();
      if (!res?.ok) throw new Error(res?.reason || 'restart is not available');
    } catch (err) {
      setRestarting(false);
      setConfirming(false);
      setError(`Couldn't restart: ${String(err?.message || err)}`);
    }
  };
  const label = updateReady ? 'Restart without updating' : 'Restart Dobius+';
  const help = autoResume
    ? 'Quits and reopens on this version. Windows and tabs come back, and Claude conversations that were running resume in a fresh claude --resume, which loads your current hooks, MCP servers and Claude in Chrome (when Chrome is on by default in /chrome). Flags a tab was started with are not kept, and Codex and plain terminal tabs come back as a new shell.'
    : 'Quits and reopens on this version. Windows and tabs come back. Auto-resume is turned off on this Mac, so Claude conversations do not restart by themselves.';
  return (
    <div
      className="mt-4 p-4 rounded-md flex items-center justify-between gap-4"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
          {restarting ? 'Restarting…' : confirming ? 'Restart now? Running Claude turns stop.' : label}
        </div>
        <div className="text-xs mt-0.5" style={{ color: error ? 'var(--danger)' : 'var(--dim)' }}>
          {error || help}
        </div>
      </div>
      {confirming && !restarting ? (
        <div className="flex gap-2 shrink-0">
          <button
            onClick={restart}
            disabled={!armed || installing}
            className="px-3 py-2 text-sm rounded-md font-medium"
            style={{ backgroundColor: 'var(--accent)', color: 'white', opacity: armed && !installing ? 1 : 0.5 }}
          >
            Restart
          </button>
          <button
            onClick={() => setConfirming(false)}
            autoFocus
            className="px-3 py-2 text-sm rounded-md"
            style={{ color: 'var(--fg)', border: '1px solid var(--border)' }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => { setError(''); setConfirming(true); }}
          disabled={restarting || installing}
          className="px-4 py-2 text-sm rounded-md font-medium shrink-0"
          style={{
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            opacity: restarting || installing ? 0.5 : 1,
            cursor: restarting ? 'wait' : installing ? 'not-allowed' : 'pointer',
          }}
        >
          {restarting ? 'Restarting…' : 'Restart'}
        </button>
      )}
    </div>
  );
}

function Card({ label, value, accent }) {
  return (
    <div
      className="p-3 rounded-md"
      style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="text-xs mb-1" style={{ color: 'var(--dim)' }}>{label}</div>
      <div
        className="text-lg font-mono"
        style={{ color: accent || 'var(--fg)', fontFamily: "'SF Mono', monospace" }}
      >
        {value}
      </div>
    </div>
  );
}

function StatusBanner({ status, ready, pending, onInstall, isUpToDate }) {
  if (status.state === 'installing') {
    return (
      <div
        className="p-4 rounded-md"
        style={{ backgroundColor: 'var(--accent-muted)', border: '1px solid var(--accent)' }}
      >
        <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
          Installing v{status.version}
        </div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
          Dobius+ will restart by itself in a moment. Your tabs and terminal sessions will restore.
        </div>
      </div>
    );
  }
  if (ready && pending) {
    return (
      <div
        className="p-4 rounded-md flex items-center justify-between"
        style={{ backgroundColor: 'var(--accent-muted)', border: '1px solid var(--accent)' }}
      >
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
            v{pending.version} downloaded and ready to install
          </div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
            Click Restart to relaunch on the new version. Your tabs and terminal sessions will restore.
          </div>
        </div>
        <button
          onClick={onInstall}
          className="px-4 py-2 text-sm rounded-md font-medium"
          style={{ backgroundColor: 'var(--accent)', color: 'white' }}
        >
          Restart now
        </button>
      </div>
    );
  }
  if (status.state === 'downloading') {
    return (
      <div
        className="p-4 rounded-md"
        style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div className="text-sm" style={{ color: 'var(--fg)' }}>
          Downloading update{status.percent != null ? ` (${status.percent}%)` : '…'}
        </div>
        {status.percent != null && (
          <div className="mt-2 h-1 rounded overflow-hidden" style={{ backgroundColor: 'var(--border)' }}>
            <div
              className="h-full transition-all"
              style={{ width: `${status.percent}%`, backgroundColor: 'var(--accent)' }}
            />
          </div>
        )}
      </div>
    );
  }
  if (status.state === 'error') {
    return (
      <div
        className="p-4 rounded-md"
        style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--danger)' }}
      >
        <div className="text-sm font-medium" style={{ color: 'var(--danger)' }}>
          Update check failed
        </div>
        <div className="text-xs mt-1 font-mono" style={{ color: 'var(--dim)' }}>
          {status.message || 'Unknown error'}
        </div>
      </div>
    );
  }
  if (isUpToDate) {
    return (
      <div
        className="p-4 rounded-md"
        style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div className="text-sm" style={{ color: 'var(--fg)' }}>You're on the latest version.</div>
      </div>
    );
  }
  return null;
}
