import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

const FILE_NAME = 'agents-config.json'

export type AgentPingStatus = {
  used: number
  max: number
  date: string
}

type AgentsConfig = {
  agentsPaused: boolean
  maxPingsPerDay: number
  pingDate: string
  pingsUsed: number
}

const DEFAULT_CONFIG: AgentsConfig = {
  agentsPaused: false,
  maxPingsPerDay: 4,
  pingDate: todayKey(),
  pingsUsed: 0
}

let cached: AgentsConfig | null = null

function todayKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

function sanitize(raw: unknown): AgentsConfig {
  const record =
    typeof raw === 'object' && raw !== null
      ? (raw as Partial<Record<keyof AgentsConfig, unknown>>)
      : {}
  return {
    agentsPaused: record.agentsPaused === true,
    maxPingsPerDay:
      typeof record.maxPingsPerDay === 'number' && Number.isFinite(record.maxPingsPerDay)
        ? Math.min(10, Math.max(1, Math.round(record.maxPingsPerDay)))
        : DEFAULT_CONFIG.maxPingsPerDay,
    pingDate: typeof record.pingDate === 'string' ? record.pingDate : todayKey(),
    pingsUsed:
      typeof record.pingsUsed === 'number' && Number.isFinite(record.pingsUsed)
        ? Math.max(0, Math.round(record.pingsUsed))
        : 0
  }
}

function load(): AgentsConfig {
  if (cached) {
    return cached
  }
  try {
    cached = sanitize(JSON.parse(readFileSync(filePath(), 'utf-8')))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT') {
      console.warn(
        '[agents] failed to load config:',
        error instanceof Error ? error.message : String(error)
      )
    }
    cached = { ...DEFAULT_CONFIG }
  }
  return rolloverPingDate(cached)
}

function persist(config: AgentsConfig): void {
  const target = filePath()
  const tmp = `${target}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    renameSync(tmp, target)
  } catch (error) {
    console.warn(
      '[agents] failed to persist config:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

function rolloverPingDate(config: AgentsConfig): AgentsConfig {
  const date = todayKey()
  if (config.pingDate === date) {
    return config
  }
  const next = { ...config, pingDate: date, pingsUsed: 0 }
  cached = next
  persist(next)
  return next
}

export function getAgentsPaused(): boolean {
  return load().agentsPaused
}

export function setAgentsPaused(paused: boolean): boolean {
  const config = { ...load(), agentsPaused: paused }
  cached = config
  persist(config)
  return config.agentsPaused
}

export function getPingStatus(): AgentPingStatus {
  const config = load()
  return { used: config.pingsUsed, max: config.maxPingsPerDay, date: config.pingDate }
}

export function consumePingBudget(): boolean {
  const config = load()
  if (config.pingsUsed >= config.maxPingsPerDay) {
    return false
  }
  const next = { ...config, pingsUsed: config.pingsUsed + 1 }
  cached = next
  persist(next)
  return true
}
