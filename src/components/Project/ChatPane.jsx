import { useState, useEffect, useRef, useCallback, useMemo, memo, createContext, useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../store/store';
import { shellEscape, arrayBufferToBase64 } from '../../lib/paste-paths';
import { normalizeBlocks, rowText, rowKeys, unseenSince, markLatest, selectorKey as selectorCardKey, tokenFingerprint, createPressGuard, stepImages, createImageCache } from '../../../shared/chat-rows.js';
import { SPIN_FRAMES, SPIN_MS, normalizeActivity, liveSeconds, activityMeta } from '../../../shared/chat-activity.js';
import './ChatPane.css';

const POLL_MS = 1500;
// Unsent drafts outlive the pane: switching a tab to Terminal unmounts it.
// A tab that leaves this window (closed, torn off) takes nothing with it, and
// must not find an old draft here if it is ever docked back.
const drafts = new Map(); // tabId -> text
useStore.subscribe((s, prev) => {
  if (s.terminalTabs === prev.terminalTabs || drafts.size === 0) return;
  const ids = new Set(s.terminalTabs.map((t) => t.id));
  for (const id of drafts.keys()) if (!ids.has(id)) drafts.delete(id);
});
// Text that reaches a composer late (a failed send, a slow image save) goes
// to the pane showing that tab NOW (it may have remounted meanwhile), else to
// the saved draft, and nowhere once the tab has left this window.
const draftRestorers = new Map(); // tabId -> (update, notice) => void
function deliverDraft(tabId, update, notice) {
  const restore = draftRestorers.get(tabId);
  if (restore) { restore(update, notice); return; }
  if (!useStore.getState().terminalTabs.some((t) => t.id === tabId)) return;
  const next = update(drafts.get(tabId) || '');
  if (next) drafts.set(tabId, next);
}
// A message that did not go out joins whatever is in the composer instead of
// losing to it. Failures resolve in send order, so appending keeps several
// cancelled sends in the order they were written.
const withUnsent = (text) => (cur) => (!cur ? text : cur.split('\n\n').includes(text) ? cur : `${cur}\n\n${text}`);
const NOT_SENT = 'Not sent. The tab was interrupted, closed or moved to another window.';
const STRANDED = 'Other input reached the terminal while this was being sent, so Chat cannot tell whether it went through. Check the terminal.';
const SELECTOR_POLL_MS = 2500;
const ECHO_TTL_MS = 90_000;

// Copy that works whether or not the async clipboard API is allowed.
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

function CopyButton({ text, label = 'Copy', className = '' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`chatp-copy ${className}${done ? ' done' : ''}`}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(text);
        setDone(!!ok);
        setTimeout(() => setDone(false), 1500);
      }}
      title={label}
    >
      {done ? 'Copied' : label}
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

// react-markdown v10 has no reliable inline test for `code` (a fenced block
// with no language looks the same), so `pre` tells its children they are in a
// block through context.
const InPre = createContext(false);
// The current chat's image fetch (ref -> Promise<data URL | null>).
const ImageFetch = createContext(null);

// Thumbnails of the images a run of steps returned, shown even while the steps
// are folded: a screenshot is the point of the step. Click opens it full size.
function ToolImages({ images }) {
  const fetchImage = useContext(ImageFetch);
  const [urls, setUrls] = useState({});
  const [failed, setFailed] = useState({});
  const [big, setBig] = useState(null);
  // What is shown is never fetched again (a poll hands in new arrays, and the
  // cache may have evicted it: Codex), and a miss retries a few times (a
  // reconnect can swallow a reply) before it says so.
  const loaded = useRef({});
  const tries = useRef({});
  useEffect(() => {
    let live = true;
    const timers = [];
    if (!fetchImage) return undefined;
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
    <div className="chatp-imgs">
      {images.map((i) => (urls[i.ref]
        ? <button key={i.ref} type="button" className="chatp-img" onClick={(e) => setBig({ url: urls[i.ref], from: e.currentTarget })} aria-label="Open image"><img src={urls[i.ref]} alt="Tool output" /></button>
        : <div key={i.ref} className={`chatp-img ${failed[i.ref] ? 'failed' : 'loading'}`}>{failed[i.ref] ? 'Image unavailable' : null}</div>))}
      {big && <Lightbox url={big.url} onClose={() => { const from = big.from; setBig(null); from?.focus?.(); }} />}
    </div>
  );
}

// Full size, modal: it takes focus and keeps it (Tab cannot reach the chat or
// a selector card behind it, Codex), Escape/Enter or a click/tap closes it.
function Lightbox({ url, onClose }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div
      ref={ref}
      className="chatp-lightbox"
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
      
    </div>
  );
}

