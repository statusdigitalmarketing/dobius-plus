import { Notification } from 'electron'
import type { Options, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BriefingItem, CustomAgent, HeartbeatVerdict } from '../../shared/agents'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { appendBriefingItem, broadcastBriefingChanged } from './agent-briefing-store'
import { appendAgentNotification } from './agent-notification-store'
import { consumePingBudget, getAgentsPaused } from './agents-config-store'
import { getAgent, listAgents, updateAgentHeartbeatAt } from './agents-store'
import { hasLiveAgentRun, startAgentRun } from './agent-runner'

const HEARTBEAT_PROMPT =
  'Heartbeat check. Follow your Role, Playbook, and Briefing directive. Investigate quietly, then return ONLY the structured verdict.'
const TICK_MS = 60_000
const TEN_MINUTES_MS = 10 * TICK_MS

type PrepareClaudeLaunch = () => Promise<ClaudeRuntimeAuthPreparation>

let interval: NodeJS.Timeout | null = null

function minutesOfDay(value: string): number {
  const [hourText, minuteText] = value.split(':')
  return Number(hourText) * 60 + Number(minuteText)
}

function isInsideQuietHours(agent: CustomAgent, now: Date): boolean {
  const start = minutesOfDay(agent.heartbeat.quietStart)
  const end = minutesOfDay(agent.heartbeat.quietEnd)
  const current = now.getHours() * 60 + now.getMinutes()
  if (start === end) {
    return false
  }
  return start < end ? current >= start && current < end : current >= start || current < end
}

function dayKey(time: number): string {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function startOfHour(now: Date): number {
  const hour = new Date(now)
  hour.setMinutes(0, 0, 0)
  return hour.getTime()
}

function scheduledAtToday(agent: CustomAgent, now: Date): number {
  const scheduled = new Date(now)
  const [hourText, minuteText] = agent.heartbeat.at.split(':')
  scheduled.setHours(Number(hourText), Number(minuteText), 0, 0)
  return scheduled.getTime()
}

function isDue(agent: CustomAgent, now: Date): boolean {
  const last = agent.lastHeartbeatAt ?? 0
  if (agent.heartbeat.frequency === 'every10min') {
    return now.getTime() - last >= TEN_MINUTES_MS
  }
  if (agent.heartbeat.frequency === 'hourly') {
    return now.getMinutes() === 0 && last < startOfHour(now)
  }
  if (agent.heartbeat.frequency === 'weekdays') {
    const day = now.getDay()
    if (day === 0 || day === 6) {
      return false
    }
  }
  const scheduled = scheduledAtToday(agent, now)
  return now.getTime() >= scheduled && dayKey(last) !== dayKey(scheduled)
}

function validateVerdict(value: unknown): HeartbeatVerdict | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Partial<Record<keyof HeartbeatVerdict, unknown>>
  if (typeof record.summary !== 'string') {
    return null
  }
  if (record.urgency !== 'silent' && record.urgency !== 'digest' && record.urgency !== 'now') {
    return null
  }
  return {
    important: record.important === true,
    urgency: record.urgency,
    summary: record.summary.trim()
  }
}

function showNotification(item: BriefingItem, agent: CustomAgent): void {
  new Notification({
    title: `${agent.name} ${item.urgency === 'now' ? 'needs attention' : 'briefing update'}`,
    body: item.summary
  }).show()
}

function routeVerdict(agent: CustomAgent, verdict: HeartbeatVerdict): void {
  // Why: urgency is authoritative — a digest verdict with important=false must
  // still land in the briefing, not vanish.
  if (verdict.urgency === 'silent' || !verdict.summary) {
    return
  }
  if (verdict.urgency === 'now') {
    const hasBudget = consumePingBudget()
    const item = appendBriefingItem({
      agentId: agent.id,
      urgency: hasBudget ? 'now' : 'digest',
      summary: verdict.summary,
      demoted: !hasBudget
    })
    if (hasBudget) {
      appendAgentNotification({
        agentId: agent.id,
        kind: 'briefing-now',
        ok: false,
        text: `${agent.name}: ${verdict.summary}`
      })
      showNotification(item, agent)
      broadcastBriefingChanged()
    }
    return
  }
  const item = appendBriefingItem({
    agentId: agent.id,
    urgency: verdict.urgency,
    summary: verdict.summary
  })
  const notifiesOnDigest = agent.notify === 'everything' || agent.notify === 'digest + urgent'
  if (verdict.urgency === 'digest' && notifiesOnDigest && consumePingBudget()) {
    showNotification(item, agent)
    broadcastBriefingChanged()
  }
}

function handleResult(agentId: string, message: SDKResultMessage): void {
  if (message.subtype !== 'success') {
    return
  }
  const agent = getAgent(agentId)
  const verdict = validateVerdict(message.structured_output)
  if (agent && verdict) {
    routeVerdict(agent, verdict)
  }
}

function heartbeatOutputFormat(): Options['outputFormat'] {
  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['important', 'urgency', 'summary'],
      properties: {
        important: { type: 'boolean' },
        urgency: { type: 'string', enum: ['silent', 'digest', 'now'] },
        summary: { type: 'string' }
      }
    }
  }
}

async function maybeStartHeartbeat(
  agent: CustomAgent,
  prepareClaudeLaunch: PrepareClaudeLaunch
): Promise<void> {
  // Why: mark the window consumed only after the run actually reserves a slot —
  // writing first made agents beyond the concurrency cap silently skip their
  // whole scheduled window. The pre-await reservation in startAgentRun keeps
  // the next tick from double-firing via hasLiveAgentRun.
  await startAgentRun({
    agentId: agent.id,
    prompt: HEARTBEAT_PROMPT,
    prepareClaudeLaunch,
    options: {
      source: 'heartbeat',
      resume: false,
      maxTurns: agent.heartbeat.maxTurns,
      maxBudgetUsd: agent.heartbeat.maxBudgetUsd,
      permissionMode: 'dontAsk',
      outputFormat: heartbeatOutputFormat(),
      onResult: (message) => handleResult(agent.id, message)
    }
  })
  updateAgentHeartbeatAt(agent.id, Date.now())
}

async function tick(prepareClaudeLaunch: PrepareClaudeLaunch): Promise<void> {
  if (getAgentsPaused()) {
    return
  }
  const now = new Date()
  for (const agent of listAgents()) {
    if (!agent.heartbeat.enabled || isInsideQuietHours(agent, now) || hasLiveAgentRun(agent.id)) {
      continue
    }
    if (!isDue(agent, now)) {
      continue
    }
    void maybeStartHeartbeat(agent, prepareClaudeLaunch).catch((error) => {
      console.warn(
        '[agents] heartbeat failed:',
        error instanceof Error ? error.message : String(error)
      )
    })
  }
}

export function startAgentHeartbeats(prepareClaudeLaunch: PrepareClaudeLaunch): void {
  if (interval) {
    return
  }
  interval = setInterval(() => void tick(prepareClaudeLaunch), TICK_MS)
  interval.unref?.()
  void tick(prepareClaudeLaunch)
}
