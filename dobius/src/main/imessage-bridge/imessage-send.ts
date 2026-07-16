import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const OSASCRIPT_TIMEOUT_MS = 10_000
const OUTBOUND_RATE_LIMIT_PER_MIN = 10
const OUTBOUND_WINDOW_MS = 60_000

// Sliding window of outbound send timestamps for the rate limit.
let outboundTimestamps: number[] = []

function pruneOutboundWindow(now: number): void {
  outboundTimestamps = outboundTimestamps.filter((sentAt) => now - sentAt < OUTBOUND_WINDOW_MS)
}

export function countOutboundLastMinute(): number {
  pruneOutboundWindow(Date.now())
  return outboundTimestamps.length
}

function escapeAppleScriptString(text: string): string {
  // AppleScript string literals are double-quoted with backslash escapes, so
  // escape those two and strip remaining control chars (except newline).
  return (
    text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      // eslint-disable-next-line no-control-regex -- control chars would corrupt the osascript literal
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
  )
}

/**
 * Send an iMessage to `handle` via Messages.app (osascript). Rate-limited to
 * OUTBOUND_RATE_LIMIT_PER_MIN so a dispatch loop can never spam the user.
 * Requires macOS Automation permission for Messages.app (prompted on first send).
 */
export async function sendImessage(handle: string, text: string): Promise<void> {
  if (!handle) {
    throw new Error('selfHandle not configured')
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('text required')
  }
  const now = Date.now()
  pruneOutboundWindow(now)
  if (outboundTimestamps.length >= OUTBOUND_RATE_LIMIT_PER_MIN) {
    throw new Error(`outbound rate limit (${OUTBOUND_RATE_LIMIT_PER_MIN}/min) exceeded`)
  }
  outboundTimestamps.push(now)

  const safeText = escapeAppleScriptString(text)
  // Handles are emails/phone numbers and never contain quotes; drop any anyway.
  const safeHandle = handle.replace(/"/g, '')
  const script = `
    tell application "Messages"
      set targetService to 1st service whose service type = iMessage
      set targetBuddy to participant "${safeHandle}" of targetService
      send "${safeText}" to targetBuddy
    end tell`

  const { stderr } = await execFileAsync('/usr/bin/osascript', ['-e', script], {
    timeout: OSASCRIPT_TIMEOUT_MS
  })
  if (stderr) {
    console.warn(`[imessage-bridge] osascript stderr: ${stderr}`)
  }
}
