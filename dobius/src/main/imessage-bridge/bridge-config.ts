import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { ImessageBridgeConfig } from '../../shared/imessage-bridge'
import {
  IMESSAGE_BRIDGE_DEFAULT_TRIGGER_PREFIX,
  IMESSAGE_BRIDGE_TRIGGER_PREFIX_MAX_LENGTH
} from '../../shared/imessage-bridge'

// Why: the bridge keeps its own JSON file instead of the typed settings store
// so this macOS-only surface never touches the GlobalSettings schema.
const CONFIG_FILE_NAME = 'imessage-bridge.json'

const DEFAULT_CONFIG: ImessageBridgeConfig = {
  enabled: false,
  triggerPrefix: IMESSAGE_BRIDGE_DEFAULT_TRIGGER_PREFIX,
  selfHandle: null,
  lastSeenRowid: 0
}

let cached: ImessageBridgeConfig | null = null

function configFilePath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE_NAME)
}

function sanitizeTriggerPrefix(value: unknown): string {
  if (typeof value !== 'string') {
    return IMESSAGE_BRIDGE_DEFAULT_TRIGGER_PREFIX
  }
  const trimmed = value.trim().slice(0, IMESSAGE_BRIDGE_TRIGGER_PREFIX_MAX_LENGTH)
  return trimmed.length > 0 ? trimmed : IMESSAGE_BRIDGE_DEFAULT_TRIGGER_PREFIX
}

function sanitizeSelfHandle(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function sanitizeConfig(raw: unknown): ImessageBridgeConfig {
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_CONFIG }
  }
  const record = raw as Partial<Record<keyof ImessageBridgeConfig, unknown>>
  return {
    enabled: record.enabled === true,
    triggerPrefix: sanitizeTriggerPrefix(record.triggerPrefix),
    selfHandle: sanitizeSelfHandle(record.selfHandle),
    lastSeenRowid:
      typeof record.lastSeenRowid === 'number' && Number.isFinite(record.lastSeenRowid)
        ? Math.max(0, Math.floor(record.lastSeenRowid))
        : 0
  }
}

function loadConfigFromDisk(): ImessageBridgeConfig {
  try {
    return sanitizeConfig(JSON.parse(readFileSync(configFilePath(), 'utf-8')))
  } catch {
    // Missing or corrupt file both fall back to defaults; the next update
    // rewrites a valid file.
    return { ...DEFAULT_CONFIG }
  }
}

function persistConfig(config: ImessageBridgeConfig): void {
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
      '[imessage-bridge] failed to persist config:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

export function getImessageBridgeConfig(): ImessageBridgeConfig {
  if (!cached) {
    cached = loadConfigFromDisk()
  }
  return { ...cached }
}

export function updateImessageBridgeConfig(
  updates: Partial<ImessageBridgeConfig>
): ImessageBridgeConfig {
  // Why: partial updates arrive with absent fields as undefined; spreading
  // those would clobber stored values, so drop them first.
  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined)
  )
  const next = sanitizeConfig({ ...getImessageBridgeConfig(), ...definedUpdates })
  cached = next
  persistConfig(next)
  return { ...next }
}
