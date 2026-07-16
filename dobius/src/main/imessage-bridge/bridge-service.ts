import os from 'node:os'
import path from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import type {
  ImessageBridgeSendResult,
  ImessageBridgeStatus,
  ImessageBridgeChatDbProbe
} from '../../shared/imessage-bridge'
import { getImessageBridgeConfig, updateImessageBridgeConfig } from './bridge-config'
import { extractChatDbMessageText } from './chat-db-message-text'
import { countOutboundLastMinute, sendImessage } from './imessage-send'
import { handleChannelMessage } from '../agents/agent-channel-service'
import type { PrepareClaudeLaunch } from '../agents/agent-runner'

export { getImessageBridgeConfig, updateImessageBridgeConfig } from './bridge-config'

/** The slice of DobiusRuntimeService the bridge needs; kept structural so the
 *  service stays testable without the full runtime. */
export type ImessageBridgeTerminalDispatcher = {
  resolveActiveTerminal: () => Promise<string>
  sendTerminal: (handle: string, action: { text?: string; enter?: boolean }) => Promise<unknown>
}

const CHAT_DB_PATH = path.join(os.homedir(), 'Library', 'Messages', 'chat.db')
const POLL_INTERVAL_MS = 2_000
const MAX_COMMAND_LENGTH = 4_000

// Self-thread filter: only messages the user sent (is_from_me) in the chat
// with their own handle. `chat.guid LIKE ?` also matches the self-chat rows
// whose handle join is NULL on some macOS versions.
const NEW_MESSAGES_SQL = `
  SELECT message.ROWID AS rowid, message.text AS text, message.attributedBody AS attributedBody
  FROM message
  LEFT JOIN handle ON message.handle_id = handle.ROWID
  LEFT JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
  LEFT JOIN chat ON chat_message_join.chat_id = chat.ROWID
  WHERE message.ROWID > ?
    AND message.is_from_me = 1
    AND (handle.id = ? OR chat.guid LIKE ?)
  ORDER BY message.ROWID ASC
  LIMIT 50
`

type NewMessageRow = {
  rowid: number
  text: string | null
  attributedBody: Uint8Array | null
}

let dispatcher: ImessageBridgeTerminalDispatcher | null = null
let claudeLaunchPreparation: PrepareClaudeLaunch | null = null
let db: SyncDatabase.Database | null = null
let pollTimer: NodeJS.Timeout | null = null
let isPolling = false

function openChatDb(): SyncDatabase.Database {
  return new SyncDatabase(CHAT_DB_PATH, { readonly: true, fileMustExist: true })
}

/**
 * Start polling chat.db if the bridge is enabled and configured. Idempotent;
 * safe to call again after config changes. macOS only (chat.db + osascript).
 */
