import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { BriefingItem } from '../../shared/agents'

const FILE_NAME = 'agents-briefing.json'
const MAX_ITEMS = 200
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000

let cached: BriefingItem[] | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function sanitizeItems(raw: unknown): BriefingItem[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }
    const record = entry as Partial<Record<keyof BriefingItem, unknown>>
    const id = typeof record.id === 'string' ? record.id : ''
    const agentId = typeof record.agentId === 'string' ? record.agentId : ''
    const ts = typeof record.ts === 'number' ? record.ts : 0
    const summary = typeof record.summary === 'string' ? record.summary : ''
    if (!id || !agentId || !ts || !summary) {
      return []
    }
    return [
      {
        id,
        agentId,
        ts,
        urgency: record.urgency === 'now' ? 'now' : 'digest',
        summary,
        demoted: record.demoted === true
      }
    ]
  })
}

function load(): BriefingItem[] {
  if (cached) {
    return cached
  }
  try {
    cached = sanitizeItems(JSON.parse(readFileSync(filePath(), 'utf-8')))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      console.warn(
        '[agents] failed to load briefing:',
        error instanceof Error ? error.message : String(error)
      )
    }
    cached = []
  }
  return cached
}

function persist(items: BriefingItem[]): void {
  const target = filePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(items.slice(-MAX_ITEMS), null, 2)}\n`, 'utf-8')
    renameSync(tmp, target)
  } catch (error) {
    console.warn(
      '[agents] failed to persist briefing:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function broadcastBriefingChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('agents:briefingChanged')
    }
  }
}

export function appendBriefingItem(input: Omit<BriefingItem, 'id' | 'ts'>): BriefingItem {
  const item: BriefingItem = { ...input, id: randomUUID(), ts: Date.now() }
  cached = [...load(), item].slice(-MAX_ITEMS)
  persist(cached)
  broadcastBriefingChanged()
  return item
}

export function listRecentBriefingItems(): BriefingItem[] {
  const cutoff = Date.now() - RECENT_WINDOW_MS
  return load()
    .filter((item) => item.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts)
}

export function dismissBriefingItems(): void {
  const now = Date.now()
  cached = load().filter((item) => item.ts > now)
  persist(cached)
  broadcastBriefingChanged()
}
