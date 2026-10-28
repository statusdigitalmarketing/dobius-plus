import { useState, useEffect, useRef, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import SpecialKeys from './SpecialKeys';
import remarkGfm from 'remark-gfm';
import { absUrl } from './host';

// One chat bubble. Assistant messages render as MARKDOWN (tables, code
// blocks, lists were showing as raw pipes/asterisks: Sam's v1.0.53 report);
// user messages stay literal text so pasted code/paths are never mangled.
// memo'd so the 3.5s transcript poll only re-parses bubbles whose content
// actually changed, not all 200.
// Per-tab input drafts, persisted so navigating Board -> tab -> Board -> tab
// never eats typed-but-unsent text (Sam's report). One localStorage key holds
// a { tabId: { text, at } } map, pruned to 40 entries / 7 days on write.
const DRAFTS_KEY = 'dobius-mobile-drafts';
function loadDraft(tabId) {
  if (!tabId) return '';
  try {
    const map = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
    return typeof map[tabId]?.text === 'string' ? map[tabId].text : '';
  } catch { return ''; }
}
function storeDraft(tabId, text) {
  if (!tabId) return;
  try {
    const map = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
    if (text) map[tabId] = { text, at: Date.now() };
    else delete map[tabId];
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const entries = Object.entries(map)
      .filter(([, v]) => v && typeof v.text === 'string' && (v.at || 0) > cutoff)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, 40);
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(entries)));
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
function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`md-copy${done ? ' done' : ''}`}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyText(text);
        setDone(!!ok);
        setTimeout(() => setDone(false), 1500);
      }}
      aria-label="Copy"
    >
      {done ? 'copied' : 'copy'}
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
function SkillPreview({ detail }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-skill">
      <div className={open ? 'chat-skill-full' : 'chat-skill-peek'}>{detail}</div>
      <button className="chat-more" onClick={() => setOpen((o) => !o)}>{open ? 'Hide skill' : 'Show skill'}</button>
    </div>
  );
}

