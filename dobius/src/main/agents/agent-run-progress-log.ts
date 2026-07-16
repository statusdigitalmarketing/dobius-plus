import type { AgentRun } from '../../shared/agents'
import { appendAgentProgressLog } from './agent-identity-files'

function summarizeForProgressLog(summary: string | undefined): string {
  return (summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

export function appendRunProgress(
  agentId: string,
  status: AgentRun['status'],
  summary: string | undefined
): void {
  appendAgentProgressLog(
    agentId,
    `- ${new Date().toISOString()} [${status}] ${summarizeForProgressLog(summary)}`
  )
}
