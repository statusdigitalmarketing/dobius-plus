import { useEffect, useState } from 'react';
import { useStore } from '../../store/store';

/**
 * Auto-move on limit, the window's half. Main decides that a tab in this
 * window hit its limit and which account has the most headroom
 * (electron/account-headroom-service.js); this window does the move the same
 * way a person would (store.moveTabToAccount: pin, respawn, resumeSession),
 * then tells main, which sends "continue" once Claude is back on its prompt.
 * Notices (moved, not moved, every account limited) show here until
 * dismissed.
 */
const SESSION_RE = /^[a-zA-Z0-9][\w-]{0,99}$/;
const MAX_NOTICES = 5;

export default function AccountMoveBanner() {
  const [notices, setNotices] = useState([]);

  useEffect(() => {
    const api = window.electronAPI;
    const tabLabel = (tabId) => useStore.getState().terminalTabs.find((t) => t.id === tabId)?.label || 'A tab';
    const add = (tabId, text) => setNotices((n) => [...n, { id: `${Date.now()}-${Math.random()}`, tabId, text: `${tabLabel(tabId)}: ${text}` }].slice(-MAX_NOTICES));
    // One move at a time in this window: each resume types into its own tab,
    // but two respawns racing the same 900ms wait gain nothing.
    let chain = Promise.resolve();
    const offMove = api?.onAccountsAutoMove?.((tabId, p) => {
      if (!p || typeof p.eventId !== 'string') return;
      chain = chain.then(async () => {
        const tab = useStore.getState().terminalTabs.find((t) => t.id === tabId);
        if (!tab) { await api.accountsAutoMoveContinue?.(tabId, p.eventId, 'the tab is no longer in this window'); return; }
        if (!SESSION_RE.test(String(p.sessionId || ''))) { await api.accountsAutoMoveContinue?.(tabId, p.eventId, 'no conversation to resume'); return; }
        const accountId = p.accountId === null ? null : String(p.accountId || '');
        // Main re-checks right before the restart (this one may have waited
        // behind other moves): typed into, unsent text or busy since it
        // decided means it is not moved at all.
        const go = await api.accountsAutoMoveStart?.(tabId, p.eventId);
        if (!go?.ok) { add(tabId, `hit its limit but was not moved: ${go?.error || 'the move was called off'}.`); return; }
        add(tabId, `hit its limit, moving to ${p.targetLabel || 'another account'} and continuing.`);
        let r;
        try {
          r = await useStore.getState().moveTabToAccount(tabId, accountId, {
            auto: true, label: p.targetLabel, sessionId: p.sessionId, project: typeof p.project === 'string' ? p.project : null,
          });
        } catch (err) { r = { ok: false, error: err?.message || String(err) }; }
        await api.accountsAutoMoveContinue?.(tabId, p.eventId, r?.ok ? null : (r?.error || 'the move failed'));
      }).catch(() => {});
    });
    const offNotice = api?.onAccountsAutoMoveNotice?.((tabId, p) => {
      if (typeof p?.text === 'string') add(tabId, p.text);
    });
    return () => { offMove?.(); offNotice?.(); };
  }, []);

  if (!notices.length) return null;
  return (
    <div data-account-move-banner style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 8px' }}>
      {notices.map((n) => (
        <div key={n.id} className="text-xs flex items-center justify-between gap-2" style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px', color: 'var(--fg)' }}>
          <span>{n.text}</span>
          <button
            style={{ fontSize: 11, color: 'var(--dim)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}
            onClick={() => setNotices((all) => all.filter((x) => x.id !== n.id))}
          >Dismiss</button>
        </div>
      ))}
    </div>
  );
}
