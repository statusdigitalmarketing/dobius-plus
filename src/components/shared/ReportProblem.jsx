// Status bar "Report a problem" (Sam, 2026-11-15). A small bug button next to the version opens a popover: say what
// went wrong, optionally attach the last errors from this computer's log, Send. Main files it to the reports repo
// through this computer's gh login (electron/problem-report.js); without access the report is copied to paste to Sam.
//
// Overlay rules (NOTES 2026-10-19): role="dialog" (the terminal's paste listener and the What's new popup both respect
// it), keydown stops at the dialog root so window shortcuts never fire while typing, focus returns to the button.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/store';
import { isWindows } from '../../../shared/platform.js';

const MAX = 4000;

export default function ReportProblem() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [includeLog, setIncludeLog] = useState(true);
  const [state, setState] = useState({ phase: 'idle' }); // idle | sending | sent | copied | error (error may carry `report`)
  const setReportProblemOpen = useStore((s) => s.setReportProblemOpen);
  const btnRef = useRef(null);
  const boxRef = useRef(null);
  const areaRef = useRef(null);

  const close = () => {
    setOpen(false);
    if (state.phase !== 'sending') setState({ phase: 'idle' });
    requestAnimationFrame(() => btnRef.current?.focus());
  };

  // Menu accelerators skip the DOM, so ProjectView's handlers read this flag and hold off while the popover is open.
  useEffect(() => {
    setReportProblemOpen(open);
    return () => setReportProblemOpen(false);
  }, [open, setReportProblemOpen]);

  useEffect(() => {
    if (!open) return undefined;
    requestAnimationFrame(() => areaRef.current?.focus());
    let closing = false; // a click outside is closing it: the focus that click moves is the person's, never pulled back
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      closeOutside();
    };
    // While it is open, focus is the popover's: a click outside closes it (onDown) before anything else can take focus,
    // so focus anywhere else came from something asynchronous (a disabled control, a terminal's Improve resolving and
    // refocusing its input). Keys there are stopped before they reach any handler, Escape closes, and focus is pulled
    // back into the box (Codex PR 18 r1, r2).
    const pullBack = () => (areaRef.current || boxRef.current?.querySelector('button'))?.focus();
    const onKey = (e) => {
      if (closing || boxRef.current?.contains(document.activeElement)) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.key === 'Escape' && !e.isComposing) {
        setOpen(false);
        setState((st) => (st.phase === 'sending' ? st : { phase: 'idle' }));
        requestAnimationFrame(() => btnRef.current?.focus());
        return;
      }
      pullBack();
    };
    // A click inside an embedded browser (<webview>) never reaches this document's mousedown; focus landing on the
    // webview is the only sign of it, so that is an outside click: it closes (Codex PR 18 r3, as BrowserPane does).
    const isGuest = (el) => el?.tagName === 'WEBVIEW' || el?.tagName === 'IFRAME';
    const closeOutside = () => { closing = true; setOpen(false); };
    const onFocusIn = (e) => {
      if (closing || boxRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      if (isGuest(e.target)) { closeOutside(); return; }
      pullBack();
    };
    // A webview whose page is still starting moves focus without a focus event; the window's blur says it. Read at the
    // blur itself: a guest still loading can hand focus straight back to this window a moment later (seen in the
    // harness), so a deferred look misses the click. A Cmd+Tab away leaves focus on the box, so it never closes.
    let blurTimer = null;
    const onBlur = () => {
      if (closing) return;
      if (isGuest(document.activeElement)) { closeOutside(); return; }
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => { if (!closing && isGuest(document.activeElement)) closeOutside(); }, 0);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('blur', onBlur);
    return () => {
      clearTimeout(blurTimer);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [open]);

  // After a send, or a state change that re-rendered the controls, focus is back in the box.
  useEffect(() => {
    if (!open || state.phase === 'sending') return;
    requestAnimationFrame(() => {
      if (boxRef.current?.contains(document.activeElement)) return;
      (areaRef.current || boxRef.current?.querySelector('button'))?.focus();
    });
  }, [open, state.phase]);

  const send = async () => {
    if (!text.trim() || state.phase === 'sending') return;
    setState({ phase: 'sending' });
    let r;
    try {
      r = await window.electronAPI?.reportProblem?.(text, includeLog);
    } catch (err) {
      r = { ok: false, reason: 'failed', error: String(err?.message || err) };
    }
    if (r?.ok) {
      setText('');
      setState({ phase: 'sent', url: r.url });
      return;
    }
    if (r?.reason === 'busy') { setState({ phase: 'error', message: 'A report just went out. Try again in a few seconds.' }); return; }
    if (r?.report) {
      let copied = false;
      try { await navigator.clipboard.writeText(`${r.report.title}\n\n${r.report.body}`); copied = true; } catch { copied = false; }
      const why = r.reason === 'no-gh'
        ? 'GitHub CLI (gh) is not installed on this computer'
        : r.reason === 'no-access' ? 'this computer’s GitHub login cannot see the reports repo' : 'GitHub did not accept it';
      setState(copied
        ? { phase: 'copied', message: `Not sent: ${why}. The report is copied, so paste it to Sam.` }
        : { phase: 'error', message: `Not sent: ${why}. Copy the report below and send it to Sam.`, report: `${r.report.title}\n\n${r.report.body}` });
      return;
    }
    setState({ phase: 'error', message: 'Write what went wrong first.' });
  };

  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); return; }
    if (e.key === 'Tab') {
      const f = [...boxRef.current.querySelectorAll('textarea, input, button, a[href]')].filter((n) => !n.disabled);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  };

  const sending = state.phase === 'sending';
  return (
    <span className="relative flex items-center">
      <button
        ref={btnRef}
        type="button"
        aria-label="Report a problem"
        title="Report a problem"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="report-problem"
        onClick={() => (open ? close() : setOpen(true))}
        className="flex items-center justify-center rounded"
        style={{ width: 20, height: 20, fontSize: 12, lineHeight: 1, cursor: 'default', opacity: open ? 1 : 0.75, background: open ? 'var(--accent-muted)' : 'transparent' }}
      >
        <span aria-hidden="true">🐞</span>
      </button>
      {open && (
        <div
          ref={boxRef}
          role="dialog"
          aria-modal="false"
          aria-label="Report a problem"
          onKeyDown={onKeyDown}
          className="absolute right-0 bottom-7 z-50 flex flex-col gap-2 rounded-lg p-3"
          style={{ width: 320, background: 'var(--surface, var(--bg))', border: '1px solid var(--border)', boxShadow: '0 8px 28px rgba(0,0,0,0.35)', color: 'var(--fg)', fontSize: 13, lineHeight: '16px', userSelect: 'text' }}
        >
          <div style={{ fontWeight: 600 }}>Report a problem</div>
          {state.phase === 'sent' ? (
            <>
              <p style={{ color: 'var(--dim)', fontSize: 12, lineHeight: '15px' }}>Sent. Thanks, it is in the Dobius+ reports list.</p>
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded px-2.5" style={{ height: 22, fontSize: 12, border: '1px solid var(--border)', cursor: 'default' }} onClick={() => setState({ phase: 'idle' })}>Report another</button>
                <button type="button" className="rounded px-2.5" style={{ height: 22, fontSize: 12, background: 'var(--accent)', color: 'var(--bg)', cursor: 'default' }} onClick={close}>Done</button>
              </div>
            </>
          ) : (
            <>
              <textarea
                ref={areaRef}
                autoFocus
                value={text}
                maxLength={MAX}
                rows={5}
                readOnly={sending}
                placeholder="What went wrong, and what were you doing?"
                aria-label="What went wrong"
                onChange={(e) => { if (sending) return; setText(e.target.value); if (state.phase === 'copied' || (state.phase === 'error' && !state.report)) setState({ phase: 'idle' }); }}
                className="w-full resize-none rounded p-2"
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--fg)', fontSize: 13, lineHeight: '16px', outline: 'none' }}
              />
              <label className="flex items-center gap-2" style={{ fontSize: 12, color: 'var(--dim)', cursor: 'default' }}>
                <input type="checkbox" checked={includeLog} aria-disabled={sending} onChange={(e) => { if (!sending) setIncludeLog(e.target.checked); }} />
                Include recent errors from this computer
              </label>
              {(state.phase === 'error' || state.phase === 'copied') && (
                <p role="alert" style={{ fontSize: 12, lineHeight: '15px', color: state.phase === 'copied' ? 'var(--fg)' : '#f85149' }}>{state.message}</p>
              )}
              {state.phase === 'error' && state.report && (
                // The clipboard refused: the whole report stays here, selected, to copy by hand (Codex PR 18 r1).
                <textarea
                  readOnly
                  value={state.report}
                  rows={4}
                  aria-label="The report, to copy"
                  data-testid="report-text"
                  onFocus={(e) => e.target.select()}
                  className="w-full resize-none rounded p-2"
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--dim)', fontSize: 11, lineHeight: '14px', outline: 'none' }}
                />
              )}
              <div className="flex items-center justify-between">
                <span style={{ fontSize: 11, color: 'var(--dim)' }}>{isWindows() ? 'Ctrl+Enter to send' : '⌘↩ to send'}</span>
                <div className="flex gap-2">
                  <button type="button" className="rounded px-2.5" style={{ height: 22, fontSize: 12, border: '1px solid var(--border)', cursor: 'default' }} onClick={close}>Cancel</button>
                  <button type="button" className="rounded px-2.5" disabled={!text.trim()} aria-disabled={sending}
                    style={{ height: 22, width: 64, fontSize: 12, background: 'var(--accent)', color: 'var(--bg)', opacity: !text.trim() || sending ? 0.5 : 1, cursor: 'default' }}
                    onClick={send}>{sending ? 'Sending' : 'Send'}</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}
