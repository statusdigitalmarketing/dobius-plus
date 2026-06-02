/**
 * voice-bridge.js — localhost-only HTTP server for inter-tab dispatch.
 *
 * The Voice Conductor (a Claude Code session running inside a Dobius+ terminal
 * tab) needs to send work to OTHER Dobius+ tabs. We expose that via a tiny
 * HTTP endpoint bound to 127.0.0.1 only — no LAN, no Tailscale, no internet.
 * A CLI script `dobius-send` is auto-installed to ~/.local/bin so any Bash
 * session running inside Dobius+ can call it.
 *
 * Endpoints (all POST, body is JSON):
 *   /tabSend   { tabId: string, message: string }  -> writeTerminal(tabId, message + '\r')
 *   /tabList   {}                                  -> { tabs: listTerminals() }
 *   /setReply  { message: string }                 -> stores last conductor reply for /voice/reply
 *   /getReply  { since: number? }                  -> { reply, ts } if newer, else 204
 *
 * Security model: bound to 127.0.0.1 only, so only local processes can reach
 * it. Any local user on the Mac is already trusted (they own the keychain).
 * No auth needed; auth would just be a key that the same trusted process
 * could read from disk anyway.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { app } from 'electron';
import { writeTerminal, listTerminals } from './terminal-manager.js';

const PORT = 8421;
const HOST = '127.0.0.1';
const EXPECTED_HOST_HEADER = `${HOST}:${PORT}`;
const MAX_BODY_BYTES = 64 * 1024; // 64KB is plenty for one message

// Per-install secret used to authenticate localhost callers. The token lives
// in a 0o600 file in the user data dir; only the owning Unix user can read
// it, so other accounts on the Mac can't forge requests. Critically, this
// also blocks the DNS-rebinding attack: a hostile webpage that rebinds
// dobius.evil to 127.0.0.1 can connect to our port, but it can't read the
// token file (browser sandbox + same-origin policy), so its requests fail
// the Bearer check even though the TCP source IP is 127.0.0.1.
let bridgeToken = null;
const TOKEN_FILE = path.join(app.getPath('userData'), 'voice-bridge-token');

let server = null;

/**
 * Read the full request body (JSON), enforcing a size cap. Resolves the
 * parsed object or rejects on parse / size error.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

const TAB_ID_RE = /^term-.+-\d+$/;

async function handleTabSend(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` });
  }
  const { tabId, message } = body || {};
  if (typeof tabId !== 'string' || !TAB_ID_RE.test(tabId)) {
    return sendJson(res, 400, { ok: false, error: 'tabId missing or malformed' });
  }
  if (typeof message !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'message must be a string' });
  }
  // Trailing \r so the target shell/TUI submits the line. Long messages get
  // chunked into 256-byte writes so the PTY's input buffer isn't slammed in a
  // single write (matches the desktop sendCommand pattern in TerminalPane).
  const CHUNK = 256;
  let i = 0;
  while (i < message.length) {
    writeTerminal(tabId, message.slice(i, i + CHUNK));
    i += CHUNK;
  }
  writeTerminal(tabId, '\r');
  return sendJson(res, 200, { ok: true, sent: message.length });
}

function handleTabList(_req, res) {
  return sendJson(res, 200, { ok: true, tabs: listTerminals() });
}

// --- Phase 2: work registry endpoints ----------------------------------
// Lazy import to dodge circular dep: work-registry imports imessage-bridge
// which imports voice-bridge.
let workRegistry = null;
async function getWorkRegistry() {
  if (!workRegistry) workRegistry = await import('./work-registry.js');
  return workRegistry;
}

async function handleTrackWork(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` }); }
  const reg = await getWorkRegistry();
  const result = reg.registerWork(body || {});
  return sendJson(res, result.ok ? 200 : 400, result);
}

async function handleGetStatus(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { body = {}; }
  const reg = await getWorkRegistry();
  const target = body?.target;
  const snapshot = reg.formatStatusSnapshot(target);
  const list = reg.getStatus(target);
  return sendJson(res, 200, { ok: true, snapshot, count: list.length });
}

async function handleMarkDone(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` }); }
  const reg = await getWorkRegistry();
  const result = reg.markDone(body?.workId, body?.summary, body?.status);
  return sendJson(res, result.ok ? 200 : 400, result);
}

// --- Phase 3: spawn + lead-tab + ask endpoints --------------------------
// Built-in agents come from main.js — set by setBuiltinAgents below at boot.
let builtinAgentsRef = [];
export function setBuiltinAgents(arr) { builtinAgentsRef = Array.isArray(arr) ? arr : []; }

async function handleSpawn(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` }); }
  try {
    const spawner = await import('./agent-spawner.js');
    const result = await spawner.spawnAgent({
      projectPath: body?.projectPath,
      agentId: body?.agentId,
      initialPrompt: body?.initialPrompt,
      builtinAgents: builtinAgentsRef,
    });
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }
}

async function handleAsk(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` }); }
  try {
    const router = await import('./conversation-router.js');
    const result = await router.askSam(body?.question, body?.timeoutMs);
    return sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleSetLeadTab(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` }); }
  try {
    const spawner = await import('./agent-spawner.js');
    const result = spawner.setLeadTab(body?.projectPath, body?.tabId ?? null);
    return sendJson(res, result.ok ? 200 : 400, result);
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleGetLeadTab(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { body = {}; }
  try {
    const spawner = await import('./agent-spawner.js');
    const leadTabId = spawner.getLeadTab(body?.projectPath);
    return sendJson(res, 200, { ok: true, leadTabId });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

// --- Phase 4: Asana queue endpoints -------------------------------------

async function handleAsanaFetch(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` }); }
  try {
    const q = await import('./asana-queue.js');
    const result = await q.fetchNewTasks({ projectName: body?.projectName });
    if (result.ok) {
      result.summary = q.formatTaskList(result.tasks);
    }
    return sendJson(res, result.ok ? 200 : 400, result);
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleAsanaAllow(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` }); }
  try {
    const q = await import('./asana-queue.js');
    const result = q.addAllowedProject({ name: body?.name, gid: body?.gid });
    return sendJson(res, result.ok ? 200 : 400, result);
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleAsanaListAllowed(_req, res) {
  try {
    const q = await import('./asana-queue.js');
    return sendJson(res, 200, { ok: true, projects: q.listAllowedProjects() });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

// --- Phase 5: scheduled-tasks endpoints + handoff -----------------------

async function handleListScheduled(_req, res) {
  try {
    const s = await import('./scheduled-tasks.js');
    return sendJson(res, 200, { ok: true, tasks: s.listScheduledTasks() });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

async function handleUpdateScheduled(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` }); }
  try {
    const s = await import('./scheduled-tasks.js');
    const result = s.updateScheduledTask(body?.id, body?.patch || {});
    return sendJson(res, result.ok ? 200 : 400, result);
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

// Handoff: write `context` to the target tab, also write a short ack to the
// source tab so it knows the handoff landed. Conductor uses this to chain
// work across agents (e.g. "review tab found a bug -> hand to b2b tab to fix").
async function handleHandoff(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` }); }
  const { fromTabId, toTabId, context } = body || {};
  if (typeof toTabId !== 'string' || !/^term-.+-\d+$/.test(toTabId)) {
    return sendJson(res, 400, { ok: false, error: 'toTabId malformed' });
  }
  if (typeof context !== 'string' || !context.trim()) {
    return sendJson(res, 400, { ok: false, error: 'context required' });
  }
  // Write context (chunked) to the target.
  const CHUNK = 256;
  for (let i = 0; i < context.length; i += CHUNK) writeTerminal(toTabId, context.slice(i, i + CHUNK));
  writeTerminal(toTabId, '\r');
  // Echo a one-liner back to source so it shows up there too.
  if (typeof fromTabId === 'string' && /^term-.+-\d+$/.test(fromTabId)) {
    writeTerminal(fromTabId, `# handoff to ${toTabId} sent\r`);
  }
  return sendJson(res, 200, { ok: true });
}

// Per-request reply table. Each voice intent gets a unique requestId; the
// Conductor must echo that id back in `dobius-reply <id> "<message>"`. The
// matching /voice/reply long-poll reads from this map by id. Critical
// correctness — without this, overlapping intents return each other's replies.
//
// Entries auto-expire after 5 minutes so the map can't grow unbounded if a
// Conductor reply never lands (Claude crash, intent never replied to, etc.).
const REPLY_TTL_MS = 5 * 60 * 1000;
const replies = new Map(); // requestId -> { message, ts }
// In-process subscribers waiting for a reply to a specific requestId. The
// iMessage bridge uses this to chain Conductor replies directly back to
// iMessage without paying HTTP long-poll overhead.
const replyCallbacks = new Map(); // requestId -> { resolve, timer }

function pruneOldReplies() {
  const cutoff = Date.now() - REPLY_TTL_MS;
  for (const [id, r] of replies) {
    if (r.ts < cutoff) replies.delete(id);
  }
}

/**
 * Wait for a Conductor reply for `requestId`. Resolves with { message, ts }
 * when the Conductor calls dobius-reply with that id, or with null on timeout.
 * If the reply already arrived before subscribing, resolves immediately.
 */
