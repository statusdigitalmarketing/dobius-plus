import { useEffect, useState } from 'react';
import { useStore } from '../../store/store';
import { autoMoveText } from '../../lib/auto-move-text';

/**
 * Auto-move on limit, the window's half. Main notices that a tab in this
 * window is on Claude's limit menu and moves it itself (the dialog's move,
 * account-headroom-service.js autoTick); this keeps the tab's account pin in
 * step and says what happened, from which account to which, until dismissed.
 *
 * The Claude in Chrome note is a fact about the extension, not about the move:
 * Claude Code reaches the extension through a bridge keyed by the claude.ai
 * account, and the extension is signed in to one account at a time. A tab on
 * another account cannot drive that browser. The move itself opens no browser
 * sign-in (only an account already logged in is a target), so the extension's
 * own sign-in is untouched.
 */
const MAX_NOTICES = 5;
let seq = 0;
export default function AutoMoveNotices() {
  const [notices, setNotices] = useState([]);

  useEffect(() => {
    const off = window.electronAPI?.onAccountsAutoMove?.((tabId, p) => {
      if (!p || typeof p !== 'object') return;
      const state = useStore.getState();
      const tab = state.terminalTabs.find((t) => t.id === tabId);
      if (!tab) return;
      // The pin says what main found running, exactly as after a manual move.
      if (p.pin !== undefined) state.applyAccountPin(tabId, p.pin);
      const msg = autoMoveText(tab.label || 'A tab', p);
      if (!msg) return;
      const id = (seq += 1);
      setNotices((n) => [...n, { id, tabId, kind: p.kind, ...msg }].slice(-MAX_NOTICES));
    });
    return () => off?.();
  }, []);

  if (!notices.length) return null;
  return (
    <div data-auto-move-notices style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 8px' }}>
      {notices.map((n) => (
        <div
          key={n.id}
          data-auto-move-kind={n.kind}
          className="text-xs flex items-start justify-between gap-2"
          style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px', color: 'var(--fg)' }}
        >
          <span>
            {n.text}
            {n.note && <span style={{ display: 'block', color: 'var(--dim)', marginTop: 2 }}>{n.note}</span>}
          </span>
          <button
            style={{ fontSize: 11, color: 'var(--dim)', background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}
            onClick={() => setNotices((all) => all.filter((x) => x.id !== n.id))}
          >Dismiss</button>
        </div>
      ))}
    </div>
  );
}
