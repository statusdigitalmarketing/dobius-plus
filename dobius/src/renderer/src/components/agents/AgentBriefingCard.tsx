import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { BriefingItem, CustomAgent } from '../../../../shared/agents'
import { AgentAvatar } from './AgentAvatar'

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit'
})

type TuneState = {
  agent: CustomAgent
  current: string
  draft: string
}

export function AgentBriefingCard({
  agents,
  items,
  silentRunsToday,
  onDismiss
}: {
  agents: CustomAgent[]
  items: BriefingItem[]
  silentRunsToday: number
  onDismiss: () => void
}): React.JSX.Element | null {
  const [tune, setTune] = useState<TuneState | null>(null)
  const [saving, setSaving] = useState(false)
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])

  useEffect(() => {
    if (!tune) {
      return
    }
    const nextAgent = agentsById.get(tune.agent.id)
    if (nextAgent && nextAgent !== tune.agent) {
      setTune({ ...tune, agent: nextAgent })
    }
  }, [agentsById, tune])

  if (items.length === 0) {
    return null
  }

  const openTune = async (agent: CustomAgent): Promise<void> => {
    try {
      const files = await window.api.agents.readFiles(agent.id)
      setTune({ agent, current: files.brief, draft: files.brief })
    } catch (error) {
      console.error('Failed to load briefing directive:', error)
      toast.error('Could not load briefing directive')
    }
  }

  const saveTune = async (): Promise<void> => {
    if (!tune) {
      return
    }
    setSaving(true)
    try {
      await window.api.agents.writeFile(tune.agent.id, 'brief', tune.draft)
      setTune(null)
      toast.success('Briefing tuned')
    } catch (error) {
      console.error('Failed to save briefing directive:', error)
      toast.error(error instanceof Error ? error.message : 'Could not save briefing directive')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <section className="border-b border-border bg-background px-5 py-4">
        <div className="mx-auto max-w-4xl rounded-md border border-border bg-card px-4 py-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">The morning briefing</h3>
            <Badge variant="outline">{items.length} items</Badge>
          </div>
          <div className="space-y-2">
            {items.map((item) => {
              const agent = agentsById.get(item.agentId)
              if (!agent) {
                return null
              }
              return (
                <div key={item.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3">
                  <AgentAvatar icon={agent.icon} color={agent.color} className="mt-0.5 size-6" />
                  <div className="min-w-0">
                    <p className="text-sm leading-5">
                      <span className="font-medium">{agent.name}: </span>
                      {item.summary}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {timeFormatter.format(new Date(item.ts))}
                      {item.demoted ? ' · demoted to digest' : ''}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => void openTune(agent)}
                  >
                    Tune
                  </Button>
                </div>
              )
            })}
          </div>
          <div className="mt-3 flex items-center gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
            <span>{silentRunsToday} heartbeat checks ran silent today</span>
            <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </div>
      </section>
      <Dialog open={Boolean(tune)} onOpenChange={(open) => !open && setTune(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Tune the briefing{tune ? ` — ${tune.agent.name}` : ''}</DialogTitle>
            <DialogDescription>applies to tomorrow&rsquo;s brief</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Current</p>
              <div className="min-h-20 whitespace-pre-wrap rounded-md border border-border bg-muted px-3 py-2 text-sm">
                {tune?.current}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Your edit</p>
              <textarea
                value={tune?.draft ?? ''}
                onChange={(event) => tune && setTune({ ...tune, draft: event.target.value })}
                className="min-h-28 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTune(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={saving} onClick={() => void saveTune()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
