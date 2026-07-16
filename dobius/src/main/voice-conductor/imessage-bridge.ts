import os from 'node:os'
import path from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { extractChatDbMessageText } from '../imessage-bridge/chat-db-message-text'
import { sendImessage } from '../imessage-bridge/imessage-send'
import type { IMessageBridge } from './types'

// Voice Conductor iMessage bridge (macOS only). Lets the background conductor
// session text Carson to ask a blocking question or send a "work done" report.
//
// Reuses the app's existing primitives instead of re-implementing them:
//   - sendImessage()             → osascript send + outbound rate limit
//   - extractChatDbMessageText() → decode plain/attributedBody message text
//   - SyncDatabase               → node:sqlite reader for chat.db
//
// Permissions required (one-time, macOS System Settings → Privacy & Security):
//   - Automation → Messages.app  (osascript send)
//   - Full Disk Access           (read ~/Library/Messages/chat.db for replies)

const DEFAULT_CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Config for {@link createIMessageBridge}. The recipient handle and any machine
 * path come from here — nothing is hardcoded.
 */
export type VoiceConductorImessageConfig = {
  /** Carson's iMessage handle (email or phone) that the conductor texts. */
  handle: string
  /** Override the chat.db path (default: ~/Library/Messages/chat.db). */
  chatDbPath?: string
  /** How often ask() re-scans chat.db for a reply (default 2000ms). */
  pollIntervalMs?: number
  /**
   * Platform to gate on. Defaults to process.platform; injectable so the gate
   * can be unit-tested without a real macOS host.
   */
  platform?: NodeJS.Platform
}

// Reply lookup: any message in the conductor↔Carson thread newer than the
// baseline ROWID captured before we sent the question. is_from_me is NOT
// filtered so this works whether Carson replies from a separate device
// (inbound, is_from_me=0) or the same Apple ID / self-thread (is_from_me=1).
// The question's own echo row is excluded by text comparison in the caller.
const NEW_REPLY_SQL = `
  SELECT message.ROWID AS rowid,
         message.text AS text,
         message.attributedBody AS attributedBody
  FROM message
  LEFT JOIN handle ON message.handle_id = handle.ROWID
  LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
  LEFT JOIN chat ON chat_message_join.chat_id = chat.ROWID
  WHERE message.ROWID > ?
    AND (handle.id = ? OR chat.guid LIKE ?)
  ORDER BY message.ROWID ASC
  LIMIT 50
`

type ReplyRow = {
  rowid: number
  text: string | null
  attributedBody: Uint8Array | null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function maxRowid(db: SyncDatabase.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS maxRowid FROM message').get() as {
    maxRowid: number
  }
  return row.maxRowid
}

/**
 * Create the Voice Conductor's iMessage bridge.
 *
 * - `isAvailable()` — true only on macOS. It does NOT probe Automation / Full
 *   Disk Access permissions (that would spawn osascript and could trigger a
 *   TCC prompt); it is a cheap platform gate. send()/ask() surface the real
 *   permission errors when they run.
 * - `send(text)` — sends an iMessage to `config.handle`. Rejects on non-macOS
 *   or if the send fails (rate limit, Automation denied, empty text).
 * - `ask(question, timeoutMs = 5min)` — sends `question`, then polls chat.db
 *   for the next NEW message in that thread that isn't the question echo.
 *   Resolves with the reply text, or an EMPTY STRING '' on timeout (the
 *   sentinel — callers distinguish "no answer yet" from a thrown error).
 *   Rejects on non-macOS, or if chat.db can't be opened / the send fails.
 */
export function createIMessageBridge(config: VoiceConductorImessageConfig): IMessageBridge {
  const platform = config.platform ?? process.platform
  const chatDbPath = config.chatDbPath ?? DEFAULT_CHAT_DB_PATH
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  function isAvailable(): boolean {
    return platform === 'darwin'
  }

  async function send(text: string): Promise<void> {
    if (!isAvailable()) {
      throw new Error('iMessage bridge unavailable: macOS only')
    }
    await sendImessage(config.handle, text)
  }

  async function ask(question: string, timeoutMs = DEFAULT_ASK_TIMEOUT_MS): Promise<string> {
    if (!isAvailable()) {
      throw new Error('iMessage bridge unavailable: macOS only')
    }
    // Open chat.db first so a missing Full Disk Access grant fails BEFORE we
    // text the user a question we could never read the answer to.
    const db = new SyncDatabase(chatDbPath, { readonly: true, fileMustExist: true })
    try {
      const baseline = maxRowid(db)
      await sendImessage(config.handle, question)

      const statement = db.prepare(NEW_REPLY_SQL)
      const chatGuidLike = `%${config.handle}%`
      const questionEcho = question.trim()
      const deadline = Date.now() + timeoutMs

      while (Date.now() < deadline) {
        const rows = statement.all(baseline, config.handle, chatGuidLike) as ReplyRow[]
        for (const row of rows) {
          const reply = extractChatDbMessageText(row)?.trim()
          // Skip empties and our own outbound question row (same text, newer ROWID).
          if (!reply || reply === questionEcho) {
            continue
          }
          return reply
        }
        await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))
      }
      return ''
    } finally {
      db.close()
    }
  }

  return { isAvailable, send, ask }
}
