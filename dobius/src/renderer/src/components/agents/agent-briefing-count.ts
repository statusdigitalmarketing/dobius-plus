import type { AgentRun, BriefingItem } from '../../../../shared/agents'

export function countSilentHeartbeatRunsToday(
  briefingItems: BriefingItem[],
  runs: AgentRun[]
): number {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const itemAgentRuns = new Set(
    briefingItems.filter((item) => item.ts >= start.getTime()).map((item) => item.agentId)
  )
  return runs.filter(
    (run) =>
      run.source === 'heartbeat' &&
      run.startedAt >= start.getTime() &&
      run.status === 'success' &&
      !itemAgentRuns.has(run.agentId)
  ).length
}
