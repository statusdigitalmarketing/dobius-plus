import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkItem, WorkRegistry } from './types'
import { createWorkRegistry } from './work-registry'

function normalizeItems(raw: unknown): WorkItem[] {
  if (!raw || typeof raw !== 'object') {return []}
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) {return []}
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') {return []}
    const record = item as Record<string, unknown>
    if (
      typeof record.workId !== 'string' ||
      typeof record.tabId !== 'string' ||
      typeof record.requestId !== 'string' ||
      typeof record.description !== 'string' ||
      typeof record.startedAt !== 'number' ||
      !['running', 'done', 'error'].includes(String(record.status))
    ) {
      return []
    }
    return [{
      workId: record.workId.slice(0, 512),
      tabId: record.tabId.slice(0, 512),
      requestId: record.requestId.slice(0, 80),
      description: record.description.slice(0, 4000),
      startedAt: record.startedAt,
      status: record.status as WorkItem['status'],
      ...(typeof record.summary === 'string' ? { summary: record.summary.slice(0, 4000) } : {})
    }]
  })
}

export function createPersistentWorkRegistry(filePath: string): WorkRegistry {
  let initialItems: WorkItem[] = []
  try {
    initialItems = normalizeItems(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    // A missing or malformed cache starts empty; the next change repairs it.
  }
  return createWorkRegistry({
    initialItems,
    onChange: (items) => {
      mkdirSync(path.dirname(filePath), { recursive: true })
      const temporaryPath = `${filePath}.${process.pid}.tmp`
      writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, {
        mode: 0o600
      })
      renameSync(temporaryPath, filePath)
    }
  })
}
