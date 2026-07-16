import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Store } from './persistence'
import { hasAsanaToken, setAsanaToken } from './asana/asana-token-store'
import { getAsanaConfig, updateAsanaConfig } from './asana/asana-config'
import { ASANA_GID_RE, DEFAULT_ASANA_CONFIG, type AsanaConfig } from '../shared/asana'
import { addLocalRepoFromPath } from './ipc/repos'

const LEGACY_CONFIG_FILE = 'config.json'
const MARKER_FILE = 'legacy-config-migrated.json'

type LegacyConfig = {
  asanaQueue?: {
    pat?: unknown
    myGid?: unknown
    reviewGid?: unknown
    allowedProjects?: unknown
    autoMode?: {
      enabled?: unknown
      intervalMinutes?: unknown
    }
    scheduledTasks?: unknown
  }
  projects?: unknown
  scheduledTasks?: unknown
}

type LegacyProject = {
  displayName?: unknown
}

type ImportMarker = {
  migratedAt: string
  imported: {
    asanaToken: boolean
    asanaConfig: string[]
    projects: { path: string; displayName?: string; kind: 'git' | 'folder'; status: string }[]
  }
  deferred: {
    scheduledTasks: unknown[]
  }
}

function userDataPath(file: string): string {
  return path.join(app.getPath('userData'), file)
}

function parseLegacyConfig(raw: unknown): LegacyConfig | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const record = raw as LegacyConfig
  if (!('asanaQueue' in record) && !('projects' in record)) {
    return null
  }
  return record
}

function readLegacyConfig(): LegacyConfig | null {
  try {
    return parseLegacyConfig(JSON.parse(readFileSync(userDataPath(LEGACY_CONFIG_FILE), 'utf8')))
  } catch {
    return null
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function isDefaultConfigValue<T>(current: T, defaultValue: T): boolean {
  return JSON.stringify(current) === JSON.stringify(defaultValue)
}

function sanitizeGid(value: unknown): string | null {
  const gid = typeof value === 'string' ? value.trim() : ''
  return ASANA_GID_RE.test(gid) ? gid : null
}

function sanitizeAllowedProjects(value: unknown): AsanaConfig['allowedProjects'] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }
    const record = entry as { name?: unknown; gid?: unknown }
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const gid = sanitizeGid(record.gid)
    return name && gid ? [{ name, gid }] : []
  })
}

function importAsanaToken(config: LegacyConfig): boolean {
  const pat = typeof config.asanaQueue?.pat === 'string' ? config.asanaQueue.pat.trim() : ''
  if (!pat || hasAsanaToken()) {
    return false
  }
  setAsanaToken(pat)
  return true
}

function importAsanaConfig(config: LegacyConfig): string[] {
  const current = getAsanaConfig()
  const updates: Partial<AsanaConfig> = {}
  const fields: string[] = []
  const myGid = sanitizeGid(config.asanaQueue?.myGid)
  if (myGid && current.myGid === DEFAULT_ASANA_CONFIG.myGid) {
    updates.myGid = myGid
    fields.push('myGid')
  }
  const reviewGid = sanitizeGid(config.asanaQueue?.reviewGid)
  if (reviewGid && current.reviewGid === DEFAULT_ASANA_CONFIG.reviewGid) {
    updates.reviewGid = reviewGid
    fields.push('reviewGid')
  }
  const allowedProjects = sanitizeAllowedProjects(config.asanaQueue?.allowedProjects)
  if (
    allowedProjects.length > 0 &&
    isDefaultConfigValue(current.allowedProjects, DEFAULT_ASANA_CONFIG.allowedProjects)
  ) {
    updates.allowedProjects = allowedProjects
    fields.push('allowedProjects')
  }
  const intervalMinutes = config.asanaQueue?.autoMode?.intervalMinutes
  if (isDefaultConfigValue(current.autoMode, DEFAULT_ASANA_CONFIG.autoMode)) {
    updates.autoMode = {
      ...DEFAULT_ASANA_CONFIG.autoMode,
      enabled: false,
      intervalMinutes:
        typeof intervalMinutes === 'number' && Number.isFinite(intervalMinutes) && intervalMinutes > 0
          ? Math.floor(intervalMinutes)
          : DEFAULT_ASANA_CONFIG.autoMode.intervalMinutes
    }
    fields.push('autoMode')
  }
  if (fields.length > 0) {
    updateAsanaConfig(updates)
  }
  return fields
}

