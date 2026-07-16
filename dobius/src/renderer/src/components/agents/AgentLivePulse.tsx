import { AlertTriangle } from 'lucide-react'
import { AgentAvatar } from './AgentAvatar'
import { AgentTerminalAvatar } from './AgentTerminalAvatar'
import type { AgentRun, CustomAgent, PendingAgentDecision } from '../../../../shared/agents'
import type { TerminalAgentRosterRow } from './use-terminal-agent-rows'
import { cn } from '@/lib/utils'

type LivePulseState = 'working' | 'waiting' | 'idle'

type LivePulseRow =
  | {
      kind: 'crew'
      id: string
      name: string
      text: string
      state: LivePulseState
      color: string
      agent: CustomAgent
    }
  | {
      kind: 'terminal'
      id: string
      name: string
      text: string
      state: LivePulseState
      color: string
      terminal: TerminalAgentRosterRow
    }

function latestRunForAgent(agentId: string, runs: AgentRun[]): AgentRun | null {
  return (
    runs.filter((run) => run.agentId === agentId).sort((a, b) => b.startedAt - a.startedAt)[0] ??
    null
  )
}

function crewRowText(
  agent: CustomAgent,
  runs: AgentRun[],
  decision?: PendingAgentDecision
): string {
  if (decision) {
    return decision.title || decision.displayName || decision.toolName || 'Waiting on you'
  }
  const run = latestRunForAgent(agent.id, runs)
  if (!run) {
    return agent.heartbeat.enabled ? 'Sleeping until heartbeat' : 'Idle'
  }
  if (run.status === 'running') {
    return run.summary || 'Running'
  }
  return run.summary || run.status
}

function terminalPulseState(state: TerminalAgentRosterRow['state']): LivePulseState {
  if (state === 'working') {
    return 'working'
  }
  if (state === 'waiting' || state === 'blocked' || state === 'permission') {
    return 'waiting'
  }
  return 'idle'
}

function buildRows({
  agents,
  runs,
  decisions,
  terminals
}: {
  agents: CustomAgent[]
  runs: AgentRun[]
  decisions: PendingAgentDecision[]
  terminals: TerminalAgentRosterRow[]
}): LivePulseRow[] {
  const runningAgentIds = new Set(
    runs.filter((run) => run.status === 'running').map((run) => run.agentId)
  )
  const decisionsByAgentId = new Map(decisions.map((decision) => [decision.agentId, decision]))

  return [
    ...agents.map((agent): LivePulseRow => {
      const decision = decisionsByAgentId.get(agent.id)
      return {
        kind: 'crew',
        id: agent.id,
        name: agent.name,
        text: crewRowText(agent, runs, decision),
        state: decision ? 'waiting' : runningAgentIds.has(agent.id) ? 'working' : 'idle',
        color: agent.color,
        agent
      }
    }),
    ...terminals.map(
      (terminal): LivePulseRow => ({
        kind: 'terminal',
        id: terminal.id,
        name: terminal.name,
        text: terminal.statusText,
        state: terminalPulseState(terminal.state),
        color: terminal.color,
        terminal
      })
    )
  ]
}

function Equalizer({ state }: { state: LivePulseState }): React.JSX.Element {
  return (
    <span className={cn('agent-live-eq', `agent-live-eq--${state}`)} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((index) => (
        <span key={index} />
      ))}
    </span>
  )
}

export function AgentLivePulse({
  agents,
  runs,
  decisions,
  terminals,
  selectedAgentId,
  selectedTerminalId,
  onSelectAgent,
  onSelectTerminal
}: {
  agents: CustomAgent[]
  runs: AgentRun[]
  decisions: PendingAgentDecision[]
  terminals: TerminalAgentRosterRow[]
  selectedAgentId: string | null
  selectedTerminalId: string | null
  onSelectAgent: (id: string) => void
  onSelectTerminal: (id: string) => void
}): React.JSX.Element {
  const rows = buildRows({ agents, runs, decisions, terminals })

  return (
    <section className="border-b border-border bg-card/30 px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          Live
        </div>
        <div className="text-[11px] text-muted-foreground">{rows.length} sources</div>
      </div>
      <div className="scrollbar-sleek flex max-h-36 flex-col gap-1 overflow-y-auto pr-1">
        {rows.map((row) => {
          const selected =
            row.kind === 'crew' ? row.id === selectedAgentId : row.id === selectedTerminalId
          return (
            <button
              key={`${row.kind}:${row.id}`}
              type="button"
              data-current={selected}
              className={cn(
                'grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent',
                selected && 'bg-accent'
              )}
              style={{ color: row.color }}
              onClick={() =>
                row.kind === 'crew' ? onSelectAgent(row.id) : onSelectTerminal(row.id)
              }
            >
              {row.kind === 'crew' ? (
                <AgentAvatar icon={row.agent.icon} color={row.agent.color} className="size-6" />
              ) : (
                <AgentTerminalAvatar className="size-6" />
              )}
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground">
                  {row.name}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {row.state === 'waiting' ? (
                    <AlertTriangle className="mr-1 inline size-3 text-[color:var(--annotation-highlight)]" />
                  ) : null}
                  {row.text}
                </span>
              </span>
              <Equalizer state={row.state} />
            </button>
          )
        })}
      </div>
    </section>
  )
}