function InlineCode({ children, ...props }) {
  const [done, setDone] = useState(false);
  return (
    <code
      {...props}
      className={`chatp-inline${done ? ' done' : ''}`}
      title="Click to copy"
      onClick={async () => {
        // A drag-select inside the chip is a selection, not a copy request.
        if (window.getSelection()?.toString()) return;
        const ok = await copyText(nodeText(children));
        setDone(!!ok);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {children}
    </code>
  );
}

const mdComponents = {
  pre: ({ node: _node, children, ...props }) => (
    <div className="chatp-pre">
      <CopyButton text={nodeText(children).replace(/\n$/, '')} />
      <InPre.Provider value={true}><pre {...props}>{children}</pre></InPre.Provider>
    </div>
  ),
  code: function Code({ node: _node, children, ...props }) {
    const inPre = useContext(InPre);
    if (inPre) return <code {...props}>{children}</code>;
    return <InlineCode {...props}>{children}</InlineCode>;
  },
  // Wide tables scroll inside their own box.
  table: ({ node: _node, ...props }) => <div className="chatp-table"><table {...props} /></div>,
  // A plain <a> would navigate the whole app window. Open in the browser.
  a: ({ node: _node, href, children, ...props }) => (
    <a
      {...props}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) window.electronAPI?.openExternal?.(href);
      }}
      // Middle-click fires auxclick, not click, and would open an app window.
      onAuxClick={(e) => {
        e.preventDefault();
        if (e.button === 1 && href) window.electronAPI?.openExternal?.(href);
      }}
    >
      {children}
    </a>
  ),
};

// A message this long starts clamped with "Show more" (Sam: "no way to
// collapse long ass chat messages"). Counted from the text, not measured, so
// the decision is made before paint and never flickers.
const LONG_CHARS = 2000;
const LONG_LINES = 20;
function isLong(text) {
  if (text.length > LONG_CHARS) return true;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1 && lines <= LONG_LINES; i = text.indexOf('\n', i + 1)) lines += 1;
  return lines > LONG_LINES;
}

// The body of a skill behind a "/name" row: a few dim lines, expandable to the
// whole skill. Sam wants the preview kept, just out of the way.
function SkillPreview({ detail, label = 'skill' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chatp-skill">
      {open
        ? <div className="chatp-skill-full"><ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{detail}</ReactMarkdown></div>
        : <div className="chatp-skill-peek">{detail}</div>}
      <button type="button" className="chatp-more" onClick={() => setOpen((o) => !o)}>{open ? `Hide ${label}` : `Show ${label}`}</button>
    </div>
  );
}

// --- Typed transcript blocks (main's opt-in { blocks } rows) ----------------
// Tool calls and thinking render as quiet one-line steps that open on click,
// so a turn reads like the reply, not like the terminal.
function DiffView({ diff }) {
  const lines = (s, sign) => (s ? s.split('\n').map((l, i) => <div key={sign + i} className={`chatp-diff-${sign === '-' ? 'del' : 'add'}`}>{sign} {l}</div>) : null);
  return <div className="chatp-diff">{lines(diff.old, '-')}{lines(diff.new, '+')}</div>;
}

