import { AlertTriangle, BookOpen, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentRun, CustomAgent, PendingAgentDecision } from '../../../../shared/agents'
import { AgentAvatar } from './AgentAvatar'
import { AgentTerminalRoster } from './AgentTerminalRoster'
import type { TerminalAgentRosterRow } from './use-terminal-agent-rows'

function AgentStatusDot({ running }: { running: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'size-2 rounded-full',
        running ? 'bg-primary motion-safe:animate-pulse' : 'border border-muted-foreground'
      )}
    />
  )
}

export function AgentList({
  agents,
  runs,
  decisions,
  terminalRows,
  selectedAgentId,
  selectedTerminalId,
  onCreate,
  onOpenCrewFiles,
  onSelect,
  onSelectTerminal
}: {
  agents: CustomAgent[]
  runs: AgentRun[]
  decisions: PendingAgentDecision[]
  terminalRows: TerminalAgentRosterRow[]
  selectedAgentId: string | null
  selectedTerminalId: string | null
  onCreate: () => void
  onOpenCrewFiles: () => void
  onSelect: (id: string) => void
  onSelectTerminal: (id: string) => void
}): React.JSX.Element {
  const runningAgentIds = new Set(
    runs.filter((run) => run.status === 'running').map((run) => run.agentId)
  )
  const waitingAgentIds = new Set(decisions.map((decision) => decision.agentId))

  return (
    <aside className="flex min-h-0 flex-col border-r border-border bg-card/40">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center justify-between">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Crew
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={onOpenCrewFiles}>
            <BookOpen className="size-3.5" />
            Crew files
          </Button>
        </div>
        <Button className="w-full" size="sm" onClick={onCreate}>
          <Plus className="size-4" />
          New crew member
        </Button>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto p-2">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            data-current={agent.id === selectedAgentId}
            className={cn(
              'grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent',
              agent.id === selectedAgentId && 'bg-accent',
              waitingAgentIds.has(agent.id) &&
                'bg-[color-mix(in_srgb,var(--annotation-highlight)_12%,var(--background))] ring-1 ring-[color-mix(in_srgb,var(--annotation-highlight)_35%,var(--border))]'
            )}
            onClick={() => onSelect(agent.id)}
          >
            <AgentAvatar icon={agent.icon} color={agent.color} className="size-7" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{agent.name}</div>
              <div className="truncate text-xs leading-5 text-muted-foreground">
                {agent.description || agent.model}
              </div>
            </div>
            {waitingAgentIds.has(agent.id) ? (
              <AlertTriangle className="size-4 text-[color:var(--annotation-highlight)]" />
            ) : (
              <AgentStatusDot running={runningAgentIds.has(agent.id)} />
            )}
          </button>
        ))}
        <AgentTerminalRoster
          rows={terminalRows}
          selectedId={selectedTerminalId}
          onSelect={onSelectTerminal}
        />
      </div>
    </aside>
  )
}
