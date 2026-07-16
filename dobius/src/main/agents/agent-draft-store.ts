import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import type { AgentDraftComment } from '../../shared/agents'

const FILE_NAME = 'agent-drafts.json'
const MAX_DRAFTS = 100
const RECENT_FINALIZED_COUNT = 20

let cached: AgentDraftComment[] | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function sanitizeStatus(value: unknown): AgentDraftComment['status'] {
  return value === 'approved' || value === 'discarded' ? value : 'pending'
}

function sanitize(raw: unknown): AgentDraftComment[] {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }
    const record = entry as Partial<Record<keyof AgentDraftComment, unknown>>
    const target = record.target
    const targetRecord =
      typeof target === 'object' && target !== null
        ? (target as Partial<AgentDraftComment['target']>)
        : null
    const id = typeof record.id === 'string' ? record.id : ''
    const agentId = typeof record.agentId === 'string' ? record.agentId : ''
    const gid = typeof targetRecord?.gid === 'string' ? targetRecord.gid : ''
    const body = typeof record.body === 'string' ? record.body : ''
    const createdAt = typeof record.createdAt === 'number' ? record.createdAt : 0
    if (!id || !agentId || !gid || !createdAt) {
      return []
    }
    return [
      {
        id,
        agentId,
        target: { kind: 'asana', gid },
        body,
        createdAt,
        status: sanitizeStatus(record.status)
      }
    ]
  })
}

function load(): AgentDraftComment[] {
  if (cached) {
    return cached
  }
  try {
    cached = sanitize(JSON.parse(readFileSync(filePath(), 'utf-8'))).slice(-MAX_DRAFTS)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      console.warn(
        '[agents] failed to load drafts:',
        error instanceof Error ? error.message : String(error)
      )
    }
    cached = []
  }
  return cached
}

function persist(drafts: AgentDraftComment[]): void {
  const target = filePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(drafts.slice(-MAX_DRAFTS), null, 2)}\n`, 'utf-8')
    renameSync(tmp, target)
  } catch (error) {
    console.warn(
      '[agents] failed to persist drafts:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function broadcastDraftsChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('agents:draftsChanged')
    }
  }
}

export function appendDraft(input: {
  agentId: string
  target: AgentDraftComment['target']
  body: string
}): AgentDraftComment {
  const draft: AgentDraftComment = {
    ...input,
    id: randomUUID(),
    createdAt: Date.now(),
    status: 'pending'
  }
  cached = [...load(), draft].slice(-MAX_DRAFTS)
  persist(cached)
  broadcastDraftsChanged()
  return { ...draft, target: { ...draft.target } }
}

export function listDrafts(): AgentDraftComment[] {
  const drafts = load()
  const pending = drafts.filter((draft) => draft.status === 'pending')
  const recentFinalized = drafts
    .filter((draft) => draft.status !== 'pending')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, RECENT_FINALIZED_COUNT)
  return [...pending, ...recentFinalized]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((draft) => ({ ...draft, target: { ...draft.target } }))
}

export function getDraft(id: string): AgentDraftComment | null {
  const draft = load().find((entry) => entry.id === id)
  return draft ? { ...draft, target: { ...draft.target } } : null
}

export function setDraftStatus(
  id: string,
  status: AgentDraftComment['status']
): AgentDraftComment | null {
  const drafts = load()
  const draft = drafts.find((entry) => entry.id === id)
  if (!draft) {
    return null
  }
  draft.status = status
  cached = drafts.slice(-MAX_DRAFTS)
  persist(cached)
  broadcastDraftsChanged()
  return { ...draft, target: { ...draft.target } }
}
