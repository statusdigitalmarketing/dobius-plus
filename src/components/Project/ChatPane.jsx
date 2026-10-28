import { useState, useEffect, useRef, useCallback, memo, createContext, useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../store/store';
import { shellEscape, arrayBufferToBase64 } from '../../lib/paste-paths';
import './ChatPane.css';

const POLL_MS = 1500;
// Unsent drafts outlive the pane: switching a tab to Terminal unmounts it.
const drafts = new Map(); // tabId -> text
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
    >
      {children}
    </a>
  ),
};

const Message = memo(function Message({ role, content, timestamp, queued, sending }) {
  const isClaude = role === 'assistant';
  return (
    <div className={`chatp-msg ${isClaude ? 'claude' : 'you'}${sending ? ' sending' : ''}`}>
      <div className="chatp-meta">
        <span className="chatp-who">{isClaude ? 'Claude' : 'You'}</span>
        {timestamp != null && <span className="chatp-time">{fmtTime(timestamp)}</span>}
        {queued && <span className="chatp-tag">queued</span>}
        {sending && <span className="chatp-tag">sending</span>}
        <CopyButton text={String(content ?? '')} className="chatp-msg-copy" label="Copy message" />
      </div>
      <div className="chatp-body">
        {isClaude
          ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{String(content ?? '')}</ReactMarkdown>
          : <div className="chatp-plain">{content}</div>}
      </div>
    </div>
  );
});

