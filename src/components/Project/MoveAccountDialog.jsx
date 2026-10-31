import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { orderedWindows, windowLabel, ago, barColor } from '../../lib/usage-format';

/**
 * Move to account: pick one of your Claude logins for this tab (or every tab in
 * this window). Best headroom first, Unknown last. A target main refuses
 * (moveRefusal in electron/account-headroom.js) is shown but cannot be picked.
 */
export default function MoveAccountDialog({ tabId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A move's result only shows here, so the dialog stays open until it has one.
  const moving = useRef(false);
  const close = () => { if (!moving.current) onClose(); };
  const windowTabIds = useStore((s) => s.terminalTabs.filter((t) => (t.kind || 'terminal') === 'terminal').map((t) => t.id).join('\n'));

  const load = useCallback(() => window.electronAPI?.accountsMoveTargets?.(tabId).then((r) => {
    if (r?.ok) setData(r); else setError(r?.error || 'Could not read the accounts.');
  }), [tabId]);

  useEffect(() => {
    load();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!moving.current) onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [load, onClose]);

  const move = async (t, ids, single) => {
    moving.current = true;
    setBusy(true);
    setError('');
    const r = await useStore.getState().moveTabsToAccount(ids, t.isDefault ? null : t.id, t.label, { single })
      .catch((err) => ({ moved: 0, skipped: [], failed: [{ label: 'Not moved', reason: err?.message || String(err) }] }));
    moving.current = false;
    setBusy(false);
    if (r.cancelled) return;
    const lines = [...r.failed, ...r.skipped].map((x) => (ids.length === 1 ? x.reason : `${x.label}: ${x.reason}`));
    if (!lines.length) { onClose(); return; }
    setError(`${r.moved ? `Moved ${r.moved}. ` : ''}${lines.join('\n')}`);
    load(); // what is true now, not what it was when the dialog opened
  };

  const tabWarn = data?.tab?.busy ? 'This tab is in the middle of a turn: moving it stops that turn.'
    : data?.tab?.draft ? 'This tab has unsent text in Claude\'s prompt: moving it loses that text.' : '';

  const btn = (enabled) => ({
    padding: '3px 9px', borderRadius: 5, fontSize: 11, border: '1px solid var(--border)',
    backgroundColor: 'transparent', color: enabled ? 'var(--fg)' : 'var(--border)', cursor: enabled ? 'pointer' : 'default',
  });

  return (
    <div
      role="dialog"
      aria-label="Move to account"
      data-move-account-dialog
      style={{ position: 'fixed', inset: 0, zIndex: 300, backgroundColor: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 70 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div style={{ width: 'min(560px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 120px)', overflowY: 'auto', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, boxShadow: '0 8px 30px rgba(0,0,0,0.35)' }}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>Move to account</div>
          <button style={btn(!busy)} disabled={busy} onClick={onClose}>Close</button>
        </div>
        <div className="text-xs mb-2" style={{ color: 'var(--dim)' }}>
          {data ? <>This tab is on <b style={{ color: 'var(--fg)' }}>{data.source.label}</b>{data.source.email ? ` (${data.source.email})` : ''}.</> : !error && 'Reading accounts…'}
        </div>
        {tabWarn && <div className="text-xs mb-2" style={{ color: '#fbbf24' }}>{tabWarn}</div>}
        {data?.tab?.hardBlock && <div data-move-block className="text-xs mb-2" style={{ color: '#f87171' }}>This tab cannot move: {data.tab.hardBlock}.</div>}
        {busy && <div data-move-progress className="text-xs mb-2" style={{ color: 'var(--fg)' }}>Moving, and checking what is really running there…</div>}
        {error && <div data-move-error className="text-xs mb-2" style={{ color: '#f87171', whiteSpace: 'pre-wrap' }}>{error}</div>}
        {(data?.targets || []).map((t, i) => {
          const u = t.usage;
          const ok = !t.refusal && !data.tab.hardBlock && !busy;
          // Every tab is judged by itself when it moves.
          const okAll = !t.allRefusal && !busy;
          return (
            <div key={`${t.id ?? 'default'}-${i}`} data-move-target={t.label} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', marginBottom: 6, opacity: t.refusal ? 0.6 : 1 }}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs" style={{ color: 'var(--fg)', minWidth: 0 }}>
                  <span className="font-medium">{t.label}</span>
                  {t.email && <span style={{ color: 'var(--dim)' }}> {t.email}</span>}
                </div>
                <div className="flex gap-1" style={{ flexShrink: 0 }}>
                  <button style={btn(ok)} disabled={!ok} onClick={() => move(t, [tabId], true)}>Move tab</button>
                  <button style={btn(okAll)} disabled={!okAll} onClick={() => move(t, windowTabIds.split('\n'), false)}>Move all in window</button>
                </div>
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--dim)' }}>
                {u?.known
                  ? <>
                      {orderedWindows(u.windows).map(([name, w]) => (
                        <span key={name} style={{ marginRight: 10 }}>
                          {windowLabel(name)} {w ? <><span style={{ color: barColor(w.used) }}>{Math.round(w.used)}%</span>, {ago(w.ageMs)}</> : 'Unknown'}
                        </span>
                      ))}
                      <span>{u.headroom}% headroom</span>
                    </>
                  : <span>Usage unknown: no session has reported on it yet</span>}
              </div>
              {t.refusal && <div className="text-xs mt-1" style={{ color: '#f87171' }}>{t.refusal}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
