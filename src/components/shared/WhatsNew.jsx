import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useStore } from '../../store/store';
import { onWindowFocus } from '../../lib/window-focus';

// The one-time "What's new" popup after an update. Main picks the window and sends the notes (electron/whats-new.js);
// this window says it is listening a moment after it mounts, so its tabs have restored first.
//
// While open it owns the keyboard: the store flag and the blur happen in the IPC callback itself, BEFORE the popup can
// paint, so no key, paste or menu accelerator reaches the tab behind it in between (Codex P1). Keys stop at the dialog
// (window keydown handlers never see them), menu accelerators check store.whatsNewOpen (ProjectView), pastes inside
// role="dialog" are skipped by TerminalPane, and focus that wanders behind it is brought back. It waits while another
// overlay holds the keyboard (a tab menu, the New Tab picker, the palette, an image), since two focus traps fight.
// Continue, Enter or Escape closes it for good; unmounting without that hands it back to main for another window.
const READY_DELAY_MS = 2000;
const WAIT_POLL_MS = 500;

function otherOverlayOpen() {
  const st = useStore.getState();
  if (st.tabMenuOpen || st.newTabPickerOpen) return true;
  return !!document.querySelector('[role="dialog"]:not([data-testid="whats-new"]), [role="menu"], .chatp-lightbox');
}

export default function WhatsNew() {
  const [data, setData] = useState(null); // { sections: [{ version, bullets }] }
  const buttonRef = useRef(null);
  const dialogRef = useRef(null);
  const returnFocus = useRef(null);
  const held = useRef(false); // main sent the notes here and Continue has not been pressed
  const waitTimer = useRef(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onWhatsNewShow) return undefined;
    // Not now (another overlay holds the keyboard, or this window lost focus after main picked it): hand the notes back
    // and say ready again once this window is focused and clear, so main picks the focused window then (Codex).
    let offFocus = null;
    // Focused NOW, read live (a cached focus flag can be one blur behind; Codex rounds 4 and 5). While a <webview> pane
    // holds focus hasFocus() is false too, so the popup waits until the person is back in Dobius itself.
    const clear = () => document.hasFocus() && !otherOverlayOpen();
    const waitUntilClear = () => {
      waitTimer.current = null;
      if (!clear()) { waitTimer.current = setTimeout(waitUntilClear, WAIT_POLL_MS); return; }
      api.whatsNewReady?.();
    };
    const present = (d) => {
      if (!clear()) {
        held.current = false;
        api.whatsNewRelease?.();
        // Focus comes back as an event; an overlay closing does not, so that is looked at twice a second.
        if (!offFocus) offFocus = onWindowFocus(() => { if (!waitTimer.current) return; clearTimeout(waitTimer.current); waitUntilClear(); });
        waitTimer.current = setTimeout(waitUntilClear, WAIT_POLL_MS);
        return;
      }
      // Keyboard first, synchronously: nothing typed after this point reaches the tab behind the popup.
      useStore.getState().setWhatsNewOpen(true);
      const active = document.activeElement;
      if (!returnFocus.current && active && active !== document.body) returnFocus.current = active;
      active?.blur?.();
      // Committed in this same task, so the dialog and its focus exist before the next key event is handled.
      flushSync(() => setData(d));
    };
    const off = api.onWhatsNewShow((d) => {
      if (!d || !Array.isArray(d.sections) || d.sections.length === 0) return;
      held.current = true;
      clearTimeout(waitTimer.current);
      present(d);
    });
    const t = setTimeout(() => api.whatsNewReady?.(), READY_DELAY_MS);
    return () => {
      clearTimeout(t);
      clearTimeout(waitTimer.current);
      offFocus?.();
      off?.();
      // Unmounted without Continue (an error screen): this window no longer listens. Free the keyboard, and let main
      // offer the notes to another window (sent even when this one never held them, so main stops counting it ready).
      if (held.current) useStore.getState().setWhatsNewOpen(false);
      held.current = false;
      api.whatsNewRelease?.();
    };
  }, []);

  useLayoutEffect(() => {
    if (!data) return undefined;
    buttonRef.current?.focus();
    // Focus moved behind the popup (a terminal focusing itself): take it back. Never fight another dialog's own trap
    // (two traps refocusing each other recurse).
    const onFocusIn = (e) => {
      const t = e.target;
      if (!dialogRef.current || dialogRef.current.contains(t)) return;
      if (t?.closest?.('[role="dialog"], .chatp-lightbox')) return;
      buttonRef.current?.focus();
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, [data]);

  const close = useCallback(() => {
    held.current = false;
    window.electronAPI?.whatsNewDismiss?.();
    useStore.getState().setWhatsNewOpen(false);
    setData(null);
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back && document.contains(back)) setTimeout(() => back.focus?.(), 0);
  }, []);

  if (!data) return null;
  const newest = data.sections[0].version;
  const several = data.sections.length > 1;

  return (
    <div
      data-dialog-backdrop=""
      // Clicks on the dimmed area do nothing (no stray dismiss, no focus to what is behind).
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9995,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 16,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        data-testid="whats-new"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); return; }
          if (e.key === 'Tab') { e.preventDefault(); buttonRef.current?.focus(); }
        }}
        onMouseDown={(e) => { e.stopPropagation(); if (e.target !== buttonRef.current) e.preventDefault(); }}
        style={{
          width: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 64px)',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface)', color: 'var(--fg)',
          border: '1px solid var(--border)', borderRadius: 12,
          boxShadow: '0 24px 64px rgba(0,0,0,0.45)', overflow: 'hidden',
          userSelect: 'text',
        }}
      >
        <div style={{ padding: '20px 20px 4px' }}>
          <h2 id="whats-new-title" style={{ fontSize: 17, lineHeight: '22px', fontWeight: 600, margin: 0 }}>
            What's new in Dobius+ {newest}
          </h2>
        </div>
        <div style={{ padding: '8px 20px 4px', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
          {data.sections.map((s) => (
            <section key={s.version} style={{ marginBottom: 12 }}>
              {several && (
                <h3 style={{ fontSize: 11, lineHeight: '14px', fontWeight: 600, color: 'var(--dim)', margin: '4px 0 6px' }}>
                  Version {s.version}
                </h3>
              )}
              <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc' }}>
                {s.bullets.map((b, i) => (
                  <li key={i} style={{ fontSize: 13, lineHeight: '18px', margin: '0 0 6px' }}>{b}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div style={{ padding: '8px 20px 16px', display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button
            ref={buttonRef}
            type="button"
            onClick={close}
            data-testid="whats-new-continue"
            style={{
              height: 28, padding: '0 16px', borderRadius: 6, border: 'none', cursor: 'default',
              background: 'var(--accent)', color: 'var(--bg)', fontSize: 13, fontWeight: 500,
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