export function subscribeReply(requestId, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    if (typeof requestId !== 'string') { resolve(null); return; }
    // Reply already landed before subscription? Resolve immediately.
    const existing = replies.get(requestId);
    if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => {
      replyCallbacks.delete(requestId);
      resolve(null);
    }, timeoutMs);
    replyCallbacks.set(requestId, { resolve, timer });
  });
}

async function handleSetReply(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: `bad body: ${err.message}` });
  }
  const requestId = body?.requestId;
  const msg = body?.message;
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{4,80}$/.test(requestId)) {
    return sendJson(res, 400, { ok: false, error: 'requestId required (alphanumeric + dash)' });
  }
  if (typeof msg !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'message must be a string' });
  }
  pruneOldReplies();
  const entry = { message: msg.slice(0, 4000), ts: Date.now() };
  replies.set(requestId, entry);
  // Notify any in-process subscriber waiting on this requestId (iMessage bridge).
  const sub = replyCallbacks.get(requestId);
  if (sub) {
    replyCallbacks.delete(requestId);
    clearTimeout(sub.timer);
    try { sub.resolve(entry); } catch (err) { console.warn(`[voice-bridge] subscribeReply resolve threw: ${err.message}`); }
  }
  return sendJson(res, 200, { ok: true });
}

async function handleGetReply(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const requestId = body?.requestId;
  if (typeof requestId !== 'string') {
    res.writeHead(400); res.end(); return;
  }
  const r = replies.get(requestId);
  if (r) return sendJson(res, 200, { ok: true, reply: r.message, ts: r.ts });
  res.writeHead(204);
  res.end();
}

