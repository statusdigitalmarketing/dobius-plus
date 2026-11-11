import { useState, useRef, useEffect, useCallback } from 'react';

// Phone mic (Brett, Asana 1220412677067987): nothing is ever sent until Send is tapped.
//   Hold to talk, slide up to lock it on, or double-tap to start hands-free.
//   Letting go (or a stray touch cancel) only stops and shows what was heard: Discard, Keep talking (adds to the same
//   message) or Send. Send goes through /voice/intent (team orchestrator, else Voice Conductor).
// Before any upload the phone asks /voice/target: a Mac that cannot answer it (before 2.2.25) would route the audio on
// upload, so nothing is uploaded and the phone says to update the Mac. Send carries the destination key the card
// showed and a sendId, so it never lands somewhere else and a retry after a lost answer is never delivered twice.
const LOCK_PX = 60;          // slide up this far while holding to lock
const TAP_MS = 250;          // a press shorter than this is a tap
const DOUBLE_TAP_MS = 320;   // second tap within this starts hands-free
const ARM_MS = 700;          // Send ignores taps this soon after the card appears (a second Stop tap lands there)
const MAX_RECORD_MS = 5 * 60_000; // ponytail: hard stop so a forgotten locked mic cannot grow without bound
const MAX_CHARS = 4000;      // the Mac refuses longer; Keep talking stops a little short of it
const BARS = 24;
const HINT_KEY = 'dobius-voice-hint-seen'; // per-phone convenience: the start hint shows until voice is used once
const hintSeen = () => { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return true; } };
const newSendId = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

// The message being put together outlives the component: leaving the board and coming back shows it again, and a
// Send already on its way finishes (its request is not tied to the component).
//   status 'editing': not sent yet, can change. 'sending': a Send is on its way. 'uncertain': a Send got no answer, so
//   it may have been delivered: the text is frozen and only Send again (same sendId, never delivered twice) or Discard.
// Every component showing it follows changes (a Send started by an earlier mount can finish while a new one shows it).
// One draft per pairing (id AND token: re-pairing at the same address can keep the id, and may be another Mac): a sendId
// is only remembered by the Mac it went to, so a message is only ever retried there. In memory only.
const RETRY_SAFE_MS = 20 * 60 * 60_000; // the Mac remembers a delivery 24 h; past 20 h a retry asks first
const DRAFTS_MAX = 8; // ponytail: past this, empty drafts are dropped; one with words, a Send on its way or an unseen warning never is
const drafts = new Map();
const draftFor = (connection) => {
  const key = `${connection?.pairing?.id || connection?.origin || ''}|${connection?.token || ''}`;
  let d = drafts.get(key);
  if (!d) {
    d = { heard: '', sendId: null, status: 'editing', sentAt: 0, notice: '' }; // notice: a warning not yet shown
    drafts.set(key, d);
    for (const [k, v] of drafts) { if (drafts.size <= DRAFTS_MAX) break; if (!v.heard && !v.notice && v.status !== 'sending' && v !== d) drafts.delete(k); }
  }
  return d;
};
const draftListeners = new Set();
const changed = (d, info) => { for (const fn of draftListeners) { try { fn(d, info); } catch { /* a listener must not stop the others */ } } };
const setDraftText = (d, text) => { d.heard = text; d.sendId = text ? newSendId() : null; d.status = 'editing'; d.sentAt = 0; changed(d, {}); };
const setStatus = (d, status, info = {}) => { d.status = status; changed(d, info); };

