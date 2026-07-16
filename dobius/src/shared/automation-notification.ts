import type {
  AutomationNotification,
  AutomationNotifyDepth,
  AutomationNotifyOn
} from './automations-types'

const NOTIFY_ON_VALUES: AutomationNotifyOn[] = ['always', 'failure']
const DEPTH_VALUES: AutomationNotifyDepth[] = ['ping', 'brief', 'full']

export function normalizeAutomationNotification(value: unknown): AutomationNotification | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const destinationId = typeof record.destinationId === 'string' ? record.destinationId : ''
  if (!destinationId) {
    return null
  }
  return {
    destinationId,
    notifyOn: NOTIFY_ON_VALUES.find((entry) => entry === record.notifyOn) ?? 'always',
    depth: DEPTH_VALUES.find((entry) => entry === record.depth) ?? 'brief'
  }
}