/**
 * Read the reply for a specific requestId, or null if not yet set.
 * Used by mobile-server.js's /voice/reply long-poll (in-process call, no HTTP).
 */
export function peekReply(requestId) {
  if (typeof requestId !== 'string') return null;
  return replies.get(requestId) || null;
}

function handleRequest(req, res) {
  // 1. Source IP must be loopback. Bound to 127.0.0.1 so this is belt-and-
  //    suspenders, but cheap to keep.
  const addr = req.socket.remoteAddress;
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
    res.writeHead(403); res.end(); return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405); res.end(); return;
  }
  // 2. Host header must match exactly. A DNS-rebinding attacker would send
  //    Host: dobius.evil (or whatever they rebound), not 127.0.0.1:8421.
  if (req.headers.host !== EXPECTED_HOST_HEADER) {
    res.writeHead(421); res.end(); return; // 421 Misdirected Request
  }
  // 3. Origin must not be set. Our CLI scripts (curl) don't send Origin;
  //    browsers do, even on cross-origin POSTs. Any Origin header means the
  //    request came from a webpage, which has no business calling us.
  if (req.headers.origin !== undefined) {
    res.writeHead(403); res.end(); return;
  }
  // 4. Content-Type must be JSON. Forces CORS preflight for browser callers
  //    (the OPTIONS we never respond to), and prevents accidental form posts.
  const ct = req.headers['content-type'] || '';
  if (!ct.toLowerCase().startsWith('application/json')) {
    res.writeHead(415); res.end(); return;
  }
  // 5. Bearer token must match the file-stored secret. This is the load-
  //    bearing defense against any in-browser attack that bypasses the above.
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${bridgeToken}`;
  if (!bridgeToken || auth.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    res.writeHead(401); res.end(); return;
  }
  if (req.url === '/tabSend') return handleTabSend(req, res);
  if (req.url === '/tabList') return handleTabList(req, res);
  if (req.url === '/setReply') return handleSetReply(req, res);
  if (req.url === '/getReply') return handleGetReply(req, res);
  if (req.url === '/trackWork') return handleTrackWork(req, res);
  if (req.url === '/getStatus') return handleGetStatus(req, res);
  if (req.url === '/markDone') return handleMarkDone(req, res);
  if (req.url === '/spawn') return handleSpawn(req, res);
  if (req.url === '/ask') return handleAsk(req, res);
  if (req.url === '/setLeadTab') return handleSetLeadTab(req, res);
  if (req.url === '/getLeadTab') return handleGetLeadTab(req, res);
  if (req.url === '/asana/fetch') return handleAsanaFetch(req, res);
  if (req.url === '/asana/allow') return handleAsanaAllow(req, res);
  if (req.url === '/asana/listAllowed') return handleAsanaListAllowed(req, res);
  if (req.url === '/scheduled/list') return handleListScheduled(req, res);
  if (req.url === '/scheduled/update') return handleUpdateScheduled(req, res);
  if (req.url === '/handoff') return handleHandoff(req, res);
  res.writeHead(404);
  res.end();
}

/**
 * Load existing token from disk or generate + persist a new one. Mode 0o600
 * means only the owning Unix user can read it.
 */
function loadOrCreateToken() {
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(existing)) {
      bridgeToken = existing;
      return;
    }
  } catch { /* fresh install or corrupted, regenerate */ }
  bridgeToken = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, bridgeToken, { mode: 0o600 });
    // chmod again in case the file already existed with looser perms.
    fs.chmodSync(TOKEN_FILE, 0o600);
  } catch (err) {
    console.warn(`[voice-bridge] could not persist token: ${err.message}`);
  }
}

/**
 * Start the local bridge server. Idempotent — calling twice is a no-op.
 */
export function startVoiceBridge() {
  if (server) return;
  loadOrCreateToken();
  server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`[voice-bridge] listening on http://${HOST}:${PORT}`);
  });
  server.on('error', (err) => {
    console.warn(`[voice-bridge] server error: ${err.message}`);
    server = null;
  });
  installCliScript();
}

