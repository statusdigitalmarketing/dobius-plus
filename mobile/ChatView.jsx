import { useState, useEffect, useRef, useCallback, useMemo, memo, createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import SpecialKeys from './SpecialKeys';
import remarkGfm from 'remark-gfm';
import { pairingKey } from './pairings';
import { normalizeBlocks, rowText, rowKeys, unseenSince, markLatest, selectorKey as selectorCardKey, tokenFingerprint, createPressGuard, stepImages, createImageCache, stepSummary } from '../shared/chat-rows.js';
import { SPIN_FRAMES, SPIN_MS, normalizeActivity, liveSeconds, activityMeta } from '../shared/chat-activity.js';

// One chat bubble. Assistant messages render as MARKDOWN (tables, code
// blocks, lists were showing as raw pipes/asterisks: Sam's v1.0.53 report);
// user messages stay literal text so pasted code/paths are never mangled.
// memo'd so the 3.5s transcript poll only re-parses bubbles whose content
// actually changed, not all 200.
// Per-tab input drafts, persisted so navigating Board -> tab -> Board -> tab
// never eats typed-but-unsent text (Sam's report). One localStorage key holds
// a { tabId: { text, at } } map, pruned to 40 entries / 7 days on write.
const DRAFTS_KEY = 'dobius-mobile-drafts';

// A multi-select option row ("[ ] Foo", "☐ Foo"): its keys row stays open.
const MULTI_OPTION = /^(\[[ x✓✔]\]|[☐☒])\s/;
// A permission prompt reads "Bash command / <command> / <description> / Do you
// want to proceed?": the tool goes in the eyebrow, the command in a code box,
// the description under it, and only the question is the heading.
function promptParts(text) {
  const rows = String(text || '').split('\n').map((r) => r.trim()).filter(Boolean);
  const question = rows.pop() || '';
  // A tool label is one or two words ending in a tool noun ("Bash command",
  // "Edit file"); "Delete the existing Makefile" is a question (Codex P2).
  const tool = rows.length > 1 && /^[A-Z]\w*( \w+)?$/.test(rows[0]) && /\b(command|file|edit|write|read|fetch|search|tool)$/i.test(rows[0]) ? rows.shift() : '';
  return { tool, context: rows, question, code: /command$/i.test(tool) };
}
function AskPrompt({ text }) {
  const { context, question, code } = promptParts(text);
  return (
    <>
      {context.length > 0 && (
        <div className="ask-context">
          {context.map((r, i) => <div key={i} className={code && i === 0 ? 'ask-code' : 'ask-context-row'}>{r}</div>)}
        </div>
      )}
      <div className="ask-question">{question || 'Claude is waiting for you to choose:'}</div>
    </>
  );
}

// Claude's "Review your answers" step: each question (● row) with its answer
// (→ row) as a quiet list, and the closing question as the card's heading.
function AskReview({ text }) {
  const rows = text.split('\n').map((r) => r.trim()).filter(Boolean);
  const heading = rows.length && !/^[●→]/.test(rows[rows.length - 1]) ? rows.pop() : 'Ready to submit your answers?';
  let kind = null; // the marked row a wrapped continuation belongs to
  return (
    <>
      <div className="ask-review">
        {rows.map((r, i) => {
          if (r.startsWith('●')) { kind = 'q'; return <div key={i} className="ask-review-q">{r.replace(/^●\s*/, '')}</div>; }
          if (r.startsWith('→')) { kind = 'a'; return <div key={i} className="ask-review-a">{r.replace(/^→\s*/, '')}</div>; }
          // A row after a question or answer continues it: shown as written,
          // never as an eyebrow (that would uppercase a path: Codex P2, twice).
          if (kind) return <div key={i} className={`ask-review-${kind} ask-review-more`}>{r}</div>;
          return <div key={i} className="ask-eyebrow">{r}</div>;
        })}
      </div>
      <div className="ask-question">{heading}</div>
    </>
  );
}

// The question tabs a newer Mac sends ({ labels, answered, current, total }),
// checked field by field: an older or newer Mac may send something else.
function askSteps(st) {
  if (!st || typeof st !== 'object' || !Array.isArray(st.labels) || !st.labels.length) return null;
  // All or nothing: dropping one bad label would shift every index after it.
  if (!st.labels.every((l) => typeof l === 'string')) return null;
  const labels = st.labels.map((l) => l.slice(0, 60));
  const total = labels.length;
  if (st.total !== undefined && st.total !== total) return null; // inconsistent: trust none of it
  if (!Number.isInteger(st.current) || st.current < 0 || st.current > total) return null;
  return { labels, total, current: st.current };
}
function loadDraft(draftsKey, tabId) {
  if (!tabId) return '';
  try {
    const map = JSON.parse(localStorage.getItem(draftsKey) || '{}');
    return typeof map[tabId]?.text === 'string' ? map[tabId].text : '';
  } catch { return ''; }
}
function storeDraft(draftsKey, tabId, text) {
  if (!tabId) return;
  try {
    const map = JSON.parse(localStorage.getItem(draftsKey) || '{}');
    if (text) map[tabId] = { text, at: Date.now() };
    else delete map[tabId];
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const entries = Object.entries(map)
      .filter(([, v]) => v && typeof v.text === 'string' && (v.at || 0) > cutoff)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, 40);
    localStorage.setItem(draftsKey, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* private mode / quota: drafts just stay session-local */ }
}

// Copy text on a phone. navigator.clipboard needs a secure context (the PWA
// is https over Tailscale when the cert exists); the execCommand fallback
// covers the plain-http tailnet mode.
function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

// A copy affordance on code boxes (Sam, 8/14: "anything that shows up in this
// box ... I need a little copy button so I can just copy that line").
// The copy glyph the Claude app uses under a reply (two overlapping sheets).
const COPY_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />
  </svg>
);
const CHECK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

function CopyBtn({ text, className = 'md-copy', icon = false }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`${className}${done ? ' done' : ''}`}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(text);
        setDone(!!ok);
        setTimeout(() => setDone(false), 1500);
      }}
      aria-label={done ? 'Copied' : 'Copy'}
    >
      {icon ? (done ? CHECK_ICON : COPY_ICON) : done ? 'copied' : 'copy'}
    </button>
  );
}

// Plain text of a react-markdown node's children (what the user sees, which
// is what copy should copy).
function nodeText(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node.props?.children != null) return nodeText(node.props.children);
  return '';
}

// A message this long starts clamped with "Show more" (Sam: "no way to
// collapse long ass chat messages"). Counted from the text, not measured, so
// the decision is made before paint and never flickers.
const LONG_CHARS = 1500;
const LONG_LINES = 16;
function isLong(text) {
  if (text.length > LONG_CHARS) return true;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1 && lines <= LONG_LINES; i = text.indexOf('\n', i + 1)) lines += 1;
  return lines > LONG_LINES;
}

