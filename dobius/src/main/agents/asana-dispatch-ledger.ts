import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AsanaLane } from '../../shared/asana'

const FILE_NAME = 'asana-dispatch-ledger.json'
const MAX_ATTEMPTS = 2
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export type AsanaDispatchRecord = {
  gid: string
  lane: AsanaLane
  firstSeenAt: number
  lastAttemptAt: number
  attempts: number
  status: 'claimed' | 'briefed' | 'failed' | 'dead'
}

let cached: AsanaDispatchRecord[] | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function sanitizeRecord(raw: unknown): AsanaDispatchRecord | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as Partial<Record<keyof AsanaDispatchRecord, unknown>>
  const gid = typeof record.gid === 'string' ? record.gid.trim() : ''
  const lane = record.lane === 'build' || record.lane === 'review' ? record.lane : null
  const status =
    record.status === 'claimed' ||
    record.status === 'briefed' ||
    record.status === 'failed' ||
    record.status === 'dead'
      ? record.status
      : null
  if (!gid || !lane || !status) {
    return null
  }
  const firstSeenAt = typeof record.firstSeenAt === 'number' ? record.firstSeenAt : Date.now()
  const lastAttemptAt =
    typeof record.lastAttemptAt === 'number' ? record.lastAttemptAt : firstSeenAt
  const attempts =
    typeof record.attempts === 'number' && Number.isFinite(record.attempts)
      ? Math.max(0, Math.floor(record.attempts))
      : 0
  return { gid, lane, firstSeenAt, lastAttemptAt, attempts, status }
}

function load(): AsanaDispatchRecord[] {
  if (cached) {
    return cached
  }
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf-8'))
    cached = Array.isArray(raw)
      ? raw.flatMap((entry) => {
          const record = sanitizeRecord(entry)
          return record ? [record] : []
        })
      : []
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      console.warn(
        '[agents] failed to load Asana dispatch ledger:',
        error instanceof Error ? error.message : String(error)
      )
    }
    cached = []
  }
  return cached
}

function persist(records: AsanaDispatchRecord[]): void {
  const target = filePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, 'utf-8')
    renameSync(tmp, target)
  } catch (error) {
    console.warn(
      '[agents] failed to persist Asana dispatch ledger:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

function findRecord(gid: string): AsanaDispatchRecord | undefined {
  return load().find((record) => record.gid === gid)
}

function cloneRecord(record: AsanaDispatchRecord): AsanaDispatchRecord {
  return { ...record }
}

export function hasBeenClaimed(gid: string): boolean {
  const record = findRecord(gid)
  return record?.status === 'claimed' || record?.status === 'briefed' || record?.status === 'dead'
}

export function claimTask(gid: string, lane: AsanaLane): AsanaDispatchRecord | null {
  if (hasBeenClaimed(gid) || isDead(gid)) {
    return null
  }
  const records = load()
  const existing = records.find((record) => record.gid === gid)
  const now = Date.now()
  if (existing) {
    // Why: failed records are the only retryable state; reclaiming preserves
    // the original edge timestamp while reserving this retry attempt.
    existing.status = 'claimed'
    existing.lane = lane
    existing.lastAttemptAt = now
    persist(records)
    return cloneRecord(existing)
  }
  const record: AsanaDispatchRecord = {
    gid,
    lane,
    firstSeenAt: now,
    lastAttemptAt: now,
    attempts: 0,
    status: 'claimed'
  }
  cached = [...records, record]
  persist(cached)
  return cloneRecord(record)
}

export function recordBriefed(gid: string): AsanaDispatchRecord | null {
  const record = findRecord(gid)
  if (!record) {
    return null
  }
  record.status = record.status === 'dead' ? 'dead' : 'briefed'
  record.lastAttemptAt = Date.now()
  persist(load())
  return cloneRecord(record)
}

export function recordFailure(gid: string): AsanaDispatchRecord | null {
  const record = findRecord(gid)
  if (!record) {
    return null
  }
  if (record.status === 'dead') {
    return cloneRecord(record)
  }
  record.attempts += 1
  record.lastAttemptAt = Date.now()
  record.status = record.attempts >= MAX_ATTEMPTS ? 'dead' : 'failed'
  persist(load())
  return cloneRecord(record)
}

export function isDead(gid: string): boolean {
  return findRecord(gid)?.status === 'dead'
}

export function listDispatchRecords(): AsanaDispatchRecord[] {
  return load().map(cloneRecord)
}

export function pruneOld(now = Date.now()): AsanaDispatchRecord[] {
  const cutoff = now - RETENTION_MS
  cached = load().filter((record) => record.firstSeenAt >= cutoff)
  persist(cached)
  return listDispatchRecords()
}
