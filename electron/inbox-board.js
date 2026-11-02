/**
 * Brett's Inbox board (a local Python app, not part of Dobius) read from the
 * Tasks dropdown. READ ONLY: Dobius only ever GETs /api/items. Every action
 * that sends anything (email, text, Asana comment) stays on the board itself,
 * where Brett's own guards and clicks govern it.
 *
 * The board guards its API with a per-install token in <board>/token.txt.
 * That token is read here, sent only to 127.0.0.1, and never handed to the
 * renderer, logged, or returned in an error.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { execFile } from 'child_process';
import { localDay } from '../shared/task-due.js';

// Harness only (an isolated DOBIUS_USERDATA_DIR instance): point at another
// port or folder to show the not-running and no-board states without
// touching the real board. Ignored in a normal launch.
const HARNESS = process.env.DOBIUS_USERDATA_DIR ? process.env : {};
// The port override applies only together with the folder override, so a
// harness pointed elsewhere only ever holds a throwaway token, never the real one.
const harnessDirSet = !!(HARNESS.DOBIUS_INBOX_DIR && path.isAbsolute(HARNESS.DOBIUS_INBOX_DIR));
const harnessPort = harnessDirSet && /^\d{2,5}$/.test(HARNESS.DOBIUS_INBOX_PORT || '') ? Number(HARNESS.DOBIUS_INBOX_PORT) : null;

export const BOARD_PORT = harnessPort || 8765; // fixed in the board's server.py (PORT, TS_PORT = 8765, 8767)
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.brett.inbox-server.plist');
const DEFAULT_DIR = path.join(os.homedir(), 'Projects (Code)', 'inbox-board');
const HARNESS_DIR = HARNESS.DOBIUS_INBOX_DIR && path.isAbsolute(HARNESS.DOBIUS_INBOX_DIR) ? HARNESS.DOBIUS_INBOX_DIR : null;
const MAX_BODY = 16 * 1024 * 1024;
const MAX_CARDS = 300;
const SOURCES = new Set(['email', 'asana', 'text', 'whatsapp', 'meeting']);
const PRIORITY = { high: 0, medium: 1, low: 2 };
// Where a card's "Open original" may go: the hosts the board itself links to.
// An allowlist, not a scrub, because a stand-in on 8765 could hide the token
// in a link in any encoding; only these hosts can ever receive a click.
const LINK_HOSTS = new Set(['mail.google.com', 'accounts.google.com', 'app.asana.com', 'app.fireflies.ai', 'notes.wisprflow.ai']);

function safeLink(v) {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && LINK_HOSTS.has(u.hostname) ? v : null;
  } catch {
    return null; // not a URL: no link
  }
}

export function boardUrl() {
  return `http://127.0.0.1:${BOARD_PORT}/`;
}

/** Where the board lives: its launchd WorkingDirectory, else the usual folder. */
export function findBoardDir({ plist = PLIST, fallback = DEFAULT_DIR, run = execFile, harnessDir = HARNESS_DIR } = {}) {
  return new Promise((resolve) => {
    if (harnessDir) return resolve(harnessDir);
    if (!fs.existsSync(plist)) return resolve(fallback);
    run('/usr/bin/plutil', ['-extract', 'WorkingDirectory', 'raw', '-o', '-', plist], { timeout: 3000 }, (err, out) => {
      const dir = !err && typeof out === 'string' ? out.trim() : '';
      resolve(dir && path.isAbsolute(dir) ? dir : fallback);
    });
  });
}

/**
 * True only when a process of THIS user listens on exactly 127.0.0.1:<port>,
 * the address getJson connects to, and every listener lsof shows there is
 * ours. Another account on this Mac could bind it while the board is down and
 * must never be handed the token. lsof silently omits other users' processes,
 * so a listener of ours on another address (::1, *) proves nothing; only an
 * exact 127.0.0.1 bind does, because while ours holds it no one else can
 * (the board sets no SO_REUSEPORT). Fails closed on no match or any error.
 * A listener swapped in between this check and the connect is an accepted
 * residual.
 */
