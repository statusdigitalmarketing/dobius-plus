import { Pencil, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { CustomAgent } from '../../../../shared/agents'
import { AGENT_COLORS } from '../../../../shared/agents'
import { AgentAvatar } from './AgentAvatar'
import type { AgentDraft, AgentPageMode } from './agent-page-state'

function ModeButton({
  active,
  children,
  onClick
}: {
  active: boolean
  children: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      className="h-8"
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

export function AgentDetailHeader({
  selectedAgent,
  draft,
  mode,
  onDraftChange,
  onEdit,
  onModeChange,
  onSaveTagline
}: {
  selectedAgent: CustomAgent | null
  draft: AgentDraft
  mode: AgentPageMode
  onDraftChange: (draft: AgentDraft) => void
  onEdit: () => void
  onModeChange: (mode: AgentPageMode) => void
  onSaveTagline: (tagline: string) => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-3">
      <div className="flex min-w-0 items-start gap-3">
        {selectedAgent ? (
          <AgentAvatar
            icon={selectedAgent.icon}
            color={selectedAgent.color}
            className="size-11 rounded-lg"
          />
        ) : (
          <AgentAvatar icon="bot" color={AGENT_COLORS[0]} className="size-11 rounded-lg" />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold">
              {selectedAgent?.name || 'New agent'}
            </h2>
            <Button type="button" variant="outline" size="xs" onClick={onEdit}>
              <Pencil className="size-3.5" />
              Edit agent
            </Button>
          </div>
          {selectedAgent ? (
            <input
              aria-label="Agent tagline"
              value={draft.description}
              onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
              onBlur={(event) => onSaveTagline(event.target.value)}
              className="mt-1 w-full max-w-xl rounded-sm bg-transparent px-1 py-0.5 text-xs text-muted-foreground outline-none hover:bg-accent focus:bg-input focus:text-foreground focus:ring-1 focus:ring-ring"
            />
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Create a crew member to begin.</p>
          )}
          {selectedAgent ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="font-mono">
                {selectedAgent.model}
              </Badge>
              <Badge variant="outline">{selectedAgent.allowedTools.join(' · ')}</Badge>
              <Badge variant="outline" className="font-mono">
                {selectedAgent.cwd || '~'}
              </Badge>
              {selectedAgent.skills.map((skill) => (
                <Badge key={skill} variant="outline" className="gap-1">
                  <Zap className="size-3 text-[color:var(--annotation-highlight)]" />
                  {skill}
                </Badge>
              ))}
              {selectedAgent.channels.imessage ? <Badge variant="outline">iMessage</Badge> : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex rounded-md border border-border bg-background p-0.5">
        <ModeButton active={mode === 'run'} onClick={() => onModeChange('run')}>
          Live run
        </ModeButton>
        <ModeButton active={mode === 'memory'} onClick={() => onModeChange('memory')}>
          Memory
        </ModeButton>
      </div>
    </div>
  )
}
