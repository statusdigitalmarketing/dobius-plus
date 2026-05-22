/**
 * WebSocket client for the Dobius+ mobile bridge.
 *
 * Handles auth, reconnect with backoff, and a wake() hook so the app can
 * force an immediate reconnect when the PWA returns to the foreground (iOS
 * kills WebSockets while a PWA is backgrounded).
 */
export class Connection {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.status = 'disconnected'; // disconnected | connecting | connected | authed
    this.reconnectDelay = 1000;
    this.shouldReconnect = true;
    this._reconnectTimer = null;
    this._pingTimer = null;
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
    this._setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
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
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'authed') {
        this.reconnectDelay = 1000;
        this._setStatus('authed');
        this._startPing();
      }
      this._emit(msg);
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
    if (this.status === 'authed' || this.status === 'connecting') return;
    this.reconnectDelay = 1000;
    this._open();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close() {
    this.shouldReconnect = false;
    clearTimeout(this._reconnectTimer);
    this._stopPing();
    if (this.ws) { try { this.ws.close(); } catch { /* noop */ } }
  }
}