/**
 * Stop the local bridge server. Called on app quit.
 */
export function stopVoiceBridge() {
  if (server) {
    server.close();
    server = null;
  }
}

// --- CLI script auto-install ---------------------------------------------

const CLI_VERSION = 7;
const CLI_DIR = path.join(os.homedir(), '.local', 'bin');
const CLI_PATH = path.join(CLI_DIR, 'dobius-send');
const CLI_TABS_PATH = path.join(CLI_DIR, 'dobius-tabs');
const CLI_REPLY_PATH = path.join(CLI_DIR, 'dobius-reply');
const CLI_TRACK_PATH = path.join(CLI_DIR, 'dobius-track');
const CLI_STATUS_PATH = path.join(CLI_DIR, 'dobius-status');
const CLI_MARKDONE_PATH = path.join(CLI_DIR, 'dobius-mark-done');
const CLI_SPAWN_PATH = path.join(CLI_DIR, 'dobius-spawn');
const CLI_ASK_PATH = path.join(CLI_DIR, 'dobius-ask');
const CLI_LEADTAB_PATH = path.join(CLI_DIR, 'dobius-lead-tab');
const CLI_ASANA_FETCH_PATH = path.join(CLI_DIR, 'dobius-asana-fetch');
const CLI_ASANA_ALLOW_PATH = path.join(CLI_DIR, 'dobius-asana-allow');
const CLI_ASANA_LIST_PATH = path.join(CLI_DIR, 'dobius-asana-list-allowed');
const CLI_CONFIRM_PATH = path.join(CLI_DIR, 'dobius-confirm');
const CLI_HANDOFF_PATH = path.join(CLI_DIR, 'dobius-handoff');
const CLI_SCHEDULED_PATH = path.join(CLI_DIR, 'dobius-scheduled');
const CLI_MARKER = `# dobius-cli v${CLI_VERSION}`;

