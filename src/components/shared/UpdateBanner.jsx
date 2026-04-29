import { useEffect, useState } from 'react';

export default function UpdateBanner() {
  const [status, setStatus] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.onUpdaterStatus) return;
    window.electronAPI.updaterGetPending?.().then((p) => {
      if (p?.version) setStatus({ state: 'ready', version: p.version });
    }).catch(() => {});
    return window.electronAPI.onUpdaterStatus((s) => {
      setStatus(s);
      if (s?.state === 'ready') setDismissed(false);
    });
  }, []);

  if (!status || dismissed) return null;
  if (status.state !== 'ready' && status.state !== 'downloading') return null;

  const isReady = status.state === 'ready';

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg"
      style={{
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--border)',
        maxWidth: '360px',
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>
          {isReady
            ? `Dobius+ ${status.version} is ready`
            : `Downloading update${status.percent ? ` ${status.percent}%` : ''}…`}
        </div>
        {isReady && (
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
            Restart to install.
          </div>
        )}
      </div>
      {isReady && (
        <button
          onClick={() => window.electronAPI.updaterInstall()}
          className="px-3 py-1.5 text-xs rounded-md font-medium transition-colors"
          style={{ backgroundColor: 'var(--accent)', color: 'white' }}
        >
          Restart
        </button>
      )}
      <button
        onClick={() => setDismissed(true)}
        className="text-xs"
        style={{ color: 'var(--dim)' }}
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
