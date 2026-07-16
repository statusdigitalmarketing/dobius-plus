import { useState } from 'react'
import { Check, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentDraftComment, CustomAgent } from '../../../../shared/agents'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { AgentAvatar } from './AgentAvatar'

function AgentDraftRow({
  draft,
  agent,
  hasAsanaToken,
  onApprove,
  onDiscard
}: {
  draft: AgentDraftComment
  agent: CustomAgent | undefined
  hasAsanaToken: boolean | null
  onApprove: (id: string) => Promise<void>
  onDiscard: (id: string) => void
}): React.JSX.Element {
  const confirm = useConfirmationDialog()
  const [posting, setPosting] = useState(false)
  const approveDisabled = hasAsanaToken !== true || posting
  const approveTooltip =
    hasAsanaToken === false ? 'Connect Asana in Settings' : 'Checking Asana connection'
  const approveDraft = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Post draft to Asana?',
      description: `Post this comment to Asana task ${draft.target.gid}? This is the one action that writes to Asana.`,
      confirmLabel: 'Approve & post'
    })
    if (!ok) {
      return
    }
    setPosting(true)
    try {
      await onApprove(draft.id)
      toast.success('Posted to Asana')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not post to Asana')
    } finally {
      setPosting(false)
    }
  }
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3">
      {agent ? (
        <AgentAvatar icon={agent.icon} color={agent.color} className="mt-0.5 size-6" />
      ) : (
        <span className="mt-0.5 size-6 rounded-md border border-border bg-muted" />
      )}
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">Asana {draft.target.gid}</p>
        <div className="scrollbar-sleek mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-2 py-1.5 text-sm leading-5">
          {draft.body}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                type="button"
                variant="default"
                size="xs"
                disabled={approveDisabled}
                onClick={() => void approveDraft()}
              >
                <Check className="size-3.5" />
                Approve &amp; post
              </Button>
            </span>
          </TooltipTrigger>
          {approveDisabled ? (
            <TooltipContent side="top" sideOffset={4}>
              {approveTooltip}
            </TooltipContent>
          ) : null}
        </Tooltip>
        <Button type="button" variant="destructive" size="xs" onClick={() => onDiscard(draft.id)}>
          <Trash2 className="size-3.5" />
          Discard
        </Button>
      </div>
    </div>
  )
}

export function AgentDraftsPanel({
  agents,
  drafts,
  hasAsanaToken,
  onApprove,
  onDiscard
}: {
  agents: CustomAgent[]
  drafts: AgentDraftComment[]
  hasAsanaToken: boolean | null
  onApprove: (id: string) => Promise<void>
  onDiscard: (id: string) => void
}): React.JSX.Element | null {
  const pending = drafts.filter((draft) => draft.status === 'pending')
  if (pending.length === 0) {
    return null
  }
  return (
    <section className="border-b border-border bg-background px-5 py-4">
      <div className="mx-auto max-w-4xl rounded-md border border-border bg-card px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Drafts</h3>
          <Badge variant="outline">{pending.length} pending</Badge>
        </div>
        <div className="space-y-2">
          {pending.map((draft) => {
            const agent = agents.find((item) => item.id === draft.agentId)
            return (
              <AgentDraftRow
                key={draft.id}
                draft={draft}
                agent={agent}
                hasAsanaToken={hasAsanaToken}
                onApprove={onApprove}
                onDiscard={onDiscard}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}
