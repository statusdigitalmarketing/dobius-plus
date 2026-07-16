import { AlertTriangle, Loader2, Play, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { AgentRun, AgentRunEvent } from '../../../../shared/agents'

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

function formatCost(value: number | undefined): string {
  return value === undefined ? '' : `$${value.toFixed(4)}`
}

function TranscriptEvent({ event }: { event: AgentRunEvent }): React.JSX.Element {
  if (event.kind === 'assistant-text') {
    return <p className="whitespace-pre-wrap text-sm leading-6">{event.text}</p>
  }
  if (event.kind === 'tool-use') {
    return (
      <div className="font-mono text-xs text-muted-foreground">
        ⏺ {event.toolName}: {event.detail}
      </div>
    )
  }
  if (event.kind === 'tool-result') {
    return <div className="font-mono text-xs text-muted-foreground">{event.detail}</div>
  }
  if (event.kind === 'result') {
    return (
      <div className="rounded-md border border-border bg-accent px-3 py-2 text-sm">
        {event.text}
      </div>
    )
  }
  if (event.kind === 'error') {
    return <div className="text-sm text-destructive">{event.text ?? event.detail}</div>
  }
  return <div className="text-xs text-muted-foreground">{event.detail ?? event.text}</div>
}

function RunHistory({ runs }: { runs: AgentRun[] }): React.JSX.Element {
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground">No runs yet.</p>
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <div key={run.id} className="rounded-md border border-border bg-card px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Badge
              variant={
                run.status === 'error'
                  ? 'destructive'
                  : run.status === 'running'
                    ? 'secondary'
                    : 'outline'
              }
            >
              {run.status}
            </Badge>
            {run.source === 'heartbeat' ? <Badge variant="outline">heartbeat</Badge> : null}
            {run.source === 'channel' ? <Badge variant="outline">channel</Badge> : null}
            {run.source === 'asana' ? <Badge variant="outline">asana</Badge> : null}
            <span className="truncate text-xs text-muted-foreground">
              {dateFormatter.format(new Date(run.startedAt))}
            </span>
            {run.costUsd !== undefined ? (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {formatCost(run.costUsd)}
              </span>
            ) : null}
          </div>
          {run.summary ? (
            <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {run.summary}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function AgentRunView({
  prompt,
  transcript,
  runs,
  runningRun,
  waitingOnDecision,
  starting,
  onPromptChange,
  onRun,
  onStop
}: {
  prompt: string
  transcript: AgentRunEvent[]
  runs: AgentRun[]
  runningRun: AgentRun | null
  waitingOnDecision: boolean
  starting: boolean
  onPromptChange: (prompt: string) => void
  onRun: () => void
  onStop: () => void
}): React.JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto]">
      <div className="space-y-3 border-b border-border px-5 py-4">
        <textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="Prompt"
          className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <div className="flex justify-end gap-2">
          {waitingOnDecision ? (
            <div className="mr-auto flex items-center gap-2 rounded-md border border-[color-mix(in_srgb,var(--annotation-highlight)_30%,var(--border))] bg-[color-mix(in_srgb,var(--annotation-highlight)_10%,var(--background))] px-3 py-1.5 text-xs font-medium">
              <AlertTriangle className="size-3.5 text-[color:var(--annotation-highlight)]" />
              waiting on you
            </div>
          ) : null}
          {runningRun ? (
            <Button type="button" variant="outline" onClick={onStop}>
              <Square className="size-4" />
              Stop
            </Button>
          ) : null}
          <Button type="button" disabled={starting || Boolean(runningRun)} onClick={onRun}>
            {starting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Run
          </Button>
        </div>
      </div>
      <div className="scrollbar-sleek min-h-0 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {transcript.length > 0 ? (
            transcript.map((event, index) => (
              <TranscriptEvent key={`${event.runId}-${event.ts}-${index}`} event={event} />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No transcript yet.</p>
          )}
        </div>
      </div>
      <div className="border-t border-border px-5 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Runs history</h3>
          <RunHistory runs={runs} />
        </div>
      </div>
    </div>
  )
}