// The body of a skill behind a "/name" row: a few dim lines, tap to read the
// whole skill. Sam wants the preview kept, just out of the way.
function SkillPreview({ detail, label = 'skill' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-skill">
      <div className={open ? 'chat-skill-full' : 'chat-skill-peek'}>{detail}</div>
      <button className="chat-more" onClick={() => setOpen((o) => !o)}>{open ? `Hide ${label}` : `Show ${label}`}</button>
    </div>
  );
}

// Markdown overrides for Claude's text, shared by plain replies and the text
// blocks of a typed turn.
const mdComponents = {
  // Wide tables scroll inside their own container on a phone.
  table: ({ node: _node, ...props }) => (
    <div className="md-table-wrap"><table {...props} /></div>
  ),
  // Fenced blocks get a copy button; the box scrolls sideways instead of
  // truncating a long one-liner.
  pre: ({ node: _node, children, ...props }) => (
    <div className="md-pre-wrap">
      <CopyBtn text={nodeText(children)} />
      <pre {...props}>{children}</pre>
    </div>
  ),
  // Inline code deliberately gets NO chip: react-markdown v10 exposes no
  // reliable inline test (a no-language fenced block also has no className,
  // and wrapping it doubled the copy button inside its own pre: Codex High).
  // Long inline spans scroll via CSS instead; fenced blocks carry the button.
};

// --- Typed transcript blocks (main's opt-in { blocks } rows) ----------------
// Tool calls and thinking render as quiet one-line steps that open on tap, so
// a turn reads like the reply, not like the terminal. Same shapes as desktop.
function DiffView({ diff }) {
  const lines = (s, sign) => (s ? s.split('\n').map((l, i) => <div key={sign + i} className={`chat-diff-${sign === '-' ? 'del' : 'add'}`}>{sign} {l}</div>) : null);
  return <div className="chat-diff">{lines(diff.old, '-')}{lines(diff.new, '+')}</div>;
}

function StepRow({ block, live }) {
  const [open, setOpen] = useState(false);
  const isTool = block.type === 'tool';
  // No result yet: running only in the turn Claude is on now; in an older
  // turn the result simply fell outside the window.
  const state = !isTool ? 'think' : block.isError ? 'err' : block.result !== undefined ? 'ok' : live ? 'running' : 'pending';
  return (
    <div className="chat-step">
      <button className="chat-step-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`chat-step-dot ${state}`} />
        <span className="chat-step-name">{isTool ? block.name : 'Thinking'}</span>
        {isTool && block.summary && <span className="chat-step-sum">{block.summary}</span>}
        <span className="chat-step-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="chat-step-body">
          {!isTool && <div className="chat-step-think">{block.text}</div>}
          {block.diff && <DiffView diff={block.diff} />}
          {block.input && <pre className="chat-step-pre">{block.input}</pre>}
          {isTool && block.result !== undefined && (
            <pre className={`chat-step-pre out${block.isError ? ' err' : ''}`}>{block.result || '(no output)'}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// A run of steps reads as one line, the way the Claude app shows it:
// "Created a file, ran a command  +12 -0  >". Tap to see each step.
function StepGroup({ steps, live }) {
  const [open, setOpen] = useState(false);
  // Claude can run several tools in parallel, so every step of the live run
  // that has no result yet is running, not only the last one (Codex).
  const running = live && steps.some((b) => b.type === 'tool' && b.result === undefined);
  const failed = steps.some((b) => b.isError);
  const sum = useMemo(() => stepSummary(steps), [steps]);
  return (
    <div className={`chat-steps${open ? ' open' : ''}`}>
      <button className="chat-run" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`chat-run-icon${running ? ' running' : failed ? ' err' : ''}`} aria-hidden="true">
          {running ? '' : failed ? '!' : <span className="chat-run-list"><i /><i /><i /></span>}
        </span>
        <span className="chat-run-text">{running ? `${sum.text}…` : sum.text}</span>
        {(sum.added > 0 || sum.removed > 0) && (
          <span className="chat-run-diff"><span className="add">+{sum.added}</span><span className="del">-{sum.removed}</span></span>
        )}
        <span className="chat-run-caret" aria-hidden="true">›</span>
      </button>
      {open && <div className="chat-run-steps">{steps.map((b, i) => <StepRow key={i} block={b} live={live} />)}</div>}
    </div>
  );
}

// The chat's image fetch (ref -> Promise<data URL | null>), over the socket.
const ImageFetch = createContext(null);
// Called when a thumbnail finishes loading: it is taller than its placeholder,
// so a reader pinned to the bottom is kept there (Codex P2).
const ImageLoaded = createContext(null);
let imageReqSeq = 0; // module-scoped: survives remounts, ids never repeat on a connection

// Thumbnails of the images a run of steps returned (a screenshot Claude read),
// shown even while the steps are folded; tap for full screen.
function ToolImages({ images }) {
  const fetchImage = useContext(ImageFetch);
  const onLoaded = useContext(ImageLoaded);
  const [urls, setUrls] = useState({});
  const [failed, setFailed] = useState({});
  const [big, setBig] = useState(null);
  // What is shown is never fetched again (a poll hands in new arrays, and the
  // cache may have evicted it: Codex), and a miss retries a few times (a
  // reconnect can swallow a reply) before it says so.
  const loaded = useRef({});
  const tries = useRef({});
  const fetcherRef = useRef(null);
  useEffect(() => {
    let live = true;
    const timers = [];
    if (!fetchImage) return undefined;
    // A new fetcher (a reconnect) gets a fresh retry budget.
    if (fetcherRef.current !== fetchImage) { fetcherRef.current = fetchImage; tries.current = {}; setFailed({}); }
    const get = (ref) => {
      if (loaded.current[ref]) return;
      fetchImage(ref).then((url) => {
        if (!live) return;
        if (url) { loaded.current[ref] = true; setUrls((cur) => ({ ...cur, [ref]: url })); return; }
        tries.current[ref] = (tries.current[ref] || 0) + 1;
        if (tries.current[ref] < 3) timers.push(setTimeout(() => get(ref), 4000 * tries.current[ref]));
        else setFailed((cur) => ({ ...cur, [ref]: true }));
      });
    };
    for (const i of images) get(i.ref);
    return () => { live = false; timers.forEach(clearTimeout); };
  }, [images, fetchImage]);
  return (
    <div className="chat-imgs">
      {images.map((i) => (urls[i.ref]
        ? <button key={i.ref} type="button" className="chat-img" onClick={(e) => setBig({ url: urls[i.ref], from: e.currentTarget })} aria-label="Open image"><img src={urls[i.ref]} alt="Tool output" onLoad={onLoaded || undefined} /></button>
        : <div key={i.ref} className={`chat-img ${failed[i.ref] ? 'failed' : 'loading'}`}>{failed[i.ref] ? 'Image unavailable' : null}</div>))}
      {big && <Lightbox url={big.url} onClose={() => { const from = big.from; setBig(null); from?.focus?.(); }} />}
    </div>
  );
}

// Full size, modal: it takes focus and keeps it (Tab cannot reach the chat or
// a selector card behind it, Codex), Escape/Enter or a click/tap closes it.
function Lightbox({ url, onClose }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  // Rendered on <body>: inside a collapsed message, the clamp's mask would
  // crop a fixed overlay to the message (Codex P2).
  return createPortal(
    <div
      ref={ref}
      className="chat-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Image"
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); onClose(); } else if (e.key === 'Tab') e.preventDefault();
      }}
    >
      <img src={url} alt="Tool output, full size" />
      <span className="chat-lightbox-close">✕</span>
    </div>,
    document.body,
  );
}

