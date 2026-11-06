// Demo mode: the whole app running against built-in sample data, with no Mac
// and no network. It exists for App Review (a reviewer has no Mac on a
// Tailnet to pair with) and doubles as a try-before-you-install tour.
//
// Entered with the reviewer credentials: Mac address `demo.dobius`, pairing
// code 123456. `demo.dobius` normalises to DEMO_ORIGIN, a name that cannot
// resolve on any real network (.dobius is not a TLD), so a real user's Mac
// can never be mistaken for it. Two pieces make the app believe it is paired:
//   - installDemoFetch() answers every REST call aimed at DEMO_ORIGIN
//     (health, pair, voice, upload, push) before it reaches the network;
//   - DemoConnection stands in for the WebSocket Connection with the same
//     interface, replying to each request type in the shapes
//     electron/mobile-server.js sends.

import { pairingRequest } from './pairings.js';
import { DEMO_ORIGIN } from './host.js';

export { DEMO_ORIGIN };
export const DEMO_CODE = '123456';
// The shape every Mac issues: Pairing.jsx refuses any other.
export const DEMO_TOKEN = 'de'.repeat(32);

// Build 4's demo token: an install already in the demo migrates with it.
const OLD_DEMO_TOKEN = 'demo-review-token';
const isDemoToken = (token) => token === DEMO_TOKEN || token === OLD_DEMO_TOKEN;

export function isDemoOrigin(origin) {
  return origin === DEMO_ORIGIN;
}

