import { useEffect, useState } from 'react';

// Sticky-dismiss key: persisted across mounts (renderer reloads, multi-window).
// localStorage is fine here, the dismissal is a UX hint not a security boundary.
const DISMISS_KEY = 'dobius:updateBanner:dismissed';

function loadDismissedVersions() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch { return new Set(); }
}

function saveDismissedVersion(version) {
  try {
    const cur = loadDismissedVersions();
    cur.add(version);
    // Cap so old dismissals don't pile up forever.
    const arr = Array.from(cur).slice(-50);
    localStorage.setItem(DISMISS_KEY, JSON.stringify(arr));
  } catch { /* noop */ }
}

export default function UpdateBanner() {
  const [status, setStatus] = useState(null);
  // Per-version dismissal. The previous local-only `dismissed` boolean got
  // reset on every periodic re-fire and was per-React-mount (UpdateBanner is
  // mounted in BOTH the Launcher and ProjectView so each window had its own
  // dismissal). Now we store the dismissed VERSION in localStorage so it
  // persists across mounts and across reloads, and we only re-show when a
  // strictly newer version appears.
  const [dismissed, setDismissed] = useState(() => loadDismissedVersions());
  const [currentVersion, setCurrentVersion] = useState(null);
  const [busyInstall, setBusyInstall] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.onUpdaterStatus) return;
    window.electronAPI.updaterGetCurrentVersion?.().then(setCurrentVersion).catch(() => {});
    window.electronAPI.updaterGetPending?.().then((p) => {
      if (p?.version) setStatus({ state: 'ready', version: p.version });
    }).catch(() => {});
    return window.electronAPI.onUpdaterStatus(setStatus);
  }, []);

  if (!status) return null;
  if (status.state === 'error' && status.message) {
    // Errors are now visible. Without this, install failures were silent and
    // Sam thought the Restart button "just didn't do anything".
    return (
      <div
        className="fixed bottom-4 right-4 z-50 flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg"
        style={{ backgroundColor: 'var(--surface)', border: '1px solid #f87171', maxWidth: '420px' }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium" style={{ color: '#f87171' }}>Update error</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {String(status.message).slice(0, 400)}
          </div>
        </div>
        <button
          onClick={() => setStatus(null)}
          className="text-xs"
          style={{ color: 'var(--dim)' }}
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    );
  }
  if (status.state !== 'ready' && status.state !== 'downloading') return null;

  const isReady = status.state === 'ready';
  // Renderer-side version sanity check (defense in depth, main already gates).
  // If the toast's version is not strictly newer than what's running, suppress.
  if (isReady && currentVersion && status.version) {
    const a = String(status.version).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(currentVersion).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    let newer = false;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x > y) { newer = true; break; }
      if (x < y) { newer = false; break; }
    }
    if (!newer) return null;
  }
  if (isReady && status.version && dismissed.has(status.version)) return null;

  const onDismiss = () => {
    if (isReady && status.version) {
      saveDismissedVersion(status.version);
      setDismissed(loadDismissedVersions());
      try { window.electronAPI?.updaterDismiss?.(status.version); } catch {}
    }
    setStatus(null);
  };

  const onRestart = async () => {
    if (busyInstall) return;
    setBusyInstall(true);
    try {
      const r = await window.electronAPI.updaterInstall();
      if (!r?.ok) {
        // The install handler set its own error status via broadcast,
        // which our onUpdaterStatus listener will pick up.
        setBusyInstall(false);
      }
      // On success the app is about to quit, no need to reset busy state.
    } catch (err) {
      setStatus({ state: 'error', message: String(err?.message || err) });
      setBusyInstall(false);
    }
  };

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
            : `Downloading update${status.percent ? ` ${status.percent}%` : ''}...`}
        </div>
        {isReady && (
          <div className="text-xs mt-0.5" style={{ color: 'var(--dim)' }}>
            Restart to install.
          </div>
        )}
      </div>
      {isReady && (
        <button
          onClick={onRestart}
          disabled={busyInstall}
          className="px-3 py-1.5 text-xs rounded-md font-medium transition-colors"
          style={{ backgroundColor: 'var(--accent)', color: 'white', opacity: busyInstall ? 0.6 : 1 }}
        >
          {busyInstall ? 'Restarting...' : 'Restart'}
        </button>
      )}
      <button
        onClick={onDismiss}
        className="text-xs"
        style={{ color: 'var(--dim)' }}
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
