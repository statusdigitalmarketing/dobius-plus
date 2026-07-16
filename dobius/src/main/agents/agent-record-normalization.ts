import {
  AGENT_COLORS,
  AGENT_ICONS,
  type AgentColor,
  type AgentChannels,
  type AgentHeartbeatFrequency,
  type AgentHeartbeatSettings,
  type AgentIcon,
  type AgentNotifyLevel
} from '../../shared/agents'

export const DEFAULT_ICON: AgentIcon = 'bot'
export const DEFAULT_COLOR: AgentColor = '#b9bcc2'
export const DEFAULT_HEARTBEAT: AgentHeartbeatSettings = {
  enabled: false,
  frequency: 'daily',
  at: '08:00',
  quietStart: '23:00',
  quietEnd: '08:00',
  maxBudgetUsd: 0.5,
  maxTurns: 25
}
const DEFAULT_NOTIFY: AgentNotifyLevel = 'digest + urgent'
export const DEFAULT_CHANNELS: AgentChannels = {
  imessage: false
}

export function normalizeIcon(value: unknown): AgentIcon {
  return AGENT_ICONS.includes(value as AgentIcon) ? (value as AgentIcon) : DEFAULT_ICON
}

export function normalizeColor(value: unknown): AgentColor {
  return AGENT_COLORS.includes(value as AgentColor) ? (value as AgentColor) : DEFAULT_COLOR
}

function normalizeTime(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    return fallback
  }
  const [hourText, minuteText] = value.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60 ? value : fallback
}

function normalizeFrequency(value: unknown): AgentHeartbeatFrequency {
  return value === 'every10min' || value === 'hourly' || value === 'weekdays' || value === 'daily'
    ? value
    : DEFAULT_HEARTBEAT.frequency
}

export function normalizeHeartbeat(value: unknown): AgentHeartbeatSettings {
  const raw =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<keyof AgentHeartbeatSettings, unknown>>)
      : {}
  return {
    enabled: raw.enabled === true,
    frequency: normalizeFrequency(raw.frequency),
    at: normalizeTime(raw.at, DEFAULT_HEARTBEAT.at),
    quietStart: normalizeTime(raw.quietStart, DEFAULT_HEARTBEAT.quietStart),
    quietEnd: normalizeTime(raw.quietEnd, DEFAULT_HEARTBEAT.quietEnd),
    maxBudgetUsd:
      typeof raw.maxBudgetUsd === 'number' && Number.isFinite(raw.maxBudgetUsd)
        ? Math.min(2, Math.max(0.1, raw.maxBudgetUsd))
        : DEFAULT_HEARTBEAT.maxBudgetUsd,
    maxTurns:
      typeof raw.maxTurns === 'number' && Number.isFinite(raw.maxTurns)
        ? Math.min(100, Math.max(1, Math.round(raw.maxTurns)))
        : DEFAULT_HEARTBEAT.maxTurns
  }
}

export function normalizeNotify(value: unknown): AgentNotifyLevel {
  return value === 'urgent only' || value === 'everything' || value === 'digest + urgent'
    ? value
    : DEFAULT_NOTIFY
}

export function normalizeChannels(value: unknown): AgentChannels {
  const raw =
    typeof value === 'object' && value !== null
      ? (value as Partial<Record<keyof AgentChannels, unknown>>)
      : {}
  return {
    imessage: raw.imessage === true
  }
}

export function normalizeSkills(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [
    ...new Set(
      value
        .filter((skill): skill is string => typeof skill === 'string')
        .map((skill) => skill.trim())
        .filter(Boolean)
    )
  ]
}