// All CLI scripts read the bridge token from a 0o600 file in userData and
// send it as a Bearer header. Without this header, the bridge rejects every
// request (including from DNS-rebound webpages that reach 127.0.0.1).
const TOKEN_FILE_PATH = TOKEN_FILE;

const CLI_SEND_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Send a message into another Dobius+ terminal tab.
# Usage: dobius-send <tabId> "<message>"
# tabId format: term-/path/to/project-N  (see: dobius-tabs)
set -e
if [ $# -lt 2 ]; then
  echo "usage: dobius-send <tabId> <message>" >&2
  exit 1
fi
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-send: bridge token unreadable (is Dobius+ running?)" >&2; exit 2; }
TAB_ID="$1"; shift
MESSAGE="$*"
RESPONSE=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/tabSend" \\
  -H "Host: 127.0.0.1:${PORT}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"tabId": sys.argv[1], "message": sys.argv[2]}))' "$TAB_ID" "$MESSAGE")")
echo "$RESPONSE"
`;

const CLI_TABS_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# List currently open Dobius+ terminal tabs.
# Usage: dobius-tabs
set -e
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-tabs: bridge token unreadable (is Dobius+ running?)" >&2; exit 2; }
curl -fsS -X POST "http://127.0.0.1:${PORT}/tabList" \\
  -H "Host: 127.0.0.1:${PORT}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d "{}" \\
  | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(t["id"], "-", t["cwd"]) for t in d.get("tabs", [])]'
`;

const CLI_REPLY_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Set the spoken reply for a specific voice request id. The request id arrives
# in the Conductor's input as a [req-XXXX] prefix; pass that same id back here
# so the right /voice/reply long-poll picks it up. Required for correctness
# when multiple voice intents are in flight concurrently.
# Usage: dobius-reply <requestId> "your one-line reply"
set -e
if [ $# -lt 2 ]; then
  echo "usage: dobius-reply <requestId> <message>" >&2
  exit 1
fi
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-reply: bridge token unreadable (is Dobius+ running?)" >&2; exit 2; }
REQUEST_ID="$1"; shift
MESSAGE="$*"
curl -fsS -X POST "http://127.0.0.1:${PORT}/setReply" \\
  -H "Host: 127.0.0.1:${PORT}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"requestId": sys.argv[1], "message": sys.argv[2]}))' "$REQUEST_ID" "$MESSAGE")" \\
  >/dev/null
`;

const CLI_TRACK_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Register a dispatched work item with the registry. Conductor calls this
# right after dobius-send so the registry can auto-text Sam when the work
# completes (tab exits). The requestId ties final-reports back to the
# original iMessage thread; pass the same [req-XXXX] id from your input.
# Usage: dobius-track <workId> <tabId> <requestId> "<description>"
set -e
if [ $# -lt 4 ]; then
  echo "usage: dobius-track <workId> <tabId> <requestId> <description>" >&2
  exit 1
fi
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-track: bridge token unreadable" >&2; exit 2; }
WORK_ID="$1"; TAB_ID="$2"; REQUEST_ID="$3"; shift 3
DESCRIPTION="$*"
curl -fsS -X POST "http://127.0.0.1:${PORT}/trackWork" \\
  -H "Host: 127.0.0.1:${PORT}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"workId": sys.argv[1], "tabId": sys.argv[2], "requestId": sys.argv[3], "description": sys.argv[4]}))' "$WORK_ID" "$TAB_ID" "$REQUEST_ID" "$DESCRIPTION")"
`;

const CLI_STATUS_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Query work-registry. Returns a short snapshot suitable for an iMessage reply.
# Conductor calls this when Sam asks "how's X going" — pipe the snapshot into
# dobius-reply.
# Usage: dobius-status [target]      (target is workId, project name substring, or empty for all)
set -e
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-status: bridge token unreadable" >&2; exit 2; }
TARGET="$*"
curl -fsS -X POST "http://127.0.0.1:${PORT}/getStatus" \\
  -H "Host: 127.0.0.1:${PORT}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"target": sys.argv[1]}))' "$TARGET")" \\
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("snapshot",""))'
`;

const CLI_MARKDONE_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Manually mark a work item as done. Use when the tracked tab won't exit
# (e.g. a long Claude session you observed completing in the output) so the
# final-report iMessage still fires.
# Usage: dobius-mark-done <workId> "<summary>" [status]    (status: completed|failed|cancelled, default completed)
set -e
if [ $# -lt 2 ]; then
  echo "usage: dobius-mark-done <workId> <summary> [status]" >&2
  exit 1
fi
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-mark-done: bridge token unreadable" >&2; exit 2; }
WORK_ID="$1"; SUMMARY="$2"; STATUS="${3-completed}"
curl -fsS -X POST "http://127.0.0.1:${PORT}/markDone" \\
  -H "Host: 127.0.0.1:${PORT}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"workId": sys.argv[1], "summary": sys.argv[2], "status": sys.argv[3]}))' "$WORK_ID" "$SUMMARY" "$STATUS")"
`;

