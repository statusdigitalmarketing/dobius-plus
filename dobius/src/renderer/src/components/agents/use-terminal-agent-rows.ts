import { useMemo } from 'react'
import { useDashboardData, type DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import type { AgentDotState } from '@/components/AgentStateDot'
import type { Repo, Worktree } from '../../../../shared/types'

export type TerminalAgentRosterRow = {
  id: string
  repo: Repo
  worktree: Worktree
  agent: DashboardAgentRow
  name: string
  cli: string
  state: AgentDotState
  statusText: string
  color: string
}

function dotStateForTerminal(agent: DashboardAgentRow): AgentDotState {
  if (agent.entry.interrupted === true) {
    return 'interrupted'
  }
  switch (agent.state) {
    case 'working':
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
      return agent.state
  }
  return 'idle'
}

export function terminalAgentStatusText(row: Pick<TerminalAgentRosterRow, 'agent'>): string {
  const { entry, state } = row.agent
  const toolName = state === 'working' ? entry.toolName?.trim() : ''
  const toolInput = state === 'working' ? entry.toolInput?.trim() : ''
  if (toolName && toolInput) {
    return `${toolName}: ${toolInput}`
  }
  if (toolName) {
    return toolName
  }
  const prompt = entry.prompt.trim()
  if (prompt) {
    return prompt
  }
  if (entry.lastAssistantMessage?.trim()) {
    return entry.lastAssistantMessage.trim()
  }
  switch (state) {
    case 'working':
      return 'Working'
    case 'waiting':
      return 'Waiting on you'
    case 'blocked':
      return 'Blocked'
    case 'done':
      return 'Done'
    default:
      return 'Idle'
  }
}

export function useTerminalAgentRows(): TerminalAgentRosterRow[] {
  const groups = useDashboardData()

  return useMemo(
    () =>
      groups.flatMap((group) =>
        group.worktrees.flatMap(({ repo, worktree, agents }) =>
          agents.map((agent) => {
            const cli = formatAgentTypeLabel(agent.agentType)
            const state = dotStateForTerminal(agent)
            const color = agent.tab.color ?? 'var(--muted-foreground)'
            return {
              id: agent.paneKey,
              repo,
              worktree,
              agent,
              name: `${worktree.displayName || repo.displayName} · ${cli}`,
              cli,
              state,
              statusText: terminalAgentStatusText({ agent }),
              color
            }
          })
        )
      ),
    [groups]
  )
}