function Blocks({ blocks, live }) {
  const parts = [];
  let run = [];
  // Only the run of steps that ENDS the turn can still be running.
  const flush = (atEnd) => {
    if (!run.length) return;
    parts.push(<StepGroup key={`s${parts.length}`} steps={run} live={live && atEnd} />);
    const images = stepImages(run);
    if (images.length) parts.push(<ToolImages key={`i${parts.length}`} images={images} />);
    run = [];
  };
  for (const b of blocks) {
    if (b.type === 'text') {
      flush(false);
      parts.push(<ReactMarkdown key={`t${parts.length}`} remarkPlugins={[remarkGfm]} components={mdComponents}>{b.text}</ReactMarkdown>);
    } else run.push(b);
  }
  flush(true);
  return parts;
}

// Claude's spinner line, live, as the terminal shows it: the glyph cycle, the
// gerund it picked for this turn ("Whirlpooling"), then the clock and token
// meter. The clock counts on from when the reading arrived. An older Mac sends
// no activity: the glyph still spins and the clock counts from first sight.
const REDUCE_MQ = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const Activity = memo(function Activity({ activity }) {
  const reduce = !!REDUCE_MQ?.matches;
  const [tick, setTick] = useState(0);
  const sec = activity?.seconds ?? null;
  const rx = activity?.rxAt ?? null;
  const [anchor, setAnchor] = useState(() => ({ at: rx || Date.now(), seconds: sec }));
  useEffect(() => { if (sec != null) setAnchor({ at: rx || Date.now(), seconds: sec }); }, [sec, rx]);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), reduce ? 1000 : SPIN_MS);
    return () => clearInterval(iv);
  }, [reduce]);
  const verb = activity?.verb || 'Working';
  const meta = activityMeta(liveSeconds(anchor, Date.now()), activity);
  return (
    <div className="chat-activity">
      <span className="chat-act-dots" aria-hidden="true"><i /><i /><i /></span>
      {meta && <span className="chat-act-meta" aria-hidden="true">{meta} ·</span>}
      <span className="chat-act-text" role="status">
        <span key={verb} className="chat-act-verb">{`${verb.toLowerCase()}\u2026`}</span>
      </span>
      <span className="chat-act-glyph" aria-hidden="true">{reduce ? '\u273b' : SPIN_FRAMES[tick % SPIN_FRAMES.length]}</span>
    </div>
  );
});

const Bubble = memo(function Bubble({ role, content, timestamp, queued, sending, command, detail, detailLabel, blocks: rawBlocks, startOpen, live }) {
  const blocks = useMemo(() => (role === 'assistant' ? normalizeBlocks(rawBlocks) : null), [role, rawBlocks]);
  const text = String(content ?? '');
  const shown = rowText(text, blocks); // what the reader sees, and what Copy copies
  const long = !command && isLong(shown);
  const [open, setOpen] = useState(!long || !!startOpen);
  const body = (
    <div className={`chat-content${long && !open ? ' clamped' : ''}${command ? ' chat-cmd' : ''}`}>
      {role === 'assistant'
        ? (blocks ? <Blocks blocks={blocks} live={!!live} /> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown>)
        : text}
    </div>
  );
  const more = long && <button className="chat-more" onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Show more'}</button>;
  if (role !== 'assistant') {
    // Yours: a right-aligned bubble, its state (queued, sending) underneath.
    return (
      <div className={`chat-msg user${sending ? ' chat-echo' : ''}`}>
        <div className="chat-bubble">{body}{more}</div>
        {command && detail && <SkillPreview detail={detail} label={detailLabel || 'skill'} />}
        {(queued || sending) && <div className="chat-msg-state">{sending ? 'Sending…' : 'Queued for after this turn'}</div>}
      </div>
    );
  }
  return (
    <div className="chat-msg assistant">
      {body}
      {more}
      {/* Quiet actions under a reply, like the Claude app: copy, and the time. */}
      {(shown || timestamp != null) && (
        <div className="chat-msg-actions">
          {shown && <CopyBtn text={shown} className="chat-msg-copy" icon />}
          {timestamp != null && <span className="chat-time">{fmtMsgTime(timestamp)}</span>}
        </div>
      )}
    </div>
  );
});

/**
 * Responsive conversation view for a session on mobile. Instead of mirroring the
 * width-locked raw terminal (a full-screen TUI drawn at the desktop's ~200 cols,
 * which shreds when squeezed onto a phone), this renders the session's TRANSCRIPT
 * as reflowing chat bubbles, and sends typed input straight to the PTY. The
 * desktop terminal is never resized or touched. Live-ish: it re-requests the
 * transcript on a short poll so new turns appear as Claude writes them.
 */