export function listenerIsMine({ port = BOARD_PORT, run = execFile, uid = process.getuid?.() } = {}) {
  return new Promise((resolve) => {
    if (typeof uid !== 'number') return resolve(false);
    run('/usr/sbin/lsof', ['-nP', '-a', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fpun'], { timeout: 3000 }, (err, out) => {
      if (err || typeof out !== 'string') return resolve(false);
      // -F records: p<pid>, u<uid>, then one n<address> per listening socket.
      let current = null;
      let ownExact = false;
      for (const line of out.split('\n')) {
        if (line.startsWith('u')) current = Number(line.slice(1));
        else if (line.startsWith('n')) {
          if (current !== uid) return resolve(false);
          if (line.slice(1) === `127.0.0.1:${port}`) ownExact = true;
        }
      }
      resolve(ownExact);
    });
  });
}

/** The board's API token, or null. A symlink or an odd-sized file is refused. */
export function readToken(dir) {
  const p = path.join(dir, 'token.txt');
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size === 0 || st.size > 512) return null;
    const tok = fs.readFileSync(p, 'utf8').trim();
    return /^[A-Za-z0-9_-]{16,256}$/.test(tok) ? tok : null;
  } catch {
    return null; // missing or unreadable: the caller reports 'not-installed'
  }
}

function getJson(tok, { port = BOARD_PORT, request = http.request, timeoutMs = 5000, deadlineMs = 8000 } = {}) {
  return new Promise((done) => {
    let settled = false;
    let req = null;
    const resolve = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req?.destroy();
      done(v);
    };
    // timeout below is socket INACTIVITY; this caps the whole read, so a
    // listener dribbling a byte every few seconds cannot hold the panel open.
    const deadline = setTimeout(() => resolve({ ok: false, reason: 'not-running' }), deadlineMs);
    req = request({
      host: '127.0.0.1',
      // A private agent: the global one can honour HTTP_PROXY (NODE_USE_ENV_PROXY),
      // which would carry the token off this Mac.
      agent: new http.Agent({ keepAlive: false }),
      port,
      path: '/api/items',
      method: 'GET',
      // The board checks Host against its own listener and the token in X-Token.
      // No Origin and no X-Visible: reading here must not mark the board "seen".
      headers: { Host: `127.0.0.1:${port}`, 'X-Token': tok, Accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { resolve({ ok: false, reason: 'bad-response' }); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (size > MAX_BODY) return;
        if (res.statusCode === 403) return resolve({ ok: false, reason: 'denied' });
        if (res.statusCode !== 200) return resolve({ ok: false, reason: 'bad-response' });
        try {
          resolve({ ok: true, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ ok: false, reason: 'bad-response' });
        }
      });
      res.on('error', () => resolve({ ok: false, reason: 'not-running' }));
    });
    req.on('timeout', () => resolve({ ok: false, reason: 'not-running' }));
    req.on('error', () => resolve({ ok: false, reason: 'not-running' }));
    req.on('upgrade', () => resolve({ ok: false, reason: 'bad-response' }));
    req.on('close', () => resolve({ ok: false, reason: 'not-running' })); // no-op once settled
    req.end();
  });
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/**
 * The open cards the dropdown shows, most pressing first. Pure: the board's
 * payload in, plain display fields out (nothing that could carry a token or
 * a file path). Cards the board itself hides (held texts, meeting boxes) stay
 * hidden.
 */
export function cardsFrom(payload, today) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const cards = [];
  for (const i of items) {
    if (!i || typeof i !== 'object' || i.status !== 'open' || i.held || i.boxOnly) continue;
    const id = str(i.id, 200);
    if (!id) continue;
    const url = safeLink(i.url);
    cards.push({
      id,
      source: SOURCES.has(i.source) ? i.source : 'other',
      who: str(i.who, 120),
      subject: str(i.subject, 300),
      summary: str(i.summary, 600),
      why: str(i.why, 400),
      priority: PRIORITY[i.priority] !== undefined ? i.priority : 'medium',
      project: str(i.project, 80),
      due: day(i.due),
      since: str(i.waitingSince || i.statusAt, 40) || null,
      meeting: str(i.meeting, 200) || null,
      url,
    });
  }
  const rank = (c) => (c.due && c.due < today ? 0 : c.due === today ? 1 : 2);
  cards.sort((a, b) => rank(a) - rank(b)
    || PRIORITY[a.priority] - PRIORITY[b.priority]
    || (a.due || '9999').localeCompare(b.due || '9999')
    || (a.since || '').localeCompare(b.since || ''));
  const overdue = cards.filter((c) => c.due && c.due < today).length;
  const dueToday = cards.filter((c) => c.due === today).length;
  return { cards: cards.slice(0, MAX_CARDS), total: cards.length, overdue, dueToday };
}

