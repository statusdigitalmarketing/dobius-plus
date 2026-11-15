// Status bar "Report a problem" (Sam, 2026-11-15). A small bug button next to the version opens a popover: say what
// went wrong, optionally attach the last errors from this computer's log, Send. Main files it to the reports repo
// through this computer's gh login (electron/problem-report.js); without access the report is copied to paste to Sam.
//
// Overlay rules (NOTES 2026-10-19): role="dialog" (the terminal's paste listener and the What's new popup both respect
// it), keydown stops at the dialog root so window shortcuts never fire while typing, focus returns to the button.
import { useEffect, useRef, useState } from 'react';

const MAX = 4000;

export default function ReportProblem() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [includeLog, setIncludeLog] = useState(true);
  const [state, setState] = useState({ phase: 'idle' }); // idle | sending | sent | copied | error
  const btnRef = useRef(null);
  const boxRef = useRef(null);
  const areaRef = useRef(null);

  const close = () => {
    setOpen(false);
    if (state.phase !== 'sending') setState({ phase: 'idle' });
    requestAnimationFrame(() => btnRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return undefined;
    requestAnimationFrame(() => areaRef.current?.focus());
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    // Escape also closes it when focus fell to the page (a button that went disabled while sending drops focus).
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const a = document.activeElement;
      if (a && a !== document.body && !boxRef.current?.contains(a)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setState((st) => (st.phase === 'sending' ? st : { phase: 'idle' }));
      requestAnimationFrame(() => btnRef.current?.focus());
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  // Sending disables the controls, which drops focus; put it back in the box once it is done.
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
      setState({ phase: copied ? 'copied' : 'error', message: copied
        ? `Not sent: ${why}. The report is copied, so paste it to Sam.`
        : `Not sent: ${why}, and it could not be copied.` });
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
                value={text}
                maxLength={MAX}
                rows={5}
                disabled={sending}
                placeholder="What went wrong, and what were you doing?"
                aria-label="What went wrong"
                onChange={(e) => { setText(e.target.value); if (state.phase === 'error' || state.phase === 'copied') setState({ phase: 'idle' }); }}
                className="w-full resize-none rounded p-2"
                style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--fg)', fontSize: 13, lineHeight: '16px', outline: 'none' }}
              />
              <label className="flex items-center gap-2" style={{ fontSize: 12, color: 'var(--dim)', cursor: 'default' }}>
                <input type="checkbox" checked={includeLog} disabled={sending} onChange={(e) => setIncludeLog(e.target.checked)} />
                Include recent errors from this computer
              </label>
              {(state.phase === 'error' || state.phase === 'copied') && (
                <p role="alert" style={{ fontSize: 12, lineHeight: '15px', color: state.phase === 'copied' ? 'var(--fg)' : '#f85149' }}>{state.message}</p>
              )}
              <div className="flex items-center justify-between">
                <span style={{ fontSize: 11, color: 'var(--dim)' }}>⌘↩ to send</span>
                <div className="flex gap-2">
                  <button type="button" className="rounded px-2.5" style={{ height: 22, fontSize: 12, border: '1px solid var(--border)', cursor: 'default' }} onClick={close}>Cancel</button>
                  <button type="button" className="rounded px-2.5" disabled={!text.trim() || sending}
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