export default function ChatView({ connection, tab, onOpenTerminal }) {
  const sessionId = tab?.sessionId || null;
  const projectPath = tab?.sessionProject || null;
  const tabId = tab?.id || null;
  // Tool images: requested over the socket only when a thumbnail shows, cached
  // per session. A Mac too old to answer just leaves the placeholder.
  // A fresh cache per (re)connection: images that failed while the socket was
  // down get fetched again once it is back (Codex P2).
  const [authEpoch, setAuthEpoch] = useState(0);
  const imageFetch = useMemo(() => {
    if (!sessionId || !projectPath) return null;
    // One request at a time: the Mac refuses an image while its send buffer
    // is still full of the last one, so parallel requests refused each other
    // in lockstep until their retries ran out (Codex P2).
    let queue = Promise.resolve();
    const one = (ref) => new Promise((resolve) => {
      if (connection.closed) { resolve(null); return; }
      const reqId = ++imageReqSeq;
      let off = () => {};
      const t = setTimeout(() => { off(); resolve(null); }, 20000);
      off = connection.onMessage((msg) => {
        if (msg?.type !== 'chatImage' || msg.reqId !== reqId) return;
        off();
        clearTimeout(t);
        resolve(msg.ok && typeof msg.data === 'string' ? { mime: msg.mime, data: msg.data } : null);
      });
      connection.send({ type: 'chatImage', sessionId, projectPath, ref, reqId });
    });
    return createImageCache((ref) => {
      const run = queue.then(() => one(ref));
      queue = run.then(() => undefined, () => undefined);
      return run;
    });
  }, [connection, sessionId, projectPath, authEpoch]); // eslint-disable-line react-hooks/exhaustive-deps -- authEpoch only renews the cache
  const [messages, setMessages] = useState(null); // null = loading
  const draftsKey = pairingKey(connection.pairing, DRAFTS_KEY);
  const [input, setInput] = useState(() => loadDraft(draftsKey, tabId));
  // Draft-aware setter: accepts a value or updater fn, mirrors to localStorage.
  const setDraft = useCallback((next) => {
    setInput((cur) => {
      const v = typeof next === 'function' ? next(cur) : next;
      storeDraft(draftsKey, tabId, v);
      return v;
    });
  }, [draftsKey, tabId]);
  // Rehydrate when this view is reused for a DIFFERENT tab (tabId prop swap).
  useEffect(() => { setInput(loadDraft(draftsKey, tabId)); }, [draftsKey, tabId]);
  // Interactive selector Claude is currently showing (permission prompt, plan
  // approval, AskUserQuestion). null = none. Detected server-side from the live
  // PTY buffer because these TUI prompts are NOT in the transcript. Display is
  // parser-driven, NOT gated on the hook-driven 'needs' status: AskUserQuestion
  // doesn't reliably fire the Notification hook, so the old status gate kept
  // question popups from ever appearing (Sam's v1.0.51 bug 1). Staleness is the
  // parser's job (trailing-prose rejection) plus the server's post-answer
  // re-push and the optimistic clear in chooseOption.
  const [selector, setSelector] = useState(null);
  // The card carries the token it was read with (`selector.token`): the Mac
  // answers a tap only while nothing reached the tab since that read. A tap
  // reads the token from the card it was rendered with, never from a ref a
  // newer card has already overwritten (Codex Critical: a tap on card A sent
  // with prompt B's valid token). null = an older Mac with no tokens: taps
  // fall back to a bare 'input' write. selBusy disables the card while a tap
  // is in flight or the screen is still moving.
  const [selBusy, setSelBusy] = useState(false);
  const tappedRef = useRef(null); // the card object the in-flight tap came from
  const selRetryRef = useRef(null); // the one pending unsettled re-probe
  // Which card each tap / key press began on (see createPressGuard).
  const pressGuard = useRef(null);
  if (!pressGuard.current) pressGuard.current = createPressGuard();
  // Releases are watched on the window: a press can end outside the card.
  useEffect(() => {
    const g = pressGuard.current;
    const onUp = (e) => g.pointerUp(e);
    const onKeyUp = (e) => g.keyUp(e);
    const onBlur = () => g.reset();
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  const [selNote, setSelNote] = useState('');
  // Question card: the fine-control key row is folded away unless asked for
  // (or the prompt is a multi-select), and the close button needs a second
  // tap, because Esc cancels Claude's whole question.
  const [askKeys, setAskKeys] = useState(false);
  // The card key the cancel was armed on: a different card is never armed
  // (the Mac can answer and show another question inside the 3s window).
  const [cancelArmedKey, setCancelArmedKey] = useState(null);
  // Arming ends the moment the phone sees anything but the card it was armed
  // on (no card, or another one): on a Mac that sends no tokens a LATER card
  // that reads the same would otherwise inherit it (Codex P1, twice).
  useEffect(() => {
    const key = selector ? `${selectorCardKey(selector)}|${selector.token ?? ''}` : null;
    setCancelArmedKey((armed) => (armed && armed !== key ? null : armed));
  }, [selector]);
  // Stop takes Send's place the moment a message goes out while Claude works,
  // so a double tap on Send would land on Stop and interrupt (Codex P1).
  const sentAtRef = useRef(0);
  // Sessionless tabs only: plain-text tail of the live PTY (null = loading).
  const [shellText, setShellText] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  // Local echoes: a just-sent message renders IMMEDIATELY instead of waiting
  // for the transcript poll (a mid-turn send used to look eaten: it sat in
  // Claude's queue and never appeared here; the server now also surfaces
  // queued entries). An echo drops once the transcript shows the same text,
  // or after 90s (e.g. the tab was a bare shell that ran it as a command).
  const [echoes, setEchoes] = useState([]);
  // On-screen terminal keys row (esc/tab/arrows/^C) for full-TUI dialogs.
  const [showKeys, setShowKeys] = useState(false);
  const fileInputRef = useRef(null);
  const bodyRef = useRef(null);
  const atBottomRef = useRef(true);
  const keepBottom = useCallback(() => {
    const el = bodyRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, []);
  // Rows that arrived (or a live turn that grew) while scrolled up, for the
  // "new" pill; the mark is the newest row seen at the bottom.
  const [unseen, setUnseen] = useState(0);
  const seenKeyRef = useRef(null);
  const jumpingRef = useRef(false); // a smooth jump to the latest is in flight
  const lastTopRef = useRef(0);
  const jumpGenRef = useRef(0);
  const preJumpMarkRef = useRef(null); // the reading mark before the last jump
  // Track the session we asked for so an out-of-order reply for a different
  // session (or a stale poll after switching tabs) can't render here.
  const wantRef = useRef(null);
  // Consecutive empty replies, to debounce clearing: a single transient empty
  // shouldn't blank a live conversation, but a persistent empty (transcript
  // reset/deleted) should. Resolves the transient-vs-real tension.
  const emptyStreakRef = useRef(0);

  // Sig of the transcript payload we already hold; echoed to the server so an
  // unchanged file gets a ~100-byte reply instead of the full payload again.
  const sigRef = useRef(null);

  const request = useCallback(() => {
    if (!sessionId || !projectPath) return;
    wantRef.current = sessionId;
    // limit = number of recent messages; the server does a cheap overscanning
    // tail read, so polling a huge transcript stays light.
    // tabId authorizes this socket to send input to the tab (server gates
    // input/kill on the socket's touched-tab set, and the Chat view never
    // attaches). Audit Medium.
    connection.send({ type: 'loadTranscript', sessionId, projectPath, tabId, limit: 200, blocks: 1, sig: sigRef.current || undefined });
  }, [connection, sessionId, projectPath, tabId]);

  // Ask the server whether the tab's live PTY is showing a selection prompt.
  const probeSelector = useCallback(() => {
    if (tabId) connection.send({ type: 'selectorSnapshot', id: tabId });
  }, [connection, tabId]);

  useEffect(() => {
    setMessages(null);
    emptyStreakRef.current = 0;
    sigRef.current = null; // new session: never claim we hold its payload
    if (!sessionId || !projectPath) return undefined;
    request();
    const poll = setInterval(request, 3500); // live-ish: pick up new turns
    return () => clearInterval(poll);
  }, [sessionId, projectPath, request]);

  // Probe for a selector on a steady interval while this tab's chat is open.
  // Cheap server-side (strip + regex over the rolling PTY tail). Clear on tab
  // switch so another tab's buttons never flash here.
  useEffect(() => {
    setSelector(null);
    tappedRef.current = null;
    setSelBusy(false);
    setSelNote('');
    if (!tabId) return undefined;
    probeSelector();
    const iv = setInterval(probeSelector, 2500);
    return () => {
      clearInterval(iv);
      clearTimeout(selRetryRef.current);
      selRetryRef.current = null;
    };
  }, [tabId, probeSelector]);

  // Poll a plain-text tail of the live PTY whenever we have no conversation to
  // render: a bare shell (Asana 1217257328849820) OR a tab whose Claude is
  // live but whose transcript we cannot resolve (Brett v1.0.56: "No messages
  // yet" on tabs that clearly had chats). Stops once messages exist.
  const needShell = !sessionId || (messages !== null && messages.length === 0);
  // The newest Claude reply stays open even when long: it is what you came to read.
  const lastClaude = messages ? messages.findLastIndex((m) => m.role === 'assistant') : -1;
  const messageKeys = useMemo(() => (messages ? rowKeys(messages) : []), [messages]);
  const messagesRef = useRef(messages); // the rows now, for timers
  messagesRef.current = messages;
  const working = tab?.status === 'working';
  const activity = working ? normalizeActivity(tab?.activity) : null;
  if (activity && typeof tab?.activity?.rxAt === 'number') activity.rxAt = tab.activity.rxAt;
  useEffect(() => {
    setShellText(null);
    if (!needShell || !tabId) return undefined;
    const ask = () => connection.send({ type: 'terminalText', id: tabId });
    ask();
    const iv = setInterval(ask, 3000);
    return () => clearInterval(iv);
  }, [connection, needShell, tabId]);

  // Track the skills catalog in a ref too: the authed handler below lives in
  // an effect keyed on [connection] and must not close over stale state.
  const skillsRef = useRef(null);
  const skillsRequestedRef = useRef(false);

  useEffect(() => {
    const off = connection.onMessage((msg) => {
      if (msg.type === 'authed') {
        setAuthEpoch((n) => n + 1);
        // Reconnect (iOS kills the socket on every backgrounding). Two jobs,
        // both BEFORE the connection's queued-send flush (emit runs listeners
        // synchronously, then flushes):
        // 1. Re-authorize this tab server-side: the fresh socket has an empty
        //    _authedTabs, so a queued submitPrompt/input flushed first would
        //    hit the server's tab guard and vanish, which is the swallow bug
        //    wearing a new hat (Codex High). selectorSnapshot both authorizes
        //    and refreshes the popup state.
        // 2. Re-request the skills catalog if the first request died with the
        //    old socket (listSkills is a read, deliberately not queueable).
        if (tabId) connection.send({ type: 'selectorSnapshot', id: tabId });
        if (skillsRequestedRef.current && skillsRef.current === null) {
          connection.send({ type: 'listSkills' });
        }
      } else if (msg.type === 'transcript' && msg.sessionId === wantRef.current
          && (msg.projectPath == null || msg.projectPath === projectPath)
          // A History reply for this session (plain rows) shares the socket
          // and the sig; only a blocks reply is ours. Older Macs omit the key.
          && (!('blocks' in msg) || msg.blocks === true)) {
        if (msg.unchanged) {
          // File identical to what we hold: keep messages as-is, but still
          // age out echo bubbles (their 90s TTL must not depend on the
          // transcript changing).
          setEchoes((cur) => {
            if (cur.length === 0) return cur;
            const now = Date.now();
            const kept = cur.filter((e) => now - e.at < 90_000);
            return kept.length === cur.length ? cur : kept;
          });
          return;
        }
        // Claim the sig ONLY for a non-empty payload (below): claiming it for
        // an empty parse would freeze the empty-streak debounce (server says
        // unchanged forever, streak never reaches 2, stale messages pinned;
        // Codex High).
        const next = msg.entries || [];
        // Prune echoes the transcript now covers (same trimmed text, queued or
        // real) and any older than 90s.
        setEchoes((cur) => {
          if (cur.length === 0) return cur;
          // Normalize the `!` composer prefix on BOTH sides: the transcript
          // records a bash command as <bash-input>cmd</bash-input>, which the
          // server collapses to "! cmd", while the user may have typed
          // "!cmd" or "!  cmd". Without this the echo never matched and the
          // bubble sat on "sending…" for a command that had already run.
          const norm = (t) => {
            const s2 = String(t).trim();
            return s2.startsWith('!') ? `! ${s2.slice(1).trim()}` : s2;
          };
          const seen = new Set(next.filter((m) => m.role === 'user').map((m) => norm(m.content)));
          const now = Date.now();
          const kept = cur.filter((e) => !seen.has(norm(e.content)) && now - e.at < 90_000);
          return kept.length === cur.length ? cur : kept;
        });
        if (next.length > 0) {
          emptyStreakRef.current = 0;
          sigRef.current = msg.sig || null;
          setMessages(next);
        } else {
          emptyStreakRef.current += 1;
          sigRef.current = null;
          // Clear on first load / already-empty, or once an empty PERSISTS (a
          // real reset). A single transient empty after real content is kept, so
          // the chat doesn't flicker to "No messages yet". Codex.
          setMessages((prev) => (!prev || prev.length === 0 || emptyStreakRef.current >= 2 ? [] : prev));
        }
      } else if (msg.type === 'selector' && msg.id === tabId) {
        if (msg.unsettled) {
          // The tab is mid-repaint: keep the card, disabled, and ask again,
          // with at most one re-probe pending (the 2.5s poll keeps going too).
          setSelBusy(true);
          if (!selRetryRef.current) {
            selRetryRef.current = setTimeout(() => {
              selRetryRef.current = null;
              connection.send({ type: 'selectorSnapshot', id: tabId });
            }, 600);
          }
        } else {
          const sel = msg.selector && Array.isArray(msg.selector.options) ? msg.selector : null;
          setSelector(sel ? { ...sel, token: 'token' in msg ? (msg.token || '') : null, fp: tokenFingerprint(msg.token) } : null);
          setSelBusy(false);
        }
      } else if (msg.type === 'selectorKeyResult' && msg.id === tabId) {
        if (msg.ok) {
          // The next key on THIS prompt (an arrow, then Enter) uses the fresh
          // token, but only if the card on screen is still the one tapped.
          const tapped = tappedRef.current;
          setSelector((cur) => (cur && cur === tapped ? { ...cur, token: msg.token || '' } : cur));
        } else {
          setSelNote(msg.stale ? 'The prompt changed before your tap landed. Nothing was sent, check the card again.' : 'Could not send that. Nothing was sent.');
          setTimeout(() => setSelNote(''), 4000);
        }
        // Either way the server's follow-up read (or the next probe) re-arms it.
        setTimeout(() => connection.send({ type: 'selectorSnapshot', id: tabId }), msg.ok ? 700 : 0);
      } else if (msg.type === 'terminalText' && msg.id === tabId) {
        setShellText(typeof msg.text === 'string' ? msg.text : '');
      }
    });
    return off;
  }, [connection, projectPath, tabId]);

  // Auto-scroll to the newest message, but only if the user was already at the
  // bottom (don't yank them up while they scroll back through history).
  useEffect(() => {
    const el = bodyRef.current;
    if (el && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      // This instant write lands the jump (it cancels a smooth scroll), and
      // the reader's next scroll must be measured from HERE, or a scroll up
      // from the bottom reads as "down" against an older position (Codex).
      jumpingRef.current = false;
      lastTopRef.current = el.scrollTop;
    }
    const rows = messages || [];
    if (atBottomRef.current || !messageKeys.length) {
      seenKeyRef.current = markLatest(rows, messageKeys);
      setUnseen(0);
      return;
    }
    // No mark (a new session loaded in this tab while the reader was scrolled
    // up): none of it was seen, so say so until they reach the bottom
    // (Codex Medium, twice: a null mark used to hide the pill for good).
    setUnseen(seenKeyRef.current ? unseenSince(rows, messageKeys, seenKeyRef.current) : -1);
  }, [messages, messageKeys, echoes, shellText]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    // A smooth jump passes through scroll positions above the bottom; they
    // must not count as the reader scrolling back up. The hold ends when the
    // jump lands or the reader scrolls UP during it (a timer alone kept a
    // real upward scroll counted as "at bottom": Codex Medium).
    if (jumpingRef.current && (near || el.scrollTop < lastTopRef.current)) {
      jumpingRef.current = false;
      // Cut short by the reader before it reached the new rows: they were
      // never seen, so the pill comes back (Codex Medium).
      if (!near) {
        seenKeyRef.current = preJumpMarkRef.current;
        setUnseen(preJumpMarkRef.current ? unseenSince(messages || [], messageKeys, preJumpMarkRef.current) : -1);
      }
    }
    lastTopRef.current = el.scrollTop;
    atBottomRef.current = jumpingRef.current || near;
    if (atBottomRef.current && unseen !== 0) {
      seenKeyRef.current = markLatest(messages || [], messageKeys);
      setUnseen(0);
    }
  };

  const jumpToLatest = () => {
    const el = bodyRef.current;
    if (!el) return;
    atBottomRef.current = true;
    // Seen on the tap itself: waiting for the scroll to land left the pill up
    // when the reply grew during the animation (Codex).
    preJumpMarkRef.current = seenKeyRef.current;
    seenKeyRef.current = markLatest(messages || [], messageKeys);
    setUnseen(0);
    const smooth = !REDUCE_MQ?.matches;
    // Only a smooth jump needs the hold; an instant one lands in one event.
    // If the animation is cut short with no further scroll events, re-read
    // the position rather than holding forever.
    jumpingRef.current = smooth;
    const gen = ++jumpGenRef.current;
    lastTopRef.current = el.scrollTop;
    if (smooth) {
      setTimeout(() => {
        // Only this jump's own hold: a later jump owns its own timer.
        if (gen !== jumpGenRef.current || !jumpingRef.current || !bodyRef.current) return;
        jumpingRef.current = false;
        const b = bodyRef.current;
        atBottomRef.current = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
        if (!atBottomRef.current) {
          seenKeyRef.current = preJumpMarkRef.current;
          setUnseen(preJumpMarkRef.current ? unseenSince(messagesRef.current || [], rowKeys(messagesRef.current || []), preJumpMarkRef.current) : -1);
        }
      }, 1500);
    }
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  // `/` skill autocomplete (v1.0.62): while the input is exactly a slash
  // command being typed, show matching skills with their descriptions; a tap
  // autofills. The catalog loads lazily on the first `/`.
  const [skills, setSkills] = useState(null); // null = no catalog yet
  useEffect(() => {
    const off = connection.onMessage((msg) => {
      if (msg.type === 'skills') {
        const list = Array.isArray(msg.list) ? msg.list : [];
        skillsRef.current = list;
        setSkills(list);
      }
    });
    return off;
  }, [connection]);
  useEffect(() => {
    // Request once per mount, and only on a live socket: a send fired while
    // disconnected is dropped (reads are deliberately not queueable), and the
    // old sentinel then blocked every retry, permanently disabling the picker
    // until remount (Codex Medium). The authed handler above retries.
    if (!skillsRequestedRef.current && /^\//.test(input) && connection.status === 'authed') {
      skillsRequestedRef.current = true;
      connection.send({ type: 'listSkills' });
    }
  }, [input, connection]);
  const slashMatch = input.match(/^\/([\w:-]*)$/);
  const suggestions = slashMatch && skills
    ? skills
      .filter((sk) => sk.name.toLowerCase().includes(slashMatch[1].toLowerCase()))
      .slice(0, 6)
    : [];

  const send = () => {
    const text = input.trim();
    if (!text || !tabId) return;
    // submitPrompt: the server bracketed-pastes the text, then presses Enter as
    // a DISCRETE keypress after the paste settles. Sending `text\r` in one
    // chunk made Claude's Ink TUI treat the \r as pasted newline, so messages
    // sat in the input box unsubmitted (Sam's v1.0.51 bug 3).
    connection.send({ type: 'submitPrompt', id: tabId, text });
    sentAtRef.current = Date.now();
    setEchoes((cur) => [...cur, { content: text, at: Date.now() }]);
    setDraft('');
    atBottomRef.current = true;
  };

  // Pick a selector option. Sends the ABSOLUTE option number the user tapped
  // (Claude's numbered prompts select on the digit key). Never relative arrows,
  // so a parse error in the cursor position can't select a DIFFERENT option than
  // the label. No trailing Enter, so a stray newline can't confirm a chained
  // prompt. Optimistically clear; the next probe reflects the real state.
  // Sends through the token guard when the Mac supports it, else the old bare
  // write. Returns false when the card is not answerable right now.
  const sendSelector = (card, data, e = null) => {
    if (!tabId || !card || selBusy) return false;
    const { token } = card;
    // A tap must END on the card it began on (shared createPressGuard).
    if (!pressGuard.current.take(e, card)) {
      setSelNote('The prompt changed while you were tapping. Nothing was sent, check the card again.');
      setTimeout(() => setSelNote(''), 4000);
      return false;
    }
    if (token === null || token === undefined) {
      connection.send({ type: 'input', id: tabId, data });
      return true;
    }
    if (!token) return false;
    tappedRef.current = card;
    setSelBusy(true);
    connection.send({ type: 'selectorKey', id: tabId, data, token });
    return true;
  };

  const chooseOption = (card, num, e) => {
    if (!sendSelector(card, String(num), e)) return;
    if (card.token == null) setSelector(null);
    atBottomRef.current = true;
  };

  // Fine-control keys for the selector (v1.0.53 UX): multiSelect prompts need
  // arrows to move, space to toggle, Enter to confirm, Esc to cancel; tapping a
  // digit alone can't finish those. Enter/Esc optimistically clear the popup
  // (the server re-push + probe restore it if a chained prompt follows).
  const SELECTOR_KEYS = [
    ['↑', '\x1b[A', false], ['↓', '\x1b[B', false], ['space', ' ', false],
    ['esc', '\x1b', true], ['enter', '\r', true],
  ];
  const sendSelectorKey = (card, seq, closes, e) => {
    if (!sendSelector(card, seq, e)) return;
    if (closes && card.token == null) setSelector(null);
  };

  // Upload a screenshot / file from the phone: POST the bytes, get back an
  // absolute temp path on the Mac, and append that path to the input so it
  // rides the normal submitPrompt (Claude Code reads local file paths, same
  // contract as the desktop clipboard-image flow). v1.0.53.
  const uploadFiles = async (files) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    setUploadMsg(''); // clear a stale error from a previous attempt (Codex Low)
    try {
      const paths = [];
      for (const f of [...files].slice(0, 5)) {
        // Always octet-stream: the server's raw parser accepts everything, and
        // a real JSON mime would otherwise be consumed by express.json (Codex).
        const res = await connection.request(`/upload?name=${encodeURIComponent(f.name || 'upload')}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: f,
        });
        const data = await res.json().catch(() => null);
        if (data?.ok && data.path) paths.push(data.path);
        else setUploadMsg(data?.error || `Upload failed (${res.status})`);
      }
      if (!connection.closed && paths.length) setDraft((cur) => `${cur}${cur && !cur.endsWith(' ') ? ' ' : ''}${paths.join(' ')} `);
    } catch {
      setUploadMsg('Upload failed (offline?)');
    } finally {
      setUploading(false);
    }
  };

  // No session linked yet: launch Claude in this tab's shell, or resume the
  // most recent conversation for this project (`claude --continue`). The
  // session link + transcript appear via the normal capture loop once Claude
  // starts. Previously this state was a dead end on mobile (Sam's v1.0.51
  // bug 2 + Asana 1217257328849820).
  const startClaude = () => {
    if (!tabId) return;
    connection.send({ type: 'submitPrompt', id: tabId, text: 'claude' });
  };
  const resumeClaude = () => {
    if (!tabId) return;
    connection.send({ type: 'submitPrompt', id: tabId, text: 'claude --continue' });
  };

  // Selector popup + input row are shared by BOTH states below: a sessionless
  // tab that just ran `claude` immediately shows the trust-folder prompt, so
  // the selector buttons must work there too.
  const selectorPopup = selector && selector.options && selector.options.length > 0 && (() => {
    const steps = askSteps(selector.steps);
    const cannotAnswer = selBusy || selector.token === '';
    // Claude's escape hatches are its exact tail: "Type something." then
    // optionally "Chat about this", last, with no description. Anything else
    // that shares a label is a real answer (Codex, twice).
    const opts = selector.options;
    const isHatch = (o, label) => o && !o.detail && o.label.toLowerCase() === label;
    let cut = opts.length;
    if (isHatch(opts[cut - 1], 'chat about this') && isHatch(opts[cut - 2], 'type something.')) cut -= 2;
    else if (isHatch(opts[cut - 1], 'type something.')) cut -= 1;
    const main = selector.options.slice(0, cut);
    const extra = selector.options.slice(cut);
    const multi = selector.options.some((o) => MULTI_OPTION.test(o.label));
    const onReview = steps && steps.current >= steps.total;
    // Armed for THIS card at THIS token: the token changes whenever anything
    // reaches the screen (moving to another question that reads the same,
    // a repaint), so the arming never carries over (Codex P1).
    const cardKey = `${selectorCardKey(selector)}|${selector.token ?? ''}`;
    const cancelArmed = cancelArmedKey === cardKey;
    const cancel = (e) => {
      if (!cancelArmed) {
        // Arming is a press too: it must end on the card it began on (Codex P1).
        if (!pressGuard.current.take(e, selector)) {
          setSelNote('The prompt changed while you were tapping. Nothing was sent, check the card again.');
          setTimeout(() => setSelNote(''), 4000);
          return;
        }
        setCancelArmedKey(cardKey);
        setTimeout(() => setCancelArmedKey((k) => (k === cardKey ? null : k)), 3000);
        return;
      }
      setCancelArmedKey(null);
      sendSelectorKey(selector, '\x1b', true, e);
    };
    return (
      <div
        className="ask-card"
        key={selectorCardKey(selector)}
        onPointerDownCapture={(e) => pressGuard.current.pointerDown(e, selector)}
        onKeyDownCapture={(e) => {
          // A held Enter auto-repeats as clicks: it must never confirm the
          // cancel or re-answer by itself (Codex P1).
          if (e.repeat && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); return; }
          pressGuard.current.keyDown(e, selector);
        }}
      >
        <div className="ask-head">
          {steps && steps.total > 1 ? (
            <div className="ask-stepper">
              {/* Claude's own question tabs: left/right arrows move between them. */}
              <button className="ask-nav" aria-label="Previous question" disabled={cannotAnswer || steps.current === 0}
                onClick={(e) => sendSelectorKey(selector, '\x1b[D', false, e)}>‹</button>
              <span className="ask-count">{onReview ? 'Review' : `${steps.current + 1} of ${steps.total}`}</span>
              <button className="ask-nav" aria-label="Next question" disabled={cannotAnswer || onReview}
                onClick={(e) => sendSelectorKey(selector, '\x1b[C', false, e)}>›</button>
            </div>
          ) : (
            <span className="ask-eyebrow">{steps?.labels[0] || promptParts(selector.prompt).tool || 'Claude needs your answer'}</span>
          )}
          <button className={`ask-close${cancelArmed ? ' armed' : ''}`} aria-label="Cancel this question"
            disabled={selector.token === ''} onClick={cancel}>{cancelArmed ? 'Cancel?' : '✕'}</button>
        </div>
        {steps && steps.total > 1 && !onReview && <div className="ask-eyebrow ask-topic">{steps.labels[steps.current]}</div>}
        {onReview ? <AskReview text={selector.prompt || ''} /> : steps ? (
          <div className="ask-question">{selector.prompt || 'Claude is waiting for you to choose:'}</div>
        ) : <AskPrompt text={selector.prompt} />}
        <div className="ask-options">
          {main.map((opt) => (
            <button key={opt.num} className="ask-opt" disabled={cannotAnswer} onClick={(e) => chooseOption(selector, opt.num, e)}>
              <span className="ask-opt-label">{opt.label}</span>
              {opt.detail && <span className="ask-opt-detail">{opt.detail}</span>}
            </button>
          ))}
        </div>
        {extra.length > 0 && (
          <div className="ask-extra">
            {extra.map((opt) => (
              <button key={opt.num} className="ask-extra-opt" disabled={cannotAnswer} onClick={(e) => chooseOption(selector, opt.num, e)}>
                {opt.label.replace(/\.$/, '')}
              </button>
            ))}
          </div>
        )}
        {(askKeys || multi) && (
          // Fine-control row: arrows/space for multiSelect movement + toggle,
          // enter/esc to confirm/cancel, without leaving Chat. v1.0.53.
          <div className="ask-keys">
            {SELECTOR_KEYS.map(([label, seq, closes]) => (
              <button key={label} className="ask-key" disabled={cannotAnswer} onClick={(e) => sendSelectorKey(selector, seq, closes, e)}>
                {label}
              </button>
            ))}
          </div>
        )}
        {cancelArmed && <div className="ask-note">Tap again to cancel Claude's question.</div>}
        {selNote && <div className="ask-note">{selNote}</div>}
        <div className="ask-foot">
          {!multi && <button className="ask-link" onClick={() => setAskKeys((v) => !v)}>{askKeys ? 'Hide keys' : 'Keys'}</button>}
          {onOpenTerminal && <button className="ask-link" onClick={onOpenTerminal}>Open terminal</button>}
        </div>
      </div>
    );
  })();

  const inputRow = (
    <>
      {uploadMsg && <div className="chat-upload-msg">{uploadMsg}</div>}
      {suggestions.length > 0 && (
        <div className="chat-skill-suggest">
          {suggestions.map((sk) => (
            <button key={`${sk.source}:${sk.name}`} className="chat-skill-row" onClick={() => { setDraft(`/${sk.name} `); }}>
              <span className="chat-skill-name">/{sk.name}</span>
              {sk.description && <span className="chat-skill-desc">{sk.description}</span>}
            </button>
          ))}
        </div>
      )}
      {/* On-screen terminal keys, for the full-TUI dialogs a popup cannot
          drive (/permissions and friends need arrows + enter + tab). */}
      {showKeys && tabId && (
        <SpecialKeys onKey={(seq) => connection.send({ type: 'input', id: tabId, data: seq })} />
      )}
      {/* One rounded composer, like the Claude app: the message on top, the
          tools underneath, and on the right Send, or Stop while Claude works
          and nothing is typed (Stop is Esc to the TUI: it interrupts the turn
          and pops queued messages back, v1.0.53). */}
      <div className="chat-composer">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
        />
        {/* Placeholder truth: a session-linked chat whose Claude has EXITED
            still sends input to the underlying shell, where it executes as a
            command (observed live 8/15: a prompt ran in zsh as `Reply ...`).
            Never claim "Message Claude" unless a Claude is actually attached;
            claudeLive comes from the tab's live process detection. */}
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          onPaste={(e) => {
            // Pasting an image (iOS long-press paste of a screenshot) uploads
            // it like the attach button; text pastes fall through untouched.
            const files = e.clipboardData?.files;
            if (files && files.length > 0) { e.preventDefault(); uploadFiles(files); }
          }}
          placeholder={sessionId
            ? (tab && !tab.claudeLive
              ? 'Claude exited. Input goes to the terminal...'
              : tab?.status === 'working' ? 'Queue for after this turn...' : 'Message Claude...')
            : 'Type into the terminal...'}
          rows={1}
        />
        <div className="chat-composer-bar">
          <button
            className="chat-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            aria-label="Attach a screenshot or file"
            title="Attach a screenshot or file (uploads to the Mac, path goes into the prompt)"
          >
            {uploading ? '…' : '+'}
          </button>
          <button
            className={`chat-keys-toggle${showKeys ? ' on' : ''}`}
            onClick={() => setShowKeys((v) => !v)}
            aria-label="Toggle terminal keys"
            title="Arrow/Enter/Esc/Tab keys for interactive dialogs like /permissions"
          >
            ⌨
          </button>
          <span className="chat-composer-spacer" />
          {tab?.status === 'working' && !input.trim() ? (
            <button
              key="stop"
              className="chat-stop"
              onKeyDown={(e) => { if (e.repeat) e.preventDefault(); }}
              onClick={() => { if (tabId && Date.now() - sentAtRef.current > 800) connection.send({ type: 'input', id: tabId, data: '\x1b' }); }}
              aria-label="Stop Claude (escape)"
              title="Interrupt Claude / cancel queued messages. Tap again to clear its input."
            ><span /></button>
          ) : (
            <button key="send" className="chat-send" onClick={send} aria-label="Send" disabled={!input.trim()}>↑</button>
          )}
        </div>
      </div>
    </>
  );

  // Sessionless: live shell tail + Start/Resume, with the same selector popup
  // and input row so the tab is fully usable before Claude ever runs.
  if (!sessionId) {
    // A LIVE Claude with no resolvable session link must NEVER get the
    // Start/Resume launcher: those type `claude` into Claude's own prompt box
    // (Brett v1.0.56, screenshot showed `claude --continue` queued twice
    // inside a running session). Show the live screen and let typing through,
    // which is exactly what a running Claude wants.
    const live = !!tab?.claudeLive;
    return (
      <div className="chat-view">
        <main className="chat-body" ref={bodyRef} onScroll={onScroll}>
          <p className="muted pad small">
            {live
              ? 'Claude is running here, but its conversation is not linked yet. Live terminal (your messages still go through):'
              : 'No Claude conversation in this tab yet. Live terminal:'}
          </p>
          {shellText === null && <p className="muted pad">Reading terminal...</p>}
          {shellText !== null && (
            <pre className="chat-shell-tail">{shellText || '(terminal is empty)'}</pre>
          )}
          {!live && (
            <div className="chat-shell-actions">
              <button className="chat-start" onClick={startClaude}>Start Claude</button>
              <button className="chat-start alt" onClick={resumeClaude}>Resume last session</button>
            </div>
          )}
        </main>
        {selectorPopup}
        {inputRow}
      </div>
    );
  }

  return (
    <ImageFetch.Provider value={imageFetch}><ImageLoaded.Provider value={keepBottom}>
    <div className="chat-view">
      <div className="chat-body-wrap">
      <main className="chat-body" ref={bodyRef} onScroll={onScroll}>
        {messages === null && <p className="muted pad">Loading conversation...</p>}
        {messages && messages.length === 0 && (
          // A linked session whose transcript resolves to nothing used to be a
          // dead end reading "No messages yet" on tabs that plainly had a
          // conversation (Brett v1.0.56, after a reset + update + resume left
          // stale links). Fall back to the live terminal so the tab stays
          // usable and the user can SEE what is actually on screen.
          <>
            <p className="muted pad small">
              {tab?.claudeLive
                ? 'Claude is running here, but this tab is linked to a conversation with no messages. Live terminal:'
                : 'No messages yet. Live terminal:'}
            </p>
            {shellText === null
              ? <p className="muted pad">Reading terminal...</p>
              : <pre className="chat-shell-tail">{shellText || '(terminal is empty)'}</pre>}
          </>
        )}
        {messages && messages.map((m, i) => (
          <Bubble
            key={messageKeys[i]} role={m.role} content={m.content} timestamp={m.timestamp || null} queued={!!m.queued}
            command={!!m.command} detail={typeof m.detail === 'string' ? m.detail : null}
            detailLabel={typeof m.detailLabel === 'string' ? m.detailLabel : null}
            blocks={m.blocks}
            startOpen={i === lastClaude}
            live={working && i === lastClaude && i === messages.length - 1}
          />
        ))}
        {echoes.map((e) => (
          <Bubble key={`echo-${e.at}`} role="user" content={e.content} timestamp={e.at} sending />
        ))}
        {sessionId && working && <Activity activity={activity} />}
      </main>
      {unseen !== 0 && (
        <button type="button" className="chat-jump" onClick={jumpToLatest}>
          <span aria-hidden="true">{'\u2193'}</span>
          {unseen > 0 ? `${unseen} new` : 'New messages'}
        </button>
      )}
      </div>
      {selectorPopup}
      {inputRow}
    </div>
    </ImageLoaded.Provider></ImageFetch.Provider>
  );
}

// "15:42" today, "Aug 4 15:42" earlier. Transcript timestamps are ISO strings.
function fmtMsgTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}
