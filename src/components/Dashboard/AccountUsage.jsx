import { useState, useEffect, useRef, useCallback } from 'react';
import { orderedWindows, windowLabel, ago, untilText, paceText, forecastText, barColor } from '../../lib/usage-format';

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
 *
 * Shown per ACCOUNT (name and login), each report attributed by the Keychain
 * service its session ran under, with pace (percent per hour) and when the
 * window runs out at that pace (electron/account-headroom.js). The opt-in
 * auto-move switch lives here too.
 */
const AMBER = '#fbbf24';
const RED = '#f87171';
export default function AccountUsage() {
  const [rows, setRows] = useState(null);
  const [scanFailed, setScanFailed] = useState(false);
  const [autoMove, setAutoMove] = useState(false);
  const [installed, setInstalled] = useState(null);
  const [elsewhere, setElsewhere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const [st, usage] = await Promise.all([
      window.electronAPI?.claudeUsageGetStatus?.(),
      window.electronAPI?.accountsUsage?.(),
    ]);
    if (!mounted.current) return;
    if (st) { setInstalled(!!st.installed); setElsewhere(!!st.installedElsewhere); }
    if (usage?.ok) { setRows(usage.accounts); setScanFailed(!!usage.scanFailed); setAutoMove(!!usage.autoMove); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    // Windows expire on a clock, not on a file change, so a reading can go
    // stale with nothing on disk moving. Re-read on a timer as well.
    const t = setInterval(load, 30000);
    // The model-line switch in Settings shares this status line.
    window.addEventListener('dobius:statusline-changed', load);
    return () => {
      mounted.current = false;
      clearInterval(t);
      window.removeEventListener('dobius:statusline-changed', load);
    };
  }, [load]);

  const enable = async () => {
    setBusy(true); setError('');
    let res = await window.electronAPI.claudeUsageEnable();
    if (res?.error === 'needs-confirm-create') {
      // Never create ~/.claude/settings.json behind the user's back.
      if (window.confirm(`${res.message}\n\nCreate it?`)) res = await window.electronAPI.claudeUsageEnable({ confirmCreate: true });
      else { setBusy(false); return; }
    }
    // The model-line switch in Settings shares this status line.
    window.dispatchEvent(new Event('dobius:statusline-changed'));
    if (!mounted.current) return;
    setBusy(false);
    if (res?.error) setError(res.error); else load();
  };

  const disable = async () => {
    setBusy(true); setError('');
    const res = await window.electronAPI.claudeUsageDisable();
    window.dispatchEvent(new Event('dobius:statusline-changed'));
    if (!mounted.current) return;
    setBusy(false);
    if (res?.error) setError(res.error); else load();
  };

  const toggleAutoMove = async () => {
    const next = !autoMove;
    await window.electronAPI?.configUpdateSettings?.({ autoMoveOnLimit: next });
    if (mounted.current) setAutoMove(next);
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

      {installed && scanFailed && (
        <div className="text-xs mb-1" style={{ color: AMBER }}>
          Could not check which sessions are running, so these may be older than they look.
        </div>
      )}

      {installed && (rows || []).map((r, i) => {
        const u = r.usage || {};
        return (
          <div key={`${r.id ?? 'default'}-${i}`} data-usage-account={r.label} className="mb-2">
            <div className="text-xs mb-0.5" style={{ color: 'var(--fg)' }}>
              <span className="font-medium">{r.label}</span>
              {r.email && <span style={{ color: 'var(--dim)' }}> {r.email}</span>}
              <span style={{ color: 'var(--dim)' }}>
                {u.known
                  ? <> · {u.via ? `from ${u.via} (same login), ` : ''}last reported {ago(u.ageMs)}{r.sessionsRunning > 0 ? `, ${r.sessionsRunning} running` : ''}{r.stale ? <span style={{ color: AMBER }}> · stale{r.sessionsRunning === 0 ? ', no session running' : ''}</span> : ''}</>
                  : ' · usage unknown'}
              </span>
            </div>
            {!u.known && (
              <div className="text-xs" style={{ color: 'var(--dim)' }}>
                {u.lastReportedAt ? `No live 5 hour figure (last report ${ago(u.ageMs)}). ` : 'No session on this account has reported yet. '}
                Unknown is not zero: it fills in once a session here sends a message.
              </div>
            )}
            {orderedWindows(u.windows).map(([name, w]) => (
              <div key={name} className="flex items-center gap-2 text-xs" style={{ color: 'var(--dim)', flexWrap: 'wrap' }}>
                <span style={{ width: 96, flexShrink: 0 }}>{windowLabel(name)}</span>
                <span style={{ flex: 1, minWidth: 80, height: 6, borderRadius: 3, backgroundColor: 'var(--border)', overflow: 'hidden', maxWidth: 180 }}>
                  <span style={{ display: 'block', height: '100%', width: `${w.used}%`, backgroundColor: barColor(w.used) }} />
                </span>
                <span style={{ width: 38, textAlign: 'right', flexShrink: 0 }}>{Math.round(w.used)}%</span>
                <span style={{ flexShrink: 0 }}>{paceText(w.pace)}</span>
                <span style={{ flexShrink: 0, color: w.forecast?.limited ? RED : w.forecast?.at ? AMBER : 'var(--dim)' }}>{forecastText(w.forecast)}</span>
                {w.resetsAt && <span style={{ flexShrink: 0 }}>resets {untilText(w.resetsAt)}</span>}
              </div>
            ))}
            {r.sameAs?.length > 0 && (
              <div className="text-xs" style={{ color: AMBER }}>Same login as {r.sameAs.join(', ')}: one limit between them.</div>
            )}
          </div>
        );
      })}

      {installed && (
        <div className="flex items-center justify-between mt-2 mb-1" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <div className="text-xs" style={{ color: 'var(--fg)' }}>
            Move a tab automatically when it hits a limit
            <div style={{ color: 'var(--dim)' }}>
              To the logged-in account with the most known headroom, then sends it &quot;continue&quot;. Never to an
              account whose usage is unknown, never while you are typing in the tab.
            </div>
          </div>
          <button data-auto-move-toggle style={btn} disabled={busy} onClick={toggleAutoMove}>{autoMove ? 'On' : 'Off'}</button>
        </div>
      )}

      {installed && (rows || []).length > 0 && (
        <div className="text-xs" style={{ color: 'var(--dim)' }}>
          These are the last figures a session reported, not a live reading. Claude does not
          timestamp them, so treat the age above as the best guide.
        </div>
      )}
    </div>
  );
}
