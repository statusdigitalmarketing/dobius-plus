import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * How much of each account's quota is gone, as LAST REPORTED by a session.
 *
 * Sam runs six or seven logins and wanted to know when one is close to its
 * limit. Claude gives its statusLine command the real numbers, so a reporter
 * installed there publishes them per session and this reads them back.
 *
 * Everything about the wording here is deliberate, because the numbers cannot
 * be proven current. The payload carries no measurement timestamp, and Claude
 * re-renders a status line for reasons unrelated to an API call, so a session
 * can republish a half-hour-old cached figure. Hence "last reported", always
 * with its age, never "current". A window past its reset is dropped rather than
 * shown as zero, and a credential with no running session is called historical
 * instead of being quietly presented as live.
 */
const AMBER = '#fbbf24';
const RED = '#f87171';
const shortName = (p) => String(p).split('/').filter(Boolean).pop() || String(p);

const WINDOW_LABEL = {
  five_hour: '5 hour',
  seven_day: '7 day',
  seven_day_opus: '7 day (Opus)',
  seven_day_sonnet: '7 day (Sonnet)',
};
const labelFor = (name) => WINDOW_LABEL[name] || name.replace(/_/g, ' ');

function ago(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function until(epochSeconds) {
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 90) return `in ${m}m`;
  const h = ms / 3600000;
  return h < 48 ? `in ${Math.round(h)}h` : `in ${Math.round(h / 24)}d`;
}

const barColor = (pct) => (pct >= 90 ? RED : pct >= 75 ? AMBER : 'var(--accent)');

export default function AccountUsage() {
  const [rows, setRows] = useState(null);
  const [scanFailed, setScanFailed] = useState(false);
  const [installed, setInstalled] = useState(null);
  const [elsewhere, setElsewhere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const [st, usage] = await Promise.all([
      window.electronAPI?.claudeUsageGetStatus?.(),
      window.electronAPI?.claudeUsageRead?.(),
    ]);
    if (!mounted.current) return;
    if (st) { setInstalled(!!st.installed); setElsewhere(!!st.installedElsewhere); }
    if (usage?.ok) { setRows(usage.usage); setScanFailed(!!usage.scanFailed); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    // Windows expire on a clock, not on a file change, so a reading can go
    // stale with nothing on disk moving. Re-read on a timer as well.
    const t = setInterval(load, 30000);
    return () => { mounted.current = false; clearInterval(t); };
  }, [load]);

  const enable = async () => {
    setBusy(true); setError('');
    let res = await window.electronAPI.claudeUsageEnable();
    if (res?.error === 'needs-confirm-create') {
      // Never create ~/.claude/settings.json behind the user's back.
      if (window.confirm(`${res.message}\n\nCreate it?`)) res = await window.electronAPI.claudeUsageEnable({ confirmCreate: true });
      else { setBusy(false); return; }
    }
    if (!mounted.current) return;
    setBusy(false);
    if (res?.error) setError(res.error); else load();
  };

  const disable = async () => {
    setBusy(true); setError('');
    const res = await window.electronAPI.claudeUsageDisable();
    if (!mounted.current) return;
    setBusy(false);
    if (res?.error) setError(res.error); else load();
  };

  const box = {
    backgroundColor: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '10px 12px', marginBottom: 10,
  };
  const btn = {
    padding: '5px 12px', borderRadius: 6, fontSize: 12,
    cursor: busy ? 'default' : 'pointer', backgroundColor: 'transparent',
    color: 'var(--dim)', border: '1px solid var(--border)', opacity: busy ? 0.55 : 1,
  };

  if (installed === null) return null;

  return (
    <div style={box}>
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>Account usage</div>
        <button style={btn} disabled={busy} onClick={installed ? disable : enable}>
          {busy ? 'Working…' : installed ? 'Turn off' : 'Turn on'}
        </button>
      </div>

      {elsewhere && (
        <div className="text-xs mb-1" style={{ color: AMBER }}>
          Another copy of Dobius already installed the reporter, and it publishes to that copy&apos;s
          folder, so nothing will show up here. Turn it on there instead, or turn it off there first.
        </div>
      )}

      {!installed && (
        <div className="text-xs" style={{ color: 'var(--dim)' }}>
          Off. Turning this on adds a status line to Claude that reports how much of each
          account&apos;s limit is used. If you already have a status line, yours keeps working and
          is restored when you turn this off.
        </div>
      )}

      {error && <div className="text-xs mt-1" style={{ color: RED }}>{error}</div>}

      {installed && rows !== null && rows.length === 0 && (
        <div className="text-xs" style={{ color: 'var(--dim)' }}>
          Nothing reported yet. The numbers only arrive after a session has sent at least one
          message, so use Claude for a moment and they will show up here.
        </div>
      )}

      {installed && scanFailed && (
        <div className="text-xs mb-1" style={{ color: AMBER }}>
          Could not check which sessions are running, so these may be older than they look.
        </div>
      )}

      {installed && (rows || []).map((r) => (
        <div key={r.key} className="mb-2">
          <div className="text-xs mb-0.5" style={{ color: 'var(--fg)', fontFamily: 'monospace' }}>
            {r.envUnset ? 'default' : shortName(r.configDir)}
            <span style={{ color: 'var(--dim)', fontFamily: 'inherit' }}>
              {' '}last reported {ago(r.ageMs)}
              {r.historical
                ? ', no session running now'
                : r.sessionsRunning > 0 ? `, ${r.sessionsRunning} running` : ''}
            </span>
          </div>
          {Object.entries(r.windows).map(([name, w]) => (
            <div key={name} className="flex items-center gap-2 text-xs" style={{ color: 'var(--dim)' }}>
              <span style={{ width: 96, flexShrink: 0 }}>{labelFor(name)}</span>
              <span style={{
                flex: 1, height: 6, borderRadius: 3, backgroundColor: 'var(--border)',
                overflow: 'hidden', maxWidth: 220,
              }}>
                <span style={{
                  display: 'block', height: '100%', width: `${w.usedPercentage}%`,
                  backgroundColor: barColor(w.usedPercentage),
                }} />
              </span>
              <span style={{ width: 38, textAlign: 'right', flexShrink: 0 }}>{Math.round(w.usedPercentage)}%</span>
              {w.resetsAt && <span style={{ flexShrink: 0 }}>resets {until(w.resetsAt)}</span>}
            </div>
          ))}
        </div>
      ))}

      {installed && (rows || []).length > 0 && (
        <div className="text-xs" style={{ color: 'var(--dim)' }}>
          These are the last figures a session reported, not a live reading. Claude does not
          timestamp them, so treat the age above as the best guide.
        </div>
      )}
    </div>
  );
}
