import { useEffect, useState, useCallback } from 'react';

const REPO = 'statusdigitalmarketing/dobius-plus';

export default function Updates() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [status, setStatus] = useState({ state: 'idle' });
  const [latestRelease, setLatestRelease] = useState(null);
  const [releaseError, setReleaseError] = useState('');
  const [pending, setPending] = useState(null);

  const refreshRelease = useCallback(async () => {
    setReleaseError('');
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
      if (!res.ok) throw new Error(`GitHub API: ${res.status}`);
      const data = await res.json();
      setLatestRelease(data);
    } catch (err) {
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
    refreshRelease();
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
          disabled={status.state === 'checking' || status.state === 'downloading'}
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
