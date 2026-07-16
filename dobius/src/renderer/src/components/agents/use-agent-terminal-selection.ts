import { useCallback, useMemo } from 'react'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentPageMode } from './agent-page-state'
import type { TerminalAgentRosterRow } from './use-terminal-agent-rows'

export function useAgentTerminalSelection({
  terminalRows,
  selectedTerminalId,
  setSelectedAgentId,
  setSelectedTerminalId,
  setMode
}: {
  terminalRows: TerminalAgentRosterRow[]
  selectedTerminalId: string | null
  setSelectedAgentId: (id: string | null) => void
  setSelectedTerminalId: (id: string | null) => void
  setMode: (mode: AgentPageMode) => void
}): {
  selectedTerminal: TerminalAgentRosterRow | null
  selectAgent: (id: string) => void
  selectTerminal: (id: string) => void
  openTerminal: (row: TerminalAgentRosterRow) => void
} {
  const selectedTerminal = useMemo(
    () => terminalRows.find((row) => row.id === selectedTerminalId) ?? null,
    [selectedTerminalId, terminalRows]
  )

  const selectAgent = useCallback(
    (id: string): void => {
      setSelectedTerminalId(null)
      setSelectedAgentId(id)
      setMode('run')
    },
    [setMode, setSelectedAgentId, setSelectedTerminalId]
  )

  const selectTerminal = useCallback(
    (id: string): void => {
      setSelectedAgentId(null)
      setSelectedTerminalId(id)
      setMode('run')
    },
    [setMode, setSelectedAgentId, setSelectedTerminalId]
  )

  const openTerminal = useCallback((row: TerminalAgentRosterRow): void => {
    const parsed = parsePaneKey(row.agent.paneKey)
    // Why: every user-initiated worktree switch must route through
    // activateAndRevealWorktree — the Agents roster spans ALL repos, and a
    // manual setActiveWorktree sequence skips cross-repo activeRepoId, nav
    // history, and sidebar-filter clearing (see WorktreeCardAgents).
    activateAndRevealWorktree(row.worktree.id)
    activateTabAndFocusPane(row.agent.tab.id, parsed?.leafId ?? null, {
      ackPaneKeyOnSuccess: row.agent.paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }, [])

  return { selectedTerminal, selectAgent, selectTerminal, openTerminal }
}
