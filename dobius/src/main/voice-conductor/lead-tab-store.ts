import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type LeadTabPayload = {
  version: 1
  leadTabIdByProjectPath: Record<string, string>
}

export type LeadTabStore = {
  get(projectPath: string): string | null
  set(projectPath: string, tabId: string | null): void
}

function normalizeProjectPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\u0000')) {
    throw new Error('projectPath required')
  }
  return path.resolve(trimmed)
}

function normalizePayload(raw: unknown): LeadTabPayload {
  const result: LeadTabPayload = { version: 1, leadTabIdByProjectPath: {} }
  if (!raw || typeof raw !== 'object') {
    return result
  }
  const entries = (raw as { leadTabIdByProjectPath?: unknown }).leadTabIdByProjectPath
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return result
  }
  for (const [projectPath, tabId] of Object.entries(entries)) {
    if (
      projectPath.length <= 4096 &&
      typeof tabId === 'string' &&
      tabId.length > 0 &&
      tabId.length <= 512 &&
      !tabId.includes('\u0000')
    ) {
      result.leadTabIdByProjectPath[projectPath] = tabId
    }
  }
  return result
}

export function createLeadTabStore(filePath: string): LeadTabStore {
  let payload: LeadTabPayload | null = null

  function load(): LeadTabPayload {
    if (payload) {
      return payload
    }
    try {
      payload = normalizePayload(JSON.parse(readFileSync(filePath, 'utf8')))
    } catch {
      payload = normalizePayload(null)
    }
    return payload
  }

  function persist(next: LeadTabPayload): void {
    mkdirSync(path.dirname(filePath), { recursive: true })
    const temporaryPath = `${filePath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, filePath)
  }

  return {
    get(projectPath) {
      return load().leadTabIdByProjectPath[normalizeProjectPath(projectPath)] ?? null
    },
    set(projectPath, tabId) {
      const key = normalizeProjectPath(projectPath)
      if (tabId !== null && (!tabId.trim() || tabId.length > 512 || tabId.includes('\u0000'))) {
        throw new Error('tabId malformed')
      }
      const next = {
        version: 1 as const,
        leadTabIdByProjectPath: { ...load().leadTabIdByProjectPath }
      }
      if (tabId === null) {
        delete next.leadTabIdByProjectPath[key]
      } else {
        next.leadTabIdByProjectPath[key] = tabId
      }
      persist(next)
      payload = next
    }
  }
}