export default function VoiceButton({ connection }) {
  // The board remounts for another Mac (MacSession is keyed by the pairing), so this is fixed for the mount.
  const [draft] = useState(() => draftFor(connection));
  const setDraft = (text) => setDraftText(draft, text);
  const setDraftStatus = (status, info) => setStatus(draft, status, info);
  // idle | holding | locked | transcribing | confirm | sending | done | error
  const [state, setState] = useState(() => (!draft.heard ? 'idle' : draft.status === 'sending' ? 'sending' : 'confirm'));
  const [, setDraftTick] = useState(0); // re-render when the shared draft's status changes
  const [line, setLine] = useState('');
  const [heard, setHeard] = useState(draft.heard);
  const [target, setTarget] = useState(null); // { label, key }
  const [armed, setArmed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState(() => new Array(BARS).fill(0));
  const [nudge, setNudge] = useState(0); // 0..1, how far toward lock while holding
  const [showHint, setShowHint] = useState(() => !hintSeen());

  // One recording at a time: { phase: 'starting' | 'recording' | 'stopping', stream, mr, chunks, stop, meters }.
  // It stays here until its own finish has released everything, and no new one starts before that.
  const recRef = useRef(null);
  const resetRef = useRef(null);
  const targetSeqRef = useRef(0);
  const transcribingRef = useRef(0); // uploads in flight; read by onDown, where the rendered state can still be stale
  const turnRef = useRef(0); // bumps when a new recording or discard starts; a late reply for an older turn is dropped
  const gestureRef = useRef({ pointerId: null, downAt: 0, startY: 0, locked: false, tapTimer: null, tapPending: false });
  const aliveRef = useRef(false);
  const abortRef = useRef(null);

  const secure = typeof window !== 'undefined' && window.isSecureContext;
  const supported = secure
    && typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';

  const release = (rec) => {
    const m = rec.meters;
    rec.meters = null;
    if (m) {
      clearInterval(m.tick); clearTimeout(m.cap);
      if (m.audio) { cancelAnimationFrame(m.audio.raf); m.audio.dead = true; m.audio.ctx.close().catch(() => {}); }
    }
    rec.stream?.getTracks().forEach((t) => t.stop());
    rec.stream = null;
  };

  const live = () => aliveRef.current && !connection.closed;

  useEffect(() => {
    aliveRef.current = true;
    abortRef.current = new AbortController();
    const gesture = gestureRef.current;
    if (draft.heard) loadTarget();
    const onDraft = (d, info) => {
      if (!aliveRef.current || d !== draft) return;
      setDraftTick((n) => n + 1);
      setHeard(draft.heard);
      if (draft.notice && !recRef.current) {
        // A warning (typed but not confirmed) stays on the draft until a screen has actually painted it (see the effect
        // that clears it).
        setState('done'); setLine(draft.notice); resetSoon(20000);
        return;
      }
      if (info.sent) { if (!recRef.current) { setState('done'); setLine('Sent.'); resetSoon(8000); } return; }
      if (draft.heard && draft.status !== 'sending') setState((s) => (s === 'sending' ? 'confirm' : s));
      if (!draft.heard) setState((s) => (s === 'sending' || s === 'confirm' ? 'idle' : s));
      if (info.line) setLine(info.line);
    };
    draftListeners.add(onDraft);
    onDraft(draft, {}); // catch up: the draft may have settled between the first render and this subscription
    return () => {
      draftListeners.delete(onDraft);
      aliveRef.current = false;
      abortRef.current.abort();
      clearTimeout(resetRef.current);
      clearTimeout(gesture.tapTimer);
      const rec = recRef.current;
      recRef.current = null;
      if (rec) {
        rec.stop = 'cancel';
        if (rec.mr) { rec.mr.onstop = null; rec.mr.ondataavailable = null; if (rec.mr.state === 'recording') { try { rec.mr.stop(); } catch { /* stopped */ } } }
        release(rec);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);

  // Whenever the mic button is not on screen its release can never arrive: the gesture lets go of its pointer.
  useEffect(() => {
    if (!['idle', 'done', 'error', 'holding'].includes(state)) gestureRef.current.pointerId = null;
  }, [state]);

  // The warning leaves the shared draft only once it is on screen (effects run after the commit).
  useEffect(() => {
    if (state === 'done' && line && line === draft.notice) draft.notice = '';
  }, [state, line, draft]);

  // Send arms a moment after the card appears or changes, so a tap meant for Stop cannot land on it.
  useEffect(() => {
    if (state !== 'confirm') { setArmed(false); return undefined; }
    setArmed(false);
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, [state, heard, target?.key]);

  const resetSoon = (ms) => {
    if (!live()) return;
    clearTimeout(resetRef.current);
    // Never hides words waiting on Send or Discard: with words it goes back to their card, not to idle.
    resetRef.current = setTimeout(() => {
      if (recRef.current || transcribingRef.current) return;
      setState(draft.heard ? 'confirm' : 'idle'); setLine('');
    }, ms);
  };

  const startMeters = (rec) => {
    const startedAt = Date.now();
    setElapsed(0);
    const m = { tick: setInterval(() => setElapsed(Date.now() - startedAt), 250), cap: setTimeout(() => stop('transcribe', rec), MAX_RECORD_MS), audio: null };
    rec.meters = m;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(rec.stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const hist = new Array(BARS).fill(0);
      let last = 0;
      const a = { ctx, raf: 0, dead: false };
      const draw = (t) => {
        if (a.dead) return;
        a.raf = requestAnimationFrame(draw);
        if (t - last < 70) return; // ~14 frames a second is plenty for a level meter
        last = t;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        hist.shift(); hist.push(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        setLevels(hist.slice());
      };
      m.audio = a;
      a.raf = requestAnimationFrame(draw);
    } catch { /* the meter is decoration: recording carries on without it */ }
  };

  const start = async (mode) => {
    if (!supported || recRef.current || transcribingRef.current) return false; // one recording or upload at a time
    clearTimeout(resetRef.current);
    const rec = { phase: 'starting', stream: null, mr: null, chunks: [], stop: null, meters: null };
    recRef.current = rec;
    turnRef.current += 1;
    setState(mode);
    setLine('');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (recRef.current === rec) recRef.current = null;
      if (!live()) return false;
      if (draft.heard) { setState('confirm'); setLine('Microphone permission denied'); return false; }
      setState('error'); setLine('Microphone permission denied'); resetSoon(4000);
      return false;
    }
    if (!live() || recRef.current !== rec) { stream.getTracks().forEach((t) => t.stop()); return false; }
    rec.stream = stream;
    if (rec.stop === 'cancel') { finishedEarly(rec); return false; }
    let mr;
    try { mr = new MediaRecorder(stream); } catch { finishedEarly(rec, 'Recording is not available'); return false; }
    rec.mr = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    mr.onstop = () => finished(rec);
    try { mr.start(); } catch { finishedEarly(rec, 'Recording is not available'); return false; }
    rec.phase = 'recording';
    startMeters(rec);
    // Released while the mic was being granted: act on it now.
    if (rec.stop) { rec.phase = 'stopping'; try { mr.stop(); } catch { finished(rec); } }
    return true;
  };

  // Stop THIS recording (the current one when none is named). The first stop asked for wins.
  const stop = (how, which) => {
    const rec = which || recRef.current;
    if (!rec && !which && !transcribingRef.current && (state === 'locked' || state === 'holding')) { gestureRef.current.locked = false; afterCancel(); return; } // nothing recording: just close
    if (!rec || rec !== recRef.current || rec.stop) return;
    rec.stop = how;
    if (rec.phase === 'recording') {
      rec.phase = 'stopping';
      try { rec.mr.stop(); } catch { finished(rec); }
    }
    // 'starting': start() sees rec.stop once the mic is granted.
  };

  const afterCancel = () => {
    // The line is left alone: a lone tap set its hint just before this (the recorder stops asynchronously).
    if (draft.heard) setState('confirm'); else setState('idle');
  };

  const finishedEarly = (rec, msg) => {
    release(rec);
    if (recRef.current === rec) recRef.current = null;
    if (!live()) return;
    if (msg) { setLine(msg); if (!draft.heard) { setState('error'); resetSoon(4000); return; } }
    afterCancel();
  };

  const finished = async (rec) => {
    if (rec.done) return;
    rec.done = true;
    release(rec);
    if (recRef.current === rec) recRef.current = null;
    gestureRef.current.locked = false;
    clearTimeout(gestureRef.current.tapTimer); gestureRef.current.tapPending = false; // a recording that ended on its own
    if (!live()) return;
    if (rec.stop === 'cancel') { afterCancel(); return; }
    const type = rec.mr?.mimeType || 'audio/webm';
    const blob = new Blob(rec.chunks, { type });
    rec.chunks = [];
    if (!blob.size) { afterCancel(); return; }
    transcribingRef.current += 1;
    try { await transcribe(blob); } finally { transcribingRef.current -= 1; }
  };

  const transcribe = async (blob) => {
    setState('transcribing');
    // Ask first: a Mac that does not know /voice/target would act on the audio the moment it arrives.
    const tgt = await loadTarget();
    if (!live()) return;
    if (tgt === 'old') { failed('Update Dobius+ on your Mac to use voice. This version would send it without asking.'); return; }
    if (!tgt) { failed('Can’t reach the Mac. Nothing was sent.'); return; }
    try {
      const res = await connection.request('/voice/audio?confirm=1', {
        method: 'POST',
        signal: abortRef.current.signal,
        headers: { 'Content-Type': blob.type },
        body: blob,
      });
      const j = await res.json();
      if (!live()) return;
      if (!j.ok) { failed(j.error || 'Transcription failed'); return; }
      if (!j.held) { failed('This Mac did not hold it for you to confirm. Update Dobius+ on the Mac.'); return; }
      const text = String(j.transcript || '').trim();
      if (!text && !draft.heard) { setState('error'); setLine('Didn’t catch anything. Try again.'); resetSoon(3000); return; }
      if (text && draft.status !== 'editing') { failed('That message may already have gone. Discard it before adding more.'); return; }
      if (text) setDraft([draft.heard, text].filter(Boolean).join(' '));
      setHeard(draft.heard);
      setLine(draft.heard.length > MAX_CHARS ? `Too long to send (${draft.heard.length} characters, ${MAX_CHARS} at most). Discard and say it in parts.` : '');
      setState('confirm');
    } catch {
      if (!live()) return;
      failed('Upload failed. Nothing was sent.');
    }
  };

  // A failure never loses what was already heard.
  const failed = (msg) => {
    if (draft.heard) { setState('confirm'); setLine(msg); return; }
    setState('error'); setLine(msg); resetSoon(5000);
  };

  // -> { label, key } | 'old' (this Mac predates /voice/target) | null (not reachable). Only the newest answer is shown.
  const loadTarget = async () => {
    const seq = ++targetSeqRef.current;
    let out;
    try {
      const res = await connection.request('/voice/target', { signal: abortRef.current.signal });
      if (res.status === 404) out = 'old';
      else {
        const j = await res.json();
        out = j.ok && j.confirm === true ? { label: j.label || '', key: j.key || 'none' } : (j.ok ? 'old' : null);
      }
    } catch { out = null; }
    if (live() && seq === targetSeqRef.current && out && out !== 'old') setTarget(out);
    return out;
  };

  const send = async () => {
    const text = draft.heard;
    const sendId = draft.sendId;
    if (!text || !armed || state !== 'confirm' || draft.status === 'sending') return;
    if (text.length > MAX_CHARS) { setLine(`Too long to send (${text.length} characters, ${MAX_CHARS} at most).`); return; }
    turnRef.current += 1; // an older message's reply must not overwrite this one's outcome
    if (!draft.sentAt) draft.sentAt = Date.now();
    const wasUncertain = draft.status === 'uncertain'; // an earlier attempt may have landed: the text stays frozen
    setDraftStatus('sending');
    setState('sending');
    setLine('Sending…');
    let j;
    try {
      // No abort signal: leaving the board must not cancel a Send already tapped. A repeat carries the same sendId.
      const res = await connection.request('/voice/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text, sendId, expect: target?.key || 'none', retry: wasUncertain }),
      });
      j = await res.json();
    } catch { j = null; }
    // The shared draft is settled first, whether or not this component is still on screen.
    if (draft.sendId !== sendId) return; // discarded meanwhile
    if (!j) { setDraftStatus('uncertain', { line: 'Couldn’t confirm it went through. Tap Send again: it won’t be delivered twice.' }); return; }
    if (j.changed && j.target) {
      if (live()) setTarget({ label: j.target.label || '', key: j.target.key || 'none' });
      setDraftStatus(wasUncertain ? 'uncertain' : 'editing', { line: j.error });
      return;
    }
    if (!j.ok || !j.requestId) { setDraftStatus(wasUncertain ? 'uncertain' : 'editing', { line: j.error || 'Not sent. Try again.' }); return; }
    setDraft('');
    // Every mount showing it (this one, or a later one after leaving the board) says Sent, or the warning when the text
    // was typed but its submission was not confirmed.
    if (j.note) draft.notice = String(j.note);
    changed(draft, { sent: true });
    if (!live() || j.note) return;
    pollReply(j.requestId);
  };

  const pollReply = async (requestId) => {
    const turn = turnRef.current;
    const mine = () => live() && turn === turnRef.current && !recRef.current;
    try {
      const res = await connection.request('/voice/reply', {
        method: 'POST',
        signal: abortRef.current.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, timeoutMs: 30000 }),
      });
      const j = await res.json();
      if (!mine()) return;
      setState('done');
      setLine(j.ok && j.reply ? j.reply : 'Sent.');
      resetSoon(10000);
    } catch {
      if (!mine()) return;
      setState('done'); setLine('Sent.'); resetSoon(7000);
    }
  };

  const discard = () => { if (draft.status === 'sending') return; turnRef.current += 1; setDraft(''); setHeard(''); setLine(''); setTarget(null); setState('idle'); };
  const keepTalking = async () => {
    setLine('');
    if (await start('locked')) gestureRef.current.locked = true;
  };

  // --- The mic button's gestures -------------------------------------------------------------------------------------
  const onDown = (e) => {
    e.preventDefault();
    if (!['idle', 'done', 'error', 'holding', 'locked'].includes(state)) return;
    // The last recording is still shutting down or being transcribed: this press is ignored whole (its release too).
    if (recRef.current?.phase === 'stopping' || recRef.current?.stop || transcribingRef.current) return;
    const g = gestureRef.current;
    if (g.pointerId != null && g.pointerId !== e.pointerId) return; // a second finger never takes over the gesture
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not every browser keeps capture */ }
    g.pointerId = e.pointerId;
    if (showHint) { setShowHint(false); try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode: shows again next time */ } }
    if (g.tapPending) {
      // Second tap: hands-free. The first tap already started the mic, unless that failed (permission denied): then
      // this tap starts it hands-free itself rather than showing a recorder that does not exist.
      clearTimeout(g.tapTimer); g.tapPending = false;
      g.locked = true;
      g.pointerId = null; // the mic button goes away while locked: its release never arrives
      if (recRef.current) { setState('locked'); return; }
      start('locked').then((ok) => { if (!ok) g.locked = false; });
      return;
    }
    if (state === 'locked') return; // the panel's own buttons stop it
    g.downAt = Date.now(); g.startY = e.clientY; g.locked = false;
    setNudge(0);
    start('holding');
  };

  const onMove = (e) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId || g.locked || state !== 'holding') return;
    const up = g.startY - e.clientY;
    setNudge(Math.max(0, Math.min(1, up / LOCK_PX)));
    if (up >= LOCK_PX && recRef.current) { g.locked = true; g.pointerId = null; setNudge(0); setState('locked'); } // its release never arrives
  };

  const onUp = (e) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    g.pointerId = null;
    setNudge(0);
    if (g.locked) return; // hands-free: keeps recording
    const rec = recRef.current;
    if (Date.now() - g.downAt < TAP_MS) {
      // A tap: wait to see if a second one makes it hands-free; if not, it was nothing.
      g.tapPending = true;
      clearTimeout(g.tapTimer);
      g.tapTimer = setTimeout(() => {
        g.tapPending = false;
        if (rec?.done) return; // it already ended (the mic went away): that path owns what is shown
        stop('cancel', rec);
        if (live()) { setLine('Hold to talk, or double-tap for hands-free'); resetSoon(2500); }
      }, DOUBLE_TAP_MS);
      return;
    }
    stop('transcribe', rec); // letting go never sends: it shows what was heard
  };

  const onCancel = (e) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    g.pointerId = null;
    setNudge(0);
    if (!g.locked && state === 'holding') stop('transcribe');
  };

  const mmss = useCallback((ms) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, []);

  if (!supported) {
    return (
      <button className="voice-fab disabled" disabled title={secure ? 'Voice not supported on this device' : 'Voice needs HTTPS (enable it in Dobius Settings)'}>
        <span aria-hidden="true">🎙</span>
      </button>
    );
  }

  const recording = state === 'holding' || state === 'locked';
  const tooLong = heard.length > MAX_CHARS;
  const frozen = draft.status !== 'editing'; // sent or maybe sent: no more changes
  const stale = draft.status === 'uncertain' && draft.sentAt && Date.now() - draft.sentAt > RETRY_SAFE_MS;
  const cardOpen = state === 'confirm' || state === 'transcribing' || (state === 'sending' && heard);
  return (
    <>
      {showHint && state === 'idle' && !line && <div className="voice-hint" aria-hidden="true">Hold to talk<br />Double-tap for hands-free</div>}
      {line && !['confirm', 'locked', 'transcribing'].includes(state) && !(state === 'sending' && heard) && <div className={`voice-bubble voice-${state}`}>{line}</div>}

      {state === 'holding' && (
        <>
          <div className="voice-lock-rail" style={{ '--nudge': nudge }} aria-hidden="true">
            <span className="voice-lock-icon">🔒</span>
            <span className="voice-lock-chev">⌃<br />⌃</span>
          </div>
          <div className="voice-hold-pill" role="status"><span className="voice-dot" />{mmss(elapsed)} · slide up to lock</div>
        </>
      )}

      {state === 'locked' && (
        <div className="voice-panel" role="dialog" aria-label="Recording">
          <div className="voice-panel-head"><span aria-hidden="true">🔒</span> RECORDING · {mmss(elapsed)}</div>
          <div className="voice-wave" aria-hidden="true">
            {levels.map((v, i) => <span key={i} style={{ height: `${Math.max(8, Math.round(v * 100))}%` }} />)}
          </div>
          {heard && <div className="voice-panel-sub">Adding to: “{heard.length > 80 ? `${heard.slice(0, 80)}…` : heard}”</div>}
          <div className="voice-row">
            <button className="voice-btn" onClick={() => stop('cancel')}>Cancel</button>
            <button className="voice-btn voice-btn-stop" onClick={() => stop('transcribe')}>Stop</button>
          </div>
        </div>
      )}

      {cardOpen && (
        <div className="voice-panel" role="dialog" aria-label="Heard">
          <div className="voice-panel-head">HEARD</div>
          <div className="voice-heard">{heard ? `“${heard}”` : ''}{state === 'transcribing' && <span className="voice-dim">{heard ? ' …' : 'Transcribing…'}</span>}</div>
          {target?.label && <div className="voice-panel-sub">Goes to: {target.label}</div>}
          {target && !target.label && state === 'confirm' && <div className="voice-panel-err">Nothing on the Mac is listening for voice right now.</div>}
          {line && state !== 'transcribing' && <div className="voice-panel-err">{line}</div>}
          <div className="voice-row">
            <button className="voice-btn" onClick={discard} disabled={state !== 'confirm'}>Discard</button>
            <button className="voice-btn" onClick={keepTalking} disabled={state !== 'confirm' || frozen || heard.length >= MAX_CHARS - 100}>Keep talking</button>
          </div>
          <button className="voice-btn voice-btn-send" onClick={send} disabled={state !== 'confirm' || !heard || !armed || tooLong}>
            {state === 'sending' ? 'Sending…' : stale ? 'Send anyway (may send twice)' : draft.status === 'uncertain' ? 'Send again' : 'Send'}
          </button>
        </div>
      )}

      {!cardOpen && state !== 'locked' && (
        <button
          className={`voice-fab voice-${recording ? 'recording' : state}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
          onLostPointerCapture={onCancel}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="Hold to talk, double-tap for hands-free"
        >
          <span aria-hidden="true">🎙</span>
        </button>
      )}
    </>
  );
}