const CLI_SPAWN_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Spawn a fresh Claude agent in a Dobius+ tab. Gated by askSam — Sam gets
# an iMessage prompt to confirm before the spawn fires.
# Usage: dobius-spawn <projectPath> <agentId> ["<initial prompt>"]
set -e
if [ $# -lt 2 ]; then
  echo "usage: dobius-spawn <projectPath> <agentId> [initial prompt]" >&2
  exit 1
fi
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-spawn: bridge token unreadable" >&2; exit 2; }
PROJECT="$1"; AGENT="$2"; shift 2
INITIAL="$*"
curl -fsS -X POST "http://127.0.0.1:${PORT}/spawn" \\
  -H "Host: 127.0.0.1:${PORT}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"projectPath": sys.argv[1], "agentId": sys.argv[2], "initialPrompt": sys.argv[3]}))' "$PROJECT" "$AGENT" "$INITIAL")"
`;

const CLI_ASK_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Ask Sam a question via iMessage and wait up to 5 min for his reply.
# Blocks until Sam responds or timeout. Conductor uses this to gate any
# irreversible / external-visible action (push, delete, asana comment).
# Usage: dobius-ask "<question>"
set -e
if [ $# -lt 1 ]; then
  echo "usage: dobius-ask <question>" >&2
  exit 1
fi
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-ask: bridge token unreadable" >&2; exit 2; }
QUESTION="$*"
curl -fsS --max-time 320 -X POST "http://127.0.0.1:${PORT}/ask" \\
  -H "Host: 127.0.0.1:${PORT}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"question": sys.argv[1]}))' "$QUESTION")" \\
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("answer") or ("(timeout)" if d.get("timedOut") else ""))'
`;

const CLI_LEADTAB_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Get or set the lead tab for a project. Lead tab = Conductor routes new
# work there instead of asking to spawn a fresh agent each time.
# Usage: dobius-lead-tab get <projectPath>
#        dobius-lead-tab set <projectPath> <tabId>
#        dobius-lead-tab clear <projectPath>
set -e
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-lead-tab: bridge token unreadable" >&2; exit 2; }
case "\${1-}" in
  get)
    [ $# -ge 2 ] || { echo "usage: dobius-lead-tab get <projectPath>" >&2; exit 1; }
    curl -fsS -X POST "http://127.0.0.1:${PORT}/getLeadTab" \\
      -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
      --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"projectPath": sys.argv[1]}))' "$2")"
    ;;
  set)
    [ $# -ge 3 ] || { echo "usage: dobius-lead-tab set <projectPath> <tabId>" >&2; exit 1; }
    curl -fsS -X POST "http://127.0.0.1:${PORT}/setLeadTab" \\
      -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
      --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"projectPath": sys.argv[1], "tabId": sys.argv[2]}))' "$2" "$3")"
    ;;
  clear)
    [ $# -ge 2 ] || { echo "usage: dobius-lead-tab clear <projectPath>" >&2; exit 1; }
    curl -fsS -X POST "http://127.0.0.1:${PORT}/setLeadTab" \\
      -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
      --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"projectPath": sys.argv[1], "tabId": None}))' "$2")"
    ;;
  *)
    echo "usage: dobius-lead-tab get|set|clear <projectPath> [tabId]" >&2; exit 1 ;;
