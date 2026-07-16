import { Badge } from '@/components/ui/badge'
import { AgentStateDot } from '@/components/AgentStateDot'
import { cn } from '@/lib/utils'
import { AgentTerminalAvatar } from './AgentTerminalAvatar'
import type { TerminalAgentRosterRow } from './use-terminal-agent-rows'

export function AgentTerminalRoster({
  rows,
  selectedId,
  onSelect
}: {
  rows: TerminalAgentRosterRow[]
  selectedId: string | null
  onSelect: (id: string) => void
}): React.JSX.Element | null {
  if (rows.length === 0) {
    return null
  }

  return (
    <div className="border-t border-border px-2 py-3">
      <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        Terminals
      </div>
      <div className="space-y-1">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            data-current={row.id === selectedId}
            className={cn(
              'grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent',
              row.id === selectedId && 'bg-accent',
              row.state === 'waiting' &&
                'bg-[color-mix(in_srgb,var(--annotation-highlight)_12%,var(--background))] ring-1 ring-[color-mix(in_srgb,var(--annotation-highlight)_35%,var(--border))]'
            )}
            onClick={() => onSelect(row.id)}
          >
            <AgentTerminalAvatar className="size-7" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{row.name}</div>
              <div className="truncate text-xs leading-5 text-muted-foreground">
                {row.statusText}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <AgentStateDot state={row.state} size="sm" />
              <Badge variant="outline" className="border-dashed px-1.5 py-0 font-mono text-[10px]">
                TERMINAL
              </Badge>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
