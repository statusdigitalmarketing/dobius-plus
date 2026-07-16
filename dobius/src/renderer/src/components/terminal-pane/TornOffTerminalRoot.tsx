import { useEffect, useState } from 'react'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { LinkRoutingPreferenceDialogProvider } from '@/components/link-routing-preference-dialog'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import TerminalPane from './TerminalPane'
import { useAppStore } from '@/store'
import type { Tab, TerminalTab } from '../../../../shared/types'

const TORN_OFF_WORKTREE_ID = 'torn-off-terminal'
const TORN_OFF_GROUP_ID = 'torn-off-terminal-group'
const TORN_OFF_LEAF_ID = '00000000-0000-4000-8000-000000000001'

type TornOffTerminalRootProps = {
  tabId: string
  ptyId: string
  title: string
  // Origin project so the floating window stays aware of and labeled with it.
  worktreeId?: string | null
  worktreeName?: string | null
}

function seedTornOffTerminalStore(args: { tabId: string; ptyId: string; title: string }): void {
  const now = Date.now()
  const tab: TerminalTab = {
    id: args.tabId,
    ptyId: args.ptyId,
    worktreeId: TORN_OFF_WORKTREE_ID,
    title: args.title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: now
  }
  const unifiedTab: Tab = {
    id: args.tabId,
    entityId: args.tabId,
    groupId: TORN_OFF_GROUP_ID,
    worktreeId: TORN_OFF_WORKTREE_ID,
    contentType: 'terminal',
    label: args.title,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: now
  }

  useAppStore.setState({
    activeWorktreeId: TORN_OFF_WORKTREE_ID,
    activeTabId: args.tabId,
    activeTabType: 'terminal',
    tabsByWorktree: { [TORN_OFF_WORKTREE_ID]: [tab] },
    unifiedTabsByWorktree: { [TORN_OFF_WORKTREE_ID]: [unifiedTab] },
    groupsByWorktree: {
      [TORN_OFF_WORKTREE_ID]: [
        {
          id: TORN_OFF_GROUP_ID,
          worktreeId: TORN_OFF_WORKTREE_ID,
          activeTabId: args.tabId,
          tabOrder: [args.tabId],
          recentTabIds: [args.tabId]
        }
      ]
    },
    activeGroupIdByWorktree: { [TORN_OFF_WORKTREE_ID]: TORN_OFF_GROUP_ID },
    ptyIdsByTabId: { [args.tabId]: [args.ptyId] },
    terminalLayoutsByTabId: {
      [args.tabId]: {
        root: { type: 'leaf', leafId: TORN_OFF_LEAF_ID },
        activeLeafId: TORN_OFF_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TORN_OFF_LEAF_ID]: args.ptyId }
      }
    }
  })
}

export function TornOffTerminalRoot({
  tabId,
  ptyId,
  title,
  worktreeName
}: TornOffTerminalRootProps): React.JSX.Element {
  const [sessionEnded, setSessionEnded] = useState(false)
  useState(() => {
    seedTornOffTerminalStore({ tabId, ptyId, title })
    return true
  })

  const labeledTitle = worktreeName ? `${worktreeName} — ${title}` : title
  useEffect(() => {
    document.title = labeledTitle
  }, [labeledTitle])

  // Why: a fresh secondary window mounts the pane without the fit + focus a
  // user gesture normally provides in the main window, so the terminal renders
  // blank and rejects keystrokes until interacted with. Nudge a fit (the pane's
  // sync-fit listener) and focus the xterm textarea. Re-run on every window
  // focus, not just mount: a torn-off window often is not yet the OS key window
  // when the pane first mounts, so an early focus() would not stick.
  useEffect(() => {
    let cancelled = false
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const focusTerminal = (): void => {
      if (cancelled) {
        return
      }
      window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
      const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      if (textarea) {
        textarea.focus()
        tries = 0
        return
      }
      if (tries < 20) {
        tries += 1
        timer = setTimeout(focusTerminal, 100)
      }
    }
    timer = setTimeout(focusTerminal, 60)
    const onWindowFocus = (): void => {
      tries = 0
      focusTerminal()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => {
      cancelled = true
      if (timer) {
        clearTimeout(timer)
      }
      window.removeEventListener('focus', onWindowFocus)
    }
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
      <ConfirmationDialogProvider>
        <LinkRoutingPreferenceDialogProvider>
          <div className="fixed inset-0 overflow-hidden bg-background text-foreground">
            <TerminalPane
              tabId={tabId}
              worktreeId={TORN_OFF_WORKTREE_ID}
              isActive
              isVisible
              isWorktreeActive
              onPtyExit={(exitedPtyId) => {
                if (exitedPtyId === ptyId) {
                  setSessionEnded(true)
                }
              }}
              onCloseTab={() => window.api.ui.requestClose()}
            />
            {sessionEnded ? (
              <div className="pointer-events-none absolute right-3 top-3 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xs">
                <span className="mr-3 text-muted-foreground">Session ended</span>
                <Button
                  className="pointer-events-auto h-6 px-2 text-xs"
                  variant="secondary"
                  size="xs"
                  onClick={() => window.api.ui.requestClose()}
                >
                  Close
                </Button>
              </div>
            ) : null}
          </div>
        </LinkRoutingPreferenceDialogProvider>
      </ConfirmationDialogProvider>
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </TooltipProvider>
  )
}
