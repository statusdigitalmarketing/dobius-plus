import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AsanaConfig, AsanaProjectRef } from '../../shared/asana'
import { DEFAULT_ASANA_CONFIG } from '../../shared/asana'
import { isTuiAgent } from '../../shared/tui-agent-config'

// Why: Asana automation keeps its own JSON file instead of the typed settings
// store so the feature can evolve without touching GlobalSettings migrations.
const CONFIG_FILE_NAME = 'asana-config.json'

let cached: AsanaConfig | null = null

function configFilePath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE_NAME)
}

function sanitizeString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function sanitizeAllowedProjects(value: unknown): AsanaProjectRef[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_ASANA_CONFIG.allowedProjects]
  }
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }
    const record = entry as Partial<Record<keyof AsanaProjectRef, unknown>>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const gid = typeof record.gid === 'string' ? record.gid.trim() : ''
    return name && gid ? [{ name, gid }] : []
  })
}

function sanitizeAutoMode(value: unknown): AsanaConfig['autoMode'] {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_ASANA_CONFIG.autoMode }
  }
  const record = value as Partial<Record<keyof AsanaConfig['autoMode'], unknown>>
  const triageAgentId = typeof record.triageAgentId === 'string' ? record.triageAgentId.trim() : ''
  const buildAgent = isTuiAgent(record.buildAgent)
    ? record.buildAgent
    : DEFAULT_ASANA_CONFIG.autoMode.buildAgent
  const autoMode: AsanaConfig['autoMode'] = {
    enabled: record.enabled === true,
    intervalMinutes:
      typeof record.intervalMinutes === 'number' &&
      Number.isFinite(record.intervalMinutes) &&
      record.intervalMinutes > 0
        ? Math.floor(record.intervalMinutes)
        : DEFAULT_ASANA_CONFIG.autoMode.intervalMinutes,
    buildAgent
  }
  if (triageAgentId) {
    autoMode.triageAgentId = triageAgentId
  }
  return autoMode
}

export function sanitizeConfig(raw: unknown): AsanaConfig {
  if (typeof raw !== 'object' || raw === null) {
    return {
      ...DEFAULT_ASANA_CONFIG,
      allowedProjects: [...DEFAULT_ASANA_CONFIG.allowedProjects],
      autoMode: { ...DEFAULT_ASANA_CONFIG.autoMode }
    }
  }
  const record = raw as Partial<Record<keyof AsanaConfig, unknown>>
  return {
    myGid: sanitizeString(record.myGid, DEFAULT_ASANA_CONFIG.myGid),
    reviewGid: sanitizeString(record.reviewGid, DEFAULT_ASANA_CONFIG.reviewGid),
    allowedProjects: sanitizeAllowedProjects(record.allowedProjects),
    autoMode: sanitizeAutoMode(record.autoMode)
  }
}

function loadConfigFromDisk(): AsanaConfig {
  try {
    return sanitizeConfig(JSON.parse(readFileSync(configFilePath(), 'utf-8')))
  } catch {
    // Missing or corrupt file both fall back to defaults; the next update
    // rewrites a valid file.
    return sanitizeConfig(DEFAULT_ASANA_CONFIG)
  }
}

function persistConfig(config: AsanaConfig): void {
  const target = configFilePath()
  // Why: tmp-write + rename keeps the file readable if the app dies mid-write,
  // mirroring the Store's atomic persistence pattern.
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    renameSync(tmp, target)
  } catch (error) {
    console.warn(
      '[asana] failed to persist config:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function getAsanaConfig(): AsanaConfig {
  if (!cached) {
    cached = loadConfigFromDisk()
  }
  return {
    ...cached,
    allowedProjects: cached.allowedProjects.map((project) => ({ ...project })),
    autoMode: { ...cached.autoMode }
  }
}

export function updateAsanaConfig(updates: Partial<AsanaConfig>): AsanaConfig {
  // Why: partial updates arrive with absent fields as undefined; spreading
  // those would clobber stored values, so drop them first.
  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined)
  )
  const next = sanitizeConfig({ ...getAsanaConfig(), ...definedUpdates })
  cached = next
  persistConfig(next)
  return {
    ...next,
    allowedProjects: next.allowedProjects.map((project) => ({ ...project })),
    autoMode: { ...next.autoMode }
  }
}
