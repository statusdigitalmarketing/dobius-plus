import { useCallback, useEffect, useState } from 'react'
import { Bell, Check, X } from 'lucide-react'
import type {
  AgentNotificationEntry,
  AgentNotificationsSnapshot,
  CustomAgent
} from '../../../shared/agents'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { TabBarQuickCommandsButton } from '@/components/tab-bar/TabBarQuickCommandsButton'
import { AgentAvatar } from './agents/AgentAvatar'

function relativeTime(ts: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`
}

function openAgentsTarget(entry: AgentNotificationEntry): void {
  const detail = { decisionId: entry.decisionId, agentId: entry.agentId }
  window.dispatchEvent(new CustomEvent('agents:openDecision', { detail }))
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('agents:openDecision', { detail }))
  }, 80)
}

// Dobius+ quick-access buttons in the top-right titlebar cluster (next to the
// sidebar-toggle): the Quick Commands button (moved here from the tab group) and
// agent notifications. The mobile-visual and Tasks buttons moved into the right
// sidebar's activity strip.
export function DobiusTitlebarButtons(): React.JSX.Element {
  const [agents, setAgents] = useState<CustomAgent[]>([])
  const [notifications, setNotifications] = useState<AgentNotificationsSnapshot>({
    entries: [],
    lastReadTs: 0,
    unreadCount: 0
  })
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const activeGroupId = useAppStore((s) =>
    activeWorktreeId
      ? (s.activeGroupIdByWorktree[activeWorktreeId] ??
        s.groupsByWorktree[activeWorktreeId]?.[0]?.id ??
        null)
      : null
  )

  const loadNotifications = useCallback(async (): Promise<void> => {
    setNotifications(await window.api.agents.listNotifications())
  }, [])

  useEffect(() => {
    void window.api.agents
      .list()
      .then(setAgents)
      .catch((error) => {
        console.error('Failed to load agents for notifications:', error)
      })
    void loadNotifications().catch((error) => {
      console.error('Failed to load agent notifications:', error)
    })
    const unsubscribe = window.api.agents.onNotificationsChanged(() => {
      void loadNotifications()
    })
    return unsubscribe
  }, [loadNotifications])

  const handleNotificationsOpenChange = (open: boolean): void => {
    setNotificationsOpen(open)
    if (open) {
      void window.api.agents
        .markNotificationsRead()
        .then(setNotifications)
        .catch((error) => {
          console.error('Failed to mark agent notifications read:', error)
        })
    }
  }

  const clickNotification = (entry: AgentNotificationEntry): void => {
    setNotificationsOpen(false)
    setActiveView('agents')
    openAgentsTarget(entry)
  }

  return (
    <>
      {activeWorktreeId && activeGroupId && (
        <TabBarQuickCommandsButton worktreeId={activeWorktreeId} groupId={activeGroupId} />
      )}
      <Popover open={notificationsOpen} onOpenChange={handleNotificationsOpenChange}>
        <PopoverTrigger asChild>
          <button className="titlebar-icon-button no-drag relative" aria-label="Notifications">
            <Bell size={14} />
            {notifications.unreadCount > 0 ? (
              <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-[color:var(--annotation-highlight)] px-1 text-[10px] leading-4 text-background">
                {Math.min(notifications.unreadCount, 99)}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
          <div className="border-b border-border px-3 py-2 text-sm font-semibold">
            Notifications
          </div>
          <div className="popover-scroll-content max-h-96 overflow-y-auto p-1">
            {notifications.entries.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No notifications
              </p>
            ) : (
              notifications.entries.map((entry) => {
                const agent = agents.find((item) => item.id === entry.agentId)
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className="grid w-full grid-cols-[28px_minmax(0,1fr)_auto] gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
                    onClick={() => clickNotification(entry)}
                  >
                    {agent ? (
                      <AgentAvatar icon={agent.icon} color={agent.color} className="size-7" />
                    ) : (
                      <span className="size-7 rounded-md bg-muted" />
                    )}
                    <span className="min-w-0">
                      <span className="line-clamp-2 text-xs leading-4">{entry.text}</span>
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        {relativeTime(entry.ts)}
                      </span>
                    </span>
                    {entry.ok ? (
                      <Check className="mt-1 size-3.5 text-status-success" />
                    ) : (
                      <X className="mt-1 size-3.5 text-destructive" />
                    )}
                  </button>
                )
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