// Both halves, or it is not the demo. A real Mac's token saved beside this address
// (an interrupted save on an older build) must never get fake answers.
export function isDemoPairing(origin, token) {
  return isDemoOrigin(origin) && isDemoToken(token);
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const VOICE_TRANSCRIPT = 'What changed in the login fix?';
const VOICE_REPLY = 'The login fix keeps the page you were on and sends you back to it after you sign in.';

// Every request names its Mac (mobile/pairings.js pairingRequest), so a request
// is the demo's exactly when it targets DEMO_ORIGIN.
function demoPath(input) {
  const url = typeof input === 'string' ? input : (input?.url || String(input || ''));
  if (url !== DEMO_ORIGIN && !url.startsWith(`${DEMO_ORIGIN}/`)) return null;
  return url.slice(DEMO_ORIGIN.length).split('?')[0] || '/';
}

// Wraps window.fetch once. Only demo requests (see demoPath) are answered
// here; every other request passes through untouched.
export function installDemoFetch() {
  if (typeof window === 'undefined' || window.__dobiusDemoFetch) return;
  const realFetch = window.fetch.bind(window);
  window.__dobiusDemoFetch = true;
  window.fetch = async (input, init) => {
    const path = demoPath(input);
    if (path === null) return realFetch(input, init);
    await new Promise((r) => setTimeout(r, 250)); // feels like a real round trip
    // A real Mac's token is refused like a Mac would, never answered with a fake success.
    const auth = new Headers(init?.headers || (typeof input === 'object' ? input?.headers : undefined)).get('Authorization');
    if (auth && !isDemoToken(auth.replace(/^Bearer /, ''))) return json({ ok: false, error: 'auth' }, 401);
    if (path === '/health') return json({ ok: true, app: 'dobius-plus', demo: true });
    if (path === '/pair') {
      let code = '';
      try { code = String(JSON.parse(init?.body || '{}').code || ''); } catch { /* bad body */ }
      return code === DEMO_CODE
        ? json({ ok: true, token: DEMO_TOKEN, name: 'Demo Mac' })
        : json({ ok: false, error: 'Invalid pairing code. The demo code is 123456.' });
    }
    if (path === '/voice/audio') return json({ ok: true, transcript: VOICE_TRANSCRIPT, requestId: 'demo-voice' });
    if (path === '/voice/reply') {
      await new Promise((r) => setTimeout(r, 1200));
      return json({ ok: true, reply: VOICE_REPLY });
    }
    if (path === '/upload') return json({ ok: true, path: '/Users/demo/Uploads/screenshot.png' });
    if (path.startsWith('/push')) return json({ ok: false, error: 'Notifications are not available in the demo.' });
    return json({ ok: false, error: 'Not available in the demo.' }, 404);
  };
}

// ---- Sample data ---------------------------------------------------------

const P_WEB = '/Users/demo/Projects/acme-web';
const P_NOTES = '/Users/demo/Projects/notes-app';
const minsAgo = (m) => Date.now() - m * 60_000;
const iso = (m) => new Date(minsAgo(m)).toISOString();

function initialTranscripts() {
  return {
    'demo-login': [
      { role: 'user', content: 'Users get sent to the home page after signing in instead of the page they were on. Can you fix that?', timestamp: iso(42) },
      { role: 'assistant', content: 'I found it. `LoginForm` always redirects to `/` after a successful sign-in. I changed it to read the `next` parameter, check that it is a path on this site, and redirect there.\n\n- `src/auth/LoginForm.tsx`: redirect to `next` when it is a safe relative path\n- `src/auth/redirect.ts`: new `safeNext()` helper\n- `src/auth/redirect.test.ts`: 6 tests, including one that rejects `//evil.com`\n\nAll 48 tests pass.', timestamp: iso(39) },
      { role: 'user', content: 'Nice. Open a PR for it.', timestamp: iso(37) },
      { role: 'assistant', content: 'Opened **#214 Keep the page after sign-in** with a short description and the test output.', timestamp: iso(36) },
    ],
    'demo-tests': [
      { role: 'user', content: 'Add tests for the orders API, the happy path and the error cases.', timestamp: iso(9) },
      { role: 'assistant', content: 'Reading `src/api/orders.ts` and the existing test setup first.', timestamp: iso(8) },
    ],
    'demo-readme': [
      { role: 'user', content: 'Update the README install steps for the new CLI flags.', timestamp: iso(60 * 26) },
      { role: 'assistant', content: 'Updated the Install and Usage sections: documented `--watch` and `--port`, and replaced the old `npm run start:dev` step.', timestamp: iso(60 * 26 - 2) },
    ],
    'demo-sync': [
      { role: 'user', content: 'Make the notes sync retry when the network drops.', timestamp: iso(60 * 5) },
      { role: 'assistant', content: 'Adding exponential backoff to `syncQueue.flush()`, capped at 30 seconds…', timestamp: iso(60 * 5 - 1) },
    ],
  };
}

function initialTabs() {
  return [
    { id: `term-${P_WEB}~w-demodemo-1`, cwd: P_WEB, projectPath: P_WEB, projectName: 'acme-web', label: 'Fix login redirect', status: 'done', verb: '', lastActivityAt: minsAgo(36), model: 'Opus', ctxPct: 34, sessionId: 'demo-login', claudeLive: true, sessionProject: P_WEB },
    { id: `term-${P_WEB}~w-demodemo-2`, cwd: P_WEB, projectPath: P_WEB, projectName: 'acme-web', label: 'Orders API tests', status: 'working', verb: 'Pondering', lastActivityAt: minsAgo(1), model: 'Sonnet', ctxPct: 12, sessionId: 'demo-tests', claudeLive: true, sessionProject: P_WEB },
    { id: `term-${P_NOTES}~w-demodemo-3`, cwd: P_NOTES, projectPath: P_NOTES, projectName: 'notes-app', label: 'Tab 1', status: 'idle', verb: '', lastActivityAt: minsAgo(15), model: '', ctxPct: null, sessionId: null, claudeLive: false, sessionProject: null },
  ];
}

const PROJECTS = [
  { path: P_WEB, name: 'acme-web' },
  { path: P_NOTES, name: 'notes-app' },
];

const SKILLS = [
  { name: 'review', description: 'Review the current changes for bugs before shipping', source: 'user' },
  { name: 'test', description: 'Run the test suite and fix what fails', source: 'user' },
  { name: 'release-notes', description: 'Draft release notes from recent commits', source: 'user' },
];

const PROMPT = '\x1b[32mdemo@mac\x1b[0m \x1b[34mnotes-app\x1b[0m % ';

function cannedReply(text) {
  const t = text.toLowerCase();
  if (/test/.test(t)) return 'Ran the suite: **48 passed**, 0 failed. Nothing else to fix.';
  if (/pr|pull request/.test(t)) return 'Pushed the branch and opened a pull request with a summary of the change.';
  if (/explain|what|why|how/.test(t)) return 'Short version: the redirect target now comes from the `next` parameter, and `safeNext()` only accepts paths on this site, so a crafted link cannot send someone elsewhere.';
  // Never quote the user's text back: it would render as Markdown, and an
  // image link in it would load from the network.
  return 'Done. I read the relevant files, made the change and ran the tests (all passing).\n\nThis is the Dobius+ demo, so these replies are samples. Paired with your Mac, this is your real Claude Code session.';
}

// ---- DemoConnection --------------------------------------------------------

const localDayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Sample Today cards: made up, like every other demo row.
function demoTodayCards() {
  const day = localDayOf(new Date());
  return [
    { id: 'demo-card-1', rev: 1, source: 'email', who: 'Jordan Lee', subject: 'Sign off on the launch checklist', summary: 'Needs your yes before Friday.', priority: 'high', due: day, reason: 'Due today and the launch waits on your sign-off.' },
    { id: 'demo-card-2', rev: 1, source: 'asana', who: 'Priya Shah', subject: 'Review the onboarding copy', summary: 'Three screens, comments in the doc.', priority: 'medium', due: null, reason: 'Priya asked twice this week.' },
    { id: 'demo-card-3', rev: 1, source: 'meeting', who: 'Design sync', subject: 'Send the logo options to the team', summary: 'You said you would after the call.', priority: 'medium', due: null, reason: 'A promise from yesterday\'s call.' },
  ];
}

export class DemoConnection {
  constructor(pairing) {
    this.pairing = Object.freeze({ ...pairing });
    this.token = this.pairing.token;
    this.origin = this.pairing.origin;
    this.closed = false;
    this.abortController = new AbortController();
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.status = 'disconnected';
    this.tabs = initialTabs();
    this.transcripts = initialTranscripts();
    this.screens = {}; // tab id -> raw terminal text (ANSI)
    this.attached = new Set();
    this.timers = new Set();
    this.counter = 3; // the seeded tabs are 1 to 3
    // Session id -> project path, kept after its tab closes (History).
    this.sessionProject = { 'demo-login': P_WEB, 'demo-tests': P_WEB, 'demo-readme': P_WEB, 'demo-sync': P_NOTES };
    this.inputLine = {}; // tab id -> characters typed in the raw terminal
    this.replyTimers = {}; // tab id -> pending reply timer (Esc cancels it)
    this.pending = {}; // tab id -> prompts waiting for their reply, oldest first
    this.looseAt = minsAgo(300); // fixed, or a dismissal would never stick
    this.looseResolved = new Set(); // loose ends picked back up this session
    this.todayCards = demoTodayCards();
    this.todaySnoozed = [];
    this.demoSettings = { todayNudges: { imessage: false, mac: true, push: true, morningAt: '08:00', quietAfter: '20:00' }, newTabTool: 'claude', autoMode: false };
    for (const t of this.tabs) this.screens[t.id] = this._initialScreen(t);
  }

  // Same as Connection.request: installDemoFetch answers it.
  async request(path, options = {}) {
    if (this.closed) throw new Error('Connection closed');
    const request = pairingRequest(this.pairing, path, options);
    return fetch(request.url, request.options);
  }

  onMessage(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  onStatus(cb) { this.statusListeners.add(cb); return () => this.statusListeners.delete(cb); }

  _setStatus(s) {
    this.status = s;
    for (const cb of this.statusListeners) { try { cb(s); } catch { /* noop */ } }
  }

  _emit(msg) {
    for (const cb of this.listeners) { try { cb(msg); } catch { /* noop */ } }
  }

  _later(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  // The project's most recently active conversation (claude --continue).
  _latestSession(projectPath) {
    let best = projectPath === P_NOTES ? 'demo-sync' : 'demo-login';
    let bestAt = -1;
    for (const [sid, p] of Object.entries(this.sessionProject)) {
      const e = this.transcripts[sid];
      if (p !== projectPath || !e?.length) continue;
      const at = Date.parse(e[e.length - 1].timestamp) || 0;
      if (at > bestAt) { best = sid; bestAt = at; }
    }
    return best;
  }

  // Esc: stop whatever Claude is doing in this tab, like the real TUI.
  _interrupt(tab) {
    if (tab.status !== 'working') return;
    this.inputLine[tab.id] = ''; // the fresh prompt below starts empty
    clearTimeout(this.replyTimers[tab.id]);
    delete this.replyTimers[tab.id];
    delete this.pending[tab.id];
    if (tab.claudeLive && tab.sessionId) {
      (this.transcripts[tab.sessionId] || (this.transcripts[tab.sessionId] = []))
        .push({ role: 'assistant', content: 'Interrupted. What should I do instead?', timestamp: new Date().toISOString() });
    }
    this._write(tab.id, '\r\n\x1b[2m[Interrupted by user]\x1b[0m\r\n> ');
    this._setStatusOf(tab.id, 'done');
  }

  connect() {
    this._setStatus('connecting');
    this._later(150, () => {
      this._setStatus('connected');
      this._setStatus('authed');
      this.features = ['ack', 'today', 'settings'];
      this._emit({ type: 'authed', version: 'demo', features: this.features });
      this._pushTerminals();
    });
  }

  wake() { if (this.status !== 'authed') this.connect(); }

  close() {
    this.closed = true;
    this.abortController.abort();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this._setStatus('disconnected');
  }

  _tab(id) { return this.tabs.find((t) => t.id === id); }

  _pushTerminals() {
    this._emit({ type: 'terminals', list: this.tabs.map((t) => ({ ...t, pid: 1000 })), recentExits: [] });
  }

  _initialScreen(t) {
    if (!t.claudeLive) return `\x1b[2mLast login: today on ttys001\x1b[0m\r\n${PROMPT}`;
    const lines = (this.transcripts[t.sessionId] || []).map((m) => (m.role === 'user'
      ? `\x1b[1m> ${m.content}\x1b[0m`
      : `\x1b[38;5;173m●\x1b[0m ${m.content.replace(/\n/g, '\r\n  ')}`));
    return `\x1b[38;5;173m✻ Welcome to Claude Code\x1b[0m\r\n\r\n${lines.join('\r\n\r\n')}\r\n\r\n> `;
  }

  _write(id, data) {
    this.screens[id] = (this.screens[id] || '') + data;
    if (this.attached.has(id)) this._emit({ type: 'output', id, data });
  }

  _setStatusOf(id, status, verb = '') {
    const t = this._tab(id);
    if (!t) return;
    t.status = status;
    t.verb = verb;
    t.lastActivityAt = Date.now();
    this._pushTerminals();
  }

  _newTab({ projectPath, sessionId = null, claudeLive = false, label }) {
    this.counter += 1;
    // An id space no real Mac uses (window key `w-demodemo`), so drafts and
    // pins saved under a demo tab never attach to a real phone terminal.
    const id = `term-${projectPath && PROJECTS.some((x) => x.path === projectPath) ? projectPath : P_WEB}~w-demodemo-${this.counter}`;
    const p = PROJECTS.find((x) => x.path === projectPath) || PROJECTS[0];
    const tab = {
      id, cwd: p.path, projectPath: p.path, projectName: p.name, label: label || `Phone ${this.counter}`,
      status: claudeLive ? 'done' : 'idle', verb: '', lastActivityAt: Date.now(), model: claudeLive ? 'Opus' : '',
      ctxPct: claudeLive ? 8 : null, sessionId, claudeLive, sessionProject: sessionId ? p.path : null,
    };
    this.tabs.push(tab);
    this.screens[id] = this._initialScreen(tab);
    return tab;
  }

  // A chat message (or a line typed in the raw terminal): Claude "works" for
  // a moment, then answers. `echoed` = the characters are already on screen.
  _converse(tab, text, echoed = false) {
    if (!tab.claudeLive) {
      // A plain shell: starting Claude turns it into a session; --continue /
      // --resume picks the project's latest sample conversation back up.
      if (/^claude\b/.test(text)) {
        const resume = /--(continue|resume)\b|\s-c\b/.test(text);
        const sid = resume ? this._latestSession(tab.cwd) : `demo-new-${tab.id}`;
        if (!this.transcripts[sid]) this.transcripts[sid] = [];
        this.sessionProject[sid] = this.sessionProject[sid] || tab.cwd;
        this.looseResolved.add(sid);
        Object.assign(tab, { claudeLive: true, sessionId: sid, sessionProject: tab.cwd, model: 'Opus', ctxPct: resume ? 21 : 3, status: 'done' });
        this._write(tab.id, `${echoed ? '' : text}\r\n\r\n${this._initialScreen(tab)}`);
        this._pushTerminals();
        return;
      }
      this._write(tab.id, `${echoed ? '' : text}\r\n\x1b[2m(demo shell: commands are not run)\x1b[0m\r\n${PROMPT}`);
      return;
    }
    const list = this.transcripts[tab.sessionId] || (this.transcripts[tab.sessionId] = []);
    list.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
    this._write(tab.id, `${echoed ? '' : text}\r\n`);
    this._setStatusOf(tab.id, 'working', 'Thinking');
    // A prompt sent during a turn queues behind it, as the composer says.
    (this.pending[tab.id] || (this.pending[tab.id] = [])).push(text);
    if (!this.replyTimers[tab.id]) this._replyNext(tab, list);
  }

  _replyNext(tab, list) {
    this.replyTimers[tab.id] = this._later(2200, () => {
      delete this.replyTimers[tab.id];
      const reply = cannedReply(this.pending[tab.id].shift());
      list.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
      this._write(tab.id, `\r\n\x1b[38;5;173m●\x1b[0m ${reply.replace(/\n/g, '\r\n  ')}\r\n\r\n> `);
      if (this.pending[tab.id].length > 0) this._replyNext(tab, list);
      else this._setStatusOf(tab.id, 'done');
    });
  }

  send(msg) {
    if (!msg || typeof msg !== 'object') return;
    // Answer asynchronously, like a socket would, so screens that set state
    // right after send() see the reply on a later tick.
    this._later(60, () => this._handle(msg));
  }

  _handle(msg) {
    switch (msg.type) {
      case 'ping': this._emit({ type: 'pong' }); break;
      case 'listTerminals': this._pushTerminals(); break;
      case 'attach': {
        const t = this._tab(msg.id);
        if (!t) { this._emit({ type: 'terminalMissing', id: msg.id }); break; }
        this.attached.add(msg.id);
        this._emit({ type: 'output', id: msg.id, data: `\x1b[0m${this.screens[msg.id] || ''}`, replay: true });
        this._emit({ type: 'attached', id: msg.id });
        break;
      }
      case 'detach': this.attached.delete(msg.id); break;
      case 'input': {
        // Raw terminal typing: echo characters, Enter submits the line.
        const t = this._tab(msg.id);
        if (!t || typeof msg.data !== 'string') break;
        if (msg.data === '\x03' && t.status !== 'working') {
          // ^C at an idle prompt drops the half-typed line, like a shell.
          this.inputLine[t.id] = '';
          this._write(t.id, t.claudeLive ? '^C\r\n> ' : `^C\r\n${PROMPT}`);
          break;
        }
        if (msg.data === '\x1b' || msg.data === '\x03') { this._interrupt(t); break; }
        if (/^\x1b/.test(msg.data)) break; // arrow keys and the like
        for (const ch of msg.data) {
          const line = this.inputLine[t.id] || '';
          if (ch === '\r' || ch === '\n') {
            this.inputLine[t.id] = '';
            if (line.trim()) this._converse(t, line.trim(), true);
            else this._write(t.id, t.claudeLive ? '\r\n> ' : `\r\n${PROMPT}`);
          } else if (ch === '\x7f' || ch === '\b') {
            if (line) { this.inputLine[t.id] = line.slice(0, -1); this._write(t.id, '\b \b'); }
          } else if (ch >= ' ') {
            this.inputLine[t.id] = line + ch;
            this._write(t.id, ch);
          }
        }
        break;
      }
      case 'submitPrompt': {
        const t = this._tab(msg.id);
        // A bare option digit answers a selector, which the demo never shows.
        if (t && typeof msg.text === 'string' && msg.text.trim()) {
          // Chat sends replace anything half-typed in the raw terminal.
          if (this.inputLine[t.id]) {
            this.inputLine[t.id] = '';
            this._write(t.id, `\x1b[2K\r${t.claudeLive ? '> ' : PROMPT}`);
          }
          this._converse(t, msg.text.trim());
        }
        break;
      }
      case 'selectorSnapshot': this._emit({ type: 'selector', id: msg.id, selector: null }); break;
      case 'terminalText': {
        const raw = (this.screens[msg.id] || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
        this._emit({ type: 'terminalText', id: msg.id, text: raw.split('\n').slice(-60).join('\n') });
        break;
      }
      case 'kill': {
        const t = this._tab(msg.id);
        if (!t) break;
        clearTimeout(this.replyTimers[t.id]); // no reply lands after a stop
        delete this.replyTimers[t.id];
        delete this.pending[t.id];
        this.tabs = this.tabs.filter((x) => x.id !== msg.id);
        this._emit({ type: 'exit', id: msg.id, code: 0, signal: null });
        this._pushTerminals();
        break;
      }
      case 'listProjects': this._emit({ type: 'projects', list: PROJECTS }); break;
      case 'createTerminal': {
        const t = this._newTab({ projectPath: msg.cwd });
        this._emit({ type: 'terminalCreated', id: t.id, nonce: typeof msg.nonce === 'string' ? msg.nonce : undefined });
        this._pushTerminals();
        break;
      }
      case 'resumeSession':
      case 'resumeCodexSession': {
        this.looseResolved.add(msg.sessionId);
        // Already open in a tab: go there rather than open a second copy.
        const open = this.tabs.find((x) => x.claudeLive && x.sessionId === msg.sessionId);
        if (open) { this._emit({ type: 'terminalCreated', id: open.id }); break; }
        const t = this._newTab({ projectPath: this.sessionProject[msg.sessionId] || msg.projectPath, sessionId: msg.sessionId, claudeLive: true, label: 'Resumed session' });
        this.sessionProject[msg.sessionId] = this.sessionProject[msg.sessionId] || t.cwd;
        if (!this.transcripts[msg.sessionId]) this.transcripts[msg.sessionId] = [];
        this.screens[t.id] = this._initialScreen(t);
        this._emit({ type: 'terminalCreated', id: t.id });
        this._pushTerminals();
        break;
      }
      case 'listSkills': this._emit({ type: 'skills', list: SKILLS }); break;
      case 'listSessions': {
        const sources = Array.isArray(msg.sources) && msg.sources.length ? msg.sources : ['claude'];
        const known = new Set(['demo-tests', 'demo-login', 'demo-sync', 'demo-readme']);
        // Conversations started in this demo session, newest first.
        const fresh = Object.entries(this.transcripts)
          .filter(([sid, e]) => !known.has(sid) && e.length > 0)
          .map(([sid, e]) => {
            const p = PROJECTS.find((x) => x.path === this.sessionProject[sid]) || PROJECTS[0];
            const first = e.find((m) => m.role === 'user')?.content || 'New conversation';
            return { sessionId: sid, projectPath: p.path, projectName: p.name, preview: first.slice(0, 80), age: 'just now', source: 'claude', timestamp: Date.parse(e[e.length - 1].timestamp) || Date.now() };
          })
          .sort((a, b) => b.timestamp - a.timestamp);
        const list = sources.includes('claude') ? [
          ...fresh,
          { sessionId: 'demo-tests', projectPath: P_WEB, projectName: 'acme-web', preview: 'Orders API tests', age: '1m ago', source: 'claude', timestamp: minsAgo(1) },
          { sessionId: 'demo-login', projectPath: P_WEB, projectName: 'acme-web', preview: 'Fix login redirect', age: '36m ago', source: 'claude', timestamp: minsAgo(36) },
          { sessionId: 'demo-sync', projectPath: P_NOTES, projectName: 'notes-app', preview: 'Retry notes sync when the network drops', age: '5h ago', source: 'claude', timestamp: minsAgo(300) },
          { sessionId: 'demo-readme', projectPath: P_WEB, projectName: 'acme-web', preview: 'Update the README install steps', age: '1d ago', source: 'claude', timestamp: minsAgo(60 * 26) },
        ] : [];
        this._emit({ type: 'sessions', list, sources, reqId: typeof msg.reqId === 'number' ? msg.reqId : undefined });
        break;
      }
      case 'listLooseEnds':
        this._emit({ type: 'looseEnds', list: [
          { sessionId: 'demo-sync', projectPath: P_NOTES, projectName: 'notes-app', lastActivityAt: this.looseAt, sizeMB: 1, ending: 'interrupted', snippet: 'Adding exponential backoff to syncQueue.flush()' },
        ].filter((x) => !this.looseResolved.has(x.sessionId)) });
        break;
      case 'loadTranscript': {
        const entries = this.transcripts[msg.sessionId] || [];
        this._emit({ type: 'transcript', sessionId: msg.sessionId, projectPath: msg.projectPath, sig: null, entries: entries.slice() });
        break;
      }
      case 'todayRead': {
        const day = localDayOf(new Date());
        const open = this.todayCards.filter((c) => !c.done && !this.todaySnoozed.includes(c.id));
        this._emit({ type: 'today', reqId: msg.reqId, ok: true, data: {
          board: { state: 'ok', mode: 'claude', picking: false, pickedAt: new Date(minsAgo(40)).toISOString(), today: day,
            suggested: open.map((c) => ({ ...c, print: `p-${c.id}` })), otherCount: 0, total: open.length, failing: [],
            snoozed: this.todayCards.filter((c) => this.todaySnoozed.includes(c.id)).map((c) => ({ id: c.id, subject: c.subject, who: c.who, source: c.source, until: minsAgo(-24 * 60), sid: `s-${c.id}` })) },
          noticed: { state: 'unavailable' } } });
        break;
      }
      case 'inboxRead':
        this._emit({ type: 'inbox', reqId: msg.reqId, ok: true, data: { ok: true, today: localDayOf(new Date()), cards: this.todayCards.filter((c) => !c.done).map((c) => ({ ...c, print: `p-${c.id}` })) } });
        break;
      case 'inboxAct': {
        const c = this.todayCards.find((x) => x.id === msg.id);
        if (c) c.done = msg.kind !== 'undo';
        this._emit({ type: 'todayResult', reqId: msg.reqId, op: msg.kind, id: msg.id, ok: !!c });
        break;
      }
      case 'todaySnooze':
        if (!this.todaySnoozed.includes(msg.id)) this.todaySnoozed.push(msg.id);
        this._emit({ type: 'todayResult', reqId: msg.reqId, op: 'snooze', id: msg.id, ok: true });
        break;
      case 'todayUnsnooze':
        this.todaySnoozed = this.todaySnoozed.filter((x) => x !== msg.id);
        this._emit({ type: 'todayResult', reqId: msg.reqId, op: 'unsnooze', id: msg.id, ok: true });
        break;
      case 'settingsRead':
        this._emit({ type: 'settings', reqId: msg.reqId, ok: true, data: { ...this.demoSettings, info: { version: 'demo', account: 'Sample account', imessageReady: false, phonePush: false } } });
        break;
      case 'settingsWrite': {
        if (msg.key === 'todayNudges') this.demoSettings.todayNudges = { ...this.demoSettings.todayNudges, ...msg.value };
        else if (msg.key === 'newTabTool' || msg.key === 'autoMode') this.demoSettings[msg.key] = msg.value;
        this._emit({ type: 'settingsResult', reqId: msg.reqId, key: msg.key, ok: true });
        break;
      }
      default: break; // auth, authorizeTab, resize: nothing to do
    }
  }
}
