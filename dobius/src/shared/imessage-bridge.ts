// Shared contract for the macOS iMessage bridge: text yourself in Messages
// with a trigger prefix and the command is typed into Dobius's active terminal.

export type ImessageBridgeConfig = {
  enabled: boolean
  /** Commands must start with this prefix (default "d:") so ordinary
   *  self-notes never dispatch into a terminal. */
  triggerPrefix: string
  /** The user's own iMessage handle (email or phone). The bridge only watches
   *  the self-chat for this handle and replies back to it. */
  selfHandle: string | null
  /** High-water mark of processed chat.db message ROWIDs, persisted so a
   *  restart never re-dispatches history. */
  lastSeenRowid: number
}

export type ImessageBridgeChatDbProbe =
  | { ok: true; messageCount: number }
  | { ok: false; error: string }

export type ImessageBridgeStatus = {
  enabled: boolean
  isRunning: boolean
  triggerPrefix: string
  selfHandle: string | null
  lastSeenRowid: number
  chatDbReadable: ImessageBridgeChatDbProbe
  /** Outbound iMessages sent within the rate-limit window (last 60s). */
  outboundLastMin: number
}

export type ImessageBridgeSendResult = { ok: true } | { ok: false; error: string }

export const IMESSAGE_BRIDGE_DEFAULT_TRIGGER_PREFIX = 'd:'
export const IMESSAGE_BRIDGE_TRIGGER_PREFIX_MAX_LENGTH = 10
