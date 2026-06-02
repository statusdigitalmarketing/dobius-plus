/**
 * imessage-bridge.js — text yourself in iMessage, drive Dobius+ from anywhere.
 *
 * Polls ~/Library/Messages/chat.db every 2s for new messages Sam sent to
 * himself with the trigger prefix (default "d:"). Each matched message is
 * dispatched into the existing Voice Conductor (/voice/intent flow) via a
 * generated requestId; when the Conductor calls dobius-reply with that id,
 * the bridge sends an iMessage back via osascript to close the loop.
 *
 * Permissions required (one-time, prompted in Settings):
 *   - Full Disk Access (read chat.db SQLite)
 *   - Automation for Messages.app (osascript send)
 *
 * Safety:
 *   - Mandatory trigger prefix → "pick up milk" never becomes a command
 *   - Self-thread filter → only messages where the recipient handle matches
 *     the configured selfHandle (Sam's own iMessage identity)
 *   - Rate limit: max 10 outbound iMessages/min (queue overflow rejected)
 *   - lastSeenRowid persisted → restart doesn't re-process history
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import { writeTerminal } from './terminal-manager.js';
import { getVoiceConductorTabId } from './voice-conductor.js';
import { subscribeReply } from './voice-bridge.js';
import { getImessageBridge, updateImessageBridge } from './config-manager.js';

const execFileP = promisify(execFile);

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const POLL_INTERVAL_MS = 2000;
const REPLY_TIMEOUT_MS = 90 * 1000;       // wait up to 90s for Conductor reply
const OUTBOUND_RATE_LIMIT_PER_MIN = 10;   // cap iMessage sends

let pollTimer = null;
let db = null;
let outboundTimestamps = [];              // sliding window for rate limit
let isStartingUp = false;
let isPolling = false;                    // prevent overlapping polls

// --- Public API -----------------------------------------------------------

/**
 * Start the bridge if config.imessageBridge.enabled is true. Idempotent.
 */
export function startImessageBridge() {
  if (pollTimer || isStartingUp) return;
  const cfg = getImessageBridge();
  if (!cfg.enabled) {
    console.log('[imessage-bridge] disabled in config, not starting');
    return;
  }
  if (!cfg.selfHandle) {
    console.warn('[imessage-bridge] no selfHandle configured — enable + set handle in Settings first');
    return;
  }
  isStartingUp = true;
  try {
    db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    console.log(`[imessage-bridge] opened ${CHAT_DB_PATH} (readonly), watching handle: ${cfg.selfHandle}`);
  } catch (err) {
    console.warn(`[imessage-bridge] could not open chat.db: ${err.message}. Grant Full Disk Access in Settings.`);
    isStartingUp = false;
    return;
  }
  // First poll immediately, then on interval. Initialize lastSeenRowid to the
  // current MAX(ROWID) on first enable so we don't re-process the entire
  // history on first run.
  if (!cfg.lastSeenRowid || cfg.lastSeenRowid <= 0) {
    try {
      const max = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS m FROM message').get().m;
      updateImessageBridge({ lastSeenRowid: max });
      console.log(`[imessage-bridge] initialized lastSeenRowid to ${max} (skipping history)`);
    } catch (err) {
      console.warn(`[imessage-bridge] could not init lastSeenRowid: ${err.message}`);
    }
  }
  pollTimer = setInterval(pollNewMessages, POLL_INTERVAL_MS);
  isStartingUp = false;
}

/**
 * Stop the bridge and release the chat.db handle. Called on app quit.
 */
export function stopImessageBridge() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (db) { try { db.close(); } catch { /* noop */ } db = null; }
}

/**
 * Restart the bridge — call after config changes (enable toggle, handle change).
 */
export function restartImessageBridge() {
  stopImessageBridge();
  startImessageBridge();
}

/**
 * Send an iMessage to the configured selfHandle. Used by the reply path and
 * the "Test send" UI button. Rate-limited to OUTBOUND_RATE_LIMIT_PER_MIN.
 */
