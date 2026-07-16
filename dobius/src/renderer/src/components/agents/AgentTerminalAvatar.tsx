import { cn } from '@/lib/utils'

export function AgentTerminalAvatar({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-md border border-dashed border-border bg-muted/40 font-mono text-xs font-semibold text-muted-foreground',
        className
      )}
    >
      &gt;_
    </span>
  )
}
