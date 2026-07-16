import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'

type TearOffBounds = { x: number; y: number; width: number; height: number }

function uniqueStrings(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value)))]
}

function resolveTabPtyId(state: AppState, tabId: string): string | null {
  const layoutPtyIds = Object.values(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})
  const tabPtyIds = state.ptyIdsByTabId[tabId] ?? []
  const tab = Object.values(state.tabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === tabId)
  return uniqueStrings([...layoutPtyIds, ...tabPtyIds, tab?.ptyId])[0] ?? null
}

function removeTornOffTabFromRenderer(tabId: string): void {
  const state = useAppStore.getState()
  state.closeUnifiedTab(tabId)
  useAppStore.setState((current) => {
    const nextTabsByWorktree = Object.fromEntries(
      Object.entries(current.tabsByWorktree).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.filter((tab) => tab.id !== tabId)
      ])
    )
    const nextLayouts = { ...current.terminalLayoutsByTabId }
    delete nextLayouts[tabId]
    const nextPtyIds = { ...current.ptyIdsByTabId }
    delete nextPtyIds[tabId]
    const nextLastKnownRelay = { ...current.lastKnownRelayPtyIdByTabId }
    delete nextLastKnownRelay[tabId]
    const nextExpanded = { ...current.expandedPaneByTabId }
    delete nextExpanded[tabId]
    const nextCanExpand = { ...current.canExpandPaneByTabId }
    delete nextCanExpand[tabId]
    return {
      tabsByWorktree: nextTabsByWorktree,
      terminalLayoutsByTabId: nextLayouts,
      ptyIdsByTabId: nextPtyIds,
      lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
      expandedPaneByTabId: nextExpanded,
      canExpandPaneByTabId: nextCanExpand,
      activeTabId: current.activeTabId === tabId ? null : current.activeTabId
    }
  })
}

export async function tearOffTerminalTab(
  tabId: string,
  options: { bounds?: TearOffBounds } = {}
): Promise<boolean> {
  const state = useAppStore.getState()
  const terminalTab = Object.values(state.tabsByWorktree)
    .flat()
    .find((candidate) => candidate.id === tabId)
  if (!terminalTab) {
    return false
  }
  const ptyId = resolveTabPtyId(state, tabId)
  if (!ptyId) {
    return false
  }
  const title = resolveTerminalTabTitle(
    terminalTab,
    state.settings?.tabAutoGenerateTitle === true,
    terminalTab.title
  )
  const worktree = findWorktreeById(state.worktreesByRepo, terminalTab.worktreeId)
  const result = await window.api.window.tearOffTerminal({
    tabId,
    ptyId,
    title,
    worktreeId: terminalTab.worktreeId,
    ...(worktree?.displayName ? { worktreeName: worktree.displayName } : {}),
    ...(options.bounds ? { bounds: options.bounds } : {})
  })
  if (!result.ok) {
    return false
  }
  removeTornOffTabFromRenderer(tabId)
  return true
}
