import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import type { CustomAgent, PendingAgentDecision } from '../../../../shared/agents'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentAvatar } from './AgentAvatar'

function relativeTime(ts: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  return `${Math.floor(minutes / 60)}h`
}

function bashCommand(decision: PendingAgentDecision): string {
  const command = decision.input.command
  return typeof command === 'string' ? command : JSON.stringify(decision.input, null, 2)
}

function displayInput(decision: PendingAgentDecision): string {
  if (decision.toolName === 'Bash') {
    return bashCommand(decision)
  }
  return JSON.stringify(decision.input, null, 2)
}

export function AgentDecisionTicketDialog({
  agents,
  decisions,
  openDecisionId,
  onOpenDecisionChange,
  onResolved
}: {
  agents: CustomAgent[]
  decisions: PendingAgentDecision[]
  openDecisionId: string | null
  onOpenDecisionChange: (id: string | null) => void
  onResolved: () => void
}): React.JSX.Element {
  const decision = decisions.find((item) => item.id === openDecisionId) ?? null
  const agent = agents.find((item) => item.id === decision?.agentId) ?? null
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editedCommand, setEditedCommand] = useState('')
  const [responding, setResponding] = useState(false)
  const [responseText, setResponseText] = useState('')
  const context = useMemo(() => {
    if (!decision) {
      return ''
    }
    return decision.branch ? `${decision.cwd} · ${decision.branch}` : decision.cwd
  }, [decision])

  const close = (): void => {
    onOpenDecisionChange(null)
    setAlwaysAllow(false)
    setEditing(false)
    setEditedCommand('')
    setResponding(false)
    setResponseText('')
  }

  const resolve = async (
    action: 'approve' | 'approveEdited' | 'alwaysAllow' | 'deny' | 'respond' | 'bypassRun'
  ): Promise<void> => {
    if (!decision) {
      return
    }
    try {
      const payload =
        action === 'approveEdited'
          ? { input: editedCommand }
          : action === 'respond'
            ? { text: responseText }
            : undefined
      const result = await window.api.agents.resolveDecision({ id: decision.id, action, payload })
      if (result.note) {
        toast.message(result.note)
      }
      close()
      onResolved()
    } catch (error) {
      console.error('Failed to resolve agent decision:', error)
      toast.error(error instanceof Error ? error.message : 'Could not resolve decision')
    }
  }

  const approve = (): void => {
    if (editing) {
      void resolve('approveEdited')
      return
    }
    void resolve(alwaysAllow ? 'alwaysAllow' : 'approve')
  }

  return (
    <Dialog open={Boolean(decision)} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            {agent ? (
              <AgentAvatar icon={agent.icon} color={agent.color} className="size-10 rounded-lg" />
            ) : null}
            <div className="min-w-0">
              <DialogTitle className="text-base">
                {agent?.name ?? 'Agent'} wants to use {decision?.displayName ?? decision?.toolName}
              </DialogTitle>
              <DialogDescription>
                waiting on you · {decision ? relativeTime(decision.createdAt) : ''}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        {decision ? (
          <div className="space-y-3">
            {decision.title ? <p className="text-sm">{decision.title}</p> : null}
            {decision.description ? (
              <p className="text-xs leading-5 text-muted-foreground">{decision.description}</p>
            ) : null}
            <div className="space-y-1">
              {decision.toolName === 'Bash' ? (
                <div className="font-mono text-[11px] text-muted-foreground">{context}</div>
              ) : null}
              {editing ? (
                <textarea
                  value={editedCommand}
                  onChange={(event) => setEditedCommand(event.target.value)}
                  className="min-h-36 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                />
              ) : (
                <pre className="scrollbar-sleek max-h-72 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap">
                  {displayInput(decision)}
                </pre>
              )}
            </div>
            {responding ? (
              <textarea
                value={responseText}
                onChange={(event) => setResponseText(event.target.value)}
                placeholder="Tell the agent what to do instead"
                className="min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              />
            ) : null}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={alwaysAllow}
                onCheckedChange={(checked) => setAlwaysAllow(checked === true)}
              />
              always allow {decision.toolName} for {agent?.name ?? 'this agent'}
            </label>
          </div>
        ) : null}
        <DialogFooter className="items-center sm:justify-between">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="border-[color-mix(in_srgb,var(--annotation-highlight)_45%,var(--border))] text-[color:var(--annotation-highlight)]"
                onClick={() => void resolve('bypassRun')}
              >
                <AlertTriangle className="size-4" />
                Bypass run
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Approve everything for the rest of this run — hard rails still apply
            </TooltipContent>
          </Tooltip>
          <div className="flex flex-wrap justify-end gap-2">
            {responding ? (
              <Button type="button" variant="outline" onClick={() => void resolve('respond')}>
                Send response
              </Button>
            ) : (
              <Button type="button" variant="outline" onClick={() => setResponding(true)}>
                Respond
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => void resolve('deny')}>
              Deny
            </Button>
            {decision?.toolName === 'Bash' && !editing ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditedCommand(bashCommand(decision))
                  setEditing(true)
                }}
              >
                Edit
              </Button>
            ) : null}
            <Button type="button" onClick={approve}>
              {editing ? 'Approve edited' : 'Approve'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
