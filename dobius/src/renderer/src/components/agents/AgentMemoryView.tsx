import { RotateCcw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { CustomAgent } from '../../../../shared/agents'

function formatSessionSubtitle(agent: CustomAgent): string {
  if (!agent.lastSessionId) {
    return 'Fresh session'
  }
  const updatedAt = new Date(agent.updatedAt)
  const ageMs = Date.now() - updatedAt.getTime()
  const days = Math.max(0, Math.floor(ageMs / 86_400_000))
  if (days > 0) {
    return `Continues ${days}-day-old session`
  }
  return 'Continues recent session'
}

export function AgentMemoryView({
  agent,
  memory,
  saving,
  resetting,
  onMemoryChange,
  onResetSession,
  onSave
}: {
  agent: CustomAgent
  memory: string
  saving: boolean
  resetting: boolean
  onMemoryChange: (memory: string) => void
  onResetSession: () => void
  onSave: () => void
}): React.JSX.Element {
  return (
    <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-xs text-muted-foreground">
              ~/.dobius/agents/{agent.id}/memory.md
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Editable memory for this crew member. It is kept on disk if the agent is deleted.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={resetting}
            onClick={onResetSession}
          >
            <RotateCcw className="size-4" />
            New session
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">{formatSessionSubtitle(agent)}</div>
        <textarea
          value={memory}
          spellCheck={false}
          onChange={(event) => onMemoryChange(event.target.value)}
          className="min-h-72 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs leading-6 shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <div className="flex justify-end">
          <Button type="button" disabled={saving} onClick={onSave}>
            <Save className="size-4" />
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