esac
`;

const CLI_ASANA_FETCH_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Fetch incomplete Asana tasks for an allowlisted project. Returns JSON
# with .tasks[] and a pre-formatted .summary string suitable for an
# iMessage body. Conductor pipes the summary into dobius-ask for batch
# approval before processing.
# Usage: dobius-asana-fetch <projectName>      (fuzzy substring match)
set -e
[ $# -ge 1 ] || { echo "usage: dobius-asana-fetch <projectName>" >&2; exit 1; }
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-asana-fetch: bridge token unreadable" >&2; exit 2; }
PROJECT="$*"
curl -fsS -X POST "http://127.0.0.1:${PORT}/asana/fetch" \\
  -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"projectName": sys.argv[1]}))' "$PROJECT")"
`;

const CLI_ASANA_ALLOW_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Add an Asana project to the auto-process allowlist. Pass the project's
# display name and its gid (find via the Asana web URL: app.asana.com/0/<GID>/...).
# Usage: dobius-asana-allow <name> <gid>
set -e
[ $# -ge 2 ] || { echo "usage: dobius-asana-allow <name> <gid>" >&2; exit 1; }
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-asana-allow: bridge token unreadable" >&2; exit 2; }
NAME="$1"; GID="$2"
curl -fsS -X POST "http://127.0.0.1:${PORT}/asana/allow" \\
  -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "gid": sys.argv[2]}))' "$NAME" "$GID")"
`;

const CLI_ASANA_LIST_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# List allowlisted Asana projects.
# Usage: dobius-asana-list-allowed
set -e
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-asana-list-allowed: bridge token unreadable" >&2; exit 2; }
curl -fsS -X POST "http://127.0.0.1:${PORT}/asana/listAllowed" \\
  -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{}" \\
  | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(p["name"], p["gid"]) for p in d.get("projects",[])]'
`;

const CLI_CONFIRM_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Pre-action confirmation gate. Calls dobius-ask with a YES/NO-framed
# question. Returns Sam's answer (typically "yes" / "no" / "" on timeout).
# Use BEFORE any irreversible action (gh push, asana comment, delete, etc.).
# Usage: dobius-confirm "Push 5 commits to main?"
set -e
[ $# -ge 1 ] || { echo "usage: dobius-confirm <action description>" >&2; exit 1; }
ACTION="$*"
QUESTION="\${ACTION}\\nReply YES to confirm or NO to skip."
TOKEN=\$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-confirm: bridge token unreadable" >&2; exit 2; }
curl -fsS --max-time 320 -X POST "http://127.0.0.1:${PORT}/ask" \\
  -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer \$TOKEN" -H "Content-Type: application/json" \\
  --data-binary "\$(python3 -c 'import json,sys; print(json.dumps({"question": sys.argv[1]}))' "\$QUESTION")" \\
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("answer") or "")'
`;

const CLI_HANDOFF_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Hand off context from one Dobius+ tab to another. The target tab receives
# the context as its next input + a carriage return. The source tab gets a
# one-line echo so it knows the handoff landed.
# Usage: dobius-handoff <fromTabId> <toTabId> "<context message>"
set -e
[ $# -ge 3 ] || { echo "usage: dobius-handoff <fromTabId> <toTabId> <context>" >&2; exit 1; }
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-handoff: bridge token unreadable" >&2; exit 2; }
FROM="$1"; TO="$2"; shift 2
CONTEXT="$*"
curl -fsS -X POST "http://127.0.0.1:${PORT}/handoff" \\
  -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  --data-binary "$(python3 -c 'import json,sys; print(json.dumps({"fromTabId": sys.argv[1], "toTabId": sys.argv[2], "context": sys.argv[3]}))' "$FROM" "$TO" "$CONTEXT")"
`;