/**
 * Whatever answered on 8765 may not be the board: a stand-in could echo the
 * token back inside a card. Strip it from every field, and drop a link that
 * carried it, so nothing the renderer shows or opens holds the token.
 */
// The token, plainly or percent-encoded (up to three layers). Other encodings
// are an accepted residual: a link can only reach an allowlisted host, and a
// stand-in on 8765 running as this user could read token.txt anyway.
function carries(url, tok) {
  let s = url;
  for (let i = 0; i < 4; i += 1) {
    if (s.includes(tok)) return true;
    let next;
    try { next = decodeURIComponent(s); } catch { return false; } // malformed escape: nothing more to decode
    if (next === s) return false;
    s = next;
  }
  return s.includes(tok);
}

export function withoutToken(result, tok) {
  const cards = result.cards.map((c) => {
    if (!JSON.stringify(c).includes(tok) && !(typeof c.url === 'string' && carries(c.url, tok))) return c;
    const out = {};
    for (const [k, v] of Object.entries(c)) {
      out[k] = typeof v === 'string' ? v.split(tok).join('[hidden]') : v;
    }
    if (typeof c.url === 'string' && carries(c.url, tok)) out.url = null;
    return out;
  });
  return { ...result, cards };
}

/** { ok, url, cards, total, overdue, dueToday } or { ok: false, reason, url }. */
export async function readBoard(opts = {}) {
  const dir = opts.dir || await findBoardDir(opts);
  const url = boardUrl();
  const tok = readToken(dir);
  if (!tok) return { ok: false, reason: 'not-installed', url };
  if (!await (opts.listenerIsMine || listenerIsMine)(opts)) return { ok: false, reason: 'not-running', url };
  const got = await getJson(tok, opts);
  if (!got.ok) return { ok: false, reason: got.reason, url };
  return { ok: true, url, ...withoutToken(cardsFrom(got.payload, opts.today || localDay()), tok) };
}

const LABEL = 'com.brett.inbox-server';

/**
 * 'closed' only when a plain connect to 127.0.0.1:<port> is refused (nothing
 * listens). Sends no bytes, so no token. 'open' when something accepts;
 * 'unknown' on a timeout or any other error. Only 'closed' may start a board.
 */
export function portState({ port = BOARD_PORT, connect = net.connect, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; sock.destroy(); resolve(v); };
    const sock = connect({ host: '127.0.0.1', port });
    sock.setTimeout?.(timeoutMs, () => finish('unknown'));
    sock.once('connect', () => finish('open'));
    sock.once('error', (err) => finish(err?.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
  });
}

/** { installed, canStart }: the board has run here (it made its token), and its launchd job exists. */
export async function boardStatus(opts = {}) {
  const dir = opts.dir || await findBoardDir(opts);
  return { installed: !!readToken(dir), canStart: fs.existsSync(opts.plist || PLIST) };
}

function launchctl(args, run) {
  return new Promise((resolve) => {
    run('/bin/launchctl', args, { timeout: 5000 }, (err) => resolve(!err));
  });
}

/**
 * Start the board through its own launchd job, the way its menu bar app
 * does: kickstart if the job is loaded (a running board is left alone, no -k),
 * else bootstrap it from its plist. Then wait for our listener on 8765.
 * { ok } or { ok: false, reason: 'not-installed' | 'not-started' }.
 */
export async function startBoard(opts = {}) {
  const { plist = PLIST, run = execFile, uid = process.getuid?.(), waitMs = 10000, isMine = listenerIsMine, probe = portState } = opts;
  if (typeof uid !== 'number' || !fs.existsSync(plist)) return { ok: false, reason: 'not-installed' };
  // A harness pointed at another port must never start the REAL board's job:
  // it would check the wrong port and launch a second board beside a running one.
  if (harnessPort && !opts.allowHarness) return { ok: false, reason: 'not-started' };
  // A board already answering (started by hand, outside launchd) must not get
  // a second copy: its startup clears shared temp files and marks in-flight
  // sends unknown before it fails to bind.
  if (await isMine()) return { ok: true };
  // Launch only into a CONFIRMED empty port. A failed or slow lsof says
  // nothing, so it must never be read as "no board".
  const port = await probe();
  if (port !== 'closed') return { ok: false, reason: port === 'open' ? 'busy' : 'not-started' };
  if (!await launchctl(['kickstart', `gui/${uid}/${LABEL}`], run)) {
    await launchctl(['bootstrap', `gui/${uid}`, plist], run);
  }
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    if (await isMine()) return { ok: true };
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: false, reason: 'not-started' };
}
