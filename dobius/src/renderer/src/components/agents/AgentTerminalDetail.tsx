import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { AgentStateDot, agentStateLabel } from '@/components/AgentStateDot'
import { AgentTerminalAvatar } from './AgentTerminalAvatar'
import type { TerminalAgentRosterRow } from './use-terminal-agent-rows'

export function AgentTerminalDetail({
  row,
  onOpenTerminal
}: {
  row: TerminalAgentRosterRow
  onOpenTerminal: (row: TerminalAgentRosterRow) => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-3">
        <div className="flex min-w-0 items-start gap-3">
          <AgentTerminalAvatar className="size-11 rounded-lg" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold">{row.name}</h2>
              <AgentStateDot state={row.state} size="md" />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              This agent lives in a terminal tab. Watch it here; drive it there.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant="outline">{row.cli}</Badge>
              <Badge variant="outline" className="font-mono">
                {row.worktree.displayName || row.repo.displayName}
              </Badge>
              <Badge variant="outline" className="border-dashed font-mono">
                TERMINAL
              </Badge>
            </div>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => onOpenTerminal(row)}>
          <ExternalLink className="size-4" />
          Open terminal
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-5">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Status
          </div>
          <div className="mt-3 flex items-start gap-3">
            <AgentStateDot state={row.state} size="md" />
            <div className="min-w-0">
              <div className="text-sm font-medium">{agentStateLabel(row.state)}</div>
              <p className="mt-1 break-words text-sm text-muted-foreground">{row.statusText}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
