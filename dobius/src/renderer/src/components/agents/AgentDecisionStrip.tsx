import { AlertTriangle } from 'lucide-react'
import type { CustomAgent, PendingAgentDecision } from '../../../../shared/agents'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

function relativeTime(ts: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

export function AgentDecisionStrip({
  agents,
  decisions,
  onOpenDecision
}: {
  agents: CustomAgent[]
  decisions: PendingAgentDecision[]
  onOpenDecision: (id: string) => void
}): React.JSX.Element | null {
  if (decisions.length === 0) {
    return null
  }
  return (
    <section className="border-b border-[color-mix(in_srgb,var(--annotation-highlight)_30%,var(--border))] bg-[color-mix(in_srgb,var(--annotation-highlight)_12%,var(--background))] px-5 py-3">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="size-4 text-[color:var(--annotation-highlight)]" />
          Needs you
          <Badge variant="outline">{decisions.length}</Badge>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap justify-end gap-2">
          {decisions.map((decision) => {
            const agent = agents.find((item) => item.id === decision.agentId)
            return (
              <Button
                key={decision.id}
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onOpenDecision(decision.id)}
              >
                {agent?.name ?? 'Agent'} · {decision.toolName} · {relativeTime(decision.createdAt)}
              </Button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
