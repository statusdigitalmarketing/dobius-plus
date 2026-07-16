import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import type {
  AgentRun,
  AgentNotificationEntry,
  AgentNotificationsSnapshot
} from '../../shared/agents'
import type { CustomAgent } from '../../shared/agents'

const FILE_NAME = 'agents-notifications.json'
const MAX_ENTRIES = 50

type PersistedNotifications = {
  entries: AgentNotificationEntry[]
  lastReadTs: number
}

let cached: PersistedNotifications | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function sanitizeEntry(raw: unknown): AgentNotificationEntry | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Partial<Record<keyof AgentNotificationEntry, unknown>>
  if (
    typeof record.id !== 'string' ||
    typeof record.ts !== 'number' ||
    typeof record.agentId !== 'string' ||
    typeof record.text !== 'string'
  ) {
    return null
  }
  if (
    record.kind !== 'run-finished' &&
    record.kind !== 'run-failed' &&
    record.kind !== 'decision-pending' &&
    record.kind !== 'decision-resolved' &&
    record.kind !== 'briefing-now'
  ) {
    return null
  }
  return {
    id: record.id,
    ts: record.ts,
    agentId: record.agentId,
    kind: record.kind,
    ok: record.ok === true,
    text: record.text,
    decisionId: typeof record.decisionId === 'string' ? record.decisionId : undefined
  }
}

function sanitize(raw: unknown): PersistedNotifications {
  if (typeof raw !== 'object' || raw === null) {
    return { entries: [], lastReadTs: 0 }
  }
  const record = raw as Partial<PersistedNotifications>
  return {
    entries: Array.isArray(record.entries)
      ? record.entries.flatMap((entry) => {
          const sanitized = sanitizeEntry(entry)
          return sanitized ? [sanitized] : []
        })
      : [],
    lastReadTs: typeof record.lastReadTs === 'number' ? record.lastReadTs : 0
  }
}

function load(): PersistedNotifications {
  if (cached) {
    return cached
  }
  try {
    cached = sanitize(JSON.parse(readFileSync(filePath(), 'utf-8')))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      console.warn(
        '[agents] failed to load notifications:',
        error instanceof Error ? error.message : String(error)
      )
    }
    cached = { entries: [], lastReadTs: 0 }
  }
  cached.entries = cached.entries.slice(-MAX_ENTRIES)
  return cached
}

function persist(data: PersistedNotifications): void {
  const target = filePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(
      tmp,
      `${JSON.stringify({ ...data, entries: data.entries.slice(-MAX_ENTRIES) }, null, 2)}\n`,
      'utf-8'
    )
    renameSync(tmp, target)
  } catch (error) {
    console.warn(
      '[agents] failed to persist notifications:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function broadcastAgentNotificationsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('agents:notificationsChanged')
    }
  }
}

export function listAgentNotifications(): AgentNotificationsSnapshot {
  const data = load()
  const entries = [...data.entries].sort((a, b) => b.ts - a.ts)
  return {
    entries,
    lastReadTs: data.lastReadTs,
    unreadCount: entries.filter((entry) => entry.ts > data.lastReadTs).length
  }
}

export function appendAgentNotification(
  input: Omit<AgentNotificationEntry, 'id' | 'ts'>
): AgentNotificationEntry {
  const data = load()
  const entry: AgentNotificationEntry = { ...input, id: randomUUID(), ts: Date.now() }
  cached = { ...data, entries: [...data.entries, entry].slice(-MAX_ENTRIES) }
  persist(cached)
  broadcastAgentNotificationsChanged()
  return entry
}

export function appendAgentRunNotification(agent: CustomAgent, run: AgentRun): void {
  if (run.status === 'running') {
    return
  }
  const ok = run.status === 'success'
  appendAgentNotification({
    agentId: agent.id,
    kind: ok ? 'run-finished' : 'run-failed',
    ok,
    text:
      run.status === 'cancelled'
        ? `${agent.name} run was cancelled`
        : `${agent.name} run ${ok ? 'finished' : 'failed'}`
  })
}

export function markAgentNotificationsRead(): AgentNotificationsSnapshot {
  const data = load()
  cached = { ...data, lastReadTs: Date.now() }
  persist(cached)
  broadcastAgentNotificationsChanged()
  return listAgentNotifications()
}
