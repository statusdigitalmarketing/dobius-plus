import type {
  AutomationNotifyDepth,
  AutomationRun,
  AutomationRunStatus
} from '../../shared/automations-types'
import type { DestinationDeliveryMessage } from '../../shared/destinations'

// Why: automation prompt templates ask the agent to end with a "NOTIFY:" block;
// that hand-written summary beats a raw terminal tail for phone-sized channels.
const NOTIFY_MARKER = /^\s*NOTIFY:\s*/m

const BRIEF_LIMIT = 300

const STATUS_LABELS: Record<AutomationRunStatus, string> = {
  pending: 'pending',
  dispatching: 'dispatching',
  dispatched: 'dispatched',
  completed: 'completed',
  skipped_precheck: 'skipped (precheck)',
  skipped_missed: 'skipped (missed window)',
  skipped_unavailable: 'skipped (target unavailable)',
  skipped_needs_interactive_auth: 'skipped (needs interactive auth)',
  dispatch_failed: 'failed'
}

export function isFailureStatus(status: AutomationRunStatus): boolean {
  return status !== 'completed'
}

export function extractNotifyBlock(output: string): string | null {
  const match = NOTIFY_MARKER.exec(output)
  if (!match) {
    return null
  }
  const block = output.slice(match.index + match[0].length).trim()
  return block.length > 0 ? block : null
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function statusLine(automationName: string, run: AutomationRun): string {
  const label = STATUS_LABELS[run.status]
  const duration =
    run.startedAt !== null && run.dispatchedAt !== null && run.dispatchedAt >= run.startedAt
      ? ` in ${Math.max(1, Math.round((run.dispatchedAt - run.startedAt) / 1000))}s`
      : ''
  const error = run.error ? ` — ${truncate(run.error, 200)}` : ''
  return `${automationName}: ${label}${duration}${error}`
}

function runSummaryText(run: AutomationRun): string {
  const output = run.outputSnapshot?.content ?? ''
  const notify = extractNotifyBlock(output)
  if (notify) {
    return notify
  }
  return output.trim()
}

export function renderAutomationNotification(
  automationName: string,
  run: AutomationRun,
  depth: AutomationNotifyDepth
): DestinationDeliveryMessage {
  const title = statusLine(automationName, run)
  if (depth === 'ping') {
    return { title, body: '' }
  }
  const summary = runSummaryText(run)
  const body = depth === 'brief' ? truncate(summary, BRIEF_LIMIT) : summary
  return { title, body }
}
