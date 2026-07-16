import { Bot, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function AgentsPageHeader({
  agentCount,
  paused,
  pingStatus,
  onTogglePaused
}: {
  agentCount: number
  paused: boolean
  pingStatus: { used: number; max: number; date: string } | null
  onTogglePaused: () => void
}): React.JSX.Element {
  const used = pingStatus?.used ?? 0
  const max = pingStatus?.max ?? 4
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
      <Bot className="size-4 text-muted-foreground" />
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold">Agents</h1>
        <p className="truncate text-xs text-muted-foreground">{agentCount} configured</p>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">
            pings {used}/{max}
          </span>
          <span className="flex gap-1" aria-hidden="true">
            {Array.from({ length: max }, (_, index) => (
              <span
                key={index}
                className={cn(
                  'size-1.5 rounded-full border border-border',
                  index < used && 'bg-primary'
                )}
              />
            ))}
          </span>
        </div>
        <Button type="button" variant="outline" size="xs" onClick={onTogglePaused}>
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          {paused ? 'Resume crew' : 'Pause crew'}
        </Button>
      </div>
    </header>
  )
}