export async function sendImessageToSelf(text) {
  const cfg = getImessageBridge();
  if (!cfg.selfHandle) throw new Error('selfHandle not configured');
  if (typeof text !== 'string' || text.length === 0) throw new Error('text required');

  // Rate limit: prune timestamps older than 60s, then check ceiling.
  const now = Date.now();
  outboundTimestamps = outboundTimestamps.filter((t) => now - t < 60_000);
  if (outboundTimestamps.length >= OUTBOUND_RATE_LIMIT_PER_MIN) {
    throw new Error(`outbound rate limit (${OUTBOUND_RATE_LIMIT_PER_MIN}/min) exceeded`);
  }
  outboundTimestamps.push(now);

  // Sanitize text for osascript: escape backslashes + double quotes, strip
  // control chars except newline. AppleScript strings use double quotes and
  // backslash-escape, just like C strings.
  const safeText = String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
  const safeHandle = cfg.selfHandle.replace(/"/g, '');  // handles have no quotes

  const script = `
    tell application "Messages"
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to participant "${safeHandle}" of targetService
      send "${safeText}" to targetBuddy
    end tell`;

  const { stdout, stderr } = await execFileP('/usr/bin/osascript', ['-e', script], {
    timeout: 10_000,
  });
  if (stderr) console.warn(`[imessage-bridge] osascript stderr: ${stderr}`);
  return stdout?.trim() || 'sent';
}

/**
 * Probe info for the Settings UI's "Test" button.
 */
export function getBridgeStatus() {
  const cfg = getImessageBridge();
  return {
    enabled: cfg.enabled,
    selfHandle: cfg.selfHandle,
    triggerPrefix: cfg.triggerPrefix,
    lastSeenRowid: cfg.lastSeenRowid,
    isRunning: !!pollTimer,
    chatDbReadable: tryProbeChatDb(),
    outboundLastMin: outboundTimestamps.filter((t) => Date.now() - t < 60_000).length,
  };
}

function tryProbeChatDb() {
  try {
    const probe = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
    const n = probe.prepare('SELECT COUNT(*) AS n FROM message').get().n;
    probe.close();
    return { ok: true, messageCount: n };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- Polling --------------------------------------------------------------

const NEW_MESSAGES_SQL = `
  SELECT message.ROWID, message.text, message.attributedBody,
         message.is_from_me, handle.id AS handle_id, chat.guid AS chat_guid
  FROM message
  LEFT JOIN handle ON message.handle_id = handle.ROWID
  LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
  LEFT JOIN chat ON chat_message_join.chat_id = chat.ROWID
  WHERE message.ROWID > ?
    AND message.is_from_me = 1
    AND (handle.id = ? OR chat.guid LIKE ?)
  ORDER BY message.ROWID ASC
  LIMIT 50
`;

async function pollNewMessages() {
  if (isPolling || !db) return;
  isPolling = true;
  try {
    const cfg = getImessageBridge();
    const lastSeen = cfg.lastSeenRowid || 0;
    const handle = cfg.selfHandle;
    const chatGuidLike = `%${handle}%`;
    const rows = db.prepare(NEW_MESSAGES_SQL).all(lastSeen, handle, chatGuidLike);
    if (rows.length === 0) return;

    let maxRowid = lastSeen;
    for (const row of rows) {
      if (row.ROWID > maxRowid) maxRowid = row.ROWID;
      const text = extractMessageText(row);
      if (!text) continue;
      const trimmed = text.trim();
      if (!trimmed.toLowerCase().startsWith(cfg.triggerPrefix.toLowerCase())) {
        // Not a Dobius command — skip silently.
        continue;
      }
      const command = trimmed.slice(cfg.triggerPrefix.length).trim();
      if (!command) continue;
      handleCommand(command).catch((err) => {
        console.warn(`[imessage-bridge] handleCommand failed: ${err.message}`);
      });
    }
    // Persist the new high-water mark even if we skipped non-command messages —
    // otherwise we'd re-scan them every poll forever.
    if (maxRowid > lastSeen) updateImessageBridge({ lastSeenRowid: maxRowid });
  } catch (err) {
    console.warn(`[imessage-bridge] poll error: ${err.message}`);
  } finally {
    isPolling = false;
  }
}

/**
 * Dispatch a command into the Voice Conductor and chain its reply back via
 * iMessage. Mirrors the /voice/intent handler in mobile-server.js but talks
 * directly to terminal-manager + voice-bridge in-process.
 */
async function handleCommand(command) {
  const requestId = `req-im-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const conductorId = getVoiceConductorTabId();
  const tagged = `[${requestId}] ${command.replace(/[\r\n]+/g, ' ').slice(0, 4000)}`;
  console.log(`[imessage-bridge] dispatch ${requestId}: ${command.slice(0, 80)}`);

  // Subscribe BEFORE writing so we never miss a fast reply.
  const replyPromise = subscribeReply(requestId, REPLY_TIMEOUT_MS);

  // Chunk write to the Conductor's PTY.
  const CHUNK = 256;
  for (let i = 0; i < tagged.length; i += CHUNK) {
    writeTerminal(conductorId, tagged.slice(i, i + CHUNK));
  }
  writeTerminal(conductorId, '\r');

  const reply = await replyPromise;
  if (!reply) {
    await sendImessageToSelf('(no reply within 90s — Conductor may be busy or offline)').catch(() => {});
    return;
  }
  await sendImessageToSelf(reply.message);
}

// --- AttributedBody decoder ----------------------------------------------

/**
 * Extract user-visible text from a chat.db message row. Prefers the plain
 * `text` column; falls back to a heuristic decode of `attributedBody` (the
 * NeXTStep typedstream blob macOS Ventura+ uses for most outgoing messages).
 *
 * The decoder finds the NSString marker, then scans forward for the longest
 * printable run that isn't a known metadata key (__kIM..., NS...). Works for
 * plain text commands; rich-formatted messages may decode imperfectly but
 * those aren't expected as Dobius commands.
 */
export function extractMessageText(row) {
  if (row.text && row.text.length > 0) return row.text;
  if (!row.attributedBody || !Buffer.isBuffer(row.attributedBody)) return null;
  return decodeAttributedBody(row.attributedBody);
}

const METADATA_KEY_PREFIXES = ['__k', 'NSAttribute', 'NSColor', 'NSDictionary'];

function decodeAttributedBody(buf) {
  const marker = Buffer.from('NSString', 'utf8');
  const start = buf.indexOf(marker);
  if (start < 0) return null;
  // Collect printable-run candidates from after the marker.
  const candidates = [];
  let curStart = -1, curLen = 0;
  const end = Math.min(buf.length, start + 16_384);
  for (let j = start + marker.length; j < end; j++) {
    const b = buf[j];
    // Treat ASCII printable + LF/CR + UTF-8 continuation bytes (0x80-0xBF) +
    // UTF-8 leading bytes (0xC2-0xF4) as part of a printable run.
    const isPrintable = (b >= 0x20 && b < 0x7F) || b === 0x0A || b === 0x0D
      || (b >= 0x80 && b < 0xC0) || (b >= 0xC2 && b <= 0xF4);
    if (isPrintable) {
      if (curStart < 0) curStart = j;
      curLen++;
    } else if (curLen > 0) {
      candidates.push({ start: curStart, len: curLen });
      curStart = -1; curLen = 0;
    }
  }
  if (curLen > 0) candidates.push({ start: curStart, len: curLen });
  // The user text is usually the FIRST run >= 1 char that isn't a known
  // metadata key. Metadata keys are short identifiers like "NSColor" or
  // "__kIMMessagePartAttributeName".
  for (const c of candidates) {
    const text = buf.slice(c.start, c.start + c.len).toString('utf8');
    const trimmed = text.replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, '').trim();
    if (!trimmed) continue;
    if (METADATA_KEY_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    return trimmed;
  }
  return null;
}