const CLI_SCHEDULED_SCRIPT = `#!/bin/bash
${CLI_MARKER}
# Manage proactive scheduled checkpoints (morning brief, end-of-day, etc).
# Usage: dobius-scheduled list
#        dobius-scheduled enable <id>
#        dobius-scheduled disable <id>
set -e
TOKEN=$(cat "${TOKEN_FILE_PATH}" 2>/dev/null) || { echo "dobius-scheduled: bridge token unreadable" >&2; exit 2; }
case "\${1-list}" in
  list)
    curl -fsS -X POST "http://127.0.0.1:${PORT}/scheduled/list" \\
      -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{}" \\
      | python3 -c 'import json,sys; d=json.load(sys.stdin); [print("[{}]".format("x" if t["enabled"] else " "), t["id"], "-", t.get("prompt","")[:60]) for t in d.get("tasks",[])]'
    ;;
  enable|disable)
    ACTION="\$1"; [ $# -ge 2 ] || { echo "usage: dobius-scheduled \$ACTION <id>" >&2; exit 1; }
    ENABLED=\$([ "\$ACTION" = "enable" ] && echo true || echo false)
    curl -fsS -X POST "http://127.0.0.1:${PORT}/scheduled/update" \\
      -H "Host: 127.0.0.1:${PORT}" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
      --data-binary "{\\\"id\\\": \\\"\$2\\\", \\\"patch\\\": {\\\"enabled\\\": \$ENABLED}}"
    ;;
  *) echo "usage: dobius-scheduled list | enable <id> | disable <id>" >&2; exit 1 ;;
esac
`;

/**
 * Write the dobius-send / dobius-tabs scripts to ~/.local/bin if missing or
 * if the marker version doesn't match. Idempotent + cheap to run on boot.
 */
function installCliScript() {
  try {
    fs.mkdirSync(CLI_DIR, { recursive: true });
    writeIfChanged(CLI_PATH, CLI_SEND_SCRIPT);
    writeIfChanged(CLI_TABS_PATH, CLI_TABS_SCRIPT);
    writeIfChanged(CLI_REPLY_PATH, CLI_REPLY_SCRIPT);
    writeIfChanged(CLI_TRACK_PATH, CLI_TRACK_SCRIPT);
    writeIfChanged(CLI_STATUS_PATH, CLI_STATUS_SCRIPT);
    writeIfChanged(CLI_MARKDONE_PATH, CLI_MARKDONE_SCRIPT);
    writeIfChanged(CLI_SPAWN_PATH, CLI_SPAWN_SCRIPT);
    writeIfChanged(CLI_ASK_PATH, CLI_ASK_SCRIPT);
    writeIfChanged(CLI_LEADTAB_PATH, CLI_LEADTAB_SCRIPT);
    writeIfChanged(CLI_ASANA_FETCH_PATH, CLI_ASANA_FETCH_SCRIPT);
    writeIfChanged(CLI_ASANA_ALLOW_PATH, CLI_ASANA_ALLOW_SCRIPT);
    writeIfChanged(CLI_ASANA_LIST_PATH, CLI_ASANA_LIST_SCRIPT);
    writeIfChanged(CLI_CONFIRM_PATH, CLI_CONFIRM_SCRIPT);
    writeIfChanged(CLI_HANDOFF_PATH, CLI_HANDOFF_SCRIPT);
    writeIfChanged(CLI_SCHEDULED_PATH, CLI_SCHEDULED_SCRIPT);
  } catch (err) {
    console.warn(`[voice-bridge] CLI install failed: ${err.message}`);
  }
}

function writeIfChanged(targetPath, content) {
  let current = '';
  try { current = fs.readFileSync(targetPath, 'utf8'); } catch { /* fresh install */ }
  if (current === content) return;
  fs.writeFileSync(targetPath, content);
  fs.chmodSync(targetPath, 0o755);
  console.log(`[voice-bridge] installed ${targetPath}`);
}