const Bubble = memo(function Bubble({ role, content, timestamp, queued, sending, command, detail, startOpen }) {
  const long = !command && isLong(String(content ?? ''));
  const [open, setOpen] = useState(!long || !!startOpen);
  return (
    <div className={`chat-msg ${role === 'assistant' ? 'assistant' : 'user'}${sending ? ' chat-echo' : ''}`}>
      <div className="chat-role">
        {role === 'assistant' ? 'Claude' : 'You'}
        {timestamp != null && <span className="chat-time">{fmtMsgTime(timestamp)}</span>}
        {queued && <span className="chat-queued">queued</span>}
        {sending && <span className="chat-queued">sending…</span>}
      </div>
      <div className={`chat-content${open ? '' : ' clamped'}${command ? ' chat-cmd' : ''}`}>
        {role === 'assistant' ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Wide tables scroll inside their own container on a phone.
              table: ({ node: _node, ...props }) => (
                <div className="md-table-wrap"><table {...props} /></div>
              ),
              // Fenced blocks get a copy button; the box scrolls sideways
              // instead of truncating a long one-liner.
              pre: ({ node: _node, children, ...props }) => (
                <div className="md-pre-wrap">
                  <CopyBtn text={nodeText(children)} />
                  <pre {...props}>{children}</pre>
                </div>
              ),
              // Inline code deliberately gets NO chip: react-markdown v10
              // exposes no reliable inline test (a no-language fenced block
              // also has no className, and wrapping it doubled the copy
              // button inside its own pre: Codex High). Long inline spans
              // scroll via CSS instead; fenced blocks carry the button.
            }}
          >
            {content}
          </ReactMarkdown>
        ) : content}
      </div>
      {command && detail && <SkillPreview detail={detail} />}
      {long && <button className="chat-more" onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Show more'}</button>}
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
  const [messages, setMessages] = useState(null); // null = loading
  const [input, setInput] = useState(() => loadDraft(tabId));
  // Draft-aware setter: accepts a value or updater fn, mirrors to localStorage.
  const setDraft = useCallback((next) => {
    setInput((cur) => {
      const v = typeof next === 'function' ? next(cur) : next;
      storeDraft(tabId, v);
      return v;
    });
  }, [tabId]);
  // Rehydrate when this view is reused for a DIFFERENT tab (tabId prop swap).
  useEffect(() => { setInput(loadDraft(tabId)); }, [tabId]);
  // Interactive selector Claude is currently showing (permission prompt, plan
  // approval, AskUserQuestion). null = none. Detected server-side from the live
  // PTY buffer because these TUI prompts are NOT in the transcript. Display is
  // parser-driven, NOT gated on the hook-driven 'needs' status: AskUserQuestion
  // doesn't reliably fire the Notification hook, so the old status gate kept
  // question popups from ever appearing (Sam's v1.0.51 bug 1). Staleness is the
  // parser's job (trailing-prose rejection) plus the server's post-answer
  // re-push and the optimistic clear in chooseOption.
  const [selector, setSelector] = useState(null);
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
    connection.send({ type: 'loadTranscript', sessionId, projectPath, tabId, limit: 200, sig: sigRef.current || undefined });
  }, [connection, sessionId, projectPath]);

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
    if (!tabId) return undefined;
    probeSelector();
    const iv = setInterval(probeSelector, 2500);
    return () => clearInterval(iv);
  }, [tabId, probeSelector]);

  // Poll a plain-text tail of the live PTY whenever we have no conversation to
  // render: a bare shell (Asana 1217257328849820) OR a tab whose Claude is
  // live but whose transcript we cannot resolve (Brett v1.0.56: "No messages
  // yet" on tabs that clearly had chats). Stops once messages exist.
  const needShell = !sessionId || (messages !== null && messages.length === 0);
  // The newest Claude reply stays open even when long: it is what you came to read.
  const lastClaude = messages ? messages.findLastIndex((m) => m.role === 'assistant') : -1;
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
          && (msg.projectPath == null || msg.projectPath === projectPath)) {
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
        setSelector(msg.selector || null);
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
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, echoes, shellText]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
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
    setEchoes((cur) => [...cur, { content: text, at: Date.now() }]);
    setDraft('');
    atBottomRef.current = true;
  };

  // Pick a selector option. Sends the ABSOLUTE option number the user tapped
  // (Claude's numbered prompts select on the digit key). Never relative arrows,
  // so a parse error in the cursor position can't select a DIFFERENT option than
  // the label. No trailing Enter, so a stray newline can't confirm a chained
  // prompt. Optimistically clear; the next probe reflects the real state.
  const chooseOption = (num) => {
    if (!tabId) return;
    connection.send({ type: 'input', id: tabId, data: String(num) });
    setSelector(null);
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
  const sendSelectorKey = (seq, closes) => {
    if (!tabId) return;
    connection.send({ type: 'input', id: tabId, data: seq });
    if (closes) setSelector(null);
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
        const res = await fetch(`${absUrl('/upload')}?name=${encodeURIComponent(f.name || 'upload')}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/octet-stream' },
          body: f,
        });
        const data = await res.json().catch(() => null);
        if (data?.ok && data.path) paths.push(data.path);
        else setUploadMsg(data?.error || `Upload failed (${res.status})`);
      }
      if (paths.length) setDraft((cur) => `${cur}${cur && !cur.endsWith(' ') ? ' ' : ''}${paths.join(' ')} `);
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
  const selectorPopup = selector && selector.options && selector.options.length > 0 && (
        <div className="chat-selector">
          <div className="chat-selector-title">
            {selector.prompt || 'Claude is waiting for you to choose:'}
          </div>
          {selector.options.map((opt) => (
            <button
              key={opt.num}
              className="chat-selector-opt"
              onClick={() => chooseOption(opt.num)}
            >
              <span className="chat-selector-num">{opt.num}</span>
              <span className="chat-selector-label">
                {opt.label}
                {opt.detail && <span className="chat-selector-detail">{opt.detail}</span>}
              </span>
            </button>
          ))}
          {/* Fine-control row: arrows/space for multiSelect movement + toggle,
              enter/esc to confirm/cancel, without leaving Chat. v1.0.53. */}
          <div className="chat-selector-keys">
            {SELECTOR_KEYS.map(([label, seq, closes]) => (
              <button key={label} className="chat-selector-key" onClick={() => sendSelectorKey(seq, closes)}>
                {label}
              </button>
            ))}
          </div>
          {onOpenTerminal && (
            <button className="chat-selector-term" onClick={onOpenTerminal}>
              Open terminal to answer manually
            </button>
          )}
    </div>
  );

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
      <div className="chat-input-row">
        <button
          className={`chat-keys-toggle${showKeys ? ' on' : ''}`}
          onClick={() => setShowKeys((v) => !v)}
          aria-label="Toggle terminal keys"
          title="Arrow/Enter/Esc/Tab keys for interactive dialogs like /permissions"
        >
          ⌨
        </button>
        {/* Interrupt/cancel from Chat (v1.0.53, Sam: "no way to cancel").
            One tap = ESC to the TUI: interrupts the running turn AND pops any
            queued messages back into Claude's input (the popAll op); a second
            tap clears that input. Red while the tab is actively working. */}
        <button
          className={`chat-esc${tab?.status === 'working' ? ' working' : ''}`}
          onClick={() => { if (tabId) connection.send({ type: 'input', id: tabId, data: '\x1b' }); }}
          aria-label="Interrupt Claude (escape)"
          title="Interrupt Claude / cancel queued messages. Tap again to clear its input."
        >
          esc
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
        />
        <button
          className="chat-attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-label="Attach a screenshot or file"
          title="Attach a screenshot or file (uploads to the Mac, path goes into the prompt)"
        >
          {uploading ? '…' : '+'}
        </button>
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
              : 'Message Claude...')
            : 'Type into the terminal...'}
          rows={1}
        />
        <button className="chat-send" onClick={send} aria-label="Send" disabled={!input.trim()}>↑</button>
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
    <div className="chat-view">
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
            key={i} role={m.role} content={m.content} timestamp={m.timestamp || null} queued={!!m.queued}
            command={!!m.command} detail={typeof m.detail === 'string' ? m.detail : null}
            startOpen={i === lastClaude}
          />
        ))}
        {echoes.map((e) => (
          <Bubble key={`echo-${e.at}`} role="user" content={e.content} timestamp={e.at} sending />
        ))}
      </main>
      {selectorPopup}
      {inputRow}
    </div>
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
