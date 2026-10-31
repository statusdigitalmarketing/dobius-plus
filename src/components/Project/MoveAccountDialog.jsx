import { useEffect, useState } from 'react';
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
  const windowTabIds = useStore((s) => s.terminalTabs.filter((t) => (t.kind || 'terminal') === 'terminal').map((t) => t.id).join('\n'));

  useEffect(() => {
    let alive = true;
    window.electronAPI?.accountsMoveTargets?.(tabId).then((r) => {
      if (!alive) return;
      if (r?.ok) setData(r); else setError(r?.error || 'Could not read the accounts.');
    });
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { alive = false; window.removeEventListener('keydown', onKey, true); };
  }, [tabId, onClose]);

  const moveOne = async (t) => {
    setBusy(true);
    const r = await useStore.getState().moveTabToAccount(tabId, t.isDefault ? null : t.id, { label: t.label });
    setBusy(false);
    if (r?.cancelled) return;
    if (!r?.ok) window.alert(`Move to ${t.label}: ${r?.error || 'something went wrong'}`);
    onClose();
  };

  const moveAll = async (t) => {
    setBusy(true);
    const ids = windowTabIds ? windowTabIds.split('\n') : [];
    const r = await useStore.getState().moveTabsToAccount(ids, t.isDefault ? null : t.id, t.label);
    setBusy(false);
    if (!r?.cancelled) onClose();
  };

  const tabWarn = data?.tab?.busy ? 'This tab is in the middle of a turn: moving it stops that turn.'
    : data?.tab?.draft ? 'This tab has unsent text in Claude\'s prompt: moving it loses that text.'
      : data?.tab?.running === 'other' ? 'This tab is running another program: moving it stops it.' : '';

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
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: 'min(560px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 120px)', overflowY: 'auto', backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, boxShadow: '0 8px 30px rgba(0,0,0,0.35)' }}>
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-medium" style={{ color: 'var(--fg)' }}>Move to account</div>
          <button style={btn(true)} onClick={onClose}>Close</button>
        </div>
        <div className="text-xs mb-2" style={{ color: 'var(--dim)' }}>
          {data ? <>This tab is on <b style={{ color: 'var(--fg)' }}>{data.source.label}</b>{data.source.email ? ` (${data.source.email})` : ''}.</> : error || 'Reading accounts…'}
        </div>
        {tabWarn && <div className="text-xs mb-2" style={{ color: '#fbbf24' }}>{tabWarn}</div>}
        {(data?.targets || []).map((t, i) => {
          const u = t.usage;
          const ok = !t.refusal && !busy;
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
                  <button style={btn(ok)} disabled={!ok} onClick={() => moveOne(t)}>Move tab</button>
                  <button style={btn(okAll)} disabled={!okAll} onClick={() => moveAll(t)}>Move all in window</button>
                </div>
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--dim)' }}>
                {u?.known
                  ? <>
                      {orderedWindows(u.windows).map(([name, w]) => (
                        <span key={name} style={{ marginRight: 10 }}>
                          {windowLabel(name)} <span style={{ color: barColor(w.used) }}>{Math.round(w.used)}%</span>
                        </span>
                      ))}
                      <span>{u.headroom}% headroom, reported {ago(u.ageMs)}</span>
                    </>
                  : <span>Usage unknown{u?.lastReportedAt ? ` (last report ${ago(u.ageMs)})` : ': no session has reported on it yet'}</span>}
              </div>
              {t.refusal && <div className="text-xs mt-1" style={{ color: '#f87171' }}>{t.refusal}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
