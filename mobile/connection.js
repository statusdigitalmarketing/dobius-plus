// Deliberate one-shot actions that must survive a reconnect blip. Deliberately
// excludes read requests (list*/loadTranscript), which screens re-issue on
// `authed` themselves, so queuing them too would double-fire. Audit HIGH-5.
// submitPrompt joined in v1.0.62: it was NOT queueable, so a chat message
// typed during the reconnect blip iOS causes on every app foreground was
// silently dropped. That is Sam's "it swallows up messages once in a while":
// the echo bubble appeared (local state), the send went nowhere, and the
// 90s echo pruner eventually erased the evidence.
const QUEUEABLE = new Set(['input', 'submitPrompt', 'kill', 'resumeSession', 'createTerminal']);

/**
 * WebSocket client for the Dobius+ mobile bridge.
 *
 * Handles auth, reconnect with backoff, and a wake() hook so the app can
 * force an immediate reconnect when the PWA returns to the foreground (iOS
 * kills WebSockets while a PWA is backgrounded).
 */
export class Connection {
  constructor(token, origin) {
    this.token = token;
    // The Mac's origin (scheme + host + port) as stored by Pairing.jsx.
    // In the TestFlight self-use build this was implicit via location.host
    // (server.url pointed WKWebView at the Mac). The public App Store build
    // ships a bundled PWA served from capacitor://localhost, so every WS and
    // REST call needs the stored origin explicitly. Empty string = browser
    // dev fallback: use location.host like the pre-App-Store flow.
    this.origin = origin || '';
    this.ws = null;
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.status = 'disconnected'; // disconnected | connecting | connected | authed
    this.reconnectDelay = 1000;
    this.shouldReconnect = true;
    this._reconnectTimer = null;
    this._pingTimer = null;
    // Outbound queue (v1.0.43 resilience): user actions typed during a
    // reconnect blip are buffered and flushed once re-authed, so a command
    // typed while the link drops is delivered, not silently lost. Only
    // deliberate, id-addressed actions queue; ephemeral/re-sent messages
    // (auth, ping, listTerminals, attach, ...) are not.
    this._queue = [];
    // Liveness probe (v1.0.62): iOS can kill the network path while the
    // browser socket still reports OPEN, so a send right after foregrounding
    // vanished with no error (Codex High). While _suspect, queueable sends
    // queue instead of trusting the socket; ANY inbound frame clears it.
    this._suspect = false;
    this._probeTimer = null;
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

  connect() {
    this.shouldReconnect = true;
    this._open();
  }

  _open() {
    clearTimeout(this._reconnectTimer);
    this._stopPing();
    // Fresh socket: any pending liveness probe belonged to the old one.
    this._suspect = false;
    clearTimeout(this._probeTimer);
    this._probeTimer = null;
    this._setStatus('connecting');
    // Native build: this.origin is the stored Mac origin (http[s]://host:port);
    // the WebView origin is capacitor://localhost so location.host would
    // resolve to that and never reach the Mac. Browser dev build:
    // this.origin is empty, fall back to location.host like the pre-App-Store
    // flow. ws:// pairs with http://, wss:// with https://.
    let url;
    if (this.origin) {
      url = this.origin.replace(/^http(s?):\/\//i, (_m, s) => `ws${s}://`).replace(/\/+$/, '') + '/ws';
    } else {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      url = `${proto}://${location.host}/ws`;
    }
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // superseded by a newer socket
      this._setStatus('connected');
      this.send({ type: 'auth', token: this.token });
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      // Any frame proves the path is alive: end a pending liveness probe and
      // release the sends it parked.
      if (this._suspect) {
        this._suspect = false;
        clearTimeout(this._probeTimer);
        this._probeTimer = null;
        if (this.status === 'authed') this._flushQueue();
      }
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      let justAuthed = false;
      if (msg.type === 'authed') {
        this.reconnectDelay = 1000;
        this._setStatus('authed');
        this._startPing();
        justAuthed = true;
      }
      // Emit FIRST so screens re-attach their terminal on `authed`, THEN flush
      // queued input, so the server has the subscription back before the queued
      // keystrokes replay (else the input would run unseen on the Mac). The
      // XtermView attach handler runs synchronously during _emit, ahead of the
      // flush. Codex v1.0.43 Phase 3c P2.
      this._emit(msg);
      if (justAuthed) this._flushQueue();
    };

    ws.onclose = (e) => {
      // Ignore a close from a socket we already replaced (wake() race).
      if (this.ws !== ws) return;
      this._stopPing();
      this._setStatus('disconnected');
      if (e.code === 4003) {
        // Token rejected: stop retrying, let the app re-pair.
        this.shouldReconnect = false;
        this._emit({ type: 'authFailed' });
        return;
      }
      this._scheduleReconnect();
    };

    ws.onerror = () => { /* onclose handles the retry */ };
  }

  /** Keepalive: mobile NAT/carrier middleboxes drop idle sockets in ~60s. */
  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => this.send({ type: 'ping' }), 30000);
  }

  _stopPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  _scheduleReconnect() {
    if (!this.shouldReconnect) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this._open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 15000);
  }

  /** Force an immediate reconnect (e.g. on PWA foreground). */
  wake() {
    if (this.status === 'connecting') return;
    if (this.status === 'authed') {
      // The socket LOOKS open, but after an iOS backgrounding the network
      // path underneath may be gone and readyState still says OPEN. Probe:
      // park queueable sends, ping, and force a reconnect if nothing comes
      // back fast. If the path is fine the pong lands in ~RTT and the parked
      // sends flush immediately.
      this._probeLiveness();
      return;
    }
    this.reconnectDelay = 1000;
    this._open();
  }

  _probeLiveness() {
    if (this._probeTimer) return; // a probe is already in flight
    const ws = this.ws;
    this._suspect = true;
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* dead: timer handles it */ }
    this._probeTimer = setTimeout(() => {
      this._probeTimer = null;
      if (!this._suspect || this.ws !== ws) return;
      // Silence: the socket is a zombie. Reconnect; queued sends flush on
      // the fresh socket's authed.
      this._suspect = false;
      try { ws.close(); } catch { /* noop */ }
      if (this.ws === ws && this.status === 'authed') {
        // Some zombie sockets never fire onclose; drive the state machine.
        this._stopPing();
        this._setStatus('disconnected');
        this.reconnectDelay = 1000;
        this._open();
      }
    }, 2500);
  }

  send(obj) {
    const open = this.ws && this.ws.readyState === WebSocket.OPEN;
    // Send once authed, and let the `auth` handshake through while merely
    // connected (else we'd deadlock: auth is sent before we are authed).
    // While a liveness probe is pending (_suspect), only QUEUEABLE actions
    // are parked (they are one-shot and must not be lost); reads and
    // subscriptions still go out best-effort, because they self-heal: polls
    // re-fire in seconds and attach/list* re-issue on `authed` if the probe
    // ends in a reconnect. Parking them instead silently starved screens
    // that never re-request outside `authed` (Codex round 2 High).
    const park = this._suspect && obj && QUEUEABLE.has(obj.type);
    if (open && !park && (this.status === 'authed' || obj?.type === 'auth')) {
      this.ws.send(JSON.stringify(obj));
      return;
    }
    // Not ready: queue deliberate, one-shot user actions so they survive a
    // reconnect blip. These are the actions NO screen re-issues on re-auth
    // (input/kill keystrokes, and the resumeSession/createTerminal spawns that
    // History/Board fire once). Read requests (listTerminals/listSessions/
    // loadTranscript/listProjects) are NOT queued: their screens re-request them
    // on `authed`, so queuing would just double-fire. Audit HIGH-5.
    if (obj && QUEUEABLE.has(obj.type)) {
      this._queue.push(obj);
      if (this._queue.length > 200) this._queue.shift(); // bound the buffer
    }
  }

  _flushQueue() {
    if (this._queue.length === 0) return;
    const pending = this._queue;
    this._queue = [];
    for (const obj of pending) this.send(obj); // now authed, so these go out
  }

  close() {
    this.shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._probeTimer);
    this._probeTimer = null;
    this._suspect = false;
    this._stopPing();
    if (this.ws) { try { this.ws.close(); } catch { /* noop */ } }
  }
}