export function startImessageBridge(
  terminalDispatcher?: ImessageBridgeTerminalDispatcher,
  prepareClaudeLaunch?: PrepareClaudeLaunch
): void {
  if (terminalDispatcher) {
    dispatcher = terminalDispatcher
  }
  if (prepareClaudeLaunch) {
    claudeLaunchPreparation = prepareClaudeLaunch
  }
  if (pollTimer || process.platform !== 'darwin') {
    return
  }
  const config = getImessageBridgeConfig()
  if (!config.enabled) {
    return
  }
  if (!config.selfHandle) {
    console.warn('[imessage-bridge] enabled but no selfHandle configured; not starting')
    return
  }
  try {
    db = openChatDb()
  } catch (error) {
    console.warn(
      '[imessage-bridge] could not open chat.db (grant Full Disk Access in System Settings):',
      error instanceof Error ? error.message : String(error)
    )
    return
  }
  // Why: on first enable, jump the high-water mark to the newest row so the
  // entire message history is never replayed as commands.
  if (config.lastSeenRowid <= 0) {
    try {
      const row = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS maxRowid FROM message').get() as {
        maxRowid: number
      }
      updateImessageBridgeConfig({ lastSeenRowid: row.maxRowid })
    } catch (error) {
      console.warn(
        '[imessage-bridge] could not initialize lastSeenRowid:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  pollTimer = setInterval(() => void pollNewMessages(), POLL_INTERVAL_MS)
  console.log(`[imessage-bridge] watching ${CHAT_DB_PATH} for handle ${config.selfHandle}`)
}

/** Stop polling and release the chat.db handle. Called on app quit. */
export function stopImessageBridge(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (db) {
    try {
      db.close()
    } catch {
      // Why: close() can throw if the underlying handle already died (e.g.
      // Messages.app vacuumed the DB); the bridge is shutting down either way.
    }
    db = null
  }
}

/** Restart after config changes (enable toggle, handle or prefix edits). */
export function restartImessageBridge(): void {
  stopImessageBridge()
  startImessageBridge()
}

function probeChatDb(): ImessageBridgeChatDbProbe {
  try {
    const probe = openChatDb()
    try {
      const row = probe.prepare('SELECT COUNT(*) AS messageCount FROM message').get() as {
        messageCount: number
      }
      return { ok: true, messageCount: row.messageCount }
    } finally {
      probe.close()
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function getImessageBridgeStatus(): ImessageBridgeStatus {
  const config = getImessageBridgeConfig()
  return {
    enabled: config.enabled,
    isRunning: pollTimer !== null,
    triggerPrefix: config.triggerPrefix,
    selfHandle: config.selfHandle,
    lastSeenRowid: config.lastSeenRowid,
    chatDbReadable:
      process.platform === 'darwin'
        ? probeChatDb()
        : { ok: false, error: 'iMessage bridge is only available on macOS' },
    outboundLastMin: countOutboundLastMinute()
  }
}

export async function testImessageSend(): Promise<ImessageBridgeSendResult> {
  const config = getImessageBridgeConfig()
  if (!config.selfHandle) {
    return { ok: false, error: 'selfHandle not configured' }
  }
  try {
    await sendImessage(config.selfHandle, 'Dobius iMessage bridge test: send pipeline works.')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function pollNewMessages(): Promise<void> {
  if (isPolling || !db) {
    return
  }
  isPolling = true
  try {
    const config = getImessageBridgeConfig()
    if (!config.selfHandle) {
      return
    }
    const rows = db
      .prepare(NEW_MESSAGES_SQL)
      .all(config.lastSeenRowid, config.selfHandle, `%${config.selfHandle}%`) as NewMessageRow[]
    if (rows.length === 0) {
      return
    }
    const maxRowid = rows.at(-1)?.rowid ?? config.lastSeenRowid
    for (const row of rows) {
      const text = extractChatDbMessageText(row)?.trim()
      if (!text) {
        continue
      }
      const handled = await tryHandleChannelMessage(text, config.selfHandle)
      if (handled) {
        continue
      }
      const command = matchTriggeredCommand(text, config.triggerPrefix)
      if (command) {
        void dispatchCommand(command, config.selfHandle)
      }
    }
    // Why: advance the high-water mark past skipped non-command messages too,
    // otherwise every poll re-scans them forever.
    if (maxRowid > config.lastSeenRowid) {
      updateImessageBridgeConfig({ lastSeenRowid: maxRowid })
    }
  } catch (error) {
    console.warn(
      '[imessage-bridge] poll error:',
      error instanceof Error ? error.message : String(error)
    )
  } finally {
    isPolling = false
  }
}

async function tryHandleChannelMessage(text: string, selfHandle: string): Promise<boolean> {
  if (!claudeLaunchPreparation) {
    return false
  }
  const result = await handleChannelMessage({
    text,
    replyHandle: selfHandle,
    prepareClaudeLaunch: claudeLaunchPreparation,
    sendReply: (reply) => sendImessage(selfHandle, reply)
  })
  return result === 'handled'
}

function matchTriggeredCommand(text: string, triggerPrefix: string): string | null {
  if (!text.toLowerCase().startsWith(triggerPrefix.toLowerCase())) {
    return null
  }
  const command = text.slice(triggerPrefix.length).trim()
  return command.length > 0 ? command : null
}

/**
 * Type the command into Dobius's active terminal and press Enter, then close the
 * loop with a short iMessage ack (or a hint when no terminal is available).
 */
async function dispatchCommand(command: string, selfHandle: string): Promise<void> {
  const singleLine = command.replace(/[\r\n]+/g, ' ').slice(0, MAX_COMMAND_LENGTH)
  try {
    if (!dispatcher) {
      throw new Error('no_active_terminal')
    }
    const handle = await dispatcher.resolveActiveTerminal()
    await dispatcher.sendTerminal(handle, { text: singleLine, enter: true })
    console.log(`[imessage-bridge] dispatched to ${handle}: ${singleLine.slice(0, 80)}`)
    await sendImessage(selfHandle, '(sent to the active Dobius+ terminal)')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[imessage-bridge] dispatch failed: ${message}`)
    const reply =
      message === 'no_active_terminal'
        ? '(no active terminal in Dobius+ right now; open a terminal and resend)'
        : `(Dobius could not deliver that command: ${message})`
    await sendImessage(selfHandle, reply).catch(() => {
      // Why: the failure reply is best-effort; a rate-limit or Automation
      // permission error here must not crash the poll loop.
    })
  }
}