function StepRow({ block, live }) {
  const [open, setOpen] = useState(false);
  const isTool = block.type === 'tool';
  // A step with no result yet is running only in the turn Claude is on now;
  // in an older turn its result simply fell outside the window.
  const state = !isTool ? 'think' : block.isError ? 'err' : block.result !== undefined ? 'ok' : live ? 'running' : 'pending';
  return (
    <div className={`chatp-step${open ? ' open' : ''}`}>
      <button type="button" className="chatp-step-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`chatp-step-dot ${state}`} />
        <span className="chatp-step-name">{isTool ? block.name : 'Thinking'}</span>
        {isTool && block.summary && <span className="chatp-step-sum">{block.summary}</span>}
        <span className="chatp-step-caret">{open ? '\u25be' : '\u25b8'}</span>
      </button>
      {open && (
        <div className="chatp-step-body">
          {!isTool && <div className="chatp-step-think">{block.text}</div>}
          {block.diff && <DiffView diff={block.diff} />}
          {block.input && <pre className="chatp-step-pre">{block.input}</pre>}
          {isTool && block.result !== undefined && (
            <pre className={`chatp-step-pre out${block.isError ? ' err' : ''}`}>{block.result || '(no output)'}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// A run of more than three steps folds into one "N steps" row: a busy turn can
// hold a hundred tool calls between two sentences.
function StepGroup({ steps, live }) {
  const [open, setOpen] = useState(false);
  // Claude can run several tools in parallel, so every step of the live run
  // that has no result yet is running, not only the last one (Codex).
  if (steps.length <= 3) return <div className="chatp-steps">{steps.map((b, i) => <StepRow key={i} block={b} live={live} />)}</div>;
  const counts = {};
  for (const b of steps) { const n = b.type === 'tool' ? b.name : 'Thinking'; counts[n] = (counts[n] || 0) + 1; }
  const label = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => (c > 1 ? `${n} \u00d7${c}` : n)).join(', ');
  const failed = steps.some((b) => b.isError);
  const running = live && steps.some((b) => b.type === 'tool' && b.result === undefined);
  return (
    <div className="chatp-steps">
      <button type="button" className="chatp-step-head group" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`chatp-step-dot ${running ? 'running' : failed ? 'err' : 'ok'}`} />
        <span className="chatp-step-name">{steps.length} steps</span>
        <span className="chatp-step-sum">{label}</span>
        <span className="chatp-step-caret">{open ? '\u25be' : '\u25b8'}</span>
      </button>
      {open && steps.map((b, i) => <StepRow key={i} block={b} live={live} />)}
    </div>
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

// Claude's spinner line, live: the glyph cycle, the gerund it picked for this
// turn ("Whirlpooling"), and the clock + token meter. The clock ticks here
// between polls. Without a line from the screen (an older Mac, a frame not
// parsed yet) it still shows the glyph and counts from when the turn was seen.
function useReducedMotion() {
  const [reduce, setReduce] = useState(() => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = () => setReduce(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

const Activity = memo(function Activity({ activity }) {
  const reduce = useReducedMotion();
  const [tick, setTick] = useState(0);
  const sec = activity?.seconds ?? null;
  const [anchor, setAnchor] = useState(() => ({ at: Date.now(), seconds: sec }));
  useEffect(() => { if (sec != null) setAnchor({ at: Date.now(), seconds: sec }); }, [sec]);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), reduce ? 1000 : SPIN_MS);
    return () => clearInterval(iv);
  }, [reduce]);
  const verb = activity?.verb || 'Working';
  const meta = activityMeta(liveSeconds(anchor, Date.now()), activity);
  return (
    <div className="chatp-activity">
      <span className="chatp-act-glyph" aria-hidden="true">{reduce ? '\u273b' : SPIN_FRAMES[tick % SPIN_FRAMES.length]}</span>
      <span className="chatp-act-text" role="status">
        <span key={verb} className="chatp-act-verb">{`${verb}\u2026`}</span>
      </span>
      {meta && <span className="chatp-act-meta" aria-hidden="true">{meta}</span>}
    </div>
  );
});

const Message = memo(function Message({ role, content, timestamp, queued, sending, command, detail, detailLabel, blocks: rawBlocks, startOpen, live }) {
  const isClaude = role === 'assistant';
  const blocks = useMemo(() => (isClaude ? normalizeBlocks(rawBlocks) : null), [isClaude, rawBlocks]);
  const text = String(content ?? '');
  const shown = rowText(text, blocks); // what the reader sees, and what Copy copies
  const long = !command && isLong(shown);
  const [open, setOpen] = useState(!long || !!startOpen);
  return (
    <div className={`chatp-msg ${isClaude ? 'claude' : 'you'}${sending ? ' sending' : ''}`}>
      <div className="chatp-meta">
        <span className="chatp-who">{isClaude ? 'Claude' : 'You'}</span>
        {timestamp != null && <span className="chatp-time">{fmtTime(timestamp)}</span>}
        {queued && <span className="chatp-tag">queued</span>}
        {sending && <span className="chatp-tag">sending</span>}
        {shown && <CopyButton text={shown} className="chatp-msg-copy" label="Copy message" />}
      </div>
      <div className={`chatp-body${long && !open ? ' clamped' : ''}`}>
        {isClaude
          ? (blocks ? <Blocks blocks={blocks} live={!!live} /> : <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown>)
          : <div className={`chatp-plain${command ? ' chatp-cmd' : ''}`}>{text}</div>}
        {command && detail && <SkillPreview detail={detail} label={detailLabel || 'skill'} />}
      </div>
      {long && <button type="button" className="chatp-more" onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Show more'}</button>}
    </div>
  );
});

// The transcript records `!cmd` as "! cmd"; compare both sides normalized.
function normEcho(t) {
  const s = String(t).trim();
  return s.startsWith('!') ? `! ${s.slice(1).trim()}` : s;
}
// The transcript caps a message (data-service MAX_MESSAGE_CHARS) and marks
// the cut; only a message cut that way is matched by prefix, so two long
// messages that merely start alike never stand in for each other.
const TRUNCATED_RE = /\n\n\[message truncated at \d+ chars\]$/;
// How many user messages in the transcript are this text. Counted, not
// tested: "yes" sent again must not be matched by the "yes" already there.
function countInTranscript(messages, text) {
  if (!Array.isArray(messages)) return 0;
  const k = normEcho(text);
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const c = String(m.content);
    if (TRUNCATED_RE.test(c)) { const p = normEcho(c.replace(TRUNCATED_RE, '')); if (p && k.startsWith(p)) n += 1; }
    else if (normEcho(c) === k) n += 1;
  }
  return n;
}

const STATUS_TEXT = { working: 'Working', needs: 'Needs you', done: 'Ready' };
// [label, bytes, closes]: Esc and Enter end the prompt, so the card goes at
// once and a second click cannot land on whatever prompt comes next.
const SELECTOR_KEYS = [
  ['Up', '\x1b[A', false], ['Down', '\x1b[B', false], ['Space', ' ', false],
  ['Esc', '\x1b', true], ['Enter', '\r', true],
];

/**
 * Readable chat view of a terminal tab, drawn over its still-mounted
 * TerminalPane (which keeps the xterm buffer and the PTY). Shows the running
 * Claude session's transcript as messages, Claude's live selector prompts as
 * buttons, and sends typed messages into the same PTY. Polls only while
 * visible.
 */
export default function ChatPane({ tabId, visible }) {
  const setTabViewMode = useStore((s) => s.setTabViewMode);
  const isActive = useStore((s) => s.activeTabId === tabId);
  const [messages, setMessages] = useState(null); // null = not loaded yet
  const [sessionId, setSessionId] = useState(undefined); // undefined = first poll pending
  const [shellText, setShellText] = useState(null);
  const [claudeLive, setClaudeLive] = useState(false);
  const [status, setStatus] = useState(null);
  const [activity, setActivity] = useState(null);
  const [selector, setSelector] = useState(null); // { prompt, options, token, fp }
  // Which card each pointer / key press began on (see createPressGuard).
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
  const [echoes, setEchoes] = useState([]);
  const echoesRef = useRef(echoes);
  useEffect(() => { echoesRef.current = echoes; }, [echoes]);
  // Identical sends still waiting on main, by normalized text (see submit).
  const inflightRef = useRef(new Map());
  const [draft, setDraft] = useState(() => drafts.get(tabId) || '');
  useEffect(() => {
    if (draft) drafts.set(tabId, draft); else drafts.delete(tabId);
  }, [draft, tabId]);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const restore = (update, notice) => {
      setDraft(update);
      if (notice) flash(notice);
    };
    draftRestorers.set(tabId, restore);
    return () => { if (draftRestorers.get(tabId) === restore) draftRestorers.delete(tabId); };
  }, [tabId]);

  const haveRef = useRef(null); // { sessionId, projectPath, sig } of the messages we hold
  const emptyStreakRef = useRef(0);
  const pollSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const selSeqRef = useRef(0);
  const selAppliedRef = useRef(0);
  const bodyRef = useRef(null);
  const atBottomRef = useRef(true);
  // Rows that arrived (or a live turn that grew) while scrolled up, for the
  // "new messages" pill. The mark is the newest row seen at the bottom (the
  // window slides, so a plain length cannot count them).
  const [unseen, setUnseen] = useState(0);
  const seenKeyRef = useRef(null);
  const jumpingRef = useRef(false); // a smooth jump to the latest is in flight
  const lastTopRef = useRef(0);
  const jumpGenRef = useRef(0);
  const preJumpMarkRef = useRef(null); // the reading mark before the last jump
  const inputRef = useRef(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const sessionIdRef = useRef(undefined);
  // Tool images (a screenshot Claude read): fetched by reference only when a
  // thumbnail shows, cached per session.
  const imageFetch = useMemo(() => createImageCache((ref) => {
    const h = haveRef.current;
    return h?.sessionId && h.projectPath ? window.electronAPI.chatImage?.(h.sessionId, h.projectPath, ref) : null;
  }), [sessionId]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Any selector read in flight describes the screen before now; discard it.
  const dropPendingSelector = useCallback(() => { selAppliedRef.current = ++selSeqRef.current; }, []);

  const apply = useCallback((r) => {
    setStatus(r.status || null);
    setActivity(r.status === 'working' ? normalizeActivity(r.activity) : null);
    setClaudeLive(!!r.claudeLive);
    if (sessionIdRef.current !== r.sessionId) {
      // A different conversation (or none): the old prompt's buttons go. Not
      // on the FIRST reply: the card read on entering Chat belongs to this
      // session, and clearing it blinked the card out until the next poll
      // (and cancelled a press begun in that window).
      const known = sessionIdRef.current !== undefined;
      sessionIdRef.current = r.sessionId;
      if (known) {
        dropPendingSelector();
        setSelector(null);
      }
    }
    // Optimistic bubbles belong to the session they were sent into.
    setEchoes((cur) => {
      const kept = cur.filter((e) => e.sid === r.sessionId);
      return kept.length === cur.length ? cur : kept;
    });
    if (!r.sessionId) {
      haveRef.current = null;
      emptyStreakRef.current = 0;
      setSessionId(null);
      setMessages(null);
      setShellText(typeof r.shellText === 'string' ? r.shellText : '');
      return;
    }
    const sameSession = haveRef.current?.sessionId === r.sessionId;
    setSessionId(r.sessionId);
    if (r.unchanged) {
      setEchoes((cur) => {
        if (cur.length === 0) return cur;
        const now = Date.now();
        const kept = cur.filter((e) => now - e.at < ECHO_TTL_MS);
        return kept.length === cur.length ? cur : kept;
      });
      return;
    }
    const next = Array.isArray(r.entries) ? r.entries : [];
    setShellText(typeof r.shellText === 'string' ? r.shellText : null);
    setEchoes((cur) => {
      if (cur.length === 0) return cur;
      const now = Date.now();
      const kept = cur.filter((e) => countInTranscript(next, e.content) <= e.base && now - e.at < ECHO_TTL_MS);
      return kept.length === cur.length ? cur : kept;
    });
    if (next.length > 0) {
      emptyStreakRef.current = 0;
      haveRef.current = { sessionId: r.sessionId, projectPath: r.projectPath, sig: r.sig || null };
      setMessages(next);
    } else {
      // One empty read after real content is a transient (file mid-rewrite);
      // keep what we show unless it persists or the session changed.
      emptyStreakRef.current += 1;
      haveRef.current = null;
      setMessages((prev) => (!sameSession || !prev || prev.length === 0 || emptyStreakRef.current >= 2 ? [] : prev));
    }
  }, [dropPendingSelector]);

  const pollOnce = useCallback(async () => {
    const seq = ++pollSeqRef.current;
    let r;
    try { r = await window.electronAPI?.chatPoll?.(tabId, haveRef.current); } catch { r = null; }
    if (!r || seq < appliedSeqRef.current) return;
    appliedSeqRef.current = seq;
    apply(r);
    // "Unchanged" against a cache a newer reply already dropped: fetch it now
    // instead of sitting on "Loading" until the next tick.
    if (r.unchanged && !haveRef.current && mountedRef.current) await pollOnce();
  }, [tabId, apply]);

  const pollSelector = useCallback(async (retries = 0) => {
    const seq = ++selSeqRef.current;
    let sel;
    try { sel = await window.electronAPI?.chatSelector?.(tabId); } catch { sel = null; }
    if (seq < selAppliedRef.current) return;
    selAppliedRef.current = seq;
    // Not repainted since the last key: unknown, not "no prompt". Keep the
    // card, disabled (no token), and look again shortly instead of dropping
    // it until the next tick (an arrow click made it blink out).
    if (sel?.unsettled) {
      setSelector((cur) => (cur ? { ...cur, token: '' } : cur));
      if (retries > 0) setTimeout(() => { if (mountedRef.current && visibleRef.current) pollSelector(retries - 1); }, 150);
      return;
    }
    const s2 = sel?.selector;
    setSelector(s2 && Array.isArray(s2.options) && s2.options.length > 0 ? { ...s2, token: sel.token, fp: tokenFingerprint(sel.token) } : null);
  }, [tabId]);

  // Transcript + status poll, only while this pane is on screen.
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      await pollOnce();
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [visible, pollOnce]);

  useEffect(() => {
    if (!visible) {
      // Off screen the prompt can be answered elsewhere (the phone, the
      // terminal); never show a remembered one when coming back.
      dropPendingSelector();
      setSelector(null);
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      // A read raced by output comes back unsettled: re-read shortly instead
      // of leaving the card disabled until the next tick.
      await pollSelector(3);
      if (!cancelled) timer = setTimeout(tick, SELECTOR_POLL_MS);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [visible, pollSelector, dropPendingSelector]);

  // Coming on screen: jump to the newest message.
  useEffect(() => {
    if (!visible) return;
    atBottomRef.current = true;
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [visible]);

  // Take focus only as THE active tab: in a grid every chat pane is visible,
  // and the last one to grab focus would receive typing meant for another.
  // An open image stays on top and keeps focus: coming back from Dashboard
  // must not put Enter on the draft hidden behind it (Codex P2).
  const focusInput = useCallback(() => {
    const box = inputRef.current?.closest('[data-chat-tab]')?.querySelector('.chatp-lightbox');
    (box || inputRef.current)?.focus();
  }, []);
  useEffect(() => {
    if (visible && isActive) requestAnimationFrame(focusInput);
  }, [visible, isActive, focusInput]);

  // Clicking, focusing or dragging over this pane makes its tab the active
  // one, so window-level drops and shortcuts target what the user is using.
  // Not for split's right pane: the split guard would hand activity (and
  // focus) straight back to the left tab.
  const activate = () => {
    const st = useStore.getState();
    if (st.activeTabId !== tabId && st.splitTabId !== tabId) st.setActiveTab(tabId);
  };

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
    const keys = rowKeys(rows);
    if (atBottomRef.current || !keys.length) {
      seenKeyRef.current = markLatest(rows, keys);
      setUnseen(0);
      return;
    }
    // No mark (a new session loaded in this tab while the reader was scrolled
    // up): none of it was seen, so say so until they reach the bottom
    // (Codex Medium, twice: a null mark used to hide the pill for good).
    setUnseen(seenKeyRef.current ? unseenSince(rows, keys, seenKeyRef.current) : -1);
  }, [messages, echoes, shellText, status, selector]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
        setUnseen(preJumpMarkRef.current ? unseenSince(messages || [], rowKeys(messages || []), preJumpMarkRef.current) : -1);
      }
    }
    lastTopRef.current = el.scrollTop;
    atBottomRef.current = jumpingRef.current || near;
    if (atBottomRef.current && unseen !== 0) {
      seenKeyRef.current = markLatest(messages || [], rowKeys(messages || []));
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
    seenKeyRef.current = markLatest(messages || [], rowKeys(messages || []));
    setUnseen(0);
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
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
        atBottomRef.current = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
        if (!atBottomRef.current) {
          seenKeyRef.current = preJumpMarkRef.current;
          setUnseen(preJumpMarkRef.current ? unseenSince(messagesRef.current || [], rowKeys(messagesRef.current || []), preJumpMarkRef.current) : -1);
        }
      }, 1500);
    }
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  // Grow the composer with its content, up to a cap.
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [draft, visible]); // a pane mounted hidden measured 0; measure again when shown

  const flash = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice((cur) => (cur === msg ? '' : cur)), 4000);
  };

  // Refresh soon after anything we type, so the answer and the cleared popup
  // show without waiting out a full poll.
  const refreshSoon = () => {
    setTimeout(() => { if (visibleRef.current) { pollSelector(); pollOnce(); } }, 700);
  };

  const submit = async (text, { echo = true } = {}) => {
    const sid = sessionId;
    const key = normEcho(text);
    // Copies already there, plus identical sends ahead of this one that have
    // not landed yet (an echo waiting, or a send still in flight): otherwise
    // the first "yes" to land would count as this one too and either clear
    // its echo or never show it (Codex Low).
    const inflight = inflightRef.current;
    const base = countInTranscript(messagesRef.current, text)
      + echoesRef.current.filter((e) => e.sid === sid && normEcho(e.content) === key).length
      + (inflight.get(key) || 0);
    inflight.set(key, (inflight.get(key) || 0) + 1);
    let r;
    try {
      r = await window.electronAPI?.chatSubmit?.(tabId, text);
    } finally {
      const n = (inflight.get(key) || 1) - 1;
      if (n > 0) inflight.set(key, n); else inflight.delete(key);
    }
    const ok = r === true;
    // Only if the conversation it went into is still the one on screen, and
    // the transcript has not already shown it while the Enter was pending.
    if (ok && echo && sid && sessionIdRef.current === sid && countInTranscript(messagesRef.current, text) <= base) {
      setEchoes((cur) => [...cur, { content: text, at: Date.now(), sid, base }]);
    }
    if (ok) refreshSoon();
    return r === 'stranded' ? 'stranded' : ok;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    atBottomRef.current = true;
    const ok = await submit(text, { echo: !!sessionId });
    // Typed but not entered: the text is already in the terminal's input
    // line, so handing it back here would send it twice.
    if (ok === 'stranded') deliverDraft(tabId, (cur) => cur, STRANDED);
    else if (!ok) deliverDraft(tabId, withUnsent(text), NOT_SENT); // keep what they wrote
  };

  // Answer the prompt on screen. Main delivers the key only if nothing has
  // typed into the tab since this card was read (the phone, the terminal),
  // so these buttons can never land on a prompt the user has not seen.
  const selectorKey = async (seq, closes = false, e = null) => {
    const token = selector?.token;
    // A press must END on the card it began on (shared createPressGuard).
    if (!pressGuard.current.take(e, selector)) {
      flash('The prompt changed while you were clicking. Nothing was sent, check the card again.');
      return;
    }
    dropPendingSelector();
    if (closes) setSelector(null);
    inputRef.current?.focus(); // a clicked key button must not keep focus
    const r = await window.electronAPI?.chatKey?.(tabId, seq, token);
    if (!mountedRef.current) return;
    if (!r?.ok) {
      setSelector(null);
      if (r?.stale) flash('That prompt changed. Showing the current one.');
      pollSelector(5);
      return;
    }
    if (!closes) setSelector((cur) => (cur && cur.token === token ? { ...cur, token: r.token } : cur));
    // An arrow or space leaves no usable token until Claude redraws the
    // prompt (main refuses reads of a screen not yet repainted): the buttons
    // wait, disabled, for a quick re-read instead of failing as stale.
    if (!closes && !r.token) setTimeout(() => { if (mountedRef.current) pollSelector(20); }, 150);
    refreshSoon();
  };

  const chooseOption = (num, e) => {
    // The absolute option digit, never relative arrows: a misparsed cursor
    // position then cannot pick a different option than the label shown.
    selectorKey(String(num), true, e);
    atBottomRef.current = true;
  };

  const interrupt = () => {
    window.electronAPI?.terminalWrite?.(tabId, '\x1b');
    dropPendingSelector();
    setSelector(null);
    refreshSoon();
    inputRef.current?.focus();
  };

  const insertText = (text) => {
    deliverDraft(tabId, (prev) => prev + (prev && !/\s$/.test(prev) ? ' ' : '') + text);
    // A slow image save must not pull focus back from a pane used since.
    if (useStore.getState().activeTabId === tabId) inputRef.current?.focus();
  };

  const onPaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      if (item.type.startsWith('image/')) {
        const base64 = arrayBufferToBase64(await file.arrayBuffer());
        const saved = await window.electronAPI?.saveClipboardImage?.(base64, item.type);
        if (saved) insertText(shellEscape(saved));
        else flash('Could not save the pasted image.');
      } else {
        const p = window.electronAPI?.getPathForFile?.(file);
        if (p) insertText(shellEscape(p));
      }
      return;
    }
  };

  // Drops are relayed window-wide by App.jsx; take them while this tab shows
  // Chat. A drop ON a chat pane belongs to that pane (split's right pane is
  // never the active tab); anywhere else, to the active tab.
  useEffect(() => {
    if (!visible) return undefined;
    const dropIsMine = (target) => {
      const pane = target?.closest?.('[data-chat-tab]');
      if (!pane) return useStore.getState().activeTabId === tabId;
      // Dropped right here: type into this composer next, even as split's
      // right pane (never the active tab), not the terminal that had focus.
      if (pane.dataset.chatTab === tabId) { requestAnimationFrame(focusInput); return true; }
      return false;
    };
    const onFiles = (e) => {
      if (!dropIsMine(e.detail?.target)) return;
      const paths = e.detail?.paths;
      if (paths?.length) insertText(paths.map((p) => shellEscape(p)).join(' '));
    };
    const onText = (e) => {
      if (!dropIsMine(e.detail?.target)) return;
      if (e.detail?.text) insertText(e.detail.text);
    };
    window.addEventListener('dobius:drop-files', onFiles);
    window.addEventListener('dobius:drop-text', onText);
    return () => {
      window.removeEventListener('dobius:drop-files', onFiles);
      window.removeEventListener('dobius:drop-text', onText);
    };
  }, [visible, tabId, focusInput]);

  const working = status === 'working';
  const placeholder = sessionId
    ? (claudeLive ? 'Message Claude...' : 'Claude exited. Input goes to the terminal...')
    : (claudeLive ? 'Message Claude...' : 'Type a command for the terminal...');

  const shellBlock = (intro) => (
    <div className="chatp-shell">
      <div className="chatp-shell-intro">{intro}</div>
      {shellText === null
        ? <div className="chatp-dim">Reading terminal...</div>
        : (
          <div className="chatp-pre">
            {shellText && <CopyButton text={shellText} />}
            <pre>{shellText || '(terminal is empty)'}</pre>
          </div>
        )}
    </div>
  );

  let body;
  if (sessionId === undefined) {
    body = <div className="chatp-dim chatp-center">Loading...</div>;
  } else if (!sessionId) {
    body = (
      <>
        {shellBlock(claudeLive
          ? 'Claude is starting up here. Its conversation will show once it links. Live terminal:'
          : 'No Claude conversation in this tab. Live terminal:')}
        {!claudeLive && (
          <div className="chatp-start">
            <button type="button" className="chatp-btn primary" onClick={() => submit('claude', { echo: false })}>Start Claude</button>
            <button type="button" className="chatp-btn" onClick={() => submit('claude --continue', { echo: false })}>Resume last session</button>
          </div>
        )}
      </>
    );
  } else if (messages === null) {
    body = <div className="chatp-dim chatp-center">Loading conversation...</div>;
  } else {
    // The newest Claude reply stays open even when long: it is what you came to read.
    const lastClaude = messages.findLastIndex((m) => m.role === 'assistant');
    const keys = rowKeys(messages);
    body = (
      <>
        {messages.length === 0 && shellBlock('No messages yet. Live terminal:')}
        {messages.map((m, i) => (
          <Message
            key={keys[i]} role={m.role} content={m.content} timestamp={m.timestamp || null} queued={!!m.queued}
            command={!!m.command} detail={typeof m.detail === 'string' ? m.detail : null}
            detailLabel={typeof m.detailLabel === 'string' ? m.detailLabel : null}
            blocks={m.blocks}
            startOpen={i === lastClaude}
            live={working && i === lastClaude && i === messages.length - 1}
          />
        ))}
        {echoes.filter((e) => e.sid === sessionId).map((e) => (
          <Message key={`echo-${e.at}`} role="user" content={e.content} timestamp={e.at} sending />
        ))}
        {working && visible && <Activity activity={activity} />}
      </>
    );
  }

  return (
    <ImageFetch.Provider value={imageFetch}>
    <div className="chatp" data-chat-tab={tabId} onMouseDownCapture={activate} onFocusCapture={activate} onDragEnterCapture={activate}>
      <div className="chatp-head">
        <span className={`chatp-status ${status || 'idle'}`} />
        <span className="chatp-head-text">
          {claudeLive || sessionId ? (STATUS_TEXT[status] || 'Ready') : 'Terminal'}
        </span>
        <span className="chatp-spacer" />
        <button type="button" className="chatp-link" onClick={() => setTabViewMode(tabId, 'terminal')} title="Back to the terminal (Cmd+Shift+C)">
          Show terminal
        </button>
      </div>
      <div className="chatp-scroll-wrap">
        <div className="chatp-scroll" ref={bodyRef} onScroll={onScroll}>
          <div className="chatp-column">{body}</div>
        </div>
        {unseen !== 0 && (
          <button type="button" className="chatp-jump" onClick={jumpToLatest}>
            <span aria-hidden="true">{'\u2193'}</span>
            {unseen > 0 ? `${unseen} new ${unseen === 1 ? 'message' : 'messages'}` : 'New messages'}
          </button>
        )}
      </div>
      <div className="chatp-column chatp-dock">
        {selector && (
          <div
            className="chatp-selector"
            key={selectorCardKey(selector)}
            onPointerDownCapture={(e) => pressGuard.current.pointerDown(e, selector)}
            onKeyDownCapture={(e) => pressGuard.current.keyDown(e, selector)}
          >
            <div className="chatp-selector-title">{selector.prompt || 'Claude is waiting for you to choose:'}</div>
            {selector.options.map((opt) => (
              <button type="button" key={opt.num} className="chatp-option" disabled={!selector.token} onClick={(e) => chooseOption(opt.num, e)}>
                <span className="chatp-option-num">{opt.num}</span>
                <span className="chatp-option-text">
                  {opt.label}
                  {opt.detail && <span className="chatp-option-detail">{opt.detail}</span>}
                </span>
              </button>
            ))}
            <div className="chatp-keys">
              {SELECTOR_KEYS.map(([label, seq, closes]) => (
                <button type="button" key={label} className="chatp-key" disabled={!selector.token} onClick={(e) => selectorKey(seq, closes, e)}>{label}</button>
              ))}
            </div>
          </div>
        )}
        {notice && <div className="chatp-notice">{notice}</div>}
        <div className="chatp-composer">
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          {working && (
            <button type="button" className="chatp-btn stop" onClick={interrupt} title="Interrupt Claude (Esc)">Stop</button>
          )}
          <button type="button" className="chatp-btn primary" onClick={send} disabled={!draft.trim()} title="Send (Enter). Shift+Enter for a new line">
            Send
          </button>
        </div>
      </div>
    </div>
    </ImageFetch.Provider>
  );
}

// "15:42" today, "Oct 4 15:42" earlier.
function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}