// The transcript records `!cmd` as "! cmd"; compare both sides normalized.
function normEcho(t) {
  const s = String(t).trim();
  return s.startsWith('!') ? `! ${s.slice(1).trim()}` : s;
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
  const [selector, setSelector] = useState(null);
  const [echoes, setEchoes] = useState([]);
  const [draft, setDraftState] = useState(() => drafts.get(tabId) || '');
  const setDraft = useCallback((next) => {
    setDraftState((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      if (v) drafts.set(tabId, v); else drafts.delete(tabId);
      return v;
    });
  }, [tabId]);
  const [notice, setNotice] = useState('');

  const haveRef = useRef(null); // { sessionId, projectPath, sig } of the messages we hold
  const emptyStreakRef = useRef(0);
  const pollSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const selSeqRef = useRef(0);
  const selAppliedRef = useRef(0);
  const bodyRef = useRef(null);
  const atBottomRef = useRef(true);
  const inputRef = useRef(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const apply = useCallback((r) => {
    setStatus(r.status || null);
    setClaudeLive(!!r.claudeLive);
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
      const seen = new Set(next.filter((m) => m.role === 'user').map((m) => normEcho(m.content)));
      const now = Date.now();
      const kept = cur.filter((e) => !seen.has(normEcho(e.content)) && now - e.at < ECHO_TTL_MS);
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
  }, []);

  const pollOnce = useCallback(async () => {
    const seq = ++pollSeqRef.current;
    let r;
    try { r = await window.electronAPI?.chatPoll?.(tabId, haveRef.current); } catch { r = null; }
    if (!r || seq < appliedSeqRef.current) return;
    appliedSeqRef.current = seq;
    apply(r);
  }, [tabId, apply]);

  const pollSelector = useCallback(async () => {
    const seq = ++selSeqRef.current;
    let sel;
    try { sel = await window.electronAPI?.chatSelector?.(tabId); } catch { sel = null; }
    if (seq < selAppliedRef.current) return;
    selAppliedRef.current = seq;
    setSelector(sel && Array.isArray(sel.options) && sel.options.length > 0 ? sel : null);
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
      selAppliedRef.current = ++selSeqRef.current;
      setSelector(null);
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      await pollSelector();
      if (!cancelled) timer = setTimeout(tick, SELECTOR_POLL_MS);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [visible, pollSelector]);

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
  useEffect(() => {
    if (visible && isActive) requestAnimationFrame(() => inputRef.current?.focus());
  }, [visible, isActive]);

  // Clicking, focusing or dragging over this pane makes its tab the active
  // one, so window-level drops and shortcuts target what the user is using.
  const activate = () => {
    const st = useStore.getState();
    if (st.activeTabId !== tabId) st.setActiveTab(tabId);
  };

  useEffect(() => {
    const el = bodyRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, echoes, shellText, status, selector]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Grow the composer with its content, up to a cap.
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [draft]);

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
    const ok = await window.electronAPI?.chatSubmit?.(tabId, text);
    if (ok && echo && sid) setEchoes((cur) => [...cur, { content: text, at: Date.now(), sid }]);
    if (ok) refreshSoon();
    return !!ok;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    atBottomRef.current = true;
    const ok = await submit(text, { echo: !!sessionId });
    if (!ok) {
      // Keep what they wrote: put it back unless they already started a new one.
      setDraft((cur) => (cur ? cur : text));
      flash('Could not send. The tab may have closed or moved to another window.');
    }
  };

  // Any read already in flight describes the screen BEFORE this input, so
  // its answer is discarded rather than redrawing a prompt we just answered.
  const dropPendingSelector = () => { selAppliedRef.current = ++selSeqRef.current; };

  const sendKeys = (seq, closes = false) => {
    window.electronAPI?.terminalWrite?.(tabId, seq);
    dropPendingSelector();
    if (closes) setSelector(null);
    refreshSoon();
    inputRef.current?.focus(); // a clicked key button must not keep focus
  };

  const chooseOption = (num) => {
    // The absolute option digit, never relative arrows: a misparsed cursor
    // position then cannot pick a different option than the label shown.
    sendKeys(String(num), true);
    atBottomRef.current = true;
  };

  const insertText = (text) => {
    setDraft((prev) => prev + (prev && !/\s$/.test(prev) ? ' ' : '') + text);
    inputRef.current?.focus();
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

  // Drops are relayed window-wide by App.jsx; take them while this tab shows Chat.
  useEffect(() => {
    if (!visible) return undefined;
    const onFiles = (e) => {
      if (useStore.getState().activeTabId !== tabId) return;
      const paths = e.detail?.paths;
      if (paths?.length) insertText(paths.map((p) => shellEscape(p)).join(' '));
    };
    const onText = (e) => {
      if (useStore.getState().activeTabId !== tabId) return;
      if (e.detail?.text) insertText(e.detail.text);
    };
    window.addEventListener('dobius:drop-files', onFiles);
    window.addEventListener('dobius:drop-text', onText);
    return () => {
      window.removeEventListener('dobius:drop-files', onFiles);
      window.removeEventListener('dobius:drop-text', onText);
    };
  }, [visible, tabId]);

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
    body = (
      <>
        {messages.length === 0 && shellBlock('No messages yet. Live terminal:')}
        {messages.map((m, i) => (
          <Message key={i} role={m.role} content={m.content} timestamp={m.timestamp || null} queued={!!m.queued} />
        ))}
        {echoes.map((e) => (
          <Message key={`echo-${e.at}`} role="user" content={e.content} timestamp={e.at} sending />
        ))}
        {working && (
          <div className="chatp-working"><span className="chatp-dots"><i /><i /><i /></span>Claude is working</div>
        )}
      </>
    );
  }

  return (
    <div className="chatp" onMouseDownCapture={activate} onFocusCapture={activate} onDragEnterCapture={activate}>
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
      <div className="chatp-scroll" ref={bodyRef} onScroll={onScroll}>
        <div className="chatp-column">{body}</div>
      </div>
      <div className="chatp-column chatp-dock">
        {selector && (
          <div className="chatp-selector">
            <div className="chatp-selector-title">{selector.prompt || 'Claude is waiting for you to choose:'}</div>
            {selector.options.map((opt) => (
              <button type="button" key={opt.num} className="chatp-option" onClick={() => chooseOption(opt.num)}>
                <span className="chatp-option-num">{opt.num}</span>
                <span>{opt.label}</span>
              </button>
            ))}
            <div className="chatp-keys">
              {SELECTOR_KEYS.map(([label, seq, closes]) => (
                <button type="button" key={label} className="chatp-key" onClick={() => sendKeys(seq, closes)}>{label}</button>
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
            <button type="button" className="chatp-btn stop" onClick={() => sendKeys('\x1b', true)} title="Interrupt Claude (Esc)">Stop</button>
          )}
          <button type="button" className="chatp-btn primary" onClick={send} disabled={!draft.trim()} title="Send (Enter). Shift+Enter for a new line">
            Send
          </button>
        </div>
      </div>
    </div>
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
