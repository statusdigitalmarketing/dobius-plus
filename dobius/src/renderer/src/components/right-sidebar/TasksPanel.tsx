import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ExternalLink, Check } from 'lucide-react'
import type { AsanaLane, AsanaTask, AsanaTasksSnapshot } from '../../../../shared/asana'
import { EMPTY_ASANA_SNAPSHOT } from '../../../../shared/asana'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const LANES: { lane: AsanaLane; labelKey: string; labelDefault: string }[] = [
  {
    lane: 'build',
    labelKey: 'auto.components.right-sidebar.TasksPanel.laneBuild',
    labelDefault: 'Mine · build'
  },
  {
    lane: 'review',
    labelKey: 'auto.components.right-sidebar.TasksPanel.laneReview',
    labelDefault: 'Sam · review'
  }
]

function TaskRow({
  task,
  done,
  onToggleDone,
  onComplete
}: {
  task: AsanaTask
  done: boolean
  onToggleDone: (task: AsanaTask, done: boolean) => void
  onComplete: (task: AsanaTask) => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
      <button
        type="button"
        aria-label={translate('auto.components.right-sidebar.TasksPanel.toggleDone', 'Toggle done')}
        onClick={() => onToggleDone(task, !done)}
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border',
          done ? 'bg-primary text-primary-foreground' : 'bg-transparent'
        )}
      >
        {done && <Check className="size-3" />}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-[13px] leading-snug text-foreground',
            done && 'text-muted-foreground line-through'
          )}
          title={task.name}
        >
          {task.name}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {task.dueOn && <span className="font-mono">{task.dueOn}</span>}
          <a
            href={task.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            <ExternalLink className="size-3" />
            {translate('auto.components.right-sidebar.TasksPanel.open', 'Open')}
          </a>
          {task.lane === 'review' && !task.completed && (
            <button
              type="button"
              onClick={() => onComplete(task)}
              className="text-primary underline-offset-2 hover:underline"
            >
              {translate(
                'auto.components.right-sidebar.TasksPanel.completeInAsana',
                'Complete in Asana'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function TasksPanel(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AsanaTasksSnapshot>(EMPTY_ASANA_SNAPSHOT)
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    let disposed = false
    const unsubscribe = window.api.asana.onTasksUpdated((next) => {
      if (!disposed) {
        setSnapshot(next)
      }
    })
    void (async () => {
      const tokenPresent = await window.api.asana.hasToken()
      if (disposed) {
        return
      }
      setHasToken(tokenPresent)
      if (!tokenPresent) {
        return
      }
      setSnapshot(await window.api.asana.listTasks())
      setSyncing(true)
      try {
        setSnapshot(await window.api.asana.refresh())
      } finally {
        if (!disposed) {
          setSyncing(false)
        }
      }
    })()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const localDone = useMemo(() => new Set(snapshot.localDone), [snapshot.localDone])

  const onSync = useCallback(async () => {
    setSyncing(true)
    try {
      setSnapshot(await window.api.asana.refresh())
    } finally {
      setSyncing(false)
    }
  }, [])

  const onToggleDone = useCallback((task: AsanaTask, done: boolean) => {
    void (
      done ? window.api.asana.markLocalDone(task.gid) : window.api.asana.clearLocalDone(task.gid)
    ).then(setSnapshot)
  }, [])

  const onComplete = useCallback((task: AsanaTask) => {
    // The one Asana write — explicit confirm, never automatic.
    const prompt = translate(
      'auto.components.right-sidebar.TasksPanel.confirmComplete',
      'Complete this task in Asana? This cannot be undone from here.'
    )
    const ok = window.confirm(`${prompt}\n\n${task.name}`)
    if (!ok) {
      return
    }
    void window.api.asana.completeTask(task.gid).then(setSnapshot)
  }, [])

  if (hasToken === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.right-sidebar.TasksPanel.notConnected',
            'Connect Asana in Settings → Automation to see your build and review lanes.'
          )}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {translate('auto.components.right-sidebar.TasksPanel.title', 'Tasks')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSync}
          disabled={syncing}
          className="h-6 gap-1 px-2 text-xs"
        >
          <RefreshCw className={cn('size-3', syncing && 'animate-spin')} />
          {translate('auto.components.right-sidebar.TasksPanel.sync', 'Sync')}
        </Button>
      </div>
      {snapshot.error && <div className="px-3 py-2 text-xs text-destructive">{snapshot.error}</div>}
      <div className="flex-1 overflow-y-auto px-1 py-2">
        {LANES.map(({ lane, labelKey, labelDefault }) => {
          const tasks = lane === 'build' ? snapshot.build : snapshot.review
          return (
            <div key={lane} className="mb-3">
              <div className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
                {translate(labelKey, labelDefault)} ({tasks.length})
              </div>
              {tasks.length === 0 ? (
                <div className="px-2 py-1 text-xs text-muted-foreground/70">
                  {translate('auto.components.right-sidebar.TasksPanel.empty', 'Nothing here.')}
                </div>
              ) : (
                tasks.map((task) => (
                  <TaskRow
                    key={task.gid}
                    task={task}
                    done={localDone.has(task.gid) || task.completed}
                    onToggleDone={onToggleDone}
                    onComplete={onComplete}
                  />
                ))
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