function legacyProjects(config: LegacyConfig): { projectPath: string; displayName?: string }[] {
  if (typeof config.projects !== 'object' || config.projects === null) {
    return []
  }
  return Object.entries(config.projects as Record<string, LegacyProject>).flatMap(
    ([projectPath, project]) => {
      if (!path.isAbsolute(projectPath)) {
        return []
      }
      const displayName =
        typeof project?.displayName === 'string' && project.displayName.trim()
          ? project.displayName.trim()
          : undefined
      return [{ projectPath, ...(displayName ? { displayName } : {}) }]
    }
  )
}

function existingProjectKind(projectPath: string): 'git' | 'folder' | null {
  try {
    if (!statSync(projectPath).isDirectory()) {
      return null
    }
    return existsSync(path.join(projectPath, '.git')) ? 'git' : 'folder'
  } catch {
    return null
  }
}

async function importProjects(
  store: Store,
  config: LegacyConfig
): Promise<ImportMarker['imported']['projects']> {
  const projects = legacyProjects(config)
  if (store.getRepoCount() > 0) {
    return projects.map((project) => ({
      path: project.projectPath,
      ...(project.displayName ? { displayName: project.displayName } : {}),
      kind: 'folder',
      status: 'skipped-existing-registry'
    }))
  }
  const results: ImportMarker['imported']['projects'] = []
  for (const project of projects) {
    const kind = existingProjectKind(project.projectPath)
    if (!kind) {
      results.push({
        path: project.projectPath,
        ...(project.displayName ? { displayName: project.displayName } : {}),
        kind: 'folder',
        status: 'skipped-missing'
      })
      continue
    }
    const result = await addLocalRepoFromPath(store, project.projectPath, kind)
    if ('error' in result) {
      results.push({
        path: project.projectPath,
        ...(project.displayName ? { displayName: project.displayName } : {}),
        kind,
        status: `error:${result.error}`
      })
      continue
    }
    if (project.displayName) {
      store.updateRepo(result.repo.id, { displayName: project.displayName })
    }
    results.push({
      path: project.projectPath,
      ...(project.displayName ? { displayName: project.displayName } : {}),
      kind,
      status: result.alreadyExisted ? 'already-known' : 'imported'
    })
  }
  return results
}

function deferredScheduledTasks(config: LegacyConfig): unknown[] {
  if (Array.isArray(config.scheduledTasks)) {
    return config.scheduledTasks
  }
  if (Array.isArray(config.asanaQueue?.scheduledTasks)) {
    return config.asanaQueue.scheduledTasks
  }
  return []
}

export async function migrateLegacyDobiusConfig(store: Store): Promise<void> {
  const markerPath = userDataPath(MARKER_FILE)
  if (existsSync(markerPath)) {
    return
  }
  const configPath = userDataPath(LEGACY_CONFIG_FILE)
  if (!existsSync(configPath)) {
    return
  }
  const config = readLegacyConfig()
  if (!config) {
    return
  }
  const marker: ImportMarker = {
    migratedAt: new Date().toISOString(),
    imported: {
      asanaToken: importAsanaToken(config),
      asanaConfig: importAsanaConfig(config),
      projects: await importProjects(store, config)
    },
    deferred: {
      scheduledTasks: deferredScheduledTasks(config)
    }
  }
  atomicWriteJson(markerPath, marker)
}
